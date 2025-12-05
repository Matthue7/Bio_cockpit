/**
 * TypeScript declarations for Electron IPC API exposed to renderer process.
 *
 * This file declares the global window.electronAPI interface used throughout
 * the Cockpit desktop application for communication with the main process.
 */

declare global {
  interface Window {
    electronAPI: {
      // Q-Sensor control APIs (bypasses CORS)
      // TODO: Phase 3 - Add URL validation before HTTP calls to prevent malformed requests
      // TODO: Phase 3 - Normalize URL to handle trailing slashes and protocol variations
      qsensorConnect: (
        baseUrl: string,
        port: string,
        baud: number
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorDisconnect: (
        baseUrl: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      // TODO: Phase 3 - Add URL validation before HTTP calls to prevent malformed requests
      // TODO: Phase 3 - Normalize URL to handle trailing slashes and protocol variations
      qsensorGetHealth: (
        baseUrl: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      // TODO: Phase 3 - Add URL validation before HTTP calls to prevent malformed requests
      // TODO: Phase 3 - Normalize URL to handle trailing slashes and protocol variations
      qsensorStartAcquisition: (
        baseUrl: string,
        pollHz?: number
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      // TODO: Phase 3 - Add URL validation before HTTP calls to prevent malformed requests
      // TODO: Phase 3 - Normalize URL to handle trailing slashes and protocol variations
      qsensorStopAcquisition: (
        baseUrl: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      // TODO: Phase 3 - Add URL validation before HTTP calls to prevent malformed requests
      // TODO: Phase 3 - Normalize URL to handle trailing slashes and protocol variations
      qsensorStartRecording: (
        baseUrl: string,
        options: {
          rate_hz?: number
          schema_version?: number
          mission?: string
          roll_interval_s?: number
        }
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      // TODO: Phase 3 - Add URL validation before HTTP calls to prevent malformed requests
      // TODO: Phase 3 - Normalize URL to handle trailing slashes and protocol variations
      qsensorStopRecording: (
        baseUrl: string,
        sessionId: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      // Q-Sensor mirroring APIs
      // TODO: Phase 3 - Add URL validation before HTTP calls to prevent malformed requests
      // TODO: Phase 3 - Normalize URL to handle trailing slashes and protocol variations
      // FIXME: Phase 3 - Implement per-sensor time sync measurements instead of global sync
      startQSensorMirror: (
        sessionId: string,
        apiBaseUrl: string,
        missionName: string,
        cadenceSec: number,
        fullBandwidth: boolean,
        unifiedSessionTimestamp?: string,
        syncId?: string
      ) => Promise<{ success: boolean; data?: { sessionRoot?: string }; error?: string; syncId?: string }>

      stopQSensorMirror: (
        sessionId: string
      ) => Promise<{ success: boolean; error?: string }>

      getQSensorStats: (
        sessionId: string
      ) => Promise<{ success: boolean; stats?: any; error?: string }>

      // Q-Sensor storage path configuration
      selectQSensorStorageDirectory: () => Promise<string | null>

      getQSensorStoragePath: () => Promise<string>

      setQSensorStoragePath: (storagePath: string) => Promise<void>

      /**
       * Get surface sensor API base URL from config store.
       * Returns empty string if not set (user must configure).
       */
      getQSensorSurfaceApiUrl: () => Promise<string>

      /**
       * Save surface sensor API base URL to config store.
       * Persists across app restarts.
       */
      setQSensorSurfaceApiUrl: (apiUrl: string) => Promise<void>

      // Q-Sensor serial recording APIs (topside/surface sensor)
      // TODO: Phase 3 - Add conditional logic for serial vs API surface sensors
      qsensorSerialConnect: (
        port: string,
        baudRate: number
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialDisconnect: () => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialGetHealth: () => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialStartAcquisition: (
        pollHz: number
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialStopAcquisition: () => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialStartRecording: (params: {
        mission: string
        rollIntervalS?: number
        rateHz?: number
        storagePath?: string
        unifiedSessionTimestamp?: string
        syncId?: string
      }) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialStopRecording: () => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialGetStats: () => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialListPorts: () => Promise<{ success: boolean; data?: any; error?: string }>

      // Q-Sensor time sync APIs
      // TODO: Phase 3 - Add URL validation before HTTP calls to prevent malformed requests
      // TODO: Phase 3 - Normalize URL to handle trailing slashes and protocol variations
      // FIXME: Phase 3 - Implement per-sensor time sync measurements instead of global sync
      measureClockOffset: (
        baseUrl: string
      ) => Promise<{
        method: string
        offsetMs: number | null
        uncertaintyMs: number | null
        topsideResponseEnd: string | null
        error?: string | null
      }>

      updateSyncMetadata: (
        sessionRoot: string,
        timeSync: {
          method: string
          offsetMs: number | null
          uncertaintyMs: number | null
          measuredAt: string | null
          error?: string | null
        }
      ) => Promise<{ success: boolean; error?: string }>

      // Q-Sensor fusion APIs
      // TODO: Phase 3 - Add conditional logic for serial vs API surface sensors
      qsensorGetFusionStatus: (
        sessionRoot: string
      ) => Promise<{
        success: boolean
        data?: {
          fusion: {
            status: 'pending' | 'complete' | 'skipped' | 'failed'
            unifiedCsv: string | null
            rowCount: number | null
            inWaterRows: number | null
            surfaceRows: number | null
            completedAt: string | null
            error: string | null
          } | null
          unifiedCsvPath: string | null
          exists: boolean
        }
        error?: string
      }>

      qsensorTriggerManualFusion: (
        sessionRoot: string
      ) => Promise<{
        success: boolean
        unifiedCsvPath?: string
        totalRows?: number
        inWaterRows?: number
        surfaceRows?: number
        error?: string
      }>
    }
  }
}

export {}
