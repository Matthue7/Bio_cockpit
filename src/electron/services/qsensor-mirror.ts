// * Q-Sensor live mirroring service for Electron main process.
// * Continuously mirrors chunked Q-Sensor data from ROV to topside during recording.
// * Uses timer-based polling to check for new chunks and downloads them atomically.

import * as crypto from 'crypto'
import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'

import store from './config-store'
import { areBothSensorsComplete, fuseSessionData, isFusionComplete } from './qsensor-fusion'
import {
  buildSensorDirectoryName,
  buildUnifiedSessionRoot,
  ensureSyncMetadata,
  getSyncMetadataPath,
  readSyncMetadata,
  updateFusionStatus,
  updateSensorMetadata,
} from './qsensor-session-utils'
import { validateAndNormalizeQSensorUrl } from './url-validator'

/**
 *
 */
interface MirrorSession {
  /**
   *
   */
  sessionId: string
  /**
   *
   */
  apiBaseUrl: string
  /**
   *
   */
  missionName: string
  /**
   *
   */
  cadenceSec: number
  /**
   *
   */
  fullBandwidth: boolean
  /**
   *
   */
  rootPath: string
  /**
   *
   */
  sessionRoot?: string
  /**
   *
   */
  lastChunkIndex: number
  /**
   *
   */
  bytesMirrored: number
  /**
   *
   */
  lastSync: string | null
  /**
   *
   */
  intervalId: NodeJS.Timeout | null
  /**
   *
   */
  running: boolean
  /**
   *
   */
  syncId: string | null
  /**
   * Sensor identifier ('inWater' or 'surface')
   */
  sensorId: 'inWater' | 'surface'
}

const activeSessions = new Map<string, MirrorSession>()

// * Inject a sync marker into the Pi recording via /record/sync-marker.
/**
 *
 * @param session
 * @param syncId
 * @param markerType
 */
async function injectPiSyncMarker(
  session: MirrorSession,
  syncId: string,
  markerType: 'START' | 'STOP'
): Promise<boolean> {
  const syncUrl = `${session.apiBaseUrl}/record/sync-marker`

  try {
    const response = await fetch(syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: session.sessionId,
        sync_id: syncId,
        marker_type: markerType,
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      console.warn(
        `[QSensor Mirror] Failed to inject ${markerType} marker to ${session.apiBaseUrl} (session ${session.sessionId}): HTTP ${response.status} ${response.statusText}`
      )
      return false
    }

    const result = await response.json().catch(() => null)
    console.log(
      `[QSensor Mirror] ${markerType} marker injected (syncId=${syncId.slice(0, 8)}..., ts=${
        result?.timestamp ?? 'unknown'
      })`
    )
    return true
  } catch (error: any) {
    console.warn(
      `[QSensor Mirror] Failed to inject ${markerType} marker to ${session.apiBaseUrl} (session ${session.sessionId}): ${error.message}`
    )
    return false
  }
}

// * Attempt to fuse both sensor session.csv files into unified output.
// * Called after a sensor finishes combine/cleanup to prevent missing dual-sensor fusion.
// * Skips if fusion already ran or both sensors are not yet complete.
/**
 *
 * @param sessionRoot
 */
