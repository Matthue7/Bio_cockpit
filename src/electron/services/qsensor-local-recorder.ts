// * Q-Series Local Recorder (TypeScript)
// * Implements the local recording and integrity layer for the Q-Series surface reference sensor.
// * Consumes readings from the serial controller and writes chunked CSV files with manifest tracking.
// * ARCHITECTURE:
// * - Event-driven reading consumption from QSeriesSerialController
// * - Buffered chunk writing (periodic flush every 200ms)
// * - Atomic file operations (.tmp → rename pattern)
// * - SHA256 checksum calculation per chunk
// * - Manifest.json generation and incremental updates
// * - Session finalization (combine chunks → session.csv)
// * REFERENCE:
// * - Mirrors Python ChunkWriter behavior from q_sensor_lib
// * - Follows patterns from qsensor-mirror.ts (Pi-side recorder)
// * - Integrates with Phase 2 QSeriesSerialController
// * CSV SCHEMA:
// * timestamp,sensor_id,mode,value,TempC,Vin
// * 2025-11-18T12:00:01.123456+00:00,SN12345,freerun,123.456789,21.34,12.345

import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'

import { areBothSensorsComplete, fuseSessionData, isFusionComplete } from './qsensor-fusion'
import { QSeriesReading } from './qsensor-protocol'
import {
  buildSensorDirectoryName,
  buildUnifiedSessionRoot,
  ensureSyncMetadata,
  readSyncMetadata,
  updateFusionStatus,
  updateSensorMetadata,
} from './qsensor-session-utils'

// ============================================================================
// Type Definitions
// ============================================================================

// * Chunk metadata stored in manifest
/**
 *
 */
export interface ChunkMetadata {
  /**
   *
   */
  index: number
  /**
   *
   */
  name: string
  /**
   *
   */
  rows: number
  /**
   *
   */
  sha256: string
  /**
   *
   */
  size_bytes: number
  /**
   *
   */
  timestamp: string
}

// * Manifest structure for recording session
/**
 *
 */
export interface RecordingManifest {
  /**
   *
   */
  session_id: string
  /**
   *
   */
  sensor_id: string
  /**
   *
   */
  mission: string
  /**
   *
   */
  started_at: string
  /**
   *
   */
  stopped_at?: string
  /**
   *
   */
  next_chunk_index: number
  /**
   *
   */
  total_rows: number
  /**
   *
   */
  total_bytes: number
  /**
   *
   */
  schema_version: number
  /**
   *
   */
  chunks: ChunkMetadata[]
  // NOTE: Session integrity
  /**
   *
   */
  session_sha256?: string
}

// * Recording session state
/**
 *
 */
interface LocalRecordingSession {
  /**
   *
   */
  session_id: string
  /**
   *
   */
  sensorId: string
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
  started_at: string
  /**
   *
   */
  readingBuffer: QSeriesReading[]
  /**
   *
   */
  currentChunkIndex: number
  /**
   *
   */
  currentChunkStartTime: number
  /**
   *
   */
  totalRowsFlushed: number
  /**
   *
   */
  flushIntervalId: NodeJS.Timeout | null
  /**
   *
   */
  rollIntervalS: number
  /**
   *
   */
  lastChunkRollTime: number
  /**
   *
   */
  syncId: string // UUID for sync marker pairing
}

// * Parameters for starting a recording session
/**
 *
 */
export interface StartRecordingParams {
  /**
   *
   */
  sensorId: string
  /**
   *
   */
  mission: string
  /**
   *
   */
  rollIntervalS?: number
  /**
   *
   */
  storagePath?: string
  // NOTE: Unified session timestamp for shared directory structure (Phase 4)
  /**
   *
   */
  unifiedSessionTimestamp?: string
  // Optional externally-coordinated syncId for paired sensors
  /**
   *
   */
  syncId?: string
}

// * Recording statistics
/**
 *
 */
export interface RecordingStats {
  /**
   *
   */
  sessionId: string
  /**
   *
   */
  totalRows: number
  /**
   *
   */
  currentChunkIndex: number
  /**
   *
   */
  bufferedRows: number
  /**
   *
   */
  bytesFlushed: number
  /**
   *
   */
  started_at: string
}

// ============================================================================
// Constants
// ============================================================================

