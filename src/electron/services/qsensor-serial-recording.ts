/**
 * Q-Sensor Serial Recording Service for Electron main process.
 *
 * Manages local recording for surface reference sensor (topside direct serial).
 * Integrates QSeriesSerialController with QSeriesLocalRecorder.
 */

console.log('[QSensor Serial Recording] Module loading...')

import { app, ipcMain } from 'electron'
console.log('[QSensor Serial Recording] Imported ipcMain, app')

import * as path from 'path'
console.log('[QSensor Serial Recording] Imported path')

import { ConnectionState, QSeriesSerialController } from './qsensor-serial-controller'
console.log('[QSensor Serial Recording] Imported QSeriesSerialController')

import { QSeriesLocalRecorder } from './qsensor-local-recorder'
console.log('[QSensor Serial Recording] Imported QSeriesLocalRecorder')

import { QSeriesReading } from './qsensor-protocol'
console.log('[QSensor Serial Recording] Imported QSeriesReading')

import store from './config-store'
console.log('[QSensor Serial Recording] Imported config-store')

import { v4 as uuidv4 } from 'uuid'
console.log('[QSensor Serial Recording] Imported uuidv4')

console.log('[QSensor Serial Recording] All imports completed successfully')

let SerialPort: any

// ============================================================================
// Global State
// ============================================================================

// Singleton instances
const serialController = new QSeriesSerialController()
const localRecorder = new QSeriesLocalRecorder()

// Active recording session state
let activeSessionId: string | null = null
let activeSyncId: string | null = null
let readingListenerAttached = false

// Cache for final session stats (preserved after recording stops)
/**
 *
 */
interface LastSessionStats {
  /**
   *
   */
  sessionId: string
  /**
   *
   */
  totalRows: number
  /**
   *
   */
  bytesFlushed: number
  /**
   *
   */
  stoppedAt: string
}
let lastSessionStats: LastSessionStats | null = null

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get default storage path for recordings
 */
function getDefaultStoragePath(): string {
  const customPath = store.get('qsensorStoragePath') as string | undefined
  return customPath || path.join(app.getPath('userData'), 'qsensor')
}

/**
 * Ensure controller is connected
 */
function ensureConnected(): void {
  if (!serialController.isConnected()) {
    throw new Error('Serial controller not connected. Call connect() first.')
  }
}

/**
 * Ensure not already recording
 */
function ensureNotRecording(): void {
  if (activeSessionId) {
    throw new Error(`Already recording session: ${activeSessionId}`)
  }
}

/**
 * Ensure recording is active
 */
function ensureRecording(): void {
  if (!activeSessionId) {
    throw new Error('No active recording session')
  }
}

// ============================================================================
// Serial Controller Operations
// ============================================================================

/**
 * Connect to surface sensor via serial
 * @param port
 * @param baudRate
 */
async function connect(
  port: string,
  baudRate = 9600
): Promise<{
  /**
))))))))))))) *
)))))))))))))
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  data?: any
  /**
dddddddddddd *
dddddddddddd
   */
  error?: string
}> {
  console.log(`[QSensor Serial] connect() called - port: ${port}, baudRate: ${baudRate}`)
  console.log(`[QSensor Serial] serialController exists: ${!!serialController}`)
  console.log(`[QSensor Serial] serialController.connect exists: ${typeof serialController?.connect}`)

  try {
    console.log('[QSensor Serial] About to call serialController.connect()...')
    await serialController.connect(port, baudRate)
    console.log('[QSensor Serial] serialController.connect() completed successfully')

    const config = serialController.getConfig()
    console.log('[QSensor Serial] Got config:', JSON.stringify(config))

    console.log('[QSensor Serial] Connected to surface sensor:', config.serial_number)

    const result = {
      success: true,
      data: {
        sensor_id: serialController.getSensorId(),
        state: serialController.getState(),
        config,
      },
    }
    console.log('[QSensor Serial] connect() returning success:', JSON.stringify(result))
    return result
  } catch (error: any) {
    console.error('[QSensor Serial] Connect failed:', error)
    console.error('[QSensor Serial] Error message:', error?.message)
    console.error('[QSensor Serial] Error stack:', error?.stack)
    console.error('[QSensor Serial] Error JSON:', JSON.stringify(error, Object.getOwnPropertyNames(error)))
    return { success: false, error: error.message || String(error) }
  }
}

/**
 * Disconnect from surface sensor
 */