async function attemptFusion(sessionRoot: string): Promise<void> {
  try {
    // NOTE: Avoid double-fusing
    const alreadyFused = await isFusionComplete(sessionRoot)
    if (alreadyFused) {
      console.log(`[QSensor Mirror] Fusion already complete for ${sessionRoot}`)
      return
    }

    // * Read current sync metadata required for fusion inputs
    const syncMetadata = await readSyncMetadata(sessionRoot)
    if (!syncMetadata) {
      console.warn(`[QSensor Mirror] No sync_metadata.json found in ${sessionRoot}`)
      return
    }

    // NOTE: Wait until both sensors have finalized before triggering fusion
    if (!areBothSensorsComplete(syncMetadata)) {
      console.log(`[QSensor Mirror] Waiting for both sensors to complete before fusion`)
      return
    }

    console.log(`[QSensor Mirror] Both sensors complete, triggering fusion...`)

    // * Perform fusion
    const result = await fuseSessionData(sessionRoot, syncMetadata)

    // * Update sync_metadata with fusion status
    if (result.success && result.unifiedCsvPath) {
      await updateFusionStatus(sessionRoot, {
        status: 'complete',
        unifiedCsv: path.basename(result.unifiedCsvPath),
        rowCount: result.totalRows ?? null,
        inWaterRows: result.inWaterRows ?? null,
        surfaceRows: result.surfaceRows ?? null,
        completedAt: new Date().toISOString(),
        error: null,
      })
      console.log(`[QSensor Mirror] ✓ Fusion complete: ${result.totalRows} rows`)
    } else if (result.error?.includes('skipping unified fusion')) {
      // NOTE: Single-sensor session; mark fusion as skipped so UIs stop waiting
      await updateFusionStatus(sessionRoot, {
        status: 'skipped',
        unifiedCsv: null,
        rowCount: null,
        inWaterRows: null,
        surfaceRows: null,
        completedAt: new Date().toISOString(),
        error: result.error,
      })
      console.log(`[QSensor Mirror] Fusion skipped: ${result.error}`)
    } else {
      // ! Fusion failed
      await updateFusionStatus(sessionRoot, {
        status: 'failed',
        unifiedCsv: null,
        rowCount: null,
        inWaterRows: null,
        surfaceRows: null,
        completedAt: new Date().toISOString(),
        error: result.error ?? 'Unknown fusion error',
      })
      console.error(`[QSensor Mirror] ✗ Fusion failed: ${result.error}`)
    }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Fusion attempt error:`, error)
    // NOTE: Try to record the failure in sync_metadata even when fusion blows up
    try {
      await updateFusionStatus(sessionRoot, {
        status: 'failed',
        unifiedCsv: null,
        rowCount: null,
        inWaterRows: null,
        surfaceRows: null,
        completedAt: new Date().toISOString(),
        error: error.message || 'Unknown error',
      })
    } catch {
      // NOTE: Ignore errors updating metadata to avoid masking the root failure
    }
  }
}

// * Compute SHA256 hash of a file.
/**
 *
 * @param filePath
 */
async function computeSHA256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// * Write mirror.json metadata atomically.
/**
 *
 * @param session
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

  // NOTE: fsync not directly available in Node, but writeFile should be durable enough here
  await fs.rename(mirrorTmp, mirrorPath)
}

// * Load mirror.json metadata if it exists.
/**
 *
 * @param rootPath
 */
async function loadMirrorMetadata(rootPath: string): Promise<{
  /**
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   */
  lastChunkIndex: number
  /**
llllllllllllllllllllllll *
llllllllllllllllllllllll
   */
  bytesMirrored: number
} | null> {
  const mirrorPath = path.join(rootPath, 'mirror.json')

  try {
    const data = await fs.readFile(mirrorPath, 'utf-8')
    const metadata = JSON.parse(data)
    return {
      lastChunkIndex: metadata.last_chunk_index ?? -1,
      bytesMirrored: metadata.bytes_mirrored ?? 0,
    }
  } catch (error) {
    // NOTE: File missing or invalid; start with defaults
    return null
  }
}

// * Download a single chunk with atomic write and SHA256 verification.
/**
 *
 * @param apiBaseUrl
 * @param sessionId
 * @param chunkName
 * @param expectedSha256
 * @param targetDir
 */
async function downloadChunk(
  apiBaseUrl: string,
  sessionId: string,
  chunkName: string,
  expectedSha256: string,
  targetDir: string
): Promise<{
  /** Whether the download succeeded */
  success: boolean
  /** Number of bytes downloaded */
  bytes: number
  /** Error message if download failed */
  error?: string
}> {
  const url = `${apiBaseUrl}/files/${sessionId}/${chunkName}`
  const targetPath = path.join(targetDir, chunkName)
  const tmpPath = path.join(targetDir, `${chunkName}.tmp`)

  try {
    console.log(`[QSensor Mirror] Downloading ${url} -> ${tmpPath}`)

    // * Download to temp file before verification
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) {
      console.error(
        `[QSensor Mirror] Download failed for ${chunkName} from ${apiBaseUrl}: HTTP ${response.status} ${response.statusText}`
      )
      return { success: false, bytes: 0, error: `HTTP ${response.status}` }
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    console.log(`[QSensor Mirror] Received ${buffer.length} bytes, writing to ${tmpPath}`)

    await fs.writeFile(tmpPath, buffer)

    // ! Verify SHA256 before moving file into session directory
    const actualSha256 = await computeSHA256(tmpPath)
    if (actualSha256 !== expectedSha256) {
      console.error(
        `[QSensor Mirror] SHA256 mismatch: expected=${expectedSha256.substring(
          0,
          8
        )}..., actual=${actualSha256.substring(0, 8)}...`
      )
      await fs.unlink(tmpPath) // NOTE: Clean up temp file on mismatch
      return { success: false, bytes: 0, error: 'SHA256 mismatch' }
    }
    console.log(`[QSensor Mirror] SHA256 verified: ${actualSha256.substring(0, 8)}...`)

    // * Atomic rename to avoid partial chunk exposure
    await fs.rename(tmpPath, targetPath)
    console.log(`[QSensor Mirror] Renamed ${tmpPath} -> ${targetPath}`)

    return { success: true, bytes: buffer.length }
  } catch (error: any) {
    // NOTE: Clean up temp file if exists
    try {
      await fs.unlink(tmpPath)
    } catch {
      // NOTE: Ignore cleanup failures
    }

    return { success: false, bytes: 0, error: error.message || 'Unknown error' }
  }
}

// * Poll for new chunks and mirror them.
/**
 *
 * @param session
 */
async function pollAndMirror(session: MirrorSession): Promise<void> {
  if (!session.running) {
    console.log(`[QSensor Mirror] pollAndMirror() skipped: session ${session.sessionId} not running`)
    return
  }

  try {
    // * Get snapshots list
    const url = `${session.apiBaseUrl}/record/snapshots?session_id=${session.sessionId}`
    console.log(`[QSensor Mirror] Polling ${url}...`)

    // NOTE: Increased timeout from 5s to 15s; Pi can be slow when finalizing chunks
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })

    if (!response.ok) {
      console.warn(
        `[QSensor Mirror] Snapshots request failed for ${session.apiBaseUrl} (session ${session.sessionId}): HTTP ${response.status} ${response.statusText}`
      )
      return
    }

    const chunks = await response.json()
    console.log(`[QSensor Mirror] Received ${chunks.length} total chunks, lastChunkIndex=${session.lastChunkIndex}`)

    // * Find new chunks beyond the last mirrored index
    const newChunks = chunks.filter((chunk: any) => chunk.index > session.lastChunkIndex)

    if (newChunks.length === 0) {
      console.log(`[QSensor Mirror] No new chunks (have up to index ${session.lastChunkIndex})`)
      return // No new data
    }

    console.log(`[QSensor Mirror] Found ${newChunks.length} new chunks for session ${session.sessionId}`)

    // * Download each new chunk
    for (const chunk of newChunks) {
      console.log(
        `[QSensor Mirror] Attempting to download chunk ${chunk.index}: ${chunk.name} (${
          chunk.size_bytes
        } bytes, sha256=${chunk.sha256?.substring(0, 8)}...)`
      )

      const result = await downloadChunk(
        session.apiBaseUrl,
        session.sessionId,
        chunk.name,
        chunk.sha256,
        session.rootPath
      )

      if (result.success) {
        session.lastChunkIndex = chunk.index
        session.bytesMirrored += result.bytes
        session.lastSync = new Date().toISOString()

        console.log(
          `[QSensor Mirror] ✓ Downloaded chunk ${chunk.name}: ${result.bytes} bytes (total mirrored: ${session.bytesMirrored})`
        )
      } else {
        console.error(`[QSensor Mirror] ✗ Failed to download ${chunk.name}: ${result.error}`)
        // NOTE: Continue with other chunks; mirror will retry on next poll
      }
    }

    // * Update metadata after completing downloads
    console.log(
      `[QSensor Mirror] Writing mirror.json: lastChunk=${session.lastChunkIndex}, bytes=${session.bytesMirrored}`
    )
    await writeMirrorMetadata(session)
    console.log(`[QSensor Mirror] Poll complete for session ${session.sessionId}`)
  } catch (error: any) {
    console.error(
      `[QSensor Mirror] Poll error for ${session.apiBaseUrl} (session ${session.sessionId}):`,
      error.message,
      error.stack
    )
  }
}

// * Start mirroring session.
// * Uses unified session layout when provided to align in-water data with topside recordings.
/**
 *
 * @param sessionId
 * @param apiBaseUrl
 * @param missionName
 * @param cadenceSec
 * @param fullBandwidth
 * @param unifiedSessionTimestamp
 * @param syncId
 * @param sensorId
 */
export async function startMirrorSession(
  sessionId: string,
  apiBaseUrl: string,
  missionName: string,
  cadenceSec: number,
  fullBandwidth: boolean,
  unifiedSessionTimestamp?: string,
  syncId?: string,
  sensorId?: 'inWater' | 'surface'
): Promise<{
  /**
))))))))))))) *
)))))))))))))
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  error?: string
  /**
eeeeeeeeeeeeeeee *
eeeeeeeeeeeeeeee
   */
  data?: {
    /**
ddddddddd *
ddddddddd
     */
    sessionRoot: string
  }
  /**
sssssssssssssssssssssss *
sssssssssssssssssssssss
   */
  syncId?: string
}> {
  try {
    // Default to 'inWater' for backwards compatibility if not specified
    const actualSensorId = sensorId || 'inWater'

    console.log(
      `[QSensor Mirror] startMirrorSession() called: session=${sessionId}, sensorId=${actualSensorId}, apiBaseUrl=${apiBaseUrl}, mission=${missionName}, unifiedTimestamp=${unifiedSessionTimestamp}`
    )

    // PHASE 3: Validate and normalize URL before starting mirror session
    const urlResult = validateAndNormalizeQSensorUrl(apiBaseUrl, `session ${sessionId}`)
    if (!urlResult.success) {
      console.error(`[QSensor Mirror] URL validation failed: ${urlResult.error}`)
      return { success: false, error: urlResult.error }
    }
    const normalizedUrl = urlResult.normalizedUrl
    console.log(`[QSensor Mirror] Validated URL: ${normalizedUrl}`)

    // NOTE: Prevent duplicate mirrors for the same session
    if (activeSessions.has(sessionId)) {
      console.warn(`[QSensor Mirror] Session ${sessionId} already active`)
      return { success: false, error: 'Session already active' }
    }

    // * Resolve storage path from config or use default
    const customStoragePath = store.get('qsensorStoragePath')
    const basePath = customStoragePath || path.join(app.getPath('userData'), 'qsensor')

    // NOTE: Use unified session layout if timestamp provided (Phase 4+)
    // NOTE: Structure: {storage}/{mission}/session_{timestamp}/{sensor}_{sessionId}/
    // NOTE: Otherwise fall back to legacy: {storage}/{mission}/{sessionId}/
    let rootPath: string
    let unifiedRoot: string | null = null
    if (unifiedSessionTimestamp) {
      unifiedRoot = buildUnifiedSessionRoot(basePath, missionName, unifiedSessionTimestamp)
      rootPath = path.join(unifiedRoot, buildSensorDirectoryName(actualSensorId, sessionId))
    } else {
      rootPath = path.join(basePath, missionName, sessionId)
    }

    console.log(
      `[QSensor Mirror] Storage path resolved: customPath=${
        customStoragePath || 'none'
      }, basePath=${basePath}, rootPath=${rootPath}`
    )

    const sessionSyncId = syncId || uuidv4()

    // * Create directory
    await fs.mkdir(rootPath, { recursive: true })

    // * Create sync_metadata.json placeholder in unified session root (Phase 4+)
    if (unifiedRoot && unifiedSessionTimestamp) {
      await ensureSyncMetadata(unifiedRoot, missionName, unifiedSessionTimestamp)
      await updateSensorMetadata(unifiedRoot, actualSensorId, {
        sessionId,
        directory: buildSensorDirectoryName(actualSensorId, sessionId),
        startedAt: new Date().toISOString(),
      })
      console.log(
        `[QSensor Mirror] sync_metadata.json initialized for ${actualSensorId} at ${getSyncMetadataPath(unifiedRoot)}`
      )
    }
    console.log(`[QSensor Mirror] Created directory: ${rootPath}`)

    // NOTE: Load existing metadata if resuming
    const existing = await loadMirrorMetadata(rootPath)
    console.log(
      `[QSensor Mirror] Loaded metadata: lastChunk=${existing?.lastChunkIndex ?? -1}, bytes=${
        existing?.bytesMirrored ?? 0
      }`
    )

    const session: MirrorSession = {
      sessionId,
      apiBaseUrl: normalizedUrl, // Use validated and normalized URL
      missionName,
      cadenceSec: fullBandwidth ? 2 : cadenceSec, // NOTE: Fast polling in full-bandwidth mode
      fullBandwidth,
      rootPath,
      sessionRoot: unifiedRoot ?? undefined,
      lastChunkIndex: existing?.lastChunkIndex ?? -1,
      bytesMirrored: existing?.bytesMirrored ?? 0,
      lastSync: null,
      intervalId: null,
      running: true,
      syncId: sessionSyncId,
      sensorId: actualSensorId,
    }

    activeSessions.set(sessionId, session)
    console.log(`[QSensor Mirror] Session ${sessionId} added to active sessions map`)

    // Inject START sync marker into Pi recording
    await injectPiSyncMarker(session, sessionSyncId, 'START')

    // NOTE: Log the URL that will be polled
    const snapshotsUrl = `${session.apiBaseUrl}/record/snapshots?session_id=${session.sessionId}`
    console.log(`[QSensor Mirror] Will poll: ${snapshotsUrl} every ${session.cadenceSec}s`)

    // * Start polling - wrap in try-catch to catch any immediate errors
    try {
      const poll = (): void => {
        pollAndMirror(session)
      }
      console.log(`[QSensor Mirror] Running initial poll...`)
      poll() // Run immediately
      session.intervalId = setInterval(poll, session.cadenceSec * 1000)
      console.log(`[QSensor Mirror] Polling interval ${session.intervalId} started (cadence=${session.cadenceSec}s)`)
    } catch (pollError: any) {
      console.error(`[QSensor Mirror] Failed to start polling:`, pollError)
      throw pollError
    }

    console.log(`[QSensor Mirror] Started session ${sessionId}: cadence=${session.cadenceSec}s, path=${rootPath}`)

    return {
      success: true,
      data: {
        sessionRoot: unifiedRoot ?? path.join(basePath, missionName, sessionId),
      },
      syncId: sessionSyncId,
    }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Start failed for ${apiBaseUrl} (session ${sessionId}):`, error)
    return { success: false, error: error.message }
  }
}