const FLUSH_INTERVAL_MS = 200 // Matches Python ChunkWriter
const DEFAULT_ROLL_INTERVAL_S = 60 // 60 seconds per chunk
const MAX_BUFFER_SIZE = 10000 // Maximum readings in memory
const CSV_HEADER = 'timestamp,sensor_id,mode,value,TempC,Vin'
const MANIFEST_SCHEMA_VERSION = 1
const CHUNK_NAME_PATTERN = /^chunk_(\d{5})\.csv$/

// ============================================================================
// Helper Functions
// ============================================================================

// * Format chunk filename with zero-padded index
/**
 *
 * @param index
 */
function formatChunkName(index: number): string {
  return `chunk_${index.toString().padStart(5, '0')}.csv`
}

// * Convert QSeriesReading to CSV row
/**
 *
 * @param reading
 */
function readingToCSVRow(reading: QSeriesReading): string {
  return [
    reading.timestamp_utc,
    reading.sensor_id,
    reading.mode,
    reading.value.toString(),
    reading.TempC?.toString() ?? '',
    reading.Vin?.toString() ?? '',
  ].join(',')
}

// * Calculate SHA256 checksum of a file
/**
 *
 * @param filePath
 */
async function computeSHA256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// * Get file size in bytes
/**
 *
 * @param filePath
 */
async function getFileSize(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath)
  return stats.size
}

// * Atomic file write using .tmp + rename pattern
/**
 *
 * @param targetPath
 * @param content
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmpPath = targetPath + '.tmp'
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, targetPath)
}

// * Create a sync marker reading for timestamp alignment
/**
 *
 * @param sensorId
 * @param syncId
 * @param markerType
 */
function createSyncMarkerReading(sensorId: string, syncId: string, markerType: 'START' | 'STOP'): QSeriesReading {
  return {
    timestamp_utc: new Date().toISOString(),
    timestamp_monotonic_ns: BigInt(Math.floor(performance.now() * 1e6)),
    sensor_id: sensorId,
    mode: `SYNC_${markerType}` as any, // Special mode for sync markers
    value: parseInt(syncId.slice(0, 8), 16) || 0, // Use first 8 chars of syncId as numeric
    TempC: 0,
    Vin: 0,
  }
}

// ============================================================================
// QSeriesLocalRecorder Class
// ============================================================================

// * Local recorder for Q-Series surface sensor data.
// * Manages recording sessions, chunk writing, manifest tracking, and session finalization.
// * Mirrors Python ChunkWriter behavior while integrating with the Phase 2 serial controller.
/**
 *
 */
export class QSeriesLocalRecorder {
  private sessions = new Map<string, LocalRecordingSession>()
  private defaultStoragePath: string | null = null
  private scheduleInterval: (handler: () => void, interval: number) => NodeJS.Timeout
  private clearScheduledInterval: (handle: NodeJS.Timeout) => void = clearInterval

  /**
   *
   * @param scheduleInterval
   * @param clearIntervalFn
   */
  constructor(
    scheduleInterval: (handler: () => void, interval: number) => NodeJS.Timeout = setInterval,
    clearIntervalFn: (handle: NodeJS.Timeout) => void = clearInterval
  ) {
    this.scheduleInterval = scheduleInterval
    this.clearScheduledInterval = clearIntervalFn
  }

  // * Set default storage path for recording sessions
  /**
   *
   * @param storagePath
   */
  setDefaultStoragePath(storagePath: string): void {
    this.defaultStoragePath = storagePath
  }

