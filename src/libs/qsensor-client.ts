/**
 * Q-Sensor API HTTP client for Cockpit desktop.
 *
 * Provides typed interface to Q_Sensor_API REST endpoints running on the ROV.
 * Default base URL: http://blueos.local:9150
 */

export interface QSensorHealthResponse {
  connected: boolean
  port: string | null
  model: string | null
  firmware: string | null
  disk_free_bytes: number | null
}

export interface RecordStartResponse {
  session_id: string
  started_at: string
  rate_hz: number
  schema_version: number
}

export interface RecordStopResponse {
  session_id: string
  stopped_at: string
  chunks: number
  rows: number
}

export interface RecordStatusResponse {
  session_id: string
  state: string
  rows: number
  bytes: number
  last_chunk_index: number
  backlog: number
}

export interface ChunkMetadata {
  index: number
  name: string
  size_bytes: number
  sha256: string
  rows: number
}

export class QSensorClient {
  private baseUrl: string
  private timeout: number

  constructor(baseUrl: string = 'http://blueos.local:9150', timeout: number = 5000) {
    this.baseUrl = baseUrl.replace(/\/$/, '') // Remove trailing slash
    this.timeout = timeout
  }

  /**
   * Connect to sensor via serial port.
   */
  async connect(port: string = '/dev/ttyUSB0', baud: number = 9600): Promise<{ status: string; sensor_id: string }> {
    const url = new URL(`${this.baseUrl}/sensor/connect`)
    url.searchParams.set('port', port)
    url.searchParams.set('baud', String(baud))

    const response = await fetch(url.toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(`Connect failed: ${error.detail || response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Disconnect from sensor.
   */
  async disconnect(): Promise<{ status: string }> {
    const response = await fetch(`${this.baseUrl}/sensor/disconnect`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(`Disconnect failed: ${error.detail || response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Check instrument health and connection status.
   */
  async health(): Promise<QSensorHealthResponse> {
    const response = await fetch(`${this.baseUrl}/instrument/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Start a new chunked recording session.
   */
  async startRecord(options: {
    rate_hz?: number
    schema_version?: number
    mission?: string
    roll_interval_s?: number
  }): Promise<RecordStartResponse> {
    const response = await fetch(`${this.baseUrl}/record/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rate_hz: options.rate_hz ?? 500,
        schema_version: options.schema_version ?? 1,
        mission: options.mission ?? 'Cockpit',
        roll_interval_s: options.roll_interval_s ?? 60,
      }),
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(`Start record failed: ${error.detail || response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Stop recording session and finalize chunks.
   */
  async stopRecord(sessionId: string): Promise<RecordStopResponse> {
    const response = await fetch(`${this.baseUrl}/record/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }))
      throw new Error(`Stop record failed: ${error.detail || response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Get current session status.
   */
  async status(sessionId: string): Promise<RecordStatusResponse> {
    const url = new URL(`${this.baseUrl}/record/status`)
    url.searchParams.set('session_id', sessionId)

    const response = await fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      throw new Error(`Status failed: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Get list of finalized chunks with metadata.
   */
  async snapshots(sessionId: string): Promise<ChunkMetadata[]> {
    const url = new URL(`${this.baseUrl}/record/snapshots`)
    url.searchParams.set('session_id', sessionId)

    const response = await fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!response.ok) {
      throw new Error(`Snapshots failed: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Download a chunk file as ArrayBuffer.
   */
  async getFile(sessionId: string, filename: string): Promise<ArrayBuffer> {
    const response = await fetch(`${this.baseUrl}/files/${sessionId}/${filename}`, {
      method: 'GET',
      signal: AbortSignal.timeout(30000), // Longer timeout for file download
    })

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`)
    }

    return await response.arrayBuffer()
  }
}