// * Verify session.csv file integrity after combining.
// * Confirms row counts and header presence before chunk cleanup.
/**
 *
 * @param sessionCsvPath
 * @param expectedRows
 */
async function verifySessionFile(
  sessionCsvPath: string,
  expectedRows: number
): Promise<{
  /**
))))))))))))) *
)))))))))))))
   */
  valid: boolean
  /**
vvvvvvvvvvvvvvvv *
vvvvvvvvvvvvvvvv
   */
  actualRows: number
  /**
aaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaa
   */
  error?: string
}> {
  try {
    console.log(`[QSensor Mirror] Verifying ${sessionCsvPath}...`)

    // * Check file exists and get size
    const stats = await fs.stat(sessionCsvPath)
    console.log(`[QSensor Mirror] Session file size: ${stats.size} bytes`)

    if (stats.size === 0) {
      return { valid: false, actualRows: 0, error: 'Session file is empty' }
    }

    // * Read and count lines (more efficient than split for large files)
    const content = await fs.readFile(sessionCsvPath, 'utf-8')
    const lines = content.split('\n')

    // * Count non-empty lines
    let actualRows = 0
    let hasHeader = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line === '') continue

      if (i === 0 || !hasHeader) {
        // NOTE: First non-empty line should be header
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
        error: `Row count mismatch: expected ${expectedRows}, got ${actualRows}`,
      }
    }

    console.log(`[QSensor Mirror] ✓ Session file verified successfully`)
    return { valid: true, actualRows }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Verification failed:`, error)
    return { valid: false, actualRows: 0, error: error.message }
  }
}

// * Clean up redundant chunk files after successful session.csv creation.
// ! Only delete chunks after successful verification; mirror.json and session.csv are preserved.
/**
 *
 * @param session
 */
async function cleanupChunkFiles(session: MirrorSession): Promise<{
  /**
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   */
  deleted: number
  /**
ddddddddddddddddd *
ddddddddddddddddd
   */
  errors: number
}> {
  let deleted = 0
  let errors = 0

  try {
    console.log(`[QSensor Mirror] Cleaning up chunk files in ${session.rootPath}...`)

    const files = await fs.readdir(session.rootPath)
    const chunkFiles = files.filter((name) => name.match(/^chunk_\d{5}\.csv$/)).sort()

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
        // NOTE: Continue cleanup even if one file fails
      }
    }

    console.log(`[QSensor Mirror] Cleanup complete: deleted=${deleted}, errors=${errors}`)
    return { deleted, errors }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Cleanup failed:`, error)
    return { deleted, errors: errors + 1 }
  }
}