  // * Start a new recording session: create directory, initialize manifest, and start periodic flush.
  /**
   *
   * @param params
   */
  async startSession(params: StartRecordingParams): Promise<{
    /**
     *
     */
    session_id: string
    /**
     *
     */
    started_at: string
    /**
     *
     */
    syncId: string
  }> {
    const sessionId = uuidv4()
    const startedAt = new Date().toISOString()
    const rollIntervalS = params.rollIntervalS ?? DEFAULT_ROLL_INTERVAL_S
    const syncId = params.syncId ?? uuidv4()

    // Resolve storage path
    const storagePath = params.storagePath ?? this.defaultStoragePath
    if (!storagePath) {
      throw new Error('Storage path not configured. Set via setDefaultStoragePath() or pass in params.')
    }

    // Create session directory with unified layout if timestamp provided (Phase 4+)
    // Structure: {storage}/{mission}/session_{timestamp}/surface_{sessionId}/
    // Otherwise fall back to legacy: {storage}/{mission}/surface_{sessionId}/
    let rootPath: string
    let sessionRoot: string | undefined
    if (params.unifiedSessionTimestamp) {
      sessionRoot = buildUnifiedSessionRoot(storagePath, params.mission, params.unifiedSessionTimestamp)
      const directoryName = buildSensorDirectoryName('surface', sessionId)
      rootPath = path.join(sessionRoot, directoryName)
      await ensureSyncMetadata(sessionRoot, params.mission, params.unifiedSessionTimestamp)
      await updateSensorMetadata(sessionRoot, 'surface', {
        sessionId,
        directory: directoryName,
        startedAt: startedAt,
      })
    } else {
      rootPath = path.join(storagePath, params.mission, `surface_${sessionId}`)
    }
    await fs.mkdir(rootPath, { recursive: true })

    console.log(`[QSeriesLocalRecorder] Session started: ${sessionId}`)
    console.log(`[QSeriesLocalRecorder] Directory: ${rootPath}`)

    // Initialize manifest
    const manifest: RecordingManifest = {
      session_id: sessionId,
      sensor_id: params.sensorId,
      mission: params.mission,
      started_at: startedAt,
      next_chunk_index: 0,
      total_rows: 0,
      total_bytes: 0,
      schema_version: MANIFEST_SCHEMA_VERSION,
      chunks: [],
    }

    await this.writeManifest(rootPath, manifest)

    // Create session state
    const session: LocalRecordingSession = {
      session_id: sessionId,
      sensorId: params.sensorId,
      rootPath,
      sessionRoot,
      started_at: startedAt,
      readingBuffer: [],
      currentChunkIndex: 0,
      currentChunkStartTime: Date.now(),
      totalRowsFlushed: 0,
      rollIntervalS,
      lastChunkRollTime: Date.now(),
      flushIntervalId: null,
      syncId,
    }

    // Inject START sync marker as first reading
    const startMarker = createSyncMarkerReading(params.sensorId, syncId, 'START')
    session.readingBuffer.push(startMarker)
    console.log(`[QSeriesLocalRecorder] Injected SYNC_START marker (syncId: ${syncId.slice(0, 8)}...)`)

    // Start periodic flush interval
    session.flushIntervalId = this.scheduleInterval(() => {
      this.flushChunk(sessionId).catch((error) => {
        console.error(`[QSeriesLocalRecorder] Flush error for session ${sessionId}:`, error)
      })
    }, FLUSH_INTERVAL_MS)

    this.sessions.set(sessionId, session)

    return { session_id: sessionId, started_at: startedAt, syncId }
  }

