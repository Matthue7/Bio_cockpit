/**
 * Q-Sensor control service for Electron main process.
 *
 * Proxies API calls to Q_Sensor_API to avoid CORS issues.
 * Electron main process can make HTTP requests without CORS restrictions.
 */

import { ipcMain } from 'electron'

/**
 * Make a fetch request from Electron main (bypasses CORS)
 */
async function fetchFromMain(url: string, options: RequestInit = {}): Promise<any> {
  const method = options.method || 'GET'

  try {
    console.log(`[QSensor][HTTP] ${method} ${url}`)
    const response = await fetch(url, options)
    console.log(`[QSensor][HTTP] ${method} ${url} → ${response.status} ${response.statusText}`)

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }))
      const errorMsg = error.detail || response.statusText
      console.error(`[QSensor][HTTP] ${method} ${url} ERROR: ${errorMsg}`)
      throw new Error(errorMsg)
    }

    return await response.json()
  } catch (error: any) {
    console.error(`[QSensor][HTTP] ${method} ${url} FAILED: ${error.message}`)
    throw new Error(error.message || 'Request failed')
  }
}

/**
 * Connect to Q-Sensor via serial port
 */
async function connect(
  baseUrl: string,
  port: string,
  baud: number
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const url = new URL('/sensor/connect', baseUrl)
    url.searchParams.set('port', port)
    url.searchParams.set('baud', String(baud))

    // 30 second timeout - connection can take time to enter config menu
    const data = await fetchFromMain(url.toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
    })

    console.log('[QSensor Control] Connected:', data)
    return { success: true, data }
  } catch (error: any) {
    console.error('[QSensor Control] Connect failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Disconnect from Q-Sensor
 */
async function disconnect(baseUrl: string): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    // Use /disconnect (not /sensor/disconnect) - server has no alias for this endpoint
    const url = new URL('/disconnect', baseUrl)

    const data = await fetchFromMain(url.toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(10000), // Increased to 10s - disconnect may need to stop acquisition first
    })

    console.log('[QSensor Control] Disconnected:', data)
    return { success: true, data }
  } catch (error: any) {
    console.error('[QSensor Control] Disconnect failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Get instrument health status
 */
async function getHealth(baseUrl: string): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    // Robust URL construction - handles trailing slashes correctly
    const url = new URL('/instrument/health', baseUrl)

    const data = await fetchFromMain(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })

    console.log('[QSensor Control] Health:', data)
    return { success: true, data }
  } catch (error: any) {
    console.error('[QSensor Control] Health check failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Start sensor acquisition
 */
async function startAcquisition(
  baseUrl: string,
  pollHz?: number
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const url = new URL('/sensor/start', baseUrl)
    if (pollHz !== undefined) {
      url.searchParams.set('poll_hz', String(pollHz))
    }

    // Increased to 15s - acquisition start can be slow (serial config, auto-record setup)
    const data = await fetchFromMain(url.toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    })

    console.log('[QSensor Control] Acquisition started:', data)
    return { success: true, data }
  } catch (error: any) {
    console.error('[QSensor Control] Start acquisition failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Stop sensor acquisition
 */
async function stopAcquisition(baseUrl: string): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const url = new URL('/sensor/stop', baseUrl)

    // Increased to 10s - stop may need to flush data
    const data = await fetchFromMain(url.toString(), {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    })

    console.log('[QSensor Control] Acquisition stopped:', data)
    return { success: true, data }
  } catch (error: any) {
    console.error('[QSensor Control] Stop acquisition failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Start recording session
 */
async function startRecording(
  baseUrl: string,
  options: {
    rate_hz?: number
    schema_version?: number
    mission?: string
    roll_interval_s?: number
  }
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    // Robust URL construction - handles trailing slashes correctly
    const url = new URL('/record/start', baseUrl)

    const data = await fetchFromMain(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rate_hz: options.rate_hz ?? 500,
        schema_version: options.schema_version ?? 1,
        mission: options.mission ?? 'Cockpit',
        roll_interval_s: options.roll_interval_s ?? 60,
      }),
      signal: AbortSignal.timeout(5000),
    })

    console.log('[QSensor Control] Recording started:', data)
    return { success: true, data }
  } catch (error: any) {
    console.error('[QSensor Control] Start recording failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Stop recording session
 */
async function stopRecording(baseUrl: string, sessionId: string): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    // Robust URL construction - handles trailing slashes correctly
    const url = new URL('/record/stop', baseUrl)

    const data = await fetchFromMain(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(5000),
    })

    console.log('[QSensor Control] Recording stopped:', data)
    return { success: true, data }
  } catch (error: any) {
    console.error('[QSensor Control] Stop recording failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Setup IPC handlers for Q-Sensor control
 */
export function setupQSensorControlService(): void {
  ipcMain.handle('qsensor:connect', async (_event, baseUrl: string, port: string, baud: number) => {
    return await connect(baseUrl, port, baud)
  })

  ipcMain.handle('qsensor:disconnect', async (_event, baseUrl: string) => {
    return await disconnect(baseUrl)
  })

  ipcMain.handle('qsensor:get-health', async (_event, baseUrl: string) => {
    return await getHealth(baseUrl)
  })

  ipcMain.handle('qsensor:start-acquisition', async (_event, baseUrl: string, pollHz?: number) => {
    return await startAcquisition(baseUrl, pollHz)
  })

  ipcMain.handle('qsensor:stop-acquisition', async (_event, baseUrl: string) => {
    return await stopAcquisition(baseUrl)
  })

  ipcMain.handle('qsensor:start-recording', async (_event, baseUrl: string, options: any) => {
    return await startRecording(baseUrl, options)
  })

  ipcMain.handle('qsensor:stop-recording', async (_event, baseUrl: string, sessionId: string) => {
    return await stopRecording(baseUrl, sessionId)
  })

  console.log('[QSensor Control] Service registered')
}
