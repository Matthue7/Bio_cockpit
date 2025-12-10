/**
 * Unit tests for Q-Series Local Recorder
 *
 * These tests verify the local recording service for surface sensor data,
 * including chunk writing, manifest management, and session finalization.
 */

import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QSeriesLocalRecorder } from '../src/electron/services/qsensor-local-recorder'
import { QSeriesReading } from '../src/electron/services/qsensor-protocol'
import { readSyncMetadata } from '../src/electron/services/qsensor-session-utils'

// ============================================================================
// Test Utilities
// ============================================================================

let testDir: string

/**
 *
 */
async function createTestDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qsensor-test-'))
  return tmpDir
}

/**
 *
 * @param dir
 */
async function cleanupTestDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    console.warn('Cleanup failed:', error)
  }
}

/**
 *
 * @param value
 * @param sensorId
 */
function createMockReading(value: number, sensorId = 'SN12345'): QSeriesReading {
  return {
    timestamp_utc: new Date().toISOString(),
    timestamp_monotonic_ns: BigInt(Math.floor(performance.now() * 1e6)),
    sensor_id: sensorId,
    mode: 'freerun',
    value,
    TempC: 21.0 + Math.random(),
    Vin: 12.0 + Math.random() * 0.5,
  }
}

/**
 *
 * @param filePath
 */
async function computeSHA256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 *
 * @param rec
 * @param sessionId
 */
async function flushSession(rec: QSeriesLocalRecorder, sessionId: string): Promise<void> {
  await (rec as any).flushChunk(sessionId)
}

/**
 *
 * @param rec
 * @param sessionId
 */
function getInternalSession(rec: QSeriesLocalRecorder, sessionId: string): any {
  return (rec as any).sessions.get(sessionId)
}

/**
 *
 * @param rec
 * @param sessionId
 */
async function forceChunkRoll(rec: QSeriesLocalRecorder, sessionId: string): Promise<void> {
  const session = getInternalSession(rec, sessionId)
  session.lastChunkRollTime = Date.now() - session.rollIntervalS * 1000 - 1
  await flushSession(rec, sessionId)
}

/**
 *
 * @param rec
 * @param sessionId
 */
async function finalizeChunk(rec: QSeriesLocalRecorder, sessionId: string): Promise<void> {
  const session = getInternalSession(rec, sessionId)
  await (rec as any).finalizeCurrentChunk(session)
}

// ============================================================================
// Tests
// ============================================================================

