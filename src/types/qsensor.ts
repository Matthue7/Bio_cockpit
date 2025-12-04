/**
 * Shared Q-Sensor type definitions for dual-sensor architecture.
 *
 * Phase 1: Both sensors support HTTP (dual-API) and Serial modes.
 * Either sensor can connect to a Q_Sensor_API instance via HTTP or direct serial.
 */

/**
 * Sensor identity type.
 * - 'inWater': In-water sensor (can use HTTP to BlueOS Pi or Serial)
 * - 'surface': Surface reference sensor (can use HTTP to separate Pi or Serial)
 *
 * Phase 1: Both sensors support HTTP (dual-API) mode with separate base URLs.
 */
export type QSensorId = 'inWater' | 'surface'

/**
 * Backend connection type for a sensor.
 * - 'http': Controlled via HTTP REST API (Q_Sensor_API on any Pi)
 * - 'serial': Controlled via direct serial communication (Electron-based, topside)
 *
 * Phase 1: Both 'inWater' and 'surface' sensors can use either backend type.
 */
export type QSensorBackendType = 'http' | 'serial'

/**
 * Health/status data for a connected sensor.
 * Unified type supporting both HTTP (in-water) and Serial (surface) backends.
 */
export interface QSensorHealthData {
  /** Connection status */
  connected: boolean
  /** Serial port or HTTP endpoint */
  port?: string | null
  /** Sensor model name */
  model?: string | null
  /** Firmware version */
  firmware?: string | null
  /** Sensor serial number / ID */
  sensorId?: string | null
  /** Free disk space in bytes (HTTP backend) */
  diskFreeBytes?: number | null
  /** Temperature in Celsius */
  tempC?: number | null
  /** Input voltage */
  vin?: number | null
  /** Controller state (Serial backend) */
  state?: string | null
  /** Line buffer size (Serial backend) */
  bufferSize?: number | null
  /** Time since last reading in ms (Serial backend) */
  lastReadingAgeMs?: number | null
  /** Sensor configuration details */
  config?: QSensorConfigData | null
}

/**
 * Sensor configuration data (from serial controller).
 */
export interface QSensorConfigData {
  /** ADC integration time in milliseconds */
  integrationTimeMs?: number | null
  /** Internal averaging count */
  internalAveraging?: number | null
  /** Sample rate in Hz */
  rateHz?: number | null
  /** Operating mode */
  mode?: string | null
  /** Tag for polled mode */
  tag?: string | null
}

/**
 * Recording session metadata.
 */
export interface QSensorSessionInfo {
  /**
   *
   */
  sessionId: string
  /**
   *
   */
  startedAt: string
  /**
   *
   */
  stoppedAt?: string
  /**
   *
   */
  mission: string
  /** Shared sync marker identifier for dual-sensor alignment */
  syncId?: string
  /**
   *
   */
  rateHz: number
  /**
   *
   */
  rollIntervalS: number
  /**
   *
   */
  schemaVersion: number
  /**
   *
   */
  totalRows?: number
  /**
   *
   */
  totalChunks?: number
  /**
   * Connection mode used for this session (Phase 1).
   * Captures user's selection at recording start.
   */
  connectionMode?: 'api' | 'serial'
  /**
   * Backend type used for this session (Phase 1).
   * For backward compatibility and historical tracking.
   */
  backendType?: 'http' | 'serial'
}

/**
 * Recording state for a sensor.
 */
export type QSensorRecordingState = 'idle' | 'recording' | 'stopping' | 'stopped'

/**
 * Individual sensor state (internal store representation).
 */
export interface QSensorState {
  /**
   *
   */
  sensorId: QSensorId
  /**
   * Backend connection type. Null until connection mode is selected.
   */
  backendType: QSensorBackendType | null

  // Connection mode selection (Phase 1)
  /**
   * User-selected connection mode. Null until explicitly chosen.
   * 'api' maps to backendType: 'http', 'serial' maps to backendType: 'serial'
   */
  connectionMode: 'api' | 'serial' | null
  /**
   * Flag indicating the connection mode has been explicitly selected by the user.
   * Used to distinguish between "not yet chosen" and "reset to null".
   */
  connectionModeExplicitlySet: boolean

  // Connection config
  /**
   * API base URL for HTTP backend.
   * - In-water: Pre-configured (http://blueos.local:9150)
   * - Surface: User-configured, persisted via config store (Phase 1)
   */
  apiBaseUrl?: string
  /**
   *
   */
  serialPort?: string | null // For serial backend (surface sensor)
  /**
   *
   */
  baudRate?: number // For serial backend

  // Connection status
  /**
   *
   */
  isConnected: boolean
  /**
   *
   */
  healthData: QSensorHealthData | null

  // Session/recording
  /**
   *
   */
  currentSession: QSensorSessionInfo | null
  /**
   *
   */
  recordingState: QSensorRecordingState

  // Mirroring stats (for HTTP backend)
  /**
   *
   */
  bytesMirrored: number
  /**
   *
   */
  lastSync: string | null

  // Errors
  /**
   *
   */
  lastError: string | null
}

/**
 * Unified session metadata for combined in-water + surface recording.
 * TODO[Phase5]: Implement unified session directory structure and time-sync metadata.
 */
export interface QSensorUnifiedSessionMetadata {
  /**
   *
   */
  unifiedSessionId: string
  /**
   *
   */
  missionName: string
  /**
   *
   */
  recordingStartedTopsideUtc: string
  /**
   *
   */
  recordingStoppedTopsideUtc?: string
  /**
   *
   */
  videoFile?: string

  // Per-sensor session mappings
  /**
   *
   */
  inWaterSessionId?: string
  /**
   *
   */
  surfaceSessionId?: string

  // Time synchronization data (Phase 5)
  /**
   *
   */
  timeSyncOffsetMs?: number
  /**
   *
   */
  timeSyncUncertaintyMs?: number
  /**
   *
   */
  timeSyncMethod?: string
}

/**
 * Clock offset measurement result.
 * TODO[Phase5]: Implement HTTP round-trip time-sync measurement.
 */
export interface QSensorClockOffsetMeasurement {
  /**
   *
   */
  timestampUtc: string
  /**
   *
   */
  offsetMs: number
  /**
   *
   */
  uncertaintyMs: number
  /**
   *
   */
  method: 'http_roundtrip' | 'mavlink_timesync' | 'manual'
}
