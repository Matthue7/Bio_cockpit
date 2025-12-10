/**
 * Pinia store for Q-Sensor live recording state and settings.
 *
 * Phase 1: Refactored to support multiple sensor contexts (in-water Pi HTTP + future surface serial).
 * Currently only the in-water sensor is active; surface sensor is scaffolded for Phase 2+.
 */

import { defineStore } from 'pinia'
import { v4 as uuidv4 } from 'uuid'
import { computed, ref } from 'vue'

import { validateAndNormalizeQSensorUrl } from '@/electron/services/url-validator'
// Note: QSensorClient was scaffolded for future direct client usage, currently unused
import { createInitialSensorState, isSensorArmed, isSensorRecording, resetSensorState } from '@/stores/qsensor-common'
import type { QSensorId, QSensorState } from '@/types/qsensor'

/**
 * Serial port information returned from port enumeration
 */
export interface SerialPortInfo {
  /**
   *
   */
  path: string
  /**
   *
   */
  manufacturer: string | null
  /**
   *
   */
  serialNumber: string | null
  /**
   *
   */
  vendorId: string | null
  /**
   *
   */
  productId: string | null
  /**
   *
   */
  isLikelyQSensor: boolean
}

export const useQSensorStore = defineStore('qsensor', () => {
  // Multi-sensor state map
  // NOTE: Currently only 'inWater' sensor is used; 'surface' is placeholder for Phase 2+
  const sensors = ref<Map<QSensorId, QSensorState>>(new Map())

  // Phase 1: Initialize sensors with backend types
  // In-water sensor pre-configured for HTTP/API (backward compatible)
  sensors.value.set(
    'inWater',
    createInitialSensorState('inWater', 'http', {
      apiBaseUrl: 'http://blueos.local:9150',
    })
  )

  // Initialize surface sensor (user will choose API or Serial)
  // NOTE: serialPort is null until user selects a port via refreshSurfaceSerialPorts/selectSurfaceSerialPort
  sensors.value.set(
    'surface',
    createInitialSensorState('surface', null, {
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
    /**
     *
     */
    status: 'pending' | 'complete' | 'skipped' | 'failed' | null
    /**
     *
     */
    unifiedCsv: string | null
    /**
     *
     */
    unifiedCsvPath: string | null
    /**
     *
     */
    rowCount: number | null
    /**
     *
     */
    inWaterRows: number | null
    /**
     *
     */
    surfaceRows: number | null
    /**
     *
     */
    completedAt: string | null
    /**
     *
     */
    error: string | null
  } | null>(null)

  /**
   *
   */
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
  function arm(sessionId: string, mission: string, vehicle = 'blueos.local'): void {
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
        inWaterSensor.value.apiBaseUrl || 'http://blueos.local:9150',
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
  async function refreshStatus(): Promise<void> {
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
    /**
     *
     */
    success: boolean
    /**
     *
     */
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

  /**
   * Set API base URL for surface sensor (API mode).
   * Validates and persists to config store.
   * Phase 1: Manual URL entry with persistence.
   * @param apiUrl - Full API base URL (e.g., 'http://surfaceref.local:9150')
   */
  async function setSurfaceApiUrl(apiUrl: string): Promise<{
    /**
     *
     */
    success: boolean
    /**
     *
     */
    error?: string
  }> {
    const surface = sensors.value.get('surface')
    if (!surface) {
      return { success: false, error: 'Surface sensor not found' }
    }

    // PHASE 3: Validate and normalize URL using shared utility
    if (apiUrl && apiUrl.trim() !== '') {
      const urlResult = validateAndNormalizeQSensorUrl(apiUrl, 'surface sensor')
      if (!urlResult.success) {
        return { success: false, error: urlResult.error }
      }

      // Save normalized URL
      try {
        await window.electronAPI.setQSensorSurfaceApiUrl(urlResult.normalizedUrl)
        surface.apiBaseUrl = urlResult.normalizedUrl
        console.log(`[QSensor Store] Surface API URL saved: ${urlResult.normalizedUrl}`)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message || 'Failed to save URL' }
      }
    }

    // Handle empty URL (clearing configuration)
    surface.apiBaseUrl = undefined
    try {
      await window.electronAPI.setQSensorSurfaceApiUrl('')
      console.log('[QSensor Store] Surface API URL cleared')
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message || 'Failed to clear URL' }
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
   * Set connection mode for a sensor.
   * Phase 1: User-selectable connection mode (API vs Serial).
   * Updates backend type dynamically based on connection mode.
   * @param sensorId - Sensor identifier
   * @param connectionMode - Connection mode ('api' or 'serial')
   */
  function setConnectionMode(sensorId: QSensorId, connectionMode: 'api' | 'serial'): void {
    const sensor = sensors.value.get(sensorId)
    if (!sensor) {
      console.error(`[QSensor Store] Unknown sensor: ${sensorId}`)
      return
    }

    // Map connection mode to backend type
    const backendType = connectionMode === 'api' ? 'http' : 'serial'

    // Update sensor state
    sensor.backendType = backendType
    sensor.connectionMode = connectionMode
    sensor.connectionModeExplicitlySet = true

    console.log(`[QSensor Store] Set ${sensorId} connection mode: ${connectionMode} (backend: ${backendType})`)

    // Phase 1: Load persisted surface URL when switching to API mode
    if (sensorId === 'surface' && connectionMode === 'api') {
      window.electronAPI
        .getQSensorSurfaceApiUrl()
        .then((savedUrl) => {
          if (savedUrl && sensor) {
            sensor.apiBaseUrl = savedUrl
            console.log(`[QSensor Store] Loaded persisted surface URL: ${savedUrl}`)
          }
        })
        .catch((error) => {
          console.error('[QSensor Store] Failed to load surface URL:', error)
          console.error('[QSensor Store] Error details:', error?.message || error)
          // Safely bail - sensor.apiBaseUrl remains undefined, user will need to enter manually
        })
    }
  }

  /**
   * Reset connection mode for a sensor.
   * Phase 1: Clears connection mode selection.
   * @param sensorId - Sensor identifier
   */
  function resetConnectionMode(sensorId: QSensorId): void {
    const sensor = sensors.value.get(sensorId)
    if (!sensor) return

    sensor.backendType = null
    sensor.connectionMode = null
    sensor.connectionModeExplicitlySet = false

    console.log(`[QSensor Store] Reset connection mode for ${sensorId}`)
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

    // Phase 1: Validate connection mode is selected
    if (!sensor.connectionMode || !sensor.connectionModeExplicitlySet) {
      return { success: false, error: 'Connection mode must be selected before connecting' }
    }

    // Phase 1: Validate backend type is set (should be set by setConnectionMode)
    if (sensor.backendType === null) {
      return { success: false, error: 'Backend type not set (connection mode error)' }
    }

    // Phase 3: Log connection attempt
    console.log(`[QSensor Store] Connecting ${sensorId} via ${sensor.connectionMode} (backend: ${sensor.backendType})`)

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

        // PHASE 3: Validate URL before connection
        const urlResult = validateAndNormalizeQSensorUrl(sensor.apiBaseUrl, `${sensorId} sensor`)
        if (!urlResult.success) {
          sensor.lastError = urlResult.error
          return { success: false, error: urlResult.error }
        }

        console.log(
          `[QSensor Store] Connecting via HTTP: apiBaseUrl="${urlResult.normalizedUrl}", port="/dev/ttyUSB0", baud=9600`
        )

        // Connect via HTTP backend (this establishes serial connection on Pi side)
        result = await window.electronAPI.qsensorConnect(urlResult.normalizedUrl, '/dev/ttyUSB0', 9600)

        if (result.success) {
          sensor.isConnected = true
          sensor.lastError = null

          // Fetch health to get sensor config
          const healthResult = await window.electronAPI.qsensorGetHealth(urlResult.normalizedUrl)
          if (healthResult.success && healthResult.data) {
            sensor.healthData = healthResult.data
          }
        } else {
          sensor.lastError = `${sensorId} sensor connection failed: ${result.error || 'Unknown error'}`
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
          sensor.lastError = `${sensorId} sensor connection failed: ${result.error || 'Unknown error'}`
        }
      } else {
        return { success: false, error: `Unknown backend type: ${sensor.backendType}` }
      }

      return { success: result.success, error: result.error }
    } catch (error: any) {
      sensor.lastError = `${sensorId} sensor error: ${error.message}`
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

        // PHASE 3: Validate URL before disconnect
        const urlResult = validateAndNormalizeQSensorUrl(sensor.apiBaseUrl, `${sensorId} sensor`)
        if (!urlResult.success) {
          console.warn(`[QSensor Store] Invalid URL during disconnect: ${urlResult.error}`)
          // Still attempt disconnect with original URL for cleanup
        }

        result = await window.electronAPI.qsensorDisconnect(
          urlResult.success ? urlResult.normalizedUrl : sensor.apiBaseUrl
        )
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
      sensor.lastError = `${sensorId} sensor error: ${error.message}`
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
   * @param params.syncId
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
      /**
       * Shared sync marker identifier for dual-sensor alignment
       */
      syncId?: string
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

    // Phase 1: Validate connection mode is selected
    if (!sensor.connectionMode || !sensor.connectionModeExplicitlySet) {
      return { success: false, error: `Connection mode must be selected before recording ${sensorId}` }
    }

    // Phase 1: Validate backend type is set
    if (sensor.backendType === null) {
      return { success: false, error: `Backend type not set for ${sensorId}` }
    }

    if (!sensor.isConnected) {
      return { success: false, error: `Sensor ${sensorId} not connected` }
    }

    if (isSensorRecording(sensor)) {
      return { success: false, error: `Sensor ${sensorId} already recording` }
    }

    // Phase 3: Log recording start attempt
    console.log(
      `[QSensor Store] Starting recording for ${sensorId} via ${sensor.connectionMode} (backend: ${sensor.backendType})`
    )

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

        // PHASE 3: Validate URL before all API calls
        const urlResult = validateAndNormalizeQSensorUrl(sensor.apiBaseUrl, `${sensorId} sensor`)
        if (!urlResult.success) {
          return { success: false, error: urlResult.error }
        }
        const normalizedUrl = urlResult.normalizedUrl

        // Prefer shared syncId from surface session or provided explicitly
        const syncId = params.syncId || surfaceSensor.value.currentSession?.syncId

        // First, start acquisition on Pi side
        const acqResult = await window.electronAPI.qsensorStartAcquisition(normalizedUrl, params.rateHz)
        if (!acqResult.success) {
          return {
            success: false,
            error: `${sensorId} sensor acquisition failed (${normalizedUrl}): ${acqResult.error || 'Unknown error'}`,
          }
        }

        // Then, start recording on Pi side
        const recResult = await window.electronAPI.qsensorStartRecording(normalizedUrl, {
          mission: params.mission,
          rate_hz: params.rateHz,
          roll_interval_s: params.rollIntervalS,
          schema_version: params.schemaVersion,
        })

        if (!recResult.success) {
          return {
            success: false,
            error: `${sensorId} sensor recording failed (${normalizedUrl}): ${recResult.error || 'Unknown error'}`,
          }
        }

        // Now start mirroring (downloads data from Pi to desktop)
        const mirrorResult = await window.electronAPI.startQSensorMirror(
          recResult.data.session_id,
          normalizedUrl,
          params.mission,
          cadenceSec.value,
          fullBandwidth.value,
          params.unifiedSessionTimestamp,
          syncId
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
            syncId: syncId || (mirrorResult as any).syncId,
            // Phase 3: Store connection mode and backend type in session
            connectionMode: sensor.connectionMode || undefined,
            backendType: sensor.backendType || undefined,
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
          syncId: params.syncId,
        })

        if (result.success && result.data) {
          sensor.currentSession = {
            sessionId: result.data.session_id,
            mission: params.mission,
            startedAt: result.data.started_at || new Date().toISOString(),
            rateHz: params.rateHz || 1.0,
            rollIntervalS: params.rollIntervalS || 60,
            schemaVersion: 1,
            syncId: params.syncId || result.data.sync_id,
            // Phase 3: Store connection mode and backend type in session
            connectionMode: sensor.connectionMode || undefined,
            backendType: sensor.backendType || undefined,
          }
          sensor.recordingState = 'recording'
          sensor.lastError = null
        }
      } else {
        return { success: false, error: `Unknown backend type: ${sensor.backendType}` }
      }

      return { success: result.success, error: result.error }
    } catch (error: any) {
      sensor.lastError = `${sensorId} sensor error: ${error.message}`
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
      sensor.lastError = `${sensorId} sensor error: ${error.message}`
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

    // Phase 1: Validate both sensors have connection modes selected
    const inWater = sensors.value.get('inWater')
    const surface = sensors.value.get('surface')

    if (!inWater?.connectionMode || !inWater?.connectionModeExplicitlySet) {
      errors.push('In-water sensor: Connection mode must be selected')
    }

    if (!surface?.connectionMode || !surface?.connectionModeExplicitlySet) {
      errors.push('Surface sensor: Connection mode must be selected')
    }

    if (errors.length > 0) {
      return { success: false, errors }
    }

    // Phase 3: Log dual-sensor start with connection modes
    console.log(
      `[QSensor Store] Starting both sensors - InWater: ${inWater?.connectionMode}, Surface: ${surface?.connectionMode}`
    )

    // Generate unified session timestamp for shared directory structure
    // Format: ISO timestamp without colons for filesystem compatibility
    const now = new Date()
    const unifiedSessionTimestamp = now.toISOString().replace(/[:.]/g, '-')
    const syncId = uuidv4()

    let inWaterStarted = false
    let success = false

    try {
      const inWaterResult = await startRecordingSensor('inWater', {
        mission: params.mission,
        rateHz: params.rateHz || 500,
        rollIntervalS: params.rollIntervalS || 60,
        unifiedSessionTimestamp,
        syncId,
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
          syncId,
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

          // Phase 3B: Per-sensor time sync measurements
          // This must not block recording - failures are logged but ignored
          if (unifiedSessionPath.value) {
            // In-water sensor time sync
            if (inWaterSensor.value.apiBaseUrl) {
              try {
                const urlResult = validateAndNormalizeQSensorUrl(
                  inWaterSensor.value.apiBaseUrl,
                  'inWater sensor time sync'
                )

                if (urlResult.success) {
                  const timeSync = await window.electronAPI.measureClockOffset(urlResult.normalizedUrl)

                  await window.electronAPI.updateSensorTimeSync(unifiedSessionPath.value, 'inWater', {
                    method: timeSync.method,
                    offsetMs: timeSync.offsetMs,
                    uncertaintyMs: timeSync.uncertaintyMs,
                    measuredAt: timeSync.topsideResponseEnd,
                    error: timeSync.error,
                  })

                  console.log(
                    `[QSensor Store] In-water time sync: offset=${timeSync.offsetMs}ms ±${timeSync.uncertaintyMs}ms`
                  )
                } else {
                  console.warn(`[QSensor Store] In-water time sync skipped: ${urlResult.error}`)
                }
              } catch (error: any) {
                console.error('[QSensor Store] In-water time sync failed (recording continues):', error)
              }
            }

            // Surface sensor time sync (API mode only)
            if (surfaceSensor.value.backendType === 'http' && surfaceSensor.value.apiBaseUrl) {
              try {
                const urlResult = validateAndNormalizeQSensorUrl(
                  surfaceSensor.value.apiBaseUrl,
                  'surface sensor time sync'
                )

                if (urlResult.success) {
                  const timeSync = await window.electronAPI.measureClockOffset(urlResult.normalizedUrl)

                  await window.electronAPI.updateSensorTimeSync(unifiedSessionPath.value, 'surface', {
                    method: timeSync.method,
                    offsetMs: timeSync.offsetMs,
                    uncertaintyMs: timeSync.uncertaintyMs,
                    measuredAt: timeSync.topsideResponseEnd,
                    error: timeSync.error,
                  })

                  console.log(
                    `[QSensor Store] Surface time sync: offset=${timeSync.offsetMs}ms ±${timeSync.uncertaintyMs}ms`
                  )
                } else {
                  console.warn(`[QSensor Store] Surface time sync skipped: ${urlResult.error}`)
                }
              } catch (error: any) {
                console.error('[QSensor Store] Surface time sync failed (recording continues):', error)
              }
            } else if (surfaceSensor.value.backendType === 'serial') {
              console.log('[QSensor Store] Surface sensor in serial mode - no Pi time sync performed')
            } else {
              console.log('[QSensor Store] Surface sensor backend not configured - no time sync performed')
            }
          }
        }
      }
    } catch (error: any) {
      errors.push(`Start recording error: ${error.message || 'Unknown error'}`)
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
      errors.push(`Stop recording error: ${error.message || 'Unknown error'}`)
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
      // PHASE 3: Fusion works for both API and serial surface sensors
      // - API surface: data comes from mirrored files
      // - Serial surface: data comes from direct serial recording
      // Both write to unified session structure, fusion reads from there
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
      console.warn(`[QSensor Store] Failed to refresh fusion status for ${unifiedSessionPath.value}:`, error)
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
    setSurfaceApiUrl, // Phase 1: Surface API URL management

    // Multi-sensor API (Phase 4+)
    sensors, // Expose for advanced usage
    getSensor,
    setConnectionMode, // Phase 1: Connection mode management
    resetConnectionMode, // Phase 1: Connection mode management
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