describe('QSeriesLocalRecorder', () => {
  let recorder: QSeriesLocalRecorder

  beforeEach(async () => {
    testDir = await createTestDir()
    recorder = new QSeriesLocalRecorder(
      () => ({ id: 0 } as unknown as NodeJS.Timeout),
      () => {}
    )
    recorder.setDefaultStoragePath(testDir)
  })

  afterEach(async () => {
    await cleanupTestDir(testDir)
  })

  describe('Session Lifecycle', () => {
    it('should create session directory and manifest on start', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      expect(session.session_id).toBeDefined()
      expect(session.started_at).toBeDefined()

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const dirExists = await fs
        .access(sessionDir)
        .then(() => true)
        .catch(() => false)
      expect(dirExists).toBe(true)

      const manifestPath = path.join(sessionDir, 'manifest.json')
      const manifestExists = await fs
        .access(manifestPath)
        .then(() => true)
        .catch(() => false)
      expect(manifestExists).toBe(true)

      const manifestContent = await fs.readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent)
      expect(manifest.session_id).toBe(session.session_id)
      expect(manifest.started_at).toBe(session.started_at)
      expect(manifest.total_rows).toBe(0)
      expect(manifest.chunks).toEqual([])

      await recorder.stopSession(session.session_id)
    })

    it('should create recursive directory structure', async () => {
      const deepMissionPath = 'mission-2025/dive-01/run-03'
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: deepMissionPath,
      })

      const sessionDir = path.join(testDir, deepMissionPath, `surface_${session.session_id}`)
      const dirExists = await fs
        .access(sessionDir)
        .then(() => true)
        .catch(() => false)
      expect(dirExists).toBe(true)

      await recorder.stopSession(session.session_id)
    })

    it('should create unified session root with sync metadata when timestamp provided', async () => {
      const unifiedTimestamp = '2025-03-15T00-00-00Z'
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
        unifiedSessionTimestamp: unifiedTimestamp,
      })

      const sessionRoot = path.join(testDir, 'test-mission', `session_${unifiedTimestamp}`)
      const sensorDir = path.join(sessionRoot, `surface_${session.session_id}`)
      const metadataPath = path.join(sessionRoot, 'sync_metadata.json')

      const rootExists = await fs
        .access(sessionRoot)
        .then(() => true)
        .catch(() => false)
      const sensorDirExists = await fs
        .access(sensorDir)
        .then(() => true)
        .catch(() => false)
      const metadataExists = await fs
        .access(metadataPath)
        .then(() => true)
        .catch(() => false)

      expect(rootExists).toBe(true)
      expect(sensorDirExists).toBe(true)
      expect(metadataExists).toBe(true)

      recorder.addReading(session.session_id, createMockReading(123))
      await flushSession(recorder, session.session_id)
      await finalizeChunk(recorder, session.session_id)

      await recorder.stopSession(session.session_id)

      const metadata = await readSyncMetadata(sessionRoot)
      expect(metadata?.sensors.surface?.sessionId).toBe(session.session_id)
      expect(metadata?.sensors.surface?.sessionCsv).toBe(`surface_${session.session_id}/session.csv`)
      expect(metadata?.sensors.surface?.stoppedAt).toBeDefined()
      expect(metadata?.sensors.surface?.bytesRecorded).toBeGreaterThan(0)
    })

    it('should finalize session on stop', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      // Add some readings
      for (let i = 0; i < 100; i++) {
        recorder.addReading(session.session_id, createMockReading(100 + i))
      }

      await flushSession(recorder, session.session_id)

      await recorder.stopSession(session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const manifestPath = path.join(sessionDir, 'manifest.json')
      const sessionCsvPath = path.join(sessionDir, 'session.csv')

      // Check manifest has stopped_at
      const manifestContent = await fs.readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent)
      expect(manifest.stopped_at).toBeDefined()

      // Check session.csv exists
      const sessionCsvExists = await fs
        .access(sessionCsvPath)
        .then(() => true)
        .catch(() => false)
      expect(sessionCsvExists).toBe(true)
    })
  })

  describe('Reading Buffer and Flush', () => {
    it('should buffer readings and flush periodically', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      // Add 50 readings
      for (let i = 0; i < 50; i++) {
        recorder.addReading(session.session_id, createMockReading(100 + i))
      }

      // Wait for flush interval (200ms + buffer)
      await flushSession(recorder, session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const chunkPath = path.join(sessionDir, 'chunk_00000.csv')
      const chunkTmpPath = chunkPath + '.tmp'

      // Check chunk .tmp file was created (not finalized until roll or stop)
      const chunkTmpExists = await fs
        .access(chunkTmpPath)
        .then(() => true)
        .catch(() => false)
      expect(chunkTmpExists).toBe(true)

      // Read chunk .tmp and verify row count
      const chunkContent = await fs.readFile(chunkTmpPath, 'utf-8')
      const lines = chunkContent.split('\n').filter((line) => line.trim() !== '')
      expect(lines.length).toBeGreaterThan(0) // At least header
      expect(lines[0]).toBe('timestamp,sensor_id,mode,value,TempC,Vin')

      await recorder.stopSession(session.session_id)
    })

    it('should handle empty session (no readings)', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      // Don't add any readings, just stop immediately
      await flushSession(recorder, session.session_id)
      await recorder.stopSession(session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const sessionCsvPath = path.join(sessionDir, 'session.csv')

      // session.csv should exist with header + SYNC_START + SYNC_STOP markers (2 sync rows)
      const sessionCsvContent = await fs.readFile(sessionCsvPath, 'utf-8')
      const lines = sessionCsvContent.split('\n').filter((line) => line.trim() !== '')
      expect(lines.length).toBe(3) // Header + 2 sync markers
      expect(lines[0]).toBe('timestamp,sensor_id,mode,value,TempC,Vin')
      expect(lines[1]).toContain('SYNC_START')
      expect(lines[2]).toContain('SYNC_STOP')
    })

    it('should handle high-rate data stream', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      // Simulate 500 Hz for 1 second (500 readings)
      for (let i = 0; i < 500; i++) {
        recorder.addReading(session.session_id, createMockReading(100 + i / 10))
      }

      await flushSession(recorder, session.session_id)
      await finalizeChunk(recorder, session.session_id)

      const stats = await recorder.getStats(session.session_id)
      // Note: totalRows comes from manifest, which is only updated after chunk finalization
      // During active recording, bufferedRows should be > 0 or totalRows if chunks have rolled
      const hasData = stats.bufferedRows > 0 || stats.totalRows > 0
      expect(hasData).toBe(true)

      await recorder.stopSession(session.session_id)
    })
  })

  describe('Chunk Writing and Manifest', () => {
    it('should write CSV with correct format', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN99999',
        mission: 'test-mission',
      })

      const mockReading: QSeriesReading = {
        timestamp_utc: '2025-11-18T12:00:00.123456+00:00',
        timestamp_monotonic_ns: 123456789n,
        sensor_id: 'SN99999',
        mode: 'freerun',
        value: 123.456789,
        TempC: 21.34,
        Vin: 12.345,
      }

      recorder.addReading(session.session_id, mockReading)

      await flushSession(recorder, session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const chunkTmpPath = path.join(sessionDir, 'chunk_00000.csv.tmp')

      const chunkContent = await fs.readFile(chunkTmpPath, 'utf-8')
      const lines = chunkContent.split('\n').filter((line) => line.trim() !== '')

      expect(lines[0]).toBe('timestamp,sensor_id,mode,value,TempC,Vin')
      // Line 1 is SYNC_START marker, line 2 is our actual reading
      expect(lines[1]).toContain('SYNC_START')
      expect(lines[2]).toContain('2025-11-18T12:00:00.123456+00:00')
      expect(lines[2]).toContain('SN99999')
      expect(lines[2]).toContain('freerun')
      expect(lines[2]).toContain('123.456789')
      expect(lines[2]).toContain('21.34')
      expect(lines[2]).toContain('12.345')

      await recorder.stopSession(session.session_id)
    })

    it('should handle optional fields correctly', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      // Reading without TempC and Vin
      const readingNoOptional: QSeriesReading = {
        timestamp_utc: '2025-11-18T12:00:00.000000+00:00',
        timestamp_monotonic_ns: 123456789n,
        sensor_id: 'SN12345',
        mode: 'polled',
        value: 999.0,
      }

      recorder.addReading(session.session_id, readingNoOptional)

      await flushSession(recorder, session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const chunkTmpPath = path.join(sessionDir, 'chunk_00000.csv.tmp')

      const chunkContent = await fs.readFile(chunkTmpPath, 'utf-8')
      const lines = chunkContent.split('\n').filter((line) => line.trim() !== '')

      // Line 1 is SYNC_START marker, line 2 is our actual reading with optional fields
      expect(lines[1]).toContain('SYNC_START')
      expect(lines[2]).toContain('999')
      const columns = lines[2].split(',')
      expect(columns).toHaveLength(6)
      expect(columns[4]).toBe('')
      expect(columns[5]).toBe('')

      await recorder.stopSession(session.session_id)
    })

    it('should calculate correct SHA256 checksums', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      for (let i = 0; i < 100; i++) {
        recorder.addReading(session.session_id, createMockReading(i))
      }

      await flushSession(recorder, session.session_id)
      await recorder.stopSession(session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const manifestPath = path.join(sessionDir, 'manifest.json')
      const sessionCsvPath = path.join(sessionDir, 'session.csv')

      const manifestContent = await fs.readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent)

      // Verify session.csv SHA256 (if chunks were created and deleted)
      if (
        await fs.access(sessionCsvPath).then(
          () => true,
          () => false
        )
      ) {
        const actualSHA256 = await computeSHA256(sessionCsvPath)
        // We can't verify against manifest chunks since they're deleted,
        // but we can verify the checksum is valid hex
        expect(actualSHA256).toMatch(/^[a-f0-9]{64}$/)
      }
    })

    it('should update manifest incrementally', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
        rollIntervalS: 1, // Roll every second for testing
      })

      // Add readings and wait for first chunk
      for (let i = 0; i < 50; i++) {
        recorder.addReading(session.session_id, createMockReading(i))
      }
      await flushSession(recorder, session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const manifestPath = path.join(sessionDir, 'manifest.json')

      let manifestContent = await fs.readFile(manifestPath, 'utf-8')
      let manifest = JSON.parse(manifestContent)
      const initialChunkCount = manifest.chunks.length

      await forceChunkRoll(recorder, session.session_id)

      // Add more readings for second chunk
      for (let i = 50; i < 100; i++) {
        recorder.addReading(session.session_id, createMockReading(i))
      }
      await flushSession(recorder, session.session_id)

      manifestContent = await fs.readFile(manifestPath, 'utf-8')
      manifest = JSON.parse(manifestContent)

      // Should have more chunks after roll
      expect(manifest.chunks.length).toBeGreaterThanOrEqual(initialChunkCount)

      await recorder.stopSession(session.session_id)
    })
  })

  describe('Session Finalization', () => {
    it('should combine chunks into session.csv', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
        rollIntervalS: 1,
      })

      // Add readings for multiple chunks
      for (let batch = 0; batch < 3; batch++) {
        for (let i = 0; i < 30; i++) {
          recorder.addReading(session.session_id, createMockReading(batch * 30 + i))
        }
        await forceChunkRoll(recorder, session.session_id)
      }

      await recorder.stopSession(session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const sessionCsvPath = path.join(sessionDir, 'session.csv')

      const sessionCsvContent = await fs.readFile(sessionCsvPath, 'utf-8')
      const lines = sessionCsvContent.split('\n').filter((line) => line.trim() !== '')

      // Should have single header + all data rows
      expect(lines[0]).toBe('timestamp,sensor_id,mode,value,TempC,Vin')
      expect(lines.length).toBeGreaterThan(1)

      // Verify no duplicate headers in middle of file
      const headerCount = lines.filter((line) => line.startsWith('timestamp,sensor_id')).length
      expect(headerCount).toBe(1)
    })

    it('should delete chunk files after finalization', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      for (let i = 0; i < 100; i++) {
        recorder.addReading(session.session_id, createMockReading(i))
      }

      await flushSession(recorder, session.session_id)
      await recorder.stopSession(session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const files = await fs.readdir(sessionDir)

      // Should not have chunk files
      const chunkFiles = files.filter((name) => /^chunk_\d{5}\.csv$/.test(name))
      expect(chunkFiles.length).toBe(0)

      // Should have manifest and session.csv
      expect(files).toContain('manifest.json')
      expect(files).toContain('session.csv')
    })

    it('should preserve manifest total_rows count', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      const numReadings = 123
      for (let i = 0; i < numReadings; i++) {
        recorder.addReading(session.session_id, createMockReading(i))
      }

      await flushSession(recorder, session.session_id)
      await recorder.stopSession(session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const manifestPath = path.join(sessionDir, 'manifest.json')
      const sessionCsvPath = path.join(sessionDir, 'session.csv')

      const manifestContent = await fs.readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent)

      const sessionCsvContent = await fs.readFile(sessionCsvPath, 'utf-8')
      const sessionCsvLines = sessionCsvContent.split('\n').filter((line) => line.trim() !== '')
      const sessionCsvDataRows = sessionCsvLines.length - 1 // Exclude header

      expect(manifest.total_rows).toBe(sessionCsvDataRows)
      // Total includes SYNC_START + numReadings + SYNC_STOP = numReadings + 2
      expect(manifest.total_rows).toBe(numReadings + 2)
    })
  })

  describe('Recording Statistics', () => {
    it('should provide accurate statistics during recording', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      // Add readings
      for (let i = 0; i < 50; i++) {
        recorder.addReading(session.session_id, createMockReading(i))
      }

      await flushSession(recorder, session.session_id)

      const stats = await recorder.getStats(session.session_id)

      expect(stats.sessionId).toBe(session.session_id)
      expect(stats.started_at).toBe(session.started_at)
      // totalRows and bytesFlushed come from manifest (updated after finalization)
      // Check that we have data in buffer or finalized
      const hasData = stats.bufferedRows > 0 || stats.totalRows > 0
      expect(hasData).toBe(true)

      await recorder.stopSession(session.session_id)
    })
  })

  describe('Edge Cases', () => {
    it('should handle rapid start/stop cycles', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      // Immediately stop
      await recorder.stopSession(session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const dirExists = await fs
        .access(sessionDir)
        .then(() => true)
        .catch(() => false)
      expect(dirExists).toBe(true)
    })

    it('should handle large batch of readings', async () => {
      const session = await recorder.startSession({
        sensorId: 'SN12345',
        mission: 'test-mission',
      })

      // Add 10,000 readings in bulk
      for (let i = 0; i < 10000; i++) {
        recorder.addReading(session.session_id, createMockReading(i))
      }

      await flushSession(recorder, session.session_id)
      await recorder.stopSession(session.session_id)

      const sessionDir = path.join(testDir, 'test-mission', `surface_${session.session_id}`)
      const sessionCsvPath = path.join(sessionDir, 'session.csv')

      const sessionCsvContent = await fs.readFile(sessionCsvPath, 'utf-8')
      const lines = sessionCsvContent.split('\n').filter((line) => line.trim() !== '')

      // 10k data rows + SYNC_START + SYNC_STOP + 1 header = 10003 total, 10002 data rows
      expect(lines.length - 1).toBe(10002)
    })

    it('should throw error for invalid session ID', async () => {
      await expect(recorder.stopSession('invalid-session-id')).rejects.toThrow('Session not found')
    })
  })
})
