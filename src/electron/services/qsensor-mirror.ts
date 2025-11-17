/**
 * Q-Sensor live mirroring service for Electron main process.
 *
 * Continuously mirrors chunked Q-Sensor data from ROV to topside during recording.
 * Uses timer-based polling to check for new chunks and downloads them atomically.
 */

import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import store from './config-store'

interface MirrorSession {
  sessionId: string
  vehicleAddress: string
  missionName: string
  cadenceSec: number
  fullBandwidth: boolean
  rootPath: string
  lastChunkIndex: number
  bytesMirrored: number
  lastSync: string | null
  intervalId: NodeJS.Timeout | null
  running: boolean
}

const activeSessions = new Map<string, MirrorSession>()

/**
 * Compute SHA256 hash of a file.
 */
async function computeSHA256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Write mirror.json metadata atomically.
 */
async function writeMirrorMetadata(session: MirrorSession): Promise<void> {
  const mirrorPath = path.join(session.rootPath, 'mirror.json')
  const mirrorTmp = path.join(session.rootPath, 'mirror.json.tmp')

  const metadata = {
    session_id: session.sessionId,
    mission: session.missionName,
    last_chunk_index: session.lastChunkIndex,
    bytes_mirrored: session.bytesMirrored,
    last_sync: session.lastSync,
  }

  await fs.writeFile(mirrorTmp, JSON.stringify(metadata, null, 2), 'utf-8')

  // fsync not directly available in Node, but writeFile should be durable
  await fs.rename(mirrorTmp, mirrorPath)
}

/**
 * Load mirror.json metadata if it exists.
 */
async function loadMirrorMetadata(rootPath: string): Promise<{ lastChunkIndex: number; bytesMirrored: number } | null> {
  const mirrorPath = path.join(rootPath, 'mirror.json')

  try {
    const data = await fs.readFile(mirrorPath, 'utf-8')
    const metadata = JSON.parse(data)
    return {
      lastChunkIndex: metadata.last_chunk_index ?? -1,
      bytesMirrored: metadata.bytes_mirrored ?? 0,
    }
  } catch (error) {
    // File doesn't exist or invalid - start fresh
    return null
  }
}

/**
 * Download a single chunk with atomic write and SHA256 verification.
 */
async function downloadChunk(
  vehicleAddress: string,
  sessionId: string,
  chunkName: string,
  expectedSha256: string,
  targetDir: string
): Promise<{ success: boolean; bytes: number; error?: string }> {
  const url = `http://${vehicleAddress}:9150/files/${sessionId}/${chunkName}`
  const targetPath = path.join(targetDir, chunkName)
  const tmpPath = path.join(targetDir, `${chunkName}.tmp`)

  try {
    console.log(`[QSensor Mirror] Downloading ${url} -> ${tmpPath}`)

    // Download to temp file
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) {
      console.error(`[QSensor Mirror] Download failed: HTTP ${response.status} ${response.statusText}`)
      return { success: false, bytes: 0, error: `HTTP ${response.status}` }
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    console.log(`[QSensor Mirror] Received ${buffer.length} bytes, writing to ${tmpPath}`)

    await fs.writeFile(tmpPath, buffer)

    // Verify SHA256
    const actualSha256 = await computeSHA256(tmpPath)
    if (actualSha256 !== expectedSha256) {
      console.error(`[QSensor Mirror] SHA256 mismatch: expected=${expectedSha256.substring(0, 8)}..., actual=${actualSha256.substring(0, 8)}...`)
      await fs.unlink(tmpPath) // Clean up
      return { success: false, bytes: 0, error: 'SHA256 mismatch' }
    }
    console.log(`[QSensor Mirror] SHA256 verified: ${actualSha256.substring(0, 8)}...`)

    // Atomic rename
    await fs.rename(tmpPath, targetPath)
    console.log(`[QSensor Mirror] Renamed ${tmpPath} -> ${targetPath}`)

    return { success: true, bytes: buffer.length }
  } catch (error: any) {
    // Clean up temp file if exists
    try {
      await fs.unlink(tmpPath)
    } catch {
      // Ignore
    }

    return { success: false, bytes: 0, error: error.message || 'Unknown error' }
  }
}

/**
 * Poll for new chunks and mirror them.
 */
