/**
 * Unit tests for Q-Sensor Pinia Store
 *
 * These tests verify the dual-sensor store operations including:
 * - startBoth/stopBoth transactional behavior
 * - Backend routing (HTTP vs Serial)
 * - Error handling and rollback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useQSensorStore } from '../src/stores/qsensor'

// ============================================================================
// Mock Setup
// ============================================================================

// Mock electronAPI for IPC calls
const mockElectronAPI = {
  // HTTP (in-water) operations
  qsensorConnect: vi.fn(),
  qsensorStartAcquisition: vi.fn(),
  qsensorStartRecording: vi.fn(),
  qsensorStopRecording: vi.fn(),
  qsensorStopAcquisition: vi.fn(),
  startQSensorMirror: vi.fn(),
  stopQSensorMirror: vi.fn(),
  getQSensorStats: vi.fn(),

  // Serial (surface) operations
  qsensorSerialConnect: vi.fn(),
  qsensorSerialStartRecording: vi.fn(),
  qsensorSerialStopRecording: vi.fn(),
  qsensorSerialGetStats: vi.fn(),

  // Shared operations
  getQSensorStoragePath: vi.fn(),
}

// Install mock on window
declare global {
  interface Window {
    electronAPI: typeof mockElectronAPI
  }
}

// ============================================================================
// Test Utilities
// ============================================================================

function setupAllMocks() {
  // Shared mocks
  mockElectronAPI.getQSensorStoragePath.mockResolvedValue('/tmp/qsensor-test')

  // Setup HTTP (in-water) mocks
  mockElectronAPI.qsensorStartAcquisition.mockResolvedValue({ success: true })
  mockElectronAPI.qsensorStartRecording.mockResolvedValue({
    success: true,
    data: { session_id: 'http-session-123' },
  })
  mockElectronAPI.startQSensorMirror.mockResolvedValue({
    success: true,
    sessionId: 'http-session-123',
    data: { sessionRoot: '/tmp/qsensor-test/test-mission/session_2025-01-01T00-00-00Z' },
  })
  mockElectronAPI.stopQSensorMirror.mockResolvedValue({ success: true })
  mockElectronAPI.qsensorStopRecording.mockResolvedValue({
    success: true,
    data: { bytes_flushed: 1024 },
  })
  mockElectronAPI.qsensorStopAcquisition.mockResolvedValue({ success: true })
  mockElectronAPI.getQSensorStats.mockResolvedValue({
    success: true,
    stats: { bytesMirrored: 1024, lastSync: new Date().toISOString() },
  })

  // Setup Serial (surface) mocks
  mockElectronAPI.qsensorSerialStartRecording.mockResolvedValue({
    success: true,
    data: {
      session_id: 'serial-session-456',
      started_at: new Date().toISOString(),
    },
  })
  mockElectronAPI.qsensorSerialStopRecording.mockResolvedValue({
    success: true,
    data: {
      session_id: 'serial-session-456',
      bytes_flushed: 2048,
      total_rows: 100,
    },
  })
  mockElectronAPI.qsensorSerialGetStats.mockResolvedValue({
    success: true,
    data: {
      recording: true,
      bytesFlushed: 2048,
      totalRows: 100,
    },
  })
}


// ============================================================================
// Tests
// ============================================================================

describe('QSensor Store', () => {
  let store: ReturnType<typeof useQSensorStore>

  beforeEach(() => {
    // Reset all mocks
    vi.resetAllMocks()

    // Setup Pinia
    setActivePinia(createPinia())

    // Install mock electronAPI
    window.electronAPI = mockElectronAPI as any

    // Get store instance
    store = useQSensorStore()

    // Mark sensors as connected (required for recording operations)
    store.inWaterSensor.isConnected = true
    store.inWaterSensor.apiBaseUrl = 'http://localhost:9150'
    store.surfaceSensor.isConnected = true
    store.surfaceSensor.serialPort = '/dev/ttyUSB1'
    store.surfaceSensor.baudRate = 9600
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('startBoth', () => {
    it('should set unifiedSessionId only after both sensors start successfully', async () => {
      setupAllMocks()

      const result = await store.startBoth({
        mission: 'test-mission',
        rateHz: 500,
        rollIntervalS: 60,
      })

      expect(result.success).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(store.unifiedSessionId).toBeDefined()
      expect(store.unifiedSessionId).toMatch(/^unified-\d+$/)
      expect(store.unifiedSessionPath).toBe('/tmp/qsensor-test/test-mission/session_2025-01-01T00-00-00Z')
      expect(store.inWaterSensor.recordingState).toBe('recording')
      expect(store.surfaceSensor.recordingState).toBe('recording')
    })

    it('should not set unifiedSessionId if first sensor (in-water) fails', async () => {
      setupAllMocks()
      // Make in-water fail
      mockElectronAPI.qsensorStartAcquisition.mockResolvedValue({
        success: false,
        error: 'HTTP connection failed',
      })

      const result = await store.startBoth({
        mission: 'test-mission',
      })

      expect(result.success).toBe(false)
      expect(result.errors).toContain('In-water: HTTP connection failed')
      expect(store.unifiedSessionId).toBeNull()
      expect(store.unifiedSessionPath).toBeNull()

      // Surface should not have been called
      expect(mockElectronAPI.qsensorSerialStartRecording).not.toHaveBeenCalled()
    })

    it('should rollback in-water sensor if surface sensor fails', async () => {
      setupAllMocks()
      // Make serial fail
      mockElectronAPI.qsensorSerialStartRecording.mockResolvedValue({
        success: false,
        error: 'Serial port not connected',
      })

      const result = await store.startBoth({
        mission: 'test-mission',
      })

      expect(result.success).toBe(false)
      expect(result.errors).toContain('Surface: Serial port not connected')
      expect(store.unifiedSessionId).toBeNull()

      // Verify rollback was called
      expect(mockElectronAPI.stopQSensorMirror).toHaveBeenCalled()
      expect(mockElectronAPI.qsensorStopRecording).toHaveBeenCalled()
    })

    it('should include rollback errors in result', async () => {
      setupAllMocks()
      // Make serial fail
      mockElectronAPI.qsensorSerialStartRecording.mockResolvedValue({
        success: false,
        error: 'Serial port not connected',
      })
      // Make rollback fail too
      mockElectronAPI.stopQSensorMirror.mockResolvedValue({
        success: false,
        error: 'Mirror already stopped',
      })

      const result = await store.startBoth({
        mission: 'test-mission',
      })

      expect(result.success).toBe(false)
      expect(result.errors).toContain('Surface: Serial port not connected')
      // Rollback errors may be logged but won't prevent the main failure
      expect(store.unifiedSessionId).toBeNull()
      expect(store.unifiedSessionPath).toBeNull()
    })

    it('should pass correct parameters to both backends', async () => {
      setupAllMocks()

      await store.startBoth({
        mission: 'dive-mission',
        rateHz: 100,
        rollIntervalS: 120,
      })

      // Check HTTP parameters (uses snake_case)
      expect(mockElectronAPI.qsensorStartRecording).toHaveBeenCalledWith(
        'http://localhost:9150',
        expect.objectContaining({
          mission: 'dive-mission',
          roll_interval_s: 120,
        })
      )

      // Check Serial parameters
      expect(mockElectronAPI.qsensorSerialStartRecording).toHaveBeenCalledWith(
        expect.objectContaining({
          mission: 'dive-mission',
          rateHz: 100,
          rollIntervalS: 120,
        })
      )
    })

    it('should pass unifiedSessionTimestamp to both backends', async () => {
      setupAllMocks()

      await store.startBoth({
        mission: 'unified-test',
        rateHz: 500,
      })

      // Both backends should receive the same unifiedSessionTimestamp
      const mirrorCall = mockElectronAPI.startQSensorMirror.mock.calls[0]
      const serialCall = mockElectronAPI.qsensorSerialStartRecording.mock.calls[0]

      // Mirror call: (sessionId, vehicleAddress, missionName, cadenceSec, fullBandwidth, unifiedSessionTimestamp)
      const mirrorTimestamp = mirrorCall[5]
      expect(mirrorTimestamp).toBeDefined()
      expect(mirrorTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)

      // Serial call: params object with unifiedSessionTimestamp
      const serialTimestamp = serialCall[0].unifiedSessionTimestamp
      expect(serialTimestamp).toBeDefined()
      expect(serialTimestamp).toBe(mirrorTimestamp)
    })

    it('should recover unified session state after a failed start attempt', async () => {
      setupAllMocks()
      mockElectronAPI.qsensorSerialStartRecording.mockResolvedValueOnce({
        success: false,
        error: 'Serial port denied',
      })

      const failed = await store.startBoth({
        mission: 'retry-mission',
      })

      expect(failed.success).toBe(false)
      expect(store.unifiedSessionId).toBeNull()
      expect(store.unifiedSessionPath).toBeNull()

      // Next call should succeed with the default mock response
      const succeeded = await store.startBoth({
        mission: 'retry-mission',
      })

      expect(succeeded.success).toBe(true)
      expect(store.unifiedSessionId).not.toBeNull()
      expect(store.unifiedSessionPath).not.toBeNull()
      expect(store.unifiedSessionPath).toMatch(/\/tmp\/qsensor-test\/.*\/session_/)
    })
  })

  describe('stopBoth', () => {
    beforeEach(async () => {
      // Setup initial recording state
      setupAllMocks()
      await store.startBoth({ mission: 'test-mission' })
      // Reset call counts so we can verify stop calls
      vi.clearAllMocks()
      // Re-setup mocks for stop operations
      setupAllMocks()
    })

    it('should clear unifiedSessionId on successful stop', async () => {
      const result = await store.stopBoth()

      expect(result.success).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(store.unifiedSessionId).toBeNull()
      expect(store.unifiedSessionPath).toBeNull()
      expect(store.inWaterSensor.recordingState).toBe('stopped')
      expect(store.surfaceSensor.recordingState).toBe('stopped')
    })

    it('should clear unifiedSessionId even on partial failure', async () => {
      // Make serial stop fail
      mockElectronAPI.qsensorSerialStopRecording.mockResolvedValue({
        success: false,
        error: 'Serial port disconnected',
      })

      const result = await store.stopBoth()

      expect(result.success).toBe(false)
      expect(result.errors).toContain('Surface: Serial port disconnected')
      // unifiedSessionId should still be cleared
      expect(store.unifiedSessionId).toBeNull()
      expect(store.unifiedSessionPath).toBeNull()
    })

    it('should attempt to stop both sensors even if first fails', async () => {
      // Make HTTP stop fail
      mockElectronAPI.qsensorStopRecording.mockResolvedValue({
        success: false,
        error: 'HTTP timeout',
      })

      const result = await store.stopBoth()

      expect(result.success).toBe(false)
      // Both stop operations should have been attempted
      expect(mockElectronAPI.qsensorStopRecording).toHaveBeenCalled()
      expect(mockElectronAPI.qsensorSerialStopRecording).toHaveBeenCalled()
      expect(store.unifiedSessionId).toBeNull()
    })

    it('should update bytesMirrored from result data', async () => {
      await store.stopBoth()

      // HTTP sensor should have its stats from stopRecording result
      expect(store.inWaterSensor.recordingState).toBe('stopped')

      // Serial sensor should have its stats from stopRecording result
      expect(store.surfaceSensor.recordingState).toBe('stopped')
      expect(store.surfaceSensor.bytesMirrored).toBe(2048)
    })

    it('should clear currentSession after successful stop', async () => {
      await store.stopBoth()

      expect(store.inWaterSensor.currentSession).toBeNull()
      expect(store.surfaceSensor.currentSession).toBeNull()
    })

    it('should clear unified state even if sensors were already stopped', async () => {
      // Simulate surface sensor already stopped
      store.surfaceSensor.currentSession = null
      const result = await store.stopBoth()

      expect(result.success).toBe(false)
      expect(store.unifiedSessionId).toBeNull()
      expect(store.unifiedSessionPath).toBeNull()
    })
  })

  describe('reset', () => {
    it('should reset both sensors and clear unifiedSessionId', async () => {
      // Setup recording state first
      setupAllMocks()
      await store.startBoth({ mission: 'test-mission' })
      vi.clearAllMocks()
      setupAllMocks()
      await store.stopBoth()

      // Add some state to reset
      store.inWaterSensor.bytesMirrored = 5000
      store.inWaterSensor.lastError = 'Previous error'
      store.surfaceSensor.bytesMirrored = 3000
      store.surfaceSensor.lastError = 'Another error'

      store.reset()

      expect(store.inWaterSensor.bytesMirrored).toBe(0)
      expect(store.inWaterSensor.lastError).toBeNull()
      expect(store.inWaterSensor.recordingState).toBe('idle')
      expect(store.surfaceSensor.bytesMirrored).toBe(0)
      expect(store.surfaceSensor.lastError).toBeNull()
      expect(store.surfaceSensor.recordingState).toBe('idle')
      expect(store.unifiedSessionId).toBeNull()
    })
  })

  describe('computed getters', () => {
    it('areBothConnected should return true only when both are connected', () => {
      store.inWaterSensor.isConnected = true
      store.surfaceSensor.isConnected = true
      expect(store.areBothConnected).toBe(true)

      store.surfaceSensor.isConnected = false
      expect(store.areBothConnected).toBe(false)
    })

    it('areBothRecording should return true only when both are recording', async () => {
      setupAllMocks()

      await store.startBoth({ mission: 'test' })
      expect(store.areBothRecording).toBe(true)

      // Stop one
      store.surfaceSensor.recordingState = 'stopped'
      expect(store.areBothRecording).toBe(false)
    })

    it('isAnyRecording should return true when at least one is recording', async () => {
      setupAllMocks()

      await store.startBoth({ mission: 'test' })
      expect(store.isAnyRecording).toBe(true)

      // Stop one
      store.surfaceSensor.recordingState = 'stopped'
      expect(store.isAnyRecording).toBe(true)

      // Stop both
      store.inWaterSensor.recordingState = 'stopped'
      expect(store.isAnyRecording).toBe(false)
    })

    it('totalBytesMirrored should sum both sensors', () => {
      store.inWaterSensor.bytesMirrored = 1000
      store.surfaceSensor.bytesMirrored = 2000
      expect(store.totalBytesMirrored).toBe(3000)
    })

    it('combinedErrors should aggregate errors from both sensors with prefixes', () => {
      store.inWaterSensor.lastError = 'HTTP error'
      store.surfaceSensor.lastError = 'Serial error'

      const errors = store.combinedErrors
      expect(errors).toHaveLength(2)
      // Errors include sensor prefixes
      expect(errors).toContain('In-water: HTTP error')
      expect(errors).toContain('Surface: Serial error')
    })
  })
})
