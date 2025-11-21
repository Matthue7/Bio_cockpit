/**
 * Pinia store for Q-Sensor live recording state and settings.
 *
 * Phase 1: Refactored to support multiple sensor contexts (in-water Pi HTTP + future surface serial).
 * Currently only the in-water sensor is active; surface sensor is scaffolded for Phase 2+.
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { QSensorClient } from '@/libs/qsensor-client'
import { createInitialSensorState, isSensorArmed, isSensorRecording, resetSensorState } from '@/stores/qsensor-common'
import type { QSensorId, QSensorState } from '@/types/qsensor'

/**
 * Serial port information returned from port enumeration
 */
export interface SerialPortInfo {
  path: string
  manufacturer: string | null
  serialNumber: string | null
  vendorId: string | null
  productId: string | null
  isLikelyQSensor: boolean
}

export const useQSensorStore = defineStore('qsensor', () => {
  // Multi-sensor state map
  // NOTE: Currently only 'inWater' sensor is used; 'surface' is placeholder for Phase 2+
  const sensors = ref<Map<QSensorId, QSensorState>>(new Map())

  // Initialize in-water sensor (Pi HTTP backend) - ACTIVE
  sensors.value.set(
    'inWater',
    createInitialSensorState('inWater', 'http', {
      apiBaseUrl: 'http://blueos.local:9150',
    })
  )

  // Initialize surface sensor (topside serial backend) - ACTIVE (Phase 4)
  // NOTE: serialPort is null until user selects a port via refreshSurfaceSerialPorts/selectSurfaceSerialPort
  sensors.value.set(
    'surface',
    createInitialSensorState('surface', 'serial', {
      serialPort: null,
      baudRate: 9600,
    })
  )

  // Serial port management state (for surface sensor)
  const availableSurfacePorts = ref<SerialPortInfo[]>([])
  const selectedSurfacePortPath = ref<string | null>(null)

  // Global settings (shared across sensors where applicable)
  const cadenceSec = ref(60) // Mirroring cadence in seconds (15-300) - used by in-water HTTP backend
  const fullBandwidth = ref(false) // Fast polling mode (~2s) - used by in-water HTTP backend

  // Unified session state (Phase 5+)
  // TODO[Phase5]: Implement unified session management for both sensors
  const unifiedSessionId = ref<string | null>(null)
  const unifiedSessionPath = ref<string | null>(null)
  const globalMissionName = ref('Cockpit')

  // Fusion status (populated after dual-sensor recording stops)
  const fusionStatus = ref<{
    status: 'pending' | 'complete' | 'skipped' | 'failed' | null
    unifiedCsv: string | null
    unifiedCsvPath: string | null
    rowCount: number | null
    inWaterRows: number | null
    surfaceRows: number | null
    completedAt: string | null
    error: string | null
  } | null>(null)

  function clearUnifiedSessionState(): void {
    unifiedSessionId.value = null
    unifiedSessionPath.value = null
  }

  // ========================================
  // BACKWARD COMPATIBILITY LAYER
  // These computed properties maintain the existing API for single-sensor usage (in-water only)
  // ========================================

  const inWaterSensor = computed(() => sensors.value.get('inWater')!)

  // Legacy state accessors (map to in-water sensor)
  const apiBaseUrl = computed({
    get: () => inWaterSensor.value.apiBaseUrl || 'http://blueos.local:9150',
    set: (value: string) => {
      inWaterSensor.value.apiBaseUrl = value
    },
  })

  const currentSessionId = computed(() => inWaterSensor.value.currentSession?.sessionId || null)
  const vehicleAddress = computed(() => {
    if (!inWaterSensor.value.apiBaseUrl) return 'blueos.local'
    try {
      const url = new URL(inWaterSensor.value.apiBaseUrl)
      return url.hostname
    } catch {
      return 'blueos.local'
    }
  })
  const missionName = computed({
    get: () => inWaterSensor.value.currentSession?.mission || globalMissionName.value,
    set: (value: string) => {
      globalMissionName.value = value
    },
  })
  const isRecording = computed(() => isSensorRecording(inWaterSensor.value))
  const bytesMirrored = computed(() => inWaterSensor.value.bytesMirrored)
  const lastSync = computed(() => inWaterSensor.value.lastSync)
  const lastError = computed(() => inWaterSensor.value.lastError)
  const isArmed = computed(() => isSensorArmed(inWaterSensor.value))

  // ========================================
  // ACTIONS - Legacy API (in-water sensor only)
  // ========================================

  /**
   * Arm the store with session parameters (before starting).
   * Legacy API - operates on in-water sensor only.
   * @param sessionId
   * @param mission
   * @param vehicle
   */
  function arm(sessionId: string, mission: string, vehicle = 'blueos.local') {
    const sensor = inWaterSensor.value

    sensor.currentSession = {
      sessionId,
      mission,
      startedAt: new Date().toISOString(),
      rateHz: 500, // Default
      rollIntervalS: 60, // Default
      schemaVersion: 1,
    }

    globalMissionName.value = mission

    // Update apiBaseUrl to match vehicle
    if (vehicle !== vehicleAddress.value) {
      sensor.apiBaseUrl = `http://${vehicle}:9150`
    }

    sensor.lastError = null
  }

  /**
   * Start mirroring via Electron IPC.
   * Legacy API - operates on in-water sensor only.
   */
  async function start(): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    error?: string
  }> {
    const sensor = inWaterSensor.value

    if (!sensor.currentSession) {
      sensor.lastError = 'No session ID set (call arm() first)'
      return { success: false, error: sensor.lastError }
    }

    try {
      window.electronAPI?.systemLog(
        'info',
        `[QSensor Store] start() requested for session ${sensor.currentSession.sessionId} (vehicle=${
          vehicleAddress.value
        }, cadence=${fullBandwidth.value ? 2 : cadenceSec.value}s)`
      )

      const result = await window.electronAPI.startQSensorMirror(
        sensor.currentSession.sessionId,
        vehicleAddress.value,
        sensor.currentSession.mission,
        cadenceSec.value,
        fullBandwidth.value
      )

      if (result.success) {
        sensor.recordingState = 'recording'
        sensor.lastError = null
        window.electronAPI?.systemLog(
          'info',
          `[QSensor Store] Mirroring started for session ${sensor.currentSession.sessionId} (bytes=${sensor.bytesMirrored})`
        )
      } else {
        sensor.lastError = result.error || 'Unknown error'
        window.electronAPI?.systemLog(
          'error',
          `[QSensor Store] Mirroring failed to start for session ${sensor.currentSession.sessionId}: ${sensor.lastError}`
        )
      }

      return result
    } catch (error: any) {
      sensor.lastError = error.message
      window.electronAPI?.systemLog(
        'error',
        `[QSensor Store] start() threw for session ${sensor.currentSession.sessionId}: ${error.message}`
      )
      return { success: false, error: error.message }
    }
  }

  /**
   * Stop mirroring via Electron IPC.
   * Legacy API - operates on in-water sensor only.
   */
  async function stop(): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    error?: string
  }> {
    const sensor = inWaterSensor.value

    if (!sensor.currentSession) {
      return { success: false, error: 'No active session' }
    }

    try {
      const result = await window.electronAPI.stopQSensorMirror(sensor.currentSession.sessionId)

      if (result.success) {
        sensor.recordingState = 'stopped'
      } else {
        sensor.lastError = result.error || 'Unknown error'
      }

      return result
    } catch (error: any) {
      sensor.lastError = error.message
      return { success: false, error: error.message }
    }
  }

  /**
   * Refresh mirroring statistics from Electron.
   * Legacy API - operates on in-water sensor only.
   */
  async function refreshStatus() {
    const sensor = inWaterSensor.value

    if (!sensor.currentSession) return

    try {
      const result = await window.electronAPI.getQSensorStats(sensor.currentSession.sessionId)

      if (result.success && result.stats) {
        sensor.bytesMirrored = result.stats.bytesMirrored || 0
        sensor.lastSync = result.stats.lastSync || null
      }
    } catch (error: any) {
      console.warn('[QSensor Store] Failed to refresh stats:', error)
    }
  }

  /**
   * Reset session state (call after recording stops).
   * Clears both in-water and surface sensor states.
   */
  function reset(): void {
    resetSensorState(inWaterSensor.value)
    const surface = sensors.value.get('surface')
    if (surface) {
      resetSensorState(surface)
    }
    unifiedSessionId.value = null
    unifiedSessionPath.value = null
  }

  // ========================================
  // SERIAL PORT MANAGEMENT
  // Dynamic COM-port scanning and selection for surface sensor
  // ========================================

  /**
   * Refresh available serial ports from system.
   * Updates availableSurfacePorts with current system ports.
   */
  async function refreshSurfaceSerialPorts(): Promise<{
    success: boolean
    error?: string
  }> {
    try {
      const result = await window.electronAPI.qsensorSerialListPorts()
      if (result && result.success && result.data) {
        availableSurfacePorts.value = result.data
        console.log(`[QSensor Store] Found ${result.data.length} serial ports`)
        if (!selectedSurfacePortPath.value && result.data.length > 0) {
          selectSurfaceSerialPort(result.data[0].path)
        }
        return { success: true }
      }
      const errorMessage = result?.error || 'Failed to list ports'
      console.warn('[QSensor Store] Failed to list serial ports:', errorMessage)
      availableSurfacePorts.value = []
      return { success: false, error: errorMessage }
    } catch (error: any) {
      console.error('[QSensor Store] refreshSurfaceSerialPorts error:', error?.message || error)
      availableSurfacePorts.value = []
      return { success: false, error: error?.message || 'Failed to list ports' }
    }
  }

  /**
   * Select a serial port for surface sensor connection.
   * Updates both selectedSurfacePortPath and the surface sensor's serialPort config.
   * @param portPath - The serial port path (e.g., '/dev/ttyUSB0' or 'COM3')
   */
  function selectSurfaceSerialPort(portPath: string | null): void {
    selectedSurfacePortPath.value = portPath
    const surface = sensors.value.get('surface')
    if (surface) {
      surface.serialPort = portPath
    }
    if (portPath) {
      console.log(`[QSensor Store] Selected serial port: ${portPath}`)
    } else {
      console.log('[QSensor Store] Cleared serial port selection')
    }
  }

  // ========================================
  // MULTI-SENSOR API (Phase 4+)
  // Dual-sensor control with backend routing (HTTP vs Serial)
  // ========================================

  /**
   * Get sensor state by ID.
   * Phase 4 API for multi-sensor control.
   * @param sensorId
   */
  function getSensor(sensorId: QSensorId): QSensorState | undefined {
    return sensors.value.get(sensorId)
  }

  /**
   * Connect to a sensor (HTTP or Serial backend routing).
   * Phase 4: Implements backend-specific connection logic.
   * @param sensorId - 'inWater' or 'surface'
   */
  async function connectSensor(sensorId: QSensorId): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    error?: string
  }> {
    const sensor = sensors.value.get(sensorId)
    if (!sensor) {
      return { success: false, error: `Unknown sensor: ${sensorId}` }
    }

    try {
      let result: {
        /**
         *
         */
        success: boolean
        /**
         *
         */
        data?: any
        /**
         *
         */
        error?: string
      }

      if (sensor.backendType === 'http') {
        // In-water sensor via Pi HTTP API
        if (!sensor.apiBaseUrl) {
          return { success: false, error: 'No API base URL configured' }
        }

        // Connect via HTTP backend (this establishes serial connection on Pi side)
        result = await window.electronAPI.qsensorConnect(sensor.apiBaseUrl, '/dev/ttyUSB0', 9600)

        if (result.success) {
          sensor.isConnected = true
          sensor.lastError = null

          // Fetch health to get sensor config
          const healthResult = await window.electronAPI.qsensorGetHealth(sensor.apiBaseUrl)
          if (healthResult.success && healthResult.data) {
            sensor.healthData = healthResult.data
          }
        } else {
          sensor.lastError = result.error || 'Connection failed'
        }
      } else if (sensor.backendType === 'serial') {
        // Surface sensor via direct serial (topside)
        let portPath = selectedSurfacePortPath.value || sensor.serialPort
        if (!portPath) {
          const refreshResult = await refreshSurfaceSerialPorts()
          if (refreshResult.success && availableSurfacePorts.value.length > 0) {
            portPath = availableSurfacePorts.value[0].path
            selectSurfaceSerialPort(portPath)
          }
        }
        if (!portPath) {
          const message = 'No serial ports available to connect'
          sensor.lastError = message
          console.warn('[QSensor Store]', message)
          return { success: false, error: message }
        }

        const baudRate = sensor.baudRate || 9600
        result = await window.electronAPI.qsensorSerialConnect(portPath, baudRate)

        if (result.success) {
          sensor.isConnected = true
          sensor.serialPort = portPath
          sensor.lastError = null

          // Fetch health to get sensor config
          const healthResult = await window.electronAPI.qsensorSerialGetHealth()
          if (healthResult.success && healthResult.data) {
            sensor.healthData = healthResult.data
          }
        } else {
          sensor.lastError = result.error || 'Connection failed'
        }
      } else {
        return { success: false, error: `Unknown backend type: ${sensor.backendType}` }
      }

      return { success: result.success, error: result.error }
    } catch (error: any) {
      sensor.lastError = error.message
      return { success: false, error: error.message }
    }
  }

  /**
   * Disconnect from a sensor (HTTP or Serial backend routing).
   * Phase 4: Implements backend-specific disconnection logic.
   * @param sensorId - 'inWater' or 'surface'
   */
  async function disconnectSensor(sensorId: QSensorId): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    error?: string
  }> {
    const sensor = sensors.value.get(sensorId)
    if (!sensor) {
      return { success: false, error: `Unknown sensor: ${sensorId}` }
    }

    try {
      let result: {
        /**
         *
         */
        success: boolean
        /**
         *
         */
        data?: any
        /**
         *
         */
        error?: string
      }

      // Stop recording first if active
      if (isSensorRecording(sensor)) {
        await stopRecordingSensor(sensorId)
      }

      if (sensor.backendType === 'http') {
        if (!sensor.apiBaseUrl) {
          return { success: false, error: 'No API base URL configured' }
        }
        result = await window.electronAPI.qsensorDisconnect(sensor.apiBaseUrl)
      } else if (sensor.backendType === 'serial') {
        result = await window.electronAPI.qsensorSerialDisconnect()
      } else {
        return { success: false, error: `Unknown backend type: ${sensor.backendType}` }
      }

      if (result.success) {
        sensor.isConnected = false
        sensor.healthData = null
      }

      return { success: result.success, error: result.error }
    } catch (error: any) {
      sensor.lastError = error.message
      return { success: false, error: error.message }
    }
  }

  /**
   * Start recording for a specific sensor (HTTP or Serial backend routing).
   * Phase 4: Implements backend-specific recording logic.
   * @param sensorId - 'inWater' or 'surface'
   * @param params - Recording parameters (mission, rateHz, etc.)
   * @param params.mission
   * @param params.rateHz
   * @param params.rollIntervalS
   * @param params.schemaVersion
   * @param params.unifiedSessionTimestamp
   */
  async function startRecordingSensor(
    sensorId: QSensorId,
    params: {
      /**
       *
       */
      mission: string
      /**
       *
       */
      rateHz?: number
      /**
       *
       */
      rollIntervalS?: number
      /**
       *
       */
      schemaVersion?: number
      /**
       * Unified session timestamp for shared directory structure
       */
      unifiedSessionTimestamp?: string
    }
  ): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    error?: string
  }> {
    const sensor = sensors.value.get(sensorId)
    if (!sensor) {
      return { success: false, error: `Unknown sensor: ${sensorId}` }
    }

    if (!sensor.isConnected) {
      return { success: false, error: `Sensor ${sensorId} not connected` }
    }

    if (isSensorRecording(sensor)) {
      return { success: false, error: `Sensor ${sensorId} already recording` }
    }

    try {
      let result: {
        /**
         *
         */
        success: boolean
        /**
         *
         */
        data?: any
        /**
         *
         */
        error?: string
      }

      if (sensor.backendType === 'http') {
        // In-water sensor via Pi HTTP API (mirroring)
        if (!sensor.apiBaseUrl) {
          return { success: false, error: 'No API base URL configured' }
        }

        // First, start acquisition on Pi side
        const acqResult = await window.electronAPI.qsensorStartAcquisition(sensor.apiBaseUrl, params.rateHz)
        if (!acqResult.success) {
          return { success: false, error: acqResult.error || 'Failed to start acquisition' }
        }

        // Then, start recording on Pi side
        const recResult = await window.electronAPI.qsensorStartRecording(sensor.apiBaseUrl, {
          mission: params.mission,
          rate_hz: params.rateHz,
          roll_interval_s: params.rollIntervalS,
          schema_version: params.schemaVersion,
        })

        if (!recResult.success) {
          return { success: false, error: recResult.error || 'Failed to start recording' }
        }

        // Now start mirroring (downloads data from Pi to desktop)
        const mirrorResult = await window.electronAPI.startQSensorMirror(
          recResult.data.session_id,
          vehicleAddress.value,
          params.mission,
          cadenceSec.value,
          fullBandwidth.value,
          params.unifiedSessionTimestamp
        )

        result = mirrorResult

        if (result.success) {
          const sessionRoot = (result as any).data?.sessionRoot
          if (sessionRoot) {
            unifiedSessionPath.value = sessionRoot
          }
          sensor.currentSession = {
            sessionId: recResult.data.session_id,
            mission: params.mission,
            startedAt: recResult.data.started_at || new Date().toISOString(),
            rateHz: params.rateHz || 500,
            rollIntervalS: params.rollIntervalS || 60,
            schemaVersion: params.schemaVersion || 1,
          }
          sensor.recordingState = 'recording'
          sensor.lastError = null
        }
      } else if (sensor.backendType === 'serial') {
        // Surface sensor via direct serial (local recording)
        const storagePath = await window.electronAPI.getQSensorStoragePath()

        result = await window.electronAPI.qsensorSerialStartRecording({
          mission: params.mission,
          rateHz: params.rateHz || 1.0,
          rollIntervalS: params.rollIntervalS || 60,
          storagePath,
          unifiedSessionTimestamp: params.unifiedSessionTimestamp,
        })

        if (result.success && result.data) {
          sensor.currentSession = {
            sessionId: result.data.session_id,
            mission: params.mission,
            startedAt: result.data.started_at || new Date().toISOString(),
            rateHz: params.rateHz || 1.0,
            rollIntervalS: params.rollIntervalS || 60,
            schemaVersion: 1,
          }
          sensor.recordingState = 'recording'
          sensor.lastError = null
        }
      } else {
        return { success: false, error: `Unknown backend type: ${sensor.backendType}` }
      }

      return { success: result.success, error: result.error }
    } catch (error: any) {
      sensor.lastError = error.message
      return { success: false, error: error.message }
    }
  }

  /**
   * Stop recording for a specific sensor (HTTP or Serial backend routing).
   * Phase 4: Implements backend-specific stop logic.
   * @param sensorId - 'inWater' or 'surface'
   */
  async function stopRecordingSensor(sensorId: QSensorId): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    error?: string
  }> {
    const sensor = sensors.value.get(sensorId)
    if (!sensor) {
      return { success: false, error: `Unknown sensor: ${sensorId}` }
    }

    if (!sensor.currentSession) {
      return { success: false, error: `No active session for sensor ${sensorId}` }
    }

    try {
      let result: {
        /**
         *
         */
        success: boolean
        /**
         *
         */
        data?: any
        /**
         *
         */
        error?: string
      }

      if (sensor.backendType === 'http') {
        // In-water sensor: stop mirroring, then stop recording on Pi
        if (!sensor.apiBaseUrl) {
          return { success: false, error: 'No API base URL configured' }
        }

        // Stop mirroring first
        const mirrorResult = await window.electronAPI.stopQSensorMirror(sensor.currentSession.sessionId)
        if (!mirrorResult.success) {
          console.warn(`[QSensor Store] Failed to stop mirroring for ${sensorId}:`, mirrorResult.error)
        }

        // Then stop recording on Pi
        result = await window.electronAPI.qsensorStopRecording(sensor.apiBaseUrl, sensor.currentSession.sessionId)

        // Stop acquisition
        await window.electronAPI.qsensorStopAcquisition(sensor.apiBaseUrl)
      } else if (sensor.backendType === 'serial') {
        // Surface sensor: stop local recording
        result = await window.electronAPI.qsensorSerialStopRecording()
      } else {
        return { success: false, error: `Unknown backend type: ${sensor.backendType}` }
      }

      if (result.success) {
        sensor.recordingState = 'stopped'

        // Update final stats from the result (service caches these before clearing session)
        if (result.data) {
          sensor.bytesMirrored = result.data.bytes_flushed || result.data.bytesFlushed || sensor.bytesMirrored
        }

        // Clear currentSession after successful stop
        sensor.currentSession = null
      } else {
        sensor.lastError = result.error || 'Stop recording failed'
      }

      return { success: result.success, error: result.error }
    } catch (error: any) {
      sensor.lastError = error.message
      return { success: false, error: error.message }
    }
  }

  /**
   * Refresh statistics for a specific sensor (HTTP or Serial backend routing).
   * Phase 4: Implements backend-specific stats polling.
   * @param sensorId - 'inWater' or 'surface'
   */
  async function refreshSensorStatus(sensorId: QSensorId): Promise<void> {
    const sensor = sensors.value.get(sensorId)
    if (!sensor) return

    try {
      if (sensor.backendType === 'http') {
        // In-water sensor: get mirroring stats (requires active session)
        if (!sensor.currentSession) return
        const result = await window.electronAPI.getQSensorStats(sensor.currentSession.sessionId)
        if (result.success && result.stats) {
          sensor.bytesMirrored = result.stats.bytesMirrored || 0
          sensor.lastSync = result.stats.lastSync || null
        }
      } else if (sensor.backendType === 'serial') {
        // Surface sensor: get local recording stats (supports cached stats after stop)
        const result = await window.electronAPI.qsensorSerialGetStats()
        if (result.success && result.data) {
          // Update stats (surface sensor tracks different metrics)
          sensor.bytesMirrored = result.data.bytesFlushed || result.data.totalRows || sensor.bytesMirrored
          if (result.data.recording) {
            sensor.lastSync = new Date().toISOString()
          } else if (result.data.stoppedAt) {
            sensor.lastSync = result.data.stoppedAt
          }
        }
      }
    } catch (error: any) {
      console.warn(`[QSensor Store] Failed to refresh stats for ${sensorId}:`, error)
    }
  }

  /**
   * Start both sensors simultaneously.
   * Phase 4: Implements unified recording start for dual-sensor operation.
   * @param params - Shared recording parameters
   * @param params.mission
   * @param params.rateHz
   * @param params.rollIntervalS
   */
  async function startBoth(params: {
    /**
     *
     */
    mission: string
    /**
     *
     */
    rateHz?: number
    /**
     *
     */
    rollIntervalS?: number
  }): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    errors: string[]
  }> {
    const errors: string[] = []
    clearUnifiedSessionState()

    // Generate unified session timestamp for shared directory structure
    // Format: ISO timestamp without colons for filesystem compatibility
    const now = new Date()
    const unifiedSessionTimestamp = now.toISOString().replace(/[:.]/g, '-')

    let inWaterStarted = false
    let success = false

    try {
      const inWaterResult = await startRecordingSensor('inWater', {
        mission: params.mission,
        rateHz: params.rateHz || 500,
        rollIntervalS: params.rollIntervalS || 60,
        unifiedSessionTimestamp,
      })

      if (!inWaterResult.success) {
        errors.push(`In-water: ${inWaterResult.error}`)
      } else {
        inWaterStarted = true
        const surfaceResult = await startRecordingSensor('surface', {
          mission: params.mission,
          rateHz: params.rateHz || 500, // Use same rate for synchronized sampling
          rollIntervalS: params.rollIntervalS || 60,
          unifiedSessionTimestamp,
        })

        if (!surfaceResult.success) {
          errors.push(`Surface: ${surfaceResult.error}`)
          console.warn('[QSensor Store] Surface sensor failed to start, rolling back in-water sensor')
          const rollbackResult = await stopRecordingSensor('inWater')
          if (!rollbackResult.success) {
            errors.push(`Rollback in-water: ${rollbackResult.error}`)
          }
        } else {
          success = true
          unifiedSessionId.value = `unified-${Date.now()}`
          console.log(`[QSensor Store] Started both sensors for mission: ${params.mission}`)

          // Phase 3: Measure clock offset and update sync metadata
          // This must not block recording - failures are logged but ignored
          if (unifiedSessionPath.value) {
            try {
              const baseUrl = inWaterSensor.value.apiBaseUrl || 'http://blueos.local:9150'
              const timeSyncResult = await window.electronAPI.measureClockOffset(baseUrl)

              // Update sync_metadata.json with time sync data
              await window.electronAPI.updateSyncMetadata(unifiedSessionPath.value, {
                method: timeSyncResult.method,
                offsetMs: timeSyncResult.offsetMs,
                uncertaintyMs: timeSyncResult.uncertaintyMs,
                measuredAt: timeSyncResult.topsideResponseEnd,
                error: timeSyncResult.error || null,
              })

              if (timeSyncResult.error) {
                console.warn(`[QSensor Store] Time sync completed with error: ${timeSyncResult.error}`)
              } else {
                console.log(
                  `[QSensor Store] Time sync: offset=${timeSyncResult.offsetMs}ms ±${timeSyncResult.uncertaintyMs}ms`
                )
              }
            } catch (timeSyncError: any) {
              // Never block recording due to time sync failure
              console.error('[QSensor Store] Time sync failed (recording continues):', timeSyncError.message)
            }
          }
        }
      }
    } catch (error: any) {
      errors.push(error.message || 'Unknown start error')
      if (inWaterStarted) {
        const rollbackResult = await stopRecordingSensor('inWater')
        if (!rollbackResult.success) {
          errors.push(`Rollback in-water: ${rollbackResult.error}`)
        }
      }
    } finally {
      if (!success) {
        clearUnifiedSessionState()
      }
    }

    return { success, errors }
  }

  /**
   * Stop both sensors simultaneously.
   * Phase 4: Implements unified recording stop for dual-sensor operation.
   */
  async function stopBoth(): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    errors: string[]
  }> {
    const errors: string[] = []

    try {
      // Stop in-water sensor
      const inWaterResult = await stopRecordingSensor('inWater')
      if (!inWaterResult.success) {
        errors.push(`In-water: ${inWaterResult.error}`)
      }

      // Stop surface sensor
      const surfaceResult = await stopRecordingSensor('surface')
      if (!surfaceResult.success) {
        errors.push(`Surface: ${surfaceResult.error}`)
      }
    } catch (error: any) {
      errors.push(error.message || 'Unknown stop error')
    } finally {
      clearUnifiedSessionState()
    }

    const success = errors.length === 0

    if (success) {
      console.log('[QSensor Store] Stopped both sensors')
    } else {
      console.warn('[QSensor Store] Failed to stop both sensors:', errors)
    }

    return { success, errors }
  }

  /**
   * Refresh fusion status from sync_metadata.json.
   * Call after recording stops to get unified CSV status.
   * @param sessionRoot - Optional session root path (defaults to unifiedSessionPath)
   */
  async function refreshFusionStatus(sessionRoot?: string): Promise<void> {
    const path = sessionRoot || unifiedSessionPath.value
    if (!path) {
      fusionStatus.value = null
      return
    }

    try {
      const result = await window.electronAPI?.qsensorGetFusionStatus(path)
      if (result?.success && result.data) {
        const fusion = result.data.fusion
        fusionStatus.value = {
          status: fusion?.status || null,
          unifiedCsv: fusion?.unifiedCsv || null,
          unifiedCsvPath: result.data.unifiedCsvPath || null,
          rowCount: fusion?.rowCount || null,
          inWaterRows: fusion?.inWaterRows || null,
          surfaceRows: fusion?.surfaceRows || null,
          completedAt: fusion?.completedAt || null,
          error: fusion?.error || null,
        }
      } else {
        fusionStatus.value = null
      }
    } catch (error: any) {
      console.warn('[QSensor Store] Failed to refresh fusion status:', error)
      fusionStatus.value = null
    }
  }

  // ========================================
  // COMPUTED GETTERS (Phase 4+)
  // Dual-sensor state aggregation
  // ========================================

  /**
   * Get surface sensor computed reference.
   */
  const surfaceSensor = computed(() => sensors.value.get('surface')!)

  /**
   * Check if both sensors are connected.
   */
  const areBothConnected = computed(() => {
    return inWaterSensor.value.isConnected && surfaceSensor.value.isConnected
  })

  /**
   * Check if both sensors are recording.
   */
  const areBothRecording = computed(() => {
    return isSensorRecording(inWaterSensor.value) && isSensorRecording(surfaceSensor.value)
  })

  /**
   * Check if any sensor is recording.
   */
  const isAnyRecording = computed(() => {
    return isSensorRecording(inWaterSensor.value) || isSensorRecording(surfaceSensor.value)
  })

  /**
   * Get total bytes mirrored/recorded across both sensors.
   */
  const totalBytesMirrored = computed(() => {
    return inWaterSensor.value.bytesMirrored + surfaceSensor.value.bytesMirrored
  })

  /**
   * Get combined error messages from both sensors.
   */
  const combinedErrors = computed(() => {
    const errors: string[] = []
    if (inWaterSensor.value.lastError) {
      errors.push(`In-water: ${inWaterSensor.value.lastError}`)
    }
    if (surfaceSensor.value.lastError) {
      errors.push(`Surface: ${surfaceSensor.value.lastError}`)
    }
    return errors
  })

  return {
    // Settings
    apiBaseUrl,
    cadenceSec,
    fullBandwidth,
    globalMissionName,

    // Legacy state (backward compatible)
    currentSessionId,
    vehicleAddress,
    missionName,
    isRecording,
    bytesMirrored,
    lastSync,
    lastError,
    isArmed,

    // Legacy actions (backward compatible)
    arm,
    start,
    stop,
    refreshStatus,
    reset,

    // Serial port management
    availableSurfacePorts,
    selectedSurfacePortPath,
    refreshSurfaceSerialPorts,
    selectSurfaceSerialPort,

    // Multi-sensor API (Phase 4+)
    sensors, // Expose for advanced usage
    getSensor,
    connectSensor,
    disconnectSensor,
    startRecordingSensor,
    stopRecordingSensor,
    refreshSensorStatus,
    startBoth,
    stopBoth,
    unifiedSessionId,
    unifiedSessionPath,
    fusionStatus,
    refreshFusionStatus,

    // Computed getters (Phase 4+)
    surfaceSensor,
    inWaterSensor,
    areBothConnected,
    areBothRecording,
    isAnyRecording,
    totalBytesMirrored,
    combinedErrors,
  }
})