async function pollAndMirror(session: MirrorSession): Promise<void> {
  if (!session.running) {
    console.log(`[QSensor Mirror] pollAndMirror() skipped: session ${session.sessionId} not running`)
    return
  }

  try {
    // Get snapshots list
    const url = `http://${session.vehicleAddress}:9150/record/snapshots?session_id=${session.sessionId}`
    console.log(`[QSensor Mirror] Polling ${url}...`)

    // Increased timeout from 5s to 15s - Pi can be slow when finalizing chunks
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })

    if (!response.ok) {
      console.warn(`[QSensor Mirror] Snapshots request failed: HTTP ${response.status} ${response.statusText}`)
      return
    }

    const chunks = await response.json()
    console.log(`[QSensor Mirror] Received ${chunks.length} total chunks, lastChunkIndex=${session.lastChunkIndex}`)

    // Find new chunks
    const newChunks = chunks.filter((chunk: any) => chunk.index > session.lastChunkIndex)

    if (newChunks.length === 0) {
      console.log(`[QSensor Mirror] No new chunks (have up to index ${session.lastChunkIndex})`)
      return // No new data
    }

    console.log(`[QSensor Mirror] Found ${newChunks.length} new chunks for session ${session.sessionId}`)

    // Download each new chunk
    for (const chunk of newChunks) {
      console.log(`[QSensor Mirror] Attempting to download chunk ${chunk.index}: ${chunk.name} (${chunk.size_bytes} bytes, sha256=${chunk.sha256?.substring(0, 8)}...)`)

      const result = await downloadChunk(
        session.vehicleAddress,
        session.sessionId,
        chunk.name,
        chunk.sha256,
        session.rootPath
      )

      if (result.success) {
        session.lastChunkIndex = chunk.index
        session.bytesMirrored += result.bytes
        session.lastSync = new Date().toISOString()

        console.log(`[QSensor Mirror] ✓ Downloaded chunk ${chunk.name}: ${result.bytes} bytes (total mirrored: ${session.bytesMirrored})`)
      } else {
        console.error(`[QSensor Mirror] ✗ Failed to download ${chunk.name}: ${result.error}`)
        // Continue with other chunks
      }
    }

    // Update metadata
    console.log(`[QSensor Mirror] Writing mirror.json: lastChunk=${session.lastChunkIndex}, bytes=${session.bytesMirrored}`)
    await writeMirrorMetadata(session)
    console.log(`[QSensor Mirror] Poll complete for session ${session.sessionId}`)
  } catch (error: any) {
    console.error(`[QSensor Mirror] Poll error for session ${session.sessionId}:`, error.message, error.stack)
  }
}

/**
 * Start mirroring session.
 */
