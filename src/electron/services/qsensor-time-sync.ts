/**
 * Q-Sensor Time Synchronization Service for Electron main process.
 *
 * Implements HTTP round-trip time measurement between Pi and topside.
 * Provides clock offset and uncertainty for sync_metadata.json population.
 *
 * Phase 2: Infrastructure only - no integration with recording workflow yet.
 */

import { ipcMain } from 'electron'

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a time synchronization measurement.
 */
export interface TimeSyncResult {
  /** Sync method: "ntp_handshake_v1" | "unsynced" */
  method: string
  /** Clock offset in milliseconds (Pi - Topside). Null on failure. */
  offsetMs: number | null
  /** Measurement uncertainty in milliseconds (RTT/2). Null on failure. */
  uncertaintyMs: number | null
  /** ISO timestamp when topside started the request */
  topsideRequestStart: string
  /** ISO timestamp from Pi response. Null on failure. */
  piResponseTime: string | null
  /** ISO timestamp when topside received response */
  topsideResponseEnd: string
  /** Error type if sync failed: "timeout" | "network_error" | "high_rtt" | "invalid_pi_time" */
  error?: string
}

/**
 * Response from Pi /api/sync/time endpoint.
 */
interface TimeSyncResponse {
  /** ISO 8601 timestamp from Pi */
  pi_iso: string
  /** Unix milliseconds from Pi */
  pi_unix_ms: number
  /** Container/API version */
  container_version: string
  /** Schema version for this response */
  schema_version: number
}

// ============================================================================
// Constants
// ============================================================================

/** Request timeout in milliseconds */
const TIMEOUT_MS = 5000

/** Maximum acceptable RTT before flagging as high_rtt */
const MAX_RTT_MS = 200

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Perform HTTP round-trip time measurement with Pi.
 *
 * Algorithm:
 * - T1: Topside records local timestamp
 * - Request /api/sync/time from Pi
 * - T4: Topside records local timestamp
 * - RTT = T4 - T1
 * - Offset = pi_unix_ms - (T1 + RTT/2)
 * - Uncertainty = RTT/2
 *
 * @param baseUrl - Pi API base URL (e.g., "http://blueos.local:9150")
 * @returns TimeSyncResult with offset, uncertainty, and timestamps
 */
export async function measureClockOffset(baseUrl: string): Promise<TimeSyncResult> {
  const topsideRequestStart = new Date().toISOString()
  const startTime = Date.now()

  try {
    const url = `${baseUrl}/api/sync/time`

    // Create abort controller for timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const piData: TimeSyncResponse = await response.json()
    const endTime = Date.now()
    const topsideResponseEnd = new Date().toISOString()

    // Validate Pi response has required fields
    if (typeof piData.pi_unix_ms !== 'number' || !piData.pi_iso) {
      console.error('[QSensor Time Sync] Invalid Pi response:', piData)
      return {
        method: 'unsynced',
        offsetMs: null,
        uncertaintyMs: null,
        topsideRequestStart,
        piResponseTime: null,
        topsideResponseEnd,
        error: 'invalid_pi_time',
      }
    }

    // Calculate RTT, offset, and uncertainty
    const rtt = endTime - startTime
    const offsetMs = piData.pi_unix_ms - (startTime + rtt / 2)
    const uncertaintyMs = rtt / 2

    // Check if RTT is acceptable
    if (rtt > MAX_RTT_MS) {
      console.warn(`[QSensor Time Sync] High RTT: ${rtt}ms (threshold: ${MAX_RTT_MS}ms)`)
      return {
        method: 'ntp_handshake_v1',
        offsetMs: null,
        uncertaintyMs: null,
        topsideRequestStart,
        piResponseTime: piData.pi_iso,
        topsideResponseEnd,
        error: 'high_rtt',
      }
    }

    console.log(
      `[QSensor Time Sync] Offset: ${Math.round(offsetMs)}ms ±${Math.round(uncertaintyMs)}ms (RTT: ${rtt}ms)`
    )

    return {
      method: 'ntp_handshake_v1',
      offsetMs: Math.round(offsetMs),
      uncertaintyMs: Math.round(uncertaintyMs),
      topsideRequestStart,
      piResponseTime: piData.pi_iso,
      topsideResponseEnd,
    }
  } catch (error: any) {
    const topsideResponseEnd = new Date().toISOString()

    // Determine error type
    let errorType: string
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      errorType = 'timeout'
      console.error(`[QSensor Time Sync] Request timeout (${TIMEOUT_MS}ms)`)
    } else {
      errorType = 'network_error'
      console.error('[QSensor Time Sync] Network error:', error.message)
    }

    return {
      method: 'unsynced',
      offsetMs: null,
      uncertaintyMs: null,
      topsideRequestStart,
      piResponseTime: null,
      topsideResponseEnd,
      error: errorType,
    }
  }
}

// ============================================================================
// IPC Setup
// ============================================================================

/**
 * Setup IPC handlers for time synchronization service.
 */
export function setupQSensorTimeSyncService(): void {
  ipcMain.handle('qsensor:measure-clock-offset', async (_event, baseUrl: string) => {
    return await measureClockOffset(baseUrl)
  })

  console.log('[QSensor Time Sync] Service registered')
}