// * Combine all chunk CSV files into a single continuous session.csv file.
// * Reads chunks in order, writes header once, and streams rows to limit memory.
/**
 *
 * @param session
 */
async function combineChunksIntoSessionFile(session: MirrorSession): Promise<{
  /**
))))))))))))) *
)))))))))))))
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  rowsWritten: number
  /**
rrrrrrrrrrrrrrrrrrrrr *
rrrrrrrrrrrrrrrrrrrrr
   */
  error?: string
}> {
  const sessionCsvPath = path.join(session.rootPath, 'session.csv')
  const sessionCsvTmpPath = path.join(session.rootPath, 'session.csv.tmp')

  try {
    console.log(`[QSensor Mirror] Combining chunks into ${sessionCsvPath}...`)

    // * Get list of all chunk files in directory
    const files = await fs.readdir(session.rootPath)
    const chunkFiles = files.filter((name) => name.match(/^chunk_\d{5}\.csv$/)).sort() // Sort by name ensures correct order (chunk_00000, chunk_00001, ...)

    if (chunkFiles.length === 0) {
      console.warn(`[QSensor Mirror] No chunk files found in ${session.rootPath}`)
      return { success: false, rowsWritten: 0, error: 'No chunk files found' }
    }

    console.log(`[QSensor Mirror] Found ${chunkFiles.length} chunk files: ${chunkFiles.join(', ')}`)

    let rowsWritten = 0
    let headerWritten = false

    // NOTE: Delete temp file if it exists from previous failed attempt
    try {
      await fs.unlink(sessionCsvTmpPath)
    } catch {
      // NOTE: Ignore if doesn't exist
    }

    try {
      // * Process each chunk file in order
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

          // NOTE: First non-empty line of first chunk is the header
          if (!headerWritten && i === 0) {
            await fs.appendFile(sessionCsvTmpPath, line + '\n', 'utf-8')
            headerWritten = true
            console.log(`[QSensor Mirror] Wrote header: ${line.substring(0, 60)}...`)
            continue
          }

          // NOTE: Skip header line in subsequent chunks
          if (i === 0) {
            continue
          }

          // * Write data row
          await fs.appendFile(sessionCsvTmpPath, line + '\n', 'utf-8')
          rowsWritten++
        }

        console.log(`[QSensor Mirror] Processed ${chunkFile}: added ${lines.length - 1} rows`)
      }

      // * Atomic rename
      await fs.rename(sessionCsvTmpPath, sessionCsvPath)

      console.log(`[QSensor Mirror] ✓ Successfully created ${sessionCsvPath} with ${rowsWritten} data rows`)

      return { success: true, rowsWritten }
    } catch (error) {
      // NOTE: Clean up on error
      try {
        await fs.unlink(sessionCsvTmpPath)
      } catch {
        // NOTE: Ignore cleanup errors
      }
      throw error
    }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Failed to combine chunks:`, error)
    return { success: false, rowsWritten: 0, error: error.message }
  }
}

// * Stop mirroring session.
// ! Call after backend /record/stop so the final chunk is finalized and downloadable.
/**
 *
 * @param sessionId
 */
export async function stopMirrorSession(sessionId: string): Promise<{
  /**
eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee *
eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  error?: string
}> {
  const session = activeSessions.get(sessionId)

  if (!session) {
    console.warn(`[QSensor Mirror] Stop requested for unknown session: ${sessionId}`)
    return { success: false, error: 'Session not found' }
  }

  // PHASE 3: Only HTTP sensors have mirror sessions
  // Serial surface sensor has no mirror session to stop
  if (!session.apiBaseUrl) {
    console.log(`[QSensor Mirror] Session ${sessionId} has no API URL - likely serial mode, no mirror to stop`)
    return { success: true } // Not an error
  }

  try {
    // NOTE: Stop polling timer
    session.running = false
    if (session.intervalId) {
      clearInterval(session.intervalId)
      session.intervalId = null
    }
    console.log(`[QSensor Mirror] Polling stopped for session ${sessionId}`)

    // Inject STOP sync marker before finalizing recording on Pi
    if (session.syncId) {
      await injectPiSyncMarker(session, session.syncId, 'STOP')
    } else {
      console.warn(`[QSensor Mirror] No syncId available to inject STOP marker for session ${sessionId}`)
    }

    // ! Wait briefly for backend /record/stop to finalize the last chunk (flush, checksum, manifest)
    console.log(`[QSensor Mirror] Waiting 1s for backend to finalize last chunk...`)
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // * Final poll to catch the last finalized chunk
    console.log(`[QSensor Mirror] Running final poll to catch last chunk...`)
    await pollAndMirror(session)

    // * Combine all chunks into single session.csv file
    console.log(`[QSensor Mirror] Combining chunks into session.csv...`)
    const combineResult = await combineChunksIntoSessionFile(session)

    if (!combineResult.success) {
      console.warn(`[QSensor Mirror] ⚠ Failed to create session.csv: ${combineResult.error}`)
      console.warn(`[QSensor Mirror] ⚠ Keeping chunk files for manual recovery`)
      // NOTE: Write metadata and continue - chunks remain for manual recovery
      await writeMirrorMetadata(session)
      activeSessions.delete(sessionId)
      return { success: true } // Don't fail stop operation
    }

    console.log(`[QSensor Mirror] ✓ Created session.csv with ${combineResult.rowsWritten} rows`)

    // * Verify session.csv integrity before cleanup
    const sessionCsvPath = path.join(session.rootPath, 'session.csv')
    console.log(`[QSensor Mirror] Verifying session.csv integrity...`)
    const verifyResult = await verifySessionFile(sessionCsvPath, combineResult.rowsWritten)

    if (!verifyResult.valid) {
      console.error(`[QSensor Mirror] ✗ Session file verification FAILED: ${verifyResult.error}`)
      console.error(`[QSensor Mirror] ✗ Keeping chunk files for recovery (DO NOT DELETE)`)
      // NOTE: Write metadata and continue - chunks remain for recovery
      await writeMirrorMetadata(session)
      activeSessions.delete(sessionId)
      return { success: true } // Don't fail stop operation, but warn user
    }

    console.log(`[QSensor Mirror] ✓ Session.csv verified: ${verifyResult.actualRows} rows`)

    // * Clean up redundant chunk files after successful verification
    console.log(`[QSensor Mirror] Cleaning up redundant chunk files...`)
    const cleanupResult = await cleanupChunkFiles(session)
    console.log(
      `[QSensor Mirror] Cleanup result: deleted ${cleanupResult.deleted} chunks, ${cleanupResult.errors} errors`
    )

    if (cleanupResult.errors > 0) {
      console.warn(`[QSensor Mirror] ⚠ Some chunk files could not be deleted (${cleanupResult.errors} errors)`)
      // NOTE: Non-fatal - session.csv is verified and available
    }

    // * Write final metadata
    await writeMirrorMetadata(session)

    if (session.sessionRoot) {
      // sessionCsvPath already declared above at line 937
      const relativeCsv = path.relative(session.sessionRoot, sessionCsvPath)

      console.log(
        `[QSensor Mirror] Updating sync_metadata.json for ${session.sensorId}: sessionCsv=${relativeCsv}, bytesMirrored=${session.bytesMirrored}`
      )

      await updateSensorMetadata(session.sessionRoot, session.sensorId, {
        stoppedAt: new Date().toISOString(),
        sessionCsv: relativeCsv,
        bytesMirrored: session.bytesMirrored,
      })

      console.log(`[QSensor Mirror] sync_metadata.json updated successfully for ${session.sensorId}`)

      // * Check if both sensors are complete and trigger fusion
      await attemptFusion(session.sessionRoot)
    }

    activeSessions.delete(sessionId)

    console.log(`[QSensor Mirror] Stopped session ${sessionId}`)

    return { success: true }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Stop failed for ${session.apiBaseUrl} (session ${sessionId}):`, error)
    return { success: false, error: error.message }
  }
}