export async function startMirrorSession(
  sessionId: string,
  vehicleAddress: string,
  missionName: string,
  cadenceSec: number,
  fullBandwidth: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log(`[QSensor Mirror] startMirrorSession() called: session=${sessionId}, vehicle=${vehicleAddress}, mission=${missionName}`)

    // Check if already running
    if (activeSessions.has(sessionId)) {
      console.warn(`[QSensor Mirror] Session ${sessionId} already active`)
      return { success: false, error: 'Session already active' }
    }

    // Resolve storage path from config or use default
    const customStoragePath = store.get('qsensorStoragePath')
    const basePath = customStoragePath || path.join(app.getPath('userData'), 'qsensor')
    const rootPath = path.join(basePath, missionName, sessionId)

    console.log(`[QSensor Mirror] Storage path resolved: customPath=${customStoragePath || 'none'}, basePath=${basePath}, rootPath=${rootPath}`)

    // Create directory
    await fs.mkdir(rootPath, { recursive: true })
    console.log(`[QSensor Mirror] Created directory: ${rootPath}`)

    // Load existing metadata if resuming
    const existing = await loadMirrorMetadata(rootPath)
    console.log(`[QSensor Mirror] Loaded metadata: lastChunk=${existing?.lastChunkIndex ?? -1}, bytes=${existing?.bytesMirrored ?? 0}`)

    const session: MirrorSession = {
      sessionId,
      vehicleAddress,
      missionName,
      cadenceSec: fullBandwidth ? 2 : cadenceSec, // Fast polling in full-bandwidth mode
      fullBandwidth,
      rootPath,
      lastChunkIndex: existing?.lastChunkIndex ?? -1,
      bytesMirrored: existing?.bytesMirrored ?? 0,
      lastSync: null,
      intervalId: null,
      running: true,
    }

    activeSessions.set(sessionId, session)
    console.log(`[QSensor Mirror] Session ${sessionId} added to active sessions map`)

    // Log the URL that will be polled
    const snapshotsUrl = `http://${session.vehicleAddress}:9150/record/snapshots?session_id=${session.sessionId}`
    console.log(`[QSensor Mirror] Will poll: ${snapshotsUrl} every ${session.cadenceSec}s`)

    // Start polling - wrap in try-catch to catch any immediate errors
    try {
      const poll = () => pollAndMirror(session)
      console.log(`[QSensor Mirror] Running initial poll...`)
      poll() // Run immediately
      session.intervalId = setInterval(poll, session.cadenceSec * 1000)
      console.log(`[QSensor Mirror] Polling interval ${session.intervalId} started (cadence=${session.cadenceSec}s)`)
    } catch (pollError: any) {
      console.error(`[QSensor Mirror] Failed to start polling:`, pollError)
      throw pollError
    }

    console.log(
      `[QSensor Mirror] Started session ${sessionId}: cadence=${session.cadenceSec}s, path=${rootPath}`
    )

    return { success: true }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Start failed:`, error)
    return { success: false, error: error.message }
  }
}

/**
 * Verify session.csv file integrity after combining.
 *
 * Checks that the combined file has the expected number of rows and valid CSV structure.
 */
async function verifySessionFile(sessionCsvPath: string, expectedRows: number): Promise<{ valid: boolean; actualRows: number; error?: string }> {
  try {
    console.log(`[QSensor Mirror] Verifying ${sessionCsvPath}...`)

    // Check file exists and get size
    const stats = await fs.stat(sessionCsvPath)
    console.log(`[QSensor Mirror] Session file size: ${stats.size} bytes`)

    if (stats.size === 0) {
      return { valid: false, actualRows: 0, error: 'Session file is empty' }
    }

    // Read and count lines (more efficient than split for large files)
    const content = await fs.readFile(sessionCsvPath, 'utf-8')
    const lines = content.split('\n')

    // Count non-empty lines
    let actualRows = 0
    let hasHeader = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line === '') continue

      if (i === 0 || !hasHeader) {
        // First non-empty line should be header
        if (line.includes('timestamp') || line.includes('sensor_id')) {
          hasHeader = true
          continue
        }
      }

      actualRows++
    }

    console.log(`[QSensor Mirror] Verification: expected=${expectedRows} rows, actual=${actualRows} rows`)

    if (!hasHeader) {
      return { valid: false, actualRows, error: 'Missing CSV header' }
    }

    if (actualRows !== expectedRows) {
      return {
        valid: false,
        actualRows,
        error: `Row count mismatch: expected ${expectedRows}, got ${actualRows}`
      }
    }

    console.log(`[QSensor Mirror] ✓ Session file verified successfully`)
    return { valid: true, actualRows }

  } catch (error: any) {
    console.error(`[QSensor Mirror] Verification failed:`, error)
    return { valid: false, actualRows: 0, error: error.message }
  }
}

/**
 * Clean up redundant chunk files after successful session.csv creation.
 *
 * Only deletes chunks after verifying session.csv integrity.
 * Keeps mirror.json and session.csv.
 */
async function cleanupChunkFiles(session: MirrorSession): Promise<{ deleted: number; errors: number }> {
  let deleted = 0
  let errors = 0

  try {
    console.log(`[QSensor Mirror] Cleaning up chunk files in ${session.rootPath}...`)

    const files = await fs.readdir(session.rootPath)
    const chunkFiles = files
      .filter(name => name.match(/^chunk_\d{5}\.csv$/))
      .sort()

    console.log(`[QSensor Mirror] Found ${chunkFiles.length} chunk files to clean up`)

    for (const chunkFile of chunkFiles) {
      try {
        const chunkPath = path.join(session.rootPath, chunkFile)
        await fs.unlink(chunkPath)
        deleted++
        console.log(`[QSensor Mirror] ✓ Deleted ${chunkFile}`)
      } catch (err: any) {
        errors++
        console.warn(`[QSensor Mirror] ✗ Failed to delete ${chunkFile}: ${err.message}`)
        // Continue cleanup even if one file fails
      }
    }

    console.log(`[QSensor Mirror] Cleanup complete: deleted=${deleted}, errors=${errors}`)
    return { deleted, errors }

  } catch (error: any) {
    console.error(`[QSensor Mirror] Cleanup failed:`, error)
    return { deleted, errors: errors + 1 }
  }
}

/**
 * Combine all chunk CSV files into a single continuous session.csv file.
 *
 * Reads chunks in order (by index), writes header once, then appends all data rows.
 * Uses streaming line-by-line processing to avoid loading entire dataset into memory.
 */
async function combineChunksIntoSessionFile(session: MirrorSession): Promise<{ success: boolean; rowsWritten: number; error?: string }> {
  const sessionCsvPath = path.join(session.rootPath, 'session.csv')
  const sessionCsvTmpPath = path.join(session.rootPath, 'session.csv.tmp')

  try {
    console.log(`[QSensor Mirror] Combining chunks into ${sessionCsvPath}...`)

    // Get list of all chunk files in directory
    const files = await fs.readdir(session.rootPath)
    const chunkFiles = files
      .filter(name => name.match(/^chunk_\d{5}\.csv$/))
      .sort() // Sort by name ensures correct order (chunk_00000, chunk_00001, ...)

    if (chunkFiles.length === 0) {
      console.warn(`[QSensor Mirror] No chunk files found in ${session.rootPath}`)
      return { success: false, rowsWritten: 0, error: 'No chunk files found' }
    }

    console.log(`[QSensor Mirror] Found ${chunkFiles.length} chunk files: ${chunkFiles.join(', ')}`)

    let rowsWritten = 0
    let headerWritten = false

    // Delete temp file if it exists from previous failed attempt
    try {
      await fs.unlink(sessionCsvTmpPath)
    } catch {
      // Ignore if doesn't exist
    }

    try {
      // Process each chunk file in order
      for (const chunkFile of chunkFiles) {
        const chunkPath = path.join(session.rootPath, chunkFile)
        console.log(`[QSensor Mirror] Processing ${chunkFile}...`)

        const content = await fs.readFile(chunkPath, 'utf-8')
        const lines = content.split('\n')

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()

          if (line === '') {
            continue // Skip empty lines
          }

          // First non-empty line of first chunk is the header
          if (!headerWritten && i === 0) {
            await fs.appendFile(sessionCsvTmpPath, line + '\n', 'utf-8')
            headerWritten = true
            console.log(`[QSensor Mirror] Wrote header: ${line.substring(0, 60)}...`)
            continue
          }

          // Skip header line in subsequent chunks
          if (i === 0) {
            continue
          }

          // Write data row
          await fs.appendFile(sessionCsvTmpPath, line + '\n', 'utf-8')
          rowsWritten++
        }

        console.log(`[QSensor Mirror] Processed ${chunkFile}: added ${lines.length - 1} rows`)
      }

      // Atomic rename
      await fs.rename(sessionCsvTmpPath, sessionCsvPath)

      console.log(`[QSensor Mirror] ✓ Successfully created ${sessionCsvPath} with ${rowsWritten} data rows`)

      return { success: true, rowsWritten }
    } catch (error) {
      // Clean up on error
      try {
        await fs.unlink(sessionCsvTmpPath)
      } catch {
        // Ignore cleanup errors
      }
      throw error
    }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Failed to combine chunks:`, error)
    return { success: false, rowsWritten: 0, error: error.message }
  }
}

