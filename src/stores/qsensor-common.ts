/**
 * Shared Q-Sensor utilities and helpers for dual-sensor architecture.
 *
 * Phase 1: Common helpers not specific to HTTP vs serial backends.
 *
 * Sensor ID to Backend Mapping:
 * =============================
 * - 'inWater'  → 'http'   → Pi-based Q_Sensor_API (proven, active)
 * - 'surface'  → 'serial' → Topside direct serial control (to be implemented in Phase 2+)
 *
 * Both sensors will ultimately be synchronized with video recording and written
 * into a unified output directory structure (Phase 5+).
 */

import type {
  QSensorBackendType,
  QSensorHealthData,
  QSensorId,
  QSensorSessionInfo,
  QSensorState,
} from '@/types/qsensor'

/**
 * Create initial state for a sensor.
 * @param sensorId - Sensor identifier ('inWater' or 'surface')
 * @param backendType - Backend type ('http' or 'serial')
 * @param config - Optional initial configuration
 * @param config.apiBaseUrl
 * @param config.serialPort
 * @param config.baudRate
 * @returns Initial QSensorState
 */
export function createInitialSensorState(
  sensorId: QSensorId,
  backendType: QSensorBackendType,
  config?: {
    /**
     *
     */
    apiBaseUrl?: string
    /**
     *
     */
    serialPort?: string
    /**
     *
     */
    baudRate?: number
  }
): QSensorState {
  return {
    sensorId,
    backendType,

    // Connection config
    apiBaseUrl: config?.apiBaseUrl,
    serialPort: config?.serialPort,
    baudRate: config?.baudRate,

    // Connection status
    isConnected: false,
    healthData: null,

    // Session/recording
    currentSession: null,
    recordingState: 'idle',

    // Mirroring stats (relevant for HTTP backend)
    bytesMirrored: 0,
    lastSync: null,

    // Errors
    lastError: null,
  }
}

/**
 * Get a human-readable label for a sensor ID.
 * @param sensorId
 */
export function getSensorLabel(sensorId: QSensorId): string {
  switch (sensorId) {
    case 'inWater':
      return 'In-Water Sensor (ROV)'
    case 'surface':
      return 'Surface Reference (Topside)'
    default:
      return 'Unknown Sensor'
  }
}

/**
 * Get a human-readable label for a backend type.
 * @param backendType
 */
export function getBackendLabel(backendType: QSensorBackendType): string {
  switch (backendType) {
    case 'http':
      return 'HTTP API (Pi)'
    case 'serial':
      return 'Serial Direct (Topside)'
    default:
      return 'Unknown Backend'
  }
}

/**
 * Check if a sensor is currently recording.
 * @param state
 */
export function isSensorRecording(state: QSensorState): boolean {
  return state.recordingState === 'recording'
}

/**
 * Check if a sensor has an active session (armed or recording).
 * @param state
 */
export function isSensorArmed(state: QSensorState): boolean {
  return state.currentSession !== null
}

/**
 * Validate sensor configuration before connecting.
 * @param state - Sensor state to validate
 * @returns Error message if invalid, null if valid
 */
export function validateSensorConfig(state: QSensorState): string | null {
  if (state.backendType === 'http') {
    if (!state.apiBaseUrl) {
      return 'HTTP backend requires apiBaseUrl'
    }
    // Basic URL validation
    try {
      new URL(state.apiBaseUrl)
    } catch {
      return 'Invalid API base URL format'
    }
  } else if (state.backendType === 'serial') {
    if (!state.serialPort) {
      return 'Serial backend requires serialPort'
    }
    if (!state.baudRate || state.baudRate <= 0) {
      return 'Serial backend requires valid baudRate'
    }
  } else {
    return 'Unknown backend type'
  }

  return null
}

/**
 * Reset sensor state to initial idle state (preserves configuration).
 * @param state
 */
export function resetSensorState(state: QSensorState): void {
  state.isConnected = false
  state.healthData = null
  state.currentSession = null
  state.recordingState = 'idle'
  state.bytesMirrored = 0
  state.lastSync = null
  state.lastError = null
}