// * Get session statistics.
/**
 *
 * @param sessionId
 */
export function getSessionStats(sessionId: string): {
  /**
eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee *
eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  stats?: any
  /**
sssssssssssss *
sssssssssssss
   */
  error?: string
} {
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

// * Setup IPC handlers for Q-Sensor mirroring.
/**
 *
 */
export function setupQSensorMirrorService(): void {
  ipcMain.handle(
    'qsensor:start-mirror',
    async (
      _event,
      sessionId,
      apiBaseUrl,
      missionName,
      cadenceSec,
      fullBandwidth,
      unifiedSessionTimestamp?,
      syncId?,
      sensorId?: 'inWater' | 'surface'
    ) => {
      console.log(
        `[QSensor Mirror] IPC start request: session=${sessionId}, sensorId=${sensorId ?? 'inWater'}, apiBaseUrl=${apiBaseUrl}, cadence=${
          fullBandwidth ? 2 : cadenceSec
        }s, fullBandwidth=${fullBandwidth}, unifiedTimestamp=${unifiedSessionTimestamp}, syncId=${syncId ?? 'auto'}`
      )
      return await startMirrorSession(
        sessionId,
        apiBaseUrl,
        missionName,
        cadenceSec,
        fullBandwidth,
        unifiedSessionTimestamp,
        syncId,
        sensorId
      )
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