async function disconnect(): Promise<{
  /**
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  data?: any
  /**
dddddddddddd *
dddddddddddd
   */
  error?: string
}> {
  try {
    // Stop recording if active
    if (activeSessionId) {
      console.warn('[QSensor Serial] Disconnecting while recording active. Stopping recording first.')
      await stopRecording()
    }

    await serialController.disconnect()
    console.log('[QSensor Serial] Disconnected')

    return { success: true, data: { state: 'disconnected' } }
  } catch (error: any) {
    console.error('[QSensor Serial] Disconnect failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Get serial controller health.
 * Normalizes snake_case from controller to camelCase for TypeScript consumers.
 */
async function getHealth(): Promise<{
  /**
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  data?: any
  /**
dddddddddddd *
dddddddddddd
   */
  error?: string
}> {
  try {
    const health = serialController.getHealth()
    const config = serialController.getConfig()

    // Normalize to camelCase for TypeScript consumers
    return {
      success: true,
      data: {
        connected: serialController.isConnected(),
        sensorId: health.sensor_id,
        state: health.state,
        tempC: health.tempC,
        vin: health.vin,
        bufferSize: health.buffer_size,
        lastReadingAgeMs: health.last_reading_age_ms,
        // Config data (if available)
        config: config
          ? {
              integrationTimeMs: config.integration_time_ms,
              internalAveraging: config.internal_averaging,
              rateHz: config.adc_rate_hz,
              mode: config.mode,
              tag: config.tag,
            }
          : null,
      },
    }
  } catch (error: any) {
    console.error('[QSensor Serial] Get health failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Start acquisition (without recording)
 * @param pollHz
 */
async function startAcquisition(pollHz = 1.0): Promise<{
  /**
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  data?: any
  /**
dddddddddddd *
dddddddddddd
   */
  error?: string
}> {
  try {
    ensureConnected()

    await serialController.startAcquisition(pollHz)

    console.log('[QSensor Serial] Acquisition started')

    return {
      success: true,
      data: {
        state: serialController.getState(),
        poll_hz: pollHz,
      },
    }
  } catch (error: any) {
    console.error('[QSensor Serial] Start acquisition failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Stop acquisition
 */
async function stopAcquisition(): Promise<{
  /**
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  data?: any
  /**
dddddddddddd *
dddddddddddd
   */
  error?: string
}> {
  try {
    await serialController.stop()

    console.log('[QSensor Serial] Acquisition stopped')

    return { success: true, data: { state: serialController.getState() } }
  } catch (error: any) {
    console.error('[QSensor Serial] Stop acquisition failed:', error.message)
    return { success: false, error: error.message }
  }
}

// ============================================================================
// Recording Operations
// ============================================================================

/**
 * Start local recording for surface sensor
 * @param params
 * @param params.mission
 * @param params.rollIntervalS
 * @param params.rateHz
 * @param params.storagePath
 * @param params.unifiedSessionTimestamp
 * @param params.syncId
 */
async function startRecording(params: {
  /**
   *
   */
  mission: string
  /**
   *
   */
  rollIntervalS?: number
  /**
   *
   */
  rateHz?: number
  /**
   *
   */
  storagePath?: string
  /**
   *
   */
  unifiedSessionTimestamp?: string
  /**
   *
   */
  syncId?: string
}): Promise<{
  /**
}}}}}}}}}}}}}} *
}}}}}}}}}}}}}}
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  data?: any
  /**
dddddddddddd *
dddddddddddd
   */
  error?: string
}> {
  try {
    ensureConnected()
    ensureNotRecording()

    const sensorId = serialController.getSensorId()
    const storagePath = params.storagePath || getDefaultStoragePath()
    const rollIntervalS = params.rollIntervalS ?? 60
    const rateHz = params.rateHz ?? 1.0

    // Set storage path in recorder
    localRecorder.setDefaultStoragePath(storagePath)

    // Start recording session with coordinated syncId
    const syncId = params.syncId ?? uuidv4()

    const sessionInfo = await localRecorder.startSession({
      sensorId,
      mission: params.mission,
      rollIntervalS,
      storagePath,
      unifiedSessionTimestamp: params.unifiedSessionTimestamp,
      syncId,
    })

    activeSessionId = sessionInfo.session_id
    activeSyncId = sessionInfo.syncId

    // Attach reading listener if not already attached
    if (!readingListenerAttached) {
      serialController.on('reading', (reading: QSeriesReading) => {
        if (activeSessionId) {
          localRecorder.addReading(activeSessionId, reading)
        }
      })
      readingListenerAttached = true
      console.log('[QSensor Serial] Reading listener attached')
    }

    // Start acquisition if not already running
    const currentState = serialController.getState()
    if (currentState === ConnectionState.CONFIG_MENU) {
      await serialController.startAcquisition(rateHz)
      console.log('[QSensor Serial] Started acquisition for recording')
    } else if (currentState === ConnectionState.ACQ_FREERUN || currentState === ConnectionState.ACQ_POLLED) {
      console.log('[QSensor Serial] Acquisition already running, using existing stream')
    } else {
      throw new Error(`Cannot start recording in state: ${currentState}`)
    }

    console.log('[QSensor Serial] Recording started:', sessionInfo)

    return {
      success: true,
      data: {
        session_id: sessionInfo.session_id,
        started_at: sessionInfo.started_at,
        sensor_id: sensorId,
        mission: params.mission,
        storage_path: storagePath,
        sync_id: sessionInfo.syncId,
      },
    }
  } catch (error: any) {
    console.error('[QSensor Serial] Start recording failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Stop local recording for surface sensor
 */
async function stopRecording(): Promise<{
  /**
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  data?: any
  /**
dddddddddddd *
dddddddddddd
   */
  error?: string
}> {
  try {
    ensureRecording()

    const sessionId = activeSessionId!
    const syncId = activeSyncId

    // Get final stats before stopping (for cache)
    const finalStats = await localRecorder.getStats(sessionId)

    // Stop recording session (finalizes chunks, creates session.csv)
    await localRecorder.stopSession(sessionId)
    activeSyncId = null
    activeSyncId = null

    // Stop acquisition - return sensor to CONFIG_MENU state
    await serialController.stop()

    // Cache final stats for retrieval after session ends
    const stoppedAt = new Date().toISOString()
    lastSessionStats = {
      sessionId,
      totalRows: finalStats.totalRows || 0,
      bytesFlushed: finalStats.bytesFlushed || 0,
      stoppedAt,
    }

    activeSessionId = null

    console.log('[QSensor Serial] Recording stopped:', sessionId)

    return {
      success: true,
      data: {
        session_id: sessionId,
        stopped_at: stoppedAt,
        total_rows: lastSessionStats.totalRows,
        bytes_flushed: lastSessionStats.bytesFlushed,
        sync_id: syncId,
      },
    }
  } catch (error: any) {
    console.error('[QSensor Serial] Stop recording failed:', error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Get recording statistics
 */
async function getRecordingStats(): Promise<{
  /**
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa *
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
   */
  success: boolean
  /**
ssssssssssssssssss *
ssssssssssssssssss
   */
  data?: any
  /**
dddddddddddd *
dddddddddddd
   */
  error?: string
}> {
  try {
    if (!activeSessionId) {
      // Not actively recording - return cached stats from last session if available
      if (lastSessionStats) {
        return {
          success: true,
          data: {
            recording: false,
            sessionId: lastSessionStats.sessionId,
            totalRows: lastSessionStats.totalRows,
            bytesFlushed: lastSessionStats.bytesFlushed,
            stoppedAt: lastSessionStats.stoppedAt,
          },
        }
      }
      return { success: true, data: { recording: false } }
    }

    const stats = await localRecorder.getStats(activeSessionId)

    return {
      success: true,
      data: {
        recording: true,
        ...stats,
      },
    }
  } catch (error: any) {
    console.error('[QSensor Serial] Get recording stats failed:', error.message)
    return { success: false, error: error.message }
  }
}

// ============================================================================
// IPC Setup
// ============================================================================

/**
 * Setup IPC handlers for Q-Sensor serial recording
 */
export function setupQSensorSerialRecordingService(): void {
  console.log('[QSensor Serial Recording] ENTER setupQSensorSerialRecordingService()')

  if (!SerialPort) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const serialportModule = require('serialport')
      SerialPort = serialportModule.SerialPort ?? serialportModule
      console.log('[QSensor Serial Recording] Loaded serialport native module successfully')
    } catch (error) {
      console.error('[QSensor Serial Recording] FAILED to load serialport native module:', error)
      throw error
    }
  }

  try {
    // Log dependencies
    console.log('[QSensor Serial Recording] Checking dependencies...')
    console.log(`[QSensor Serial Recording] - ipcMain: ${typeof ipcMain}`)
    console.log(`[QSensor Serial Recording] - SerialPort: ${typeof SerialPort}`)
    console.log(`[QSensor Serial Recording] - serialController: ${typeof serialController}`)
    console.log(`[QSensor Serial Recording] - localRecorder: ${typeof localRecorder}`)

    // Port enumeration
    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:list-ports')
    ipcMain.handle('qsensor-serial:list-ports', async () => {
      console.log('[QSensor Serial] IPC handler invoked: qsensor-serial:list-ports')
      try {
        const ports = await SerialPort.list()
        console.log(`[QSensor Serial] Found ${ports.length} serial ports`)
        return {
          success: true,
          data: ports.map((port) => ({
            path: port.path,
            manufacturer: port.manufacturer || null,
            serialNumber: port.serialNumber || null,
            vendorId: port.vendorId || null,
            productId: port.productId || null,
            // Flag likely Q-Sensor devices (FTDI chips commonly used)
            isLikelyQSensor:
              port.manufacturer?.toLowerCase().includes('ftdi') ||
              port.manufacturer?.toLowerCase().includes('silicon labs') ||
              port.path.includes('ttyUSB') ||
              port.path.includes('ttyACM') ||
              port.path.includes('COM'),
          })),
        }
      } catch (error: any) {
        console.error('[QSensor Serial] List ports failed:', error?.message || error)
        console.error('[QSensor Serial] List ports error stack:', error?.stack)
        throw new Error(error?.message || 'Failed to list serial ports')
      }
    })
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:list-ports')

    // Controller operations
    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:connect')
    ipcMain.handle('qsensor-serial:connect', async (_event, port: string, baudRate: number) => {
      console.log(`[QSensor Serial] IPC handler invoked: qsensor-serial:connect - port: ${port}, baudRate: ${baudRate}`)
      try {
        const result = await connect(port, baudRate)
        console.log('[QSensor Serial] IPC handler returning:', JSON.stringify(result))
        return result
      } catch (error: any) {
        console.error('[QSensor Serial] IPC handler qsensor-serial:connect threw:', error)
        console.error('[QSensor Serial] Error message:', error?.message)
        console.error('[QSensor Serial] Error stack:', error?.stack)
        // Re-throw so IPC surfaces it
        throw error
      }
    })
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:connect')

    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:disconnect')
    ipcMain.handle('qsensor-serial:disconnect', async (_event) => {
      console.log('[QSensor Serial] IPC handler invoked: qsensor-serial:disconnect')
      return await disconnect()
    })
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:disconnect')

    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:get-health')
    ipcMain.handle('qsensor-serial:get-health', async (_event) => {
      console.log('[QSensor Serial] IPC handler invoked: qsensor-serial:get-health')
      return await getHealth()
    })
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:get-health')

    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:start-acquisition')
    ipcMain.handle('qsensor-serial:start-acquisition', async (_event, pollHz: number) => {
      console.log(`[QSensor Serial] IPC handler invoked: qsensor-serial:start-acquisition - pollHz: ${pollHz}`)
      return await startAcquisition(pollHz)
    })
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:start-acquisition')

    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:stop-acquisition')
    ipcMain.handle('qsensor-serial:stop-acquisition', async (_event) => {
      console.log('[QSensor Serial] IPC handler invoked: qsensor-serial:stop-acquisition')
      return await stopAcquisition()
    })
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:stop-acquisition')

    // Recording operations
    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:start-recording')
    ipcMain.handle(
      'qsensor-serial:start-recording',
      async (
        _event,
        params: {
          /**
           *
           */
          mission: string
          /**
           *
           */
          rollIntervalS?: number
          /**
           *
           */
          rateHz?: number
          /**
           *
           */
          storagePath?: string
          /**
           *
           */
          unifiedSessionTimestamp?: string
        }
      ) => {
        console.log('[QSensor Serial] IPC handler invoked: qsensor-serial:start-recording', JSON.stringify(params))
        return await startRecording(params)
      }
    )
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:start-recording')

    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:stop-recording')
    ipcMain.handle('qsensor-serial:stop-recording', async (_event) => {
      console.log('[QSensor Serial] IPC handler invoked: qsensor-serial:stop-recording')
      return await stopRecording()
    })
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:stop-recording')

    console.log('[QSensor Serial Recording] Registering handler: qsensor-serial:get-stats')
    ipcMain.handle('qsensor-serial:get-stats', async (_event) => {
      console.log('[QSensor Serial] IPC handler invoked: qsensor-serial:get-stats')
      return await getRecordingStats()
    })
    console.log('[QSensor Serial Recording] Registered handler: qsensor-serial:get-stats')

    console.log('[QSensor Serial Recording] All handlers registered successfully')
    console.log('[QSensor Serial Recording] Service registered')
  } catch (error: any) {
    console.error('[QSensor Serial Recording] FATAL: setupQSensorSerialRecordingService() failed')
    console.error('[QSensor Serial Recording] Error:', error)
    console.error('[QSensor Serial Recording] Error message:', error?.message)
    console.error('[QSensor Serial Recording] Error stack:', error?.stack)
    console.error('[QSensor Serial Recording] Error JSON:', JSON.stringify(error, Object.getOwnPropertyNames(error)))
    // Re-throw to surface the error loudly
    throw error
  }
}