  // * Add a reading to the session buffer; flushed periodically or on overflow.
  /**
   *
   * @param sessionId
   * @param reading
   */
  addReading(sessionId: string, reading: QSeriesReading): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      console.warn(`[QSeriesLocalRecorder] Session not found: ${sessionId}`)
      return
    }

    session.readingBuffer.push(reading)

    // NOTE: Buffer overflow protection
    if (session.readingBuffer.length > MAX_BUFFER_SIZE) {
      console.warn(
        `[QSeriesLocalRecorder] Buffer overflow (${session.readingBuffer.length} > ${MAX_BUFFER_SIZE}). Forcing flush.`
      )
      this.flushChunk(sessionId).catch((error) => {
        console.error(`[QSeriesLocalRecorder] Emergency flush error:`, error)
      })
    }
  }

  // * Stop recording session and finalize: stop flushing, finalize chunk, combine CSV, verify, and clean up.
  /**
   *
   * @param sessionId
   */
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    console.log(`[QSeriesLocalRecorder] Stopping session: ${sessionId}`)

    // Stop flush interval
    if (session.flushIntervalId) {
      this.clearScheduledInterval(session.flushIntervalId)
      session.flushIntervalId = null
    }

    // Inject STOP sync marker as last reading before final flush
    const stopMarker = createSyncMarkerReading(session.sensorId, session.syncId, 'STOP')
    session.readingBuffer.push(stopMarker)
    console.log(`[QSeriesLocalRecorder] Injected SYNC_STOP marker (syncId: ${session.syncId.slice(0, 8)}...)`)

    // Final flush (any remaining buffered data)
    await this.flushChunk(sessionId)

    // Finalize the current chunk (rename .tmp, calculate SHA256, update manifest)
    await this.finalizeCurrentChunk(session)

    // Update manifest with stopped_at timestamp
    const manifest = await this.readManifest(session.rootPath)
    manifest.stopped_at = new Date().toISOString()
    await this.writeManifest(session.rootPath, manifest)

    // Combine chunks into session.csv
    await this.combineChunksIntoSessionFile(session)

    // Calculate session.csv checksum and update manifest
    const sessionCsvPath = path.join(session.rootPath, 'session.csv')
    const sessionSha256 = await computeSHA256(sessionCsvPath)
    const finalManifest = await this.readManifest(session.rootPath)
    finalManifest.session_sha256 = sessionSha256
    await this.writeManifest(session.rootPath, finalManifest)

    if (session.sessionRoot) {
      const relativeCsv = path.relative(session.sessionRoot, sessionCsvPath)
      await updateSensorMetadata(session.sessionRoot, 'surface', {
        stoppedAt: finalManifest.stopped_at,
        sessionCsv: relativeCsv,
        bytesRecorded: finalManifest.total_bytes,
      })
    }

    // Verify session.csv integrity
    await this.verifySessionFile(session)

    // Delete chunk files (keep manifest.json and session.csv)
    await this.cleanupChunkFiles(session)

    // Attempt fusion if both sensors are complete
    if (session.sessionRoot) {
      await this.attemptFusion(session.sessionRoot)
    }

    // Remove session from active sessions
    this.sessions.delete(sessionId)

    console.log(`[QSeriesLocalRecorder] Session stopped: ${sessionId}`)
  }

  // * Get recording statistics for a session.
  /**
   *
   * @param sessionId
   */
  async getStats(sessionId: string): Promise<RecordingStats> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const manifest = await this.readManifest(session.rootPath)

    return {
      sessionId: session.session_id,
      totalRows: manifest.total_rows || session.totalRowsFlushed,
      currentChunkIndex: session.currentChunkIndex,
      bufferedRows: session.readingBuffer.length,
      bytesFlushed: manifest.chunks.reduce((sum, chunk) => sum + chunk.size_bytes, 0),
      started_at: session.started_at,
    }
  }

  // ========================================================================
  // Internal Methods: Fusion
  // ========================================================================

  // * Attempt to fuse both sensor session.csv files into unified output after stopSession completes.
  /**
   *
   * @param sessionRoot
   */
  private async attemptFusion(sessionRoot: string): Promise<void> {
    try {
      // NOTE: Prevent double-fusion
      const alreadyFused = await isFusionComplete(sessionRoot)
      if (alreadyFused) {
        console.log(`[QSeriesLocalRecorder] Fusion already complete for ${sessionRoot}`)
        return
      }

      // * Read current sync metadata
      const syncMetadata = await readSyncMetadata(sessionRoot)
      if (!syncMetadata) {
        console.warn(`[QSeriesLocalRecorder] No sync_metadata.json found in ${sessionRoot}`)
        return
      }

      // NOTE: Wait until both sensors have completed before running fusion
      if (!areBothSensorsComplete(syncMetadata)) {
        console.log(`[QSeriesLocalRecorder] Waiting for both sensors to complete before fusion`)
        return
      }

      console.log(`[QSeriesLocalRecorder] Both sensors complete, triggering fusion...`)

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
        console.log(`[QSeriesLocalRecorder] ✓ Fusion complete: ${result.totalRows} rows`)
      } else if (result.error?.includes('skipping unified fusion')) {
        // NOTE: Single sensor case - mark as skipped so surface recording can finish cleanly
        await updateFusionStatus(sessionRoot, {
          status: 'skipped',
          unifiedCsv: null,
          rowCount: null,
          inWaterRows: null,
          surfaceRows: null,
          completedAt: new Date().toISOString(),
          error: result.error,
        })
        console.log(`[QSeriesLocalRecorder] Fusion skipped: ${result.error}`)
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
        console.error(`[QSeriesLocalRecorder] ✗ Fusion failed: ${result.error}`)
      }
    } catch (error: any) {
      console.error(`[QSeriesLocalRecorder] Fusion attempt error:`, error)
      // NOTE: Try to record the failure in sync_metadata
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
        // NOTE: Ignore errors updating metadata
      }
    }
  }

  // ========================================================================
  // Internal Methods: Chunk Writing
  // ========================================================================

  // * Flush buffered readings to current chunk file, used on interval and during shutdown.
  /**
   *
   * @param sessionId
   */
  private async flushChunk(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return // Session might have been stopped
    }

    // NOTE: No-op if buffer is empty
    if (session.readingBuffer.length === 0) {
      return
    }

    const chunkName = formatChunkName(session.currentChunkIndex)
    const chunkPath = path.join(session.rootPath, chunkName)
    const chunkTmpPath = chunkPath + '.tmp'

    // NOTE: Detect new chunk to decide whether to write header
    const isNewChunk = !(await this.fileExists(chunkPath)) && !(await this.fileExists(chunkTmpPath))

    // * Build CSV content from buffer
    let csvContent = ''

    if (isNewChunk) {
      csvContent += CSV_HEADER + '\n'
    }

    for (const reading of session.readingBuffer) {
      csvContent += readingToCSVRow(reading) + '\n'
    }

    const _rowsInBuffer = session.readingBuffer.length // Reserved for future logging

    // * Append to chunk file (or create if new)
    if (isNewChunk) {
      // New chunk - write to .tmp
      await fs.writeFile(chunkTmpPath, csvContent, 'utf-8')
    } else {
      // Existing chunk - append to .tmp
      await fs.appendFile(chunkTmpPath, csvContent, 'utf-8')
    }

    // * Clear buffer
    const flushedRows = session.readingBuffer.length
    session.readingBuffer = []
    session.totalRowsFlushed += flushedRows

    console.log(
      `[QSeriesLocalRecorder] Flushed ${flushedRows} rows to ${chunkName} (total: ${session.totalRowsFlushed})`
    )

    // NOTE: Check if we should roll to next chunk (time-based)
    const now = Date.now()
    const elapsedSinceRoll = (now - session.lastChunkRollTime) / 1000 // seconds

    if (elapsedSinceRoll >= session.rollIntervalS) {
      await this.finalizeCurrentChunk(session)
      session.currentChunkIndex++
      session.lastChunkRollTime = now
      console.log(`[QSeriesLocalRecorder] Rolling to next chunk: ${session.currentChunkIndex}`)
    }
  }

  // * Finalize current chunk: rename .tmp, calculate SHA256, and update manifest.
  /**
   *
   * @param session
   */
  private async finalizeCurrentChunk(session: LocalRecordingSession): Promise<void> {
    const chunkName = formatChunkName(session.currentChunkIndex)
    const chunkPath = path.join(session.rootPath, chunkName)
    const chunkTmpPath = chunkPath + '.tmp'

    // NOTE: Only finalize when a .tmp exists
    if (await this.fileExists(chunkTmpPath)) {
      // Rename .tmp → final
      await fs.rename(chunkTmpPath, chunkPath)
    }

    // NOTE: If chunk file doesn't exist, this was an empty chunk (no-op)
    if (!(await this.fileExists(chunkPath))) {
      return
    }

    // * Calculate SHA256 and file size
    const sha256 = await computeSHA256(chunkPath)
    const sizeBytes = await getFileSize(chunkPath)

    // NOTE: Count rows (excluding header)
    const content = await fs.readFile(chunkPath, 'utf-8')
    const lines = content.split('\n').filter((line) => line.trim() !== '')
    const rows = lines.length - 1 // Exclude header

    // * Update manifest
    const manifest = await this.readManifest(session.rootPath)

    const chunkMetadata: ChunkMetadata = {
      index: session.currentChunkIndex,
      name: chunkName,
      rows,
      sha256,
      size_bytes: sizeBytes,
      timestamp: new Date().toISOString(),
    }

    manifest.chunks.push(chunkMetadata)
    manifest.next_chunk_index = session.currentChunkIndex + 1
    manifest.total_rows += rows
    manifest.total_bytes += sizeBytes

    await this.writeManifest(session.rootPath, manifest)

    console.log(
      `[QSeriesLocalRecorder] Finalized ${chunkName}: ${rows} rows, ${sizeBytes} bytes, SHA256: ${sha256.slice(
        0,
        16
      )}...`
    )
  }

  // ========================================================================
  // Internal Methods: Session Finalization
  // ========================================================================

  // * Combine all chunk files into session.csv using atomic write pattern.
  // * Writes a single header, then appends all data rows in order.
  /**
   *
   * @param session
   */
  private async combineChunksIntoSessionFile(session: LocalRecordingSession): Promise<void> {
    const sessionCsvPath = path.join(session.rootPath, 'session.csv')
    const sessionCsvTmpPath = sessionCsvPath + '.tmp'

    console.log(`[QSeriesLocalRecorder] Combining chunks into session.csv...`)

    // * Get all chunk files sorted by index
    const files = await fs.readdir(session.rootPath)
    const chunkFiles = files.filter((name) => CHUNK_NAME_PATTERN.test(name)).sort() // Lexicographic sort works due to zero-padding

    if (chunkFiles.length === 0) {
      console.warn(`[QSeriesLocalRecorder] No chunks found for session ${session.session_id}`)
      // NOTE: Create empty session.csv with just header
      await atomicWrite(sessionCsvPath, CSV_HEADER + '\n')
      return
    }

    let headerWritten = false
    let totalRowsWritten = 0

    for (const chunkFile of chunkFiles) {
      const chunkPath = path.join(session.rootPath, chunkFile)
      const content = await fs.readFile(chunkPath, 'utf-8')
      const lines = content.split('\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line === '') continue

        // NOTE: First line of first chunk is header
        if (!headerWritten && i === 0) {
          await fs.appendFile(sessionCsvTmpPath, line + '\n', 'utf-8')
          headerWritten = true
          continue
        }

        // NOTE: Skip header lines in subsequent chunks
        if (i === 0) continue

        // * Append data row
        await fs.appendFile(sessionCsvTmpPath, line + '\n', 'utf-8')
        totalRowsWritten++
      }
    }

    // * Atomic rename
    await fs.rename(sessionCsvTmpPath, sessionCsvPath)

    console.log(`[QSeriesLocalRecorder] session.csv created: ${totalRowsWritten} rows`)
  }

  // * Verify session.csv integrity by comparing against manifest row counts.
  /**
   *
   * @param session
   */
  private async verifySessionFile(session: LocalRecordingSession): Promise<void> {
    const sessionCsvPath = path.join(session.rootPath, 'session.csv')
    const manifest = await this.readManifest(session.rootPath)

    const content = await fs.readFile(sessionCsvPath, 'utf-8')
    const lines = content.split('\n').filter((line) => line.trim() !== '')
    const dataRows = lines.length - 1 // Exclude header

    if (dataRows !== manifest.total_rows) {
      console.warn(
        `[QSeriesLocalRecorder] Row count mismatch: session.csv has ${dataRows} rows, manifest reports ${manifest.total_rows}`
      )
    } else {
      console.log(`[QSeriesLocalRecorder] session.csv verified: ${dataRows} rows match manifest`)
    }
  }

  // * Delete chunk files after successful session.csv creation while preserving manifest.json and session.csv.
  /**
   *
   * @param session
   */
  private async cleanupChunkFiles(session: LocalRecordingSession): Promise<void> {
    const files = await fs.readdir(session.rootPath)
    const chunkFiles = files.filter((name) => CHUNK_NAME_PATTERN.test(name))

    for (const chunkFile of chunkFiles) {
      const chunkPath = path.join(session.rootPath, chunkFile)
      await fs.unlink(chunkPath)
      console.log(`[QSeriesLocalRecorder] Deleted chunk file: ${chunkFile}`)
    }

    console.log(`[QSeriesLocalRecorder] Cleanup complete: ${chunkFiles.length} chunk files deleted`)
  }

  // ========================================================================
  // Internal Methods: Manifest I/O
  // ========================================================================

  // * Read manifest.json from session directory.
  /**
   *
   * @param rootPath
   */
  private async readManifest(rootPath: string): Promise<RecordingManifest> {
    const manifestPath = path.join(rootPath, 'manifest.json')
    const content = await fs.readFile(manifestPath, 'utf-8')
    return JSON.parse(content)
  }

  // * Write manifest.json to session directory (atomic).
  /**
   *
   * @param rootPath
   * @param manifest
   */
  private async writeManifest(rootPath: string, manifest: RecordingManifest): Promise<void> {
    const manifestPath = path.join(rootPath, 'manifest.json')
    const content = JSON.stringify(manifest, null, 2)
    await atomicWrite(manifestPath, content)
  }

  // * Check if file exists.
  /**
   *
   * @param filePath
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }
}