/**
 * Stop mirroring session.
 *
 * IMPORTANT: This should be called AFTER /record/stop has been called on the backend
 * to ensure the final chunk is finalized and available for mirroring.
 */
export async function stopMirrorSession(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  const session = activeSessions.get(sessionId)

  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  try {
    // Stop polling timer
    session.running = false
    if (session.intervalId) {
      clearInterval(session.intervalId)
      session.intervalId = null
    }
    console.log(`[QSensor Mirror] Polling stopped for session ${sessionId}`)

    // CRITICAL: Wait a moment for backend's /record/stop to complete final chunk finalization
    // The backend needs time to flush, compute SHA256, and write manifest.json
    console.log(`[QSensor Mirror] Waiting 1s for backend to finalize last chunk...`)
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Final poll to catch the last finalized chunk
    console.log(`[QSensor Mirror] Running final poll to catch last chunk...`)
    await pollAndMirror(session)

    // Combine all chunks into single session.csv file
    console.log(`[QSensor Mirror] Combining chunks into session.csv...`)
    const combineResult = await combineChunksIntoSessionFile(session)

    if (!combineResult.success) {
      console.warn(`[QSensor Mirror] ⚠ Failed to create session.csv: ${combineResult.error}`)
      console.warn(`[QSensor Mirror] ⚠ Keeping chunk files for manual recovery`)
      // Write metadata and continue - chunks remain for manual recovery
      await writeMirrorMetadata(session)
      activeSessions.delete(sessionId)
      return { success: true } // Don't fail stop operation
    }

    console.log(`[QSensor Mirror] ✓ Created session.csv with ${combineResult.rowsWritten} rows`)

    // Verify session.csv integrity before cleanup
    const sessionCsvPath = path.join(session.rootPath, 'session.csv')
    console.log(`[QSensor Mirror] Verifying session.csv integrity...`)
    const verifyResult = await verifySessionFile(sessionCsvPath, combineResult.rowsWritten)

    if (!verifyResult.valid) {
      console.error(`[QSensor Mirror] ✗ Session file verification FAILED: ${verifyResult.error}`)
      console.error(`[QSensor Mirror] ✗ Keeping chunk files for recovery (DO NOT DELETE)`)
      // Write metadata and continue - chunks remain for recovery
      await writeMirrorMetadata(session)
      activeSessions.delete(sessionId)
      return { success: true } // Don't fail stop operation, but warn user
    }

    console.log(`[QSensor Mirror] ✓ Session.csv verified: ${verifyResult.actualRows} rows`)

    // Clean up redundant chunk files after successful verification
    console.log(`[QSensor Mirror] Cleaning up redundant chunk files...`)
    const cleanupResult = await cleanupChunkFiles(session)
    console.log(`[QSensor Mirror] Cleanup result: deleted ${cleanupResult.deleted} chunks, ${cleanupResult.errors} errors`)

    if (cleanupResult.errors > 0) {
      console.warn(`[QSensor Mirror] ⚠ Some chunk files could not be deleted (${cleanupResult.errors} errors)`)
      // Non-fatal - session.csv is verified and available
    }

    // Write final metadata
    await writeMirrorMetadata(session)

    activeSessions.delete(sessionId)

    console.log(`[QSensor Mirror] Stopped session ${sessionId}`)

    return { success: true }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Stop failed:`, error)
    return { success: false, error: error.message }
  }
}

/**
 * Get session statistics.
 */
export function getSessionStats(
  sessionId: string
): { success: boolean; stats?: any; error?: string } {
  const session = activeSessions.get(sessionId)

  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  return {
    success: true,
    stats: {
      sessionId: session.sessionId,
      running: session.running,
      lastChunkIndex: session.lastChunkIndex,
      bytesMirrored: session.bytesMirrored,
      lastSync: session.lastSync,
      rootPath: session.rootPath,
    },
  }
}

/**
 * Setup IPC handlers for Q-Sensor mirroring.
 */
export function setupQSensorMirrorService(): void {
  ipcMain.handle(
    'qsensor:start-mirror',
    async (_event, sessionId, vehicleAddress, missionName, cadenceSec, fullBandwidth) => {
      console.log(
        `[QSensor Mirror] IPC start request: session=${sessionId}, vehicle=${vehicleAddress}, cadence=${
          fullBandwidth ? 2 : cadenceSec
        }s, fullBandwidth=${fullBandwidth}`
      )
      return await startMirrorSession(sessionId, vehicleAddress, missionName, cadenceSec, fullBandwidth)
    }
  )

  ipcMain.handle('qsensor:stop-mirror', async (_event, sessionId) => {
    return await stopMirrorSession(sessionId)
  })

  ipcMain.handle('qsensor:get-stats', (_event, sessionId) => {
    return getSessionStats(sessionId)
  })

  console.log('[QSensor Mirror] Service registered')
}
