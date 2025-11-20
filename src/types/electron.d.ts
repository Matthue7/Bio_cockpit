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
      qsensorConnect: (
        baseUrl: string,
        port: string,
        baud: number
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorDisconnect: (
        baseUrl: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorGetHealth: (
        baseUrl: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorStartAcquisition: (
        baseUrl: string,
        pollHz?: number
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorStopAcquisition: (
        baseUrl: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorStartRecording: (
        baseUrl: string,
        options: {
          rate_hz?: number
          schema_version?: number
          mission?: string
          roll_interval_s?: number
        }
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorStopRecording: (
        baseUrl: string,
        sessionId: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>

      // Q-Sensor mirroring APIs
      startQSensorMirror: (
        sessionId: string,
        vehicleAddress: string,
        missionName: string,
        cadenceSec: number,
        fullBandwidth: boolean,
        unifiedSessionTimestamp?: string
      ) => Promise<{ success: boolean; data?: { sessionRoot?: string }; error?: string }>

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

      // Q-Sensor serial recording APIs (topside/surface sensor)
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
      }) => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialStopRecording: () => Promise<{ success: boolean; data?: any; error?: string }>

      qsensorSerialGetStats: () => Promise<{ success: boolean; data?: any; error?: string }>
    }
  }
}

export {}
