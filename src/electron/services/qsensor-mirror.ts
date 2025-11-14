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
 * Stop mirroring session.
 */
export async function stopMirrorSession(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  const session = activeSessions.get(sessionId)

  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  try {
    // Stop polling
    session.running = false
    if (session.intervalId) {
      clearInterval(session.intervalId)
      session.intervalId = null
    }

    // Final poll to catch any remaining chunks
    await pollAndMirror(session)

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
