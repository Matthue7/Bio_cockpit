// * Q-Series Serial Controller (TypeScript)
// * Topside control layer for the Q-Series surface reference sensor: serial communication, menu navigation, data acquisition.
// * ARCHITECTURE:
// * - Opens/closes serial port on topside computer
// * - Manages connection lifecycle and state machine
// * - Implements connect/configure/start/stop/health methods
// * - Manages freerun acquisition with event-based reading emission
// * - Integrates with existing Electron serial infrastructure
// * REFERENCE:
// * Based on Python implementation in q_sensor_lib/controller.py while matching Node/Electron patterns.

import EventEmitter from 'events'
import { performance } from 'perf_hooks'

import { SerialLink } from './link/serial'
import {
  AVERAGING_MAX,
  AVERAGING_MIN,
  DELAY_POST_OPEN,
  DELAY_POST_RESET,
  // Constants
  ESC,
  INPUT_TERMINATOR,
  InvalidFrameError,
  makePolledInitCmd,
  makePolledQueryCmd,
  MENU_CMD_AVERAGING,
  MENU_CMD_CONFIG_DUMP,
  MENU_CMD_EXIT,
  MENU_CMD_MODE,
  MENU_CMD_RATE,
  MENU_REDISPLAY_DELAY,
  QSeriesData,
  QSeriesMode,
  QSeriesProtocolParser,
  QSeriesReading,
  QSeriesSensorConfig,
  RE_AVERAGING_SET,
  RE_ERROR_BAD_TAG,
  RE_MENU_PROMPT,
  RE_MODE_PROMPT,
  RE_RATE_PROMPT,
  RE_RATE_SET,
  RE_TAG_PROMPT,
  TIMEOUT_MENU_PROMPT,
  VALID_ADC_RATES,
  VALID_TAGS,
} from './qsensor-protocol'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 *
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONFIG_MENU = 'config_menu',
  ACQ_FREERUN = 'acq_freerun',
  ACQ_POLLED = 'acq_polled',
  PAUSED = 'paused',
}

/**
 *
 */
export interface SerialControllerConfig {
  /**
   *
   */
  port: string
  /**
   *
   */
  baudRate: number
}

/**
 *
 */
export interface HealthData {
  /**
   *
   */
  sensor_id: string
  /**
   *
   */
  state: ConnectionState
  /**
   *
   */
  tempC?: number
  /**
   *
   */
  vin?: number
  /**
   *
   */
  buffer_size: number
  /**
   *
   */
  last_reading_age_ms?: number
}

// ============================================================================
// Custom Errors
// ============================================================================

/**
 *
 */
export class SerialIOError extends Error {
  /**
   *
   * @param message
   */
  constructor(message: string) {
    super(message)
    this.name = 'SerialIOError'
  }
}

/**
 *
 */
export class MenuTimeoutError extends Error {
  /**
   *
   * @param message
   */
  constructor(message: string) {
    super(message)
    this.name = 'MenuTimeoutError'
  }
}

/**
 *
 */
export class InvalidConfigValueError extends Error {
  /**
   *
   * @param message
   */
  constructor(message: string) {
    super(message)
    this.name = 'InvalidConfigValueError'
  }
}

// ============================================================================
// QSeriesSerialController Class
// ============================================================================

// * High-level controller for Q-Series sensor with state management.
// * Orchestrates connection, configuration, acquisition, buffering, and event emission.
// * EVENT EMISSION: 'reading', 'error', 'state-change'.
// ! THREAD SAFETY: Not thread-safe; call from main Electron thread only.
/**
 *
 */
export class QSeriesSerialController extends EventEmitter {
  private link: SerialLink | null = null
  private parser: QSeriesProtocolParser
  private state: ConnectionState = ConnectionState.DISCONNECTED
  private config: QSeriesSensorConfig | null = null
  private sensorId = 'unknown'

  // Connection parameters for reconnection
  private lastPort: string | null = null
  private lastBaud = 9600

  // Acquisition state
  private acquisitionInterval: NodeJS.Timeout | null = null
  private lastPolledTag: string | null = null
  private lastPollHz = 1.0

  // Reading tracking
  private lastReadingTimestamp: number | null = null
  private lineBuffer: string[] = []

  /**
   *
   */
  constructor() {
    super()
    this.parser = new QSeriesProtocolParser()
  }

  // Allow tests to override scheduling behavior
  /**
   *
   * @param callback
   * @param periodMs
   */
  protected scheduleInterval(callback: () => void, periodMs: number): NodeJS.Timeout {
    return setInterval(callback, periodMs)
  }

  /**
   *
   * @param handle
   */
  protected clearScheduledInterval(handle: NodeJS.Timeout): void {
    clearInterval(handle)
  }

  // ========================================================================
  // Factory Methods (for test injection)
  // ========================================================================

  // * Create a serial link instance (protected for test mocking).
  /**
   *
   * @param port
   * @param baudRate
   */
  protected createSerialLink(port: string, baudRate: number): SerialLink {
    const uri = new URL(`serial:${port}?baudrate=${baudRate}`)
    return new SerialLink(uri)
  }

  // ========================================================================
  // Connection Management
  // ========================================================================

  // * Connect to sensor and enter configuration menu (forces ESC, waits for menu prompt, reads config snapshot).
  /**
   *
   * @param port
   * @param baudRate
   */
  async connect(port: string, baudRate = 9600): Promise<void> {
    console.log(`[QSeriesSerial] connect() called - port: ${port}, baudRate: ${baudRate}, currentState: ${this.state}`)

    if (this.state !== ConnectionState.DISCONNECTED) {
      const errorMsg = `Already connected (state: ${this.state})`
      console.error(`[QSeriesSerial] connect() rejected: ${errorMsg}`)
      throw new SerialIOError(errorMsg)
    }

    // Store connection params for reconnection
    this.lastPort = port
    this.lastBaud = baudRate
    console.log('[QSeriesSerial] Stored connection params')

    // Create serial link via factory method (allows test injection)
    console.log(`[QSeriesSerial] Creating SerialLink with port: ${port}, baudRate: ${baudRate}`)
    try {
      this.link = this.createSerialLink(port, baudRate)
      console.log('[QSeriesSerial] SerialLink created successfully')
    } catch (error: any) {
      console.error('[QSeriesSerial] Failed to create SerialLink:', error)
      console.error('[QSeriesSerial] Error message:', error?.message)
      console.error('[QSeriesSerial] Error stack:', error?.stack)
      throw error
    }

    // Set up data handler
    console.log('[QSeriesSerial] Setting up event handlers on link')
    this.link.on('data', (data: Buffer) => this.handleSerialData(data))
    this.link.on('error', (error: Error) => this.handleSerialError(error))
    this.link.on('close', () => this.handleSerialClose())

    // Open port
    console.log('[QSeriesSerial] About to call link.open()...')
    try {
      await this.link.open()
      console.log('[QSeriesSerial] link.open() completed successfully')
    } catch (error: any) {
      console.error('[QSeriesSerial] link.open() failed:', error)
      console.error('[QSeriesSerial] Error message:', error?.message)
      console.error('[QSeriesSerial] Error stack:', error?.stack)
      this.link = null
      throw new SerialIOError(`Failed to open port ${port}: ${error}`)
    }

    // Enter menu and read config
    console.log('[QSeriesSerial] Port opened, entering menu...')
    try {
      await this.enterMenu()
      console.log('[QSeriesSerial] Entered menu, reading config snapshot...')
      this.config = await this.readConfigSnapshot()
      console.log('[QSeriesSerial] Config snapshot read:', JSON.stringify(this.config))
      this.state = ConnectionState.CONFIG_MENU
      this.emitStateChange()

      console.log(`[QSeriesSerial] Connected to ${this.sensorId}, config:`, this.config)
    } catch (error: any) {
      console.error('[QSeriesSerial] Menu/config phase failed:', error)
      console.error('[QSeriesSerial] Error message:', error?.message)
      console.error('[QSeriesSerial] Error stack:', error?.stack)
      // Clean up on failure
      await this.disconnect()
      throw error
    }
  }

  // * Disconnect from sensor and clean up resources (stop acquisition, close port, reset state).
  /**
   *
   */
  async disconnect(): Promise<void> {
    if (this.state === ConnectionState.DISCONNECTED) {
      return
    }

    console.log('[QSeriesSerial] Disconnecting...')

    // Stop acquisition if running
    this.stopAcquisitionLoop()

    // Close serial port
    if (this.link) {
      try {
        await this.link.close()
      } catch (error) {
        console.error('[QSeriesSerial] Error closing port:', error)
      }
      this.link = null
    }

    this.state = ConnectionState.DISCONNECTED
    this.emitStateChange()
    console.log('[QSeriesSerial] Disconnected')
  }

  // * Reconnect to sensor using last known port/baud.
  /**
   *
   */
  async reconnect(): Promise<void> {
    if (!this.lastPort) {
      throw new SerialIOError('Cannot reconnect: no previous connection')
    }

    console.log(`[QSeriesSerial] Reconnecting to ${this.lastPort}...`)

    if (this.state !== ConnectionState.DISCONNECTED) {
      await this.disconnect()
    }

    await this.connect(this.lastPort, this.lastBaud)
  }

  // ========================================================================
  // Configuration Methods
  // ========================================================================

  // * Get current sensor configuration (requires CONFIG_MENU state).
  /**
   *
   */
  getConfig(): QSeriesSensorConfig {
    if (this.state !== ConnectionState.CONFIG_MENU) {
      throw new SerialIOError(`Cannot get config in state ${this.state}. Must be in CONFIG_MENU.`)
    }

    if (!this.config) {
      throw new SerialIOError('Configuration not available')
    }

    return this.config
  }

  // * Set number of readings to average (1-65535) while in CONFIG_MENU.
  /**
   *
   * @param n
   */
  async setAveraging(n: number): Promise<QSeriesSensorConfig> {
    this.ensureInMenu()

    if (n < AVERAGING_MIN || n > AVERAGING_MAX) {
      throw new InvalidConfigValueError(`Averaging must be ${AVERAGING_MIN}-${AVERAGING_MAX}, got ${n}`)
    }

    console.log(`[QSeriesSerial] Setting averaging to ${n}...`)

    // Send 'A' command
    await this.writeCommand(MENU_CMD_AVERAGING)

    // Wait for averaging prompt
    if (!(await this.waitForPrompt(/Enter # readings to average/i, 5000))) {
      throw new MenuTimeoutError('Did not receive averaging prompt')
    }

    // Send value
    await this.writeCommand(String(n))

    // Wait for confirmation
    const confirmed = await this.waitForPattern(RE_AVERAGING_SET, 10000, (match) => parseInt(match[1], 10) === n)

    if (!confirmed) {
      throw new MenuTimeoutError('Averaging not confirmed by device')
    }

    // Update cached config
    if (this.config) {
      this.config.averaging = n
    }

    // Wait for menu to redisplay
    await this.waitForMenuPrompt()
    await this.delay(MENU_REDISPLAY_DELAY)

    return this.getConfig()
  }

  // * Set ADC sample rate (valid: 4, 8, 16, 33, 62, 125, 250, 500 Hz) while in CONFIG_MENU.
  /**
   *
   * @param rateHz
   */
  async setAdcRate(rateHz: number): Promise<QSeriesSensorConfig> {
    this.ensureInMenu()

    if (!VALID_ADC_RATES.has(rateHz)) {
      throw new InvalidConfigValueError(
        `ADC rate must be one of ${Array.from(VALID_ADC_RATES).join(', ')}, got ${rateHz}`
      )
    }

    console.log(`[QSeriesSerial] Setting ADC rate to ${rateHz} Hz...`)

    // Send 'R' command
    await this.writeCommand(MENU_CMD_RATE)

    // Wait for rate prompt (multi-line)
    if (!(await this.waitForPrompt(RE_RATE_PROMPT, 5000))) {
      throw new MenuTimeoutError('Did not receive rate prompt')
    }

    // Wait for second line of prompt
    await this.delay(500)

    // Send value
    await this.writeCommand(String(rateHz))

    // Wait for confirmation
    const confirmed = await this.waitForPattern(RE_RATE_SET, 15000, (match) => parseInt(match[1], 10) === rateHz)

    if (!confirmed) {
      throw new MenuTimeoutError('Rate not confirmed by device')
    }

    // Update cached config
    if (this.config) {
      this.config.adc_rate_hz = rateHz
    }

    // Wait for menu to redisplay
    await this.waitForMenuPrompt()
    await this.delay(MENU_REDISPLAY_DELAY)

    return this.getConfig()
  }

  // * Set operating mode (freerun or polled). Polled requires a single uppercase tag.
  /**
   *
   * @param mode
   * @param tag
   */
  async setMode(mode: QSeriesMode, tag: string | null = null): Promise<QSeriesSensorConfig> {
    this.ensureInMenu()

    if (mode === 'polled') {
      if (!tag || tag.length !== 1 || !VALID_TAGS.includes(tag)) {
        throw new InvalidConfigValueError(`Tag must be single uppercase A-Z for polled mode, got '${tag}'`)
      }
    }

    console.log(`[QSeriesSerial] Setting mode to ${mode}${tag ? ` with tag '${tag}'` : ''}...`)

    // Send 'M' command (single char, no CR)
    await this.writeBytes(Buffer.from(MENU_CMD_MODE, 'ascii'))

    // Wait for mode prompt
    if (!(await this.waitForPrompt(RE_MODE_PROMPT, 5000))) {
      throw new MenuTimeoutError('Did not receive mode prompt')
    }

    await this.delay(500)

    // Send mode choice ('0' for freerun, '1' for polled)
    const modeChar = mode === 'freerun' ? '0' : '1'
    await this.writeBytes(Buffer.from(modeChar, 'ascii'))

    if (mode === 'polled' && tag) {
      // Wait for TAG prompt
      if (!(await this.waitForPrompt(RE_TAG_PROMPT, 5000))) {
        throw new MenuTimeoutError('Did not receive TAG prompt')
      }

      await this.delay(500)

      // Send TAG character
      await this.writeBytes(Buffer.from(tag, 'ascii'))

      // Check for bad tag error
      await this.delay(1000)
      const errorLine = this.lineBuffer.find((line) => RE_ERROR_BAD_TAG.test(line))
      if (errorLine) {
        throw new InvalidConfigValueError(`Device rejected TAG '${tag}': ${errorLine}`)
      }
    }

    // Update cached config
    if (this.config) {
      this.config.mode = mode
      this.config.tag = tag
    }

    // Wait for menu to redisplay (mode change triggers banner)
    await this.delay(1000)
    await this.waitForMenuPrompt(10000)

    return this.getConfig()
  }

  // ========================================================================
  // Acquisition Control
  // ========================================================================

  // * Exit menu and start data acquisition in configured mode (freerun or polled).
  /**
   *
   * @param pollHz
   */
  async startAcquisition(pollHz = 1.0): Promise<void> {
    this.ensureInMenu()

    if (!this.config) {
      throw new SerialIOError('No configuration available')
    }

    console.log(`[QSeriesSerial] Starting acquisition in ${this.config.mode} mode...`)

    // Send 'X' to exit menu (triggers device reset)
    await this.writeCommand(MENU_CMD_EXIT)

    // Wait for device to reboot
    console.log('[QSeriesSerial] Device resetting, waiting for reboot...')
    await this.delay(DELAY_POST_RESET)

    // Clear parser buffer (discard banner)
    this.parser.clearBuffer()
    this.lineBuffer = []

    // Start appropriate acquisition mode
    if (this.config.mode === 'freerun') {
      this.state = ConnectionState.ACQ_FREERUN
      this.startFreerunLoop()
    } else if (this.config.mode === 'polled') {
      this.state = ConnectionState.ACQ_POLLED
      this.lastPollHz = pollHz
      this.lastPolledTag = this.config.tag || 'A'
      await this.startPolledLoop(this.lastPolledTag, pollHz)
    }

    this.emitStateChange()
    console.log(`[QSeriesSerial] Acquisition started in ${this.config.mode} mode`)
  }

  // * Pause acquisition and enter menu (stops loops, sends ESC).
  /**
   *
   */
  async pause(): Promise<void> {
    if (this.state !== ConnectionState.ACQ_FREERUN && this.state !== ConnectionState.ACQ_POLLED) {
      throw new SerialIOError(`Cannot pause from state ${this.state}. Must be acquiring.`)
    }

    console.log('[QSeriesSerial] Pausing acquisition...')

    // Stop acquisition loop
    this.stopAcquisitionLoop()

    // Enter menu
    await this.enterMenu()

    this.state = ConnectionState.PAUSED
    this.emitStateChange()
    console.log('[QSeriesSerial] Acquisition paused, in menu')
  }

  // * Resume acquisition from paused state.
  /**
   *
   */
  async resume(): Promise<void> {
    if (this.state !== ConnectionState.PAUSED) {
      throw new SerialIOError(`Cannot resume from state ${this.state}. Must be PAUSED.`)
    }

    console.log('[QSeriesSerial] Resuming acquisition...')

    // Re-read config
    this.config = await this.readConfigSnapshot()

    // Exit menu and restart acquisition
    this.state = ConnectionState.CONFIG_MENU
    await this.startAcquisition(this.lastPollHz)
  }

  // * Stop acquisition and return to CONFIG_MENU state.
  /**
   *
   */
  async stop(): Promise<void> {
    if (
      this.state !== ConnectionState.ACQ_FREERUN &&
      this.state !== ConnectionState.ACQ_POLLED &&
      this.state !== ConnectionState.PAUSED
    ) {
      throw new SerialIOError(`Cannot stop from state ${this.state}. Not acquiring.`)
    }

    console.log('[QSeriesSerial] Stopping acquisition...')

    // Stop loops if running
    this.stopAcquisitionLoop()

    // Enter menu
    await this.enterMenu()

    this.state = ConnectionState.CONFIG_MENU
    this.emitStateChange()
    console.log('[QSeriesSerial] Acquisition stopped, in menu')
  }

  // ========================================================================
  // Health / Status
  // ========================================================================

  // * Get current health/status data.
  /**
   *
   */
  getHealth(): HealthData {
    const lastReadingAge = this.lastReadingTimestamp ? Date.now() - this.lastReadingTimestamp : undefined

    return {
      sensor_id: this.sensorId,
      state: this.state,
      buffer_size: this.parser.getBufferSize(),
      last_reading_age_ms: lastReadingAge,
    }
  }

  // * Check if controller is connected to sensor.
  /**
   *
   */
  isConnected(): boolean {
    return this.link !== null && this.link.isOpen && this.state !== ConnectionState.DISCONNECTED
  }

  // * Get current connection state.
  /**
   *
   */
  getState(): ConnectionState {
    return this.state
  }

  // * Get sensor ID.
  /**
   *
   */
  getSensorId(): string {
    return this.sensorId
  }

  // ========================================================================
  // Internal Helpers: Menu Operations
  // ========================================================================

  /**
   *
   */
  private ensureInMenu(): void {
    if (this.state !== ConnectionState.CONFIG_MENU) {
      throw new SerialIOError(`Operation requires CONFIG_MENU state, current: ${this.state}`)
    }
  }

  /**
   *
   */
  private async enterMenu(): Promise<void> {
    if (!this.link) {
      throw new SerialIOError('Not connected')
    }

    // Wait for power-on banner to complete
    await this.delay(DELAY_POST_OPEN)

    // Flush input buffer
    this.parser.clearBuffer()
    this.lineBuffer = []

    // Send ESC to enter menu
    await this.writeBytes(Buffer.from(ESC, 'ascii'))

    // Wait for menu prompt
    if (!(await this.waitForMenuPrompt())) {
      throw new MenuTimeoutError('Did not receive menu prompt after ESC')
    }

    console.log('[QSeriesSerial] Entered config menu')
  }

  /**
   *
   * @param timeout
   */
  private async waitForMenuPrompt(timeout: number = TIMEOUT_MENU_PROMPT): Promise<boolean> {
    return this.waitForPrompt(RE_MENU_PROMPT, timeout)
  }

  /**
   *
   * @param pattern
   * @param timeout
   */
  private async waitForPrompt(pattern: RegExp, timeout: number): Promise<boolean> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      // Check existing lines in buffer
      const matchingLine = this.lineBuffer.find((line) => pattern.test(line))
      if (matchingLine) {
        console.log('[QSeriesSerial] Found prompt:', matchingLine.slice(0, 60))
        return true
      }

      // Wait a bit and try again
      await this.delay(50)
    }

    console.warn(`[QSeriesSerial] Timeout waiting for pattern: ${pattern}`)
    return false
  }

  /**
   *
   * @param pattern
   * @param timeout
   * @param validator
   */
  private async waitForPattern(
    pattern: RegExp,
    timeout: number,
    validator?: (match: RegExpExecArray) => boolean
  ): Promise<boolean> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      // Check existing lines
      for (const line of this.lineBuffer) {
        const match = pattern.exec(line)
        if (match) {
          if (!validator || validator(match)) {
            return true
          }
        }
      }

      await this.delay(50)
    }

    return false
  }

  /**
   *
   */
  private async readConfigSnapshot(): Promise<QSeriesSensorConfig> {
    if (!this.link) {
      throw new SerialIOError('Not connected')
    }

    // Send '^' to get config dump
    await this.writeCommand(MENU_CMD_CONFIG_DUMP)

    // Wait for CSV line
    const startTime = Date.now()
    while (Date.now() - startTime < 5000) {
      for (const line of this.lineBuffer) {
        try {
          const config = this.parser.parseConfigCsv(line)
          this.sensorId = config.serial_number || 'unknown'
          console.log('[QSeriesSerial] Parsed config from CSV:', config)
          // Fill in defaults for missing fields
          return {
            averaging: config.averaging || 12,
            adc_rate_hz: config.adc_rate_hz || 125,
            mode: config.mode || 'freerun',
            tag: config.tag || null,
            include_temp: config.include_temp || false,
            include_vin: config.include_vin || false,
            preamble: config.preamble || '',
            calfactor: config.calfactor || 1.0,
            serial_number: config.serial_number || 'unknown',
            firmware_version: config.firmware_version || 'unknown',
          }
        } catch (error) {
          // Not the CSV line yet
          continue
        }
      }

      await this.delay(50)
    }

    throw new MenuTimeoutError('Timeout waiting for config CSV response')
  }

  // ========================================================================
  // Internal Helpers: Acquisition Loops
  // ========================================================================

  /**
   *
   */
  private startFreerunLoop(): void {
    // Freerun mode: data arrives via serial data event handler
    // No active polling needed, just parse incoming lines
    console.log('[QSeriesSerial] Freerun reader loop started (event-driven)')
  }

  /**
   *
   * @param tag
   * @param pollHz
   */
  private async startPolledLoop(tag: string, pollHz: number): Promise<void> {
    if (!this.link) {
      throw new SerialIOError('Not connected')
    }

    // Send polled init command
    const initCmd = makePolledInitCmd(tag)
    await this.writeCommand(initCmd)
    console.log(`[QSeriesSerial] Sent polled init command: ${initCmd}`)

    // Wait for averaging to fill
    if (this.config) {
      const waitTime = (this.config.averaging / this.config.adc_rate_hz + 0.5) * 1000
      console.log(`[QSeriesSerial] Waiting ${waitTime}ms for averaging to fill...`)
      await this.delay(waitTime)
    }

    // Start polling interval
    const pollPeriod = 1000 / pollHz
    const queryCmd = makePolledQueryCmd(tag)

    this.acquisitionInterval = this.scheduleInterval(async () => {
      try {
        // Send query (no CR - raw bytes)
        await this.writeBytes(Buffer.from(queryCmd, 'ascii'))
      } catch (error) {
        console.error('[QSeriesSerial] Error sending polled query:', error)
        this.emit('error', error)
      }
    }, pollPeriod)

    console.log(`[QSeriesSerial] Started polled reader loop at ${pollHz} Hz`)
  }

  /**
   *
   */
  private stopAcquisitionLoop(): void {
    if (this.acquisitionInterval) {
      this.clearScheduledInterval(this.acquisitionInterval)
      this.acquisitionInterval = null
      console.log('[QSeriesSerial] Stopped acquisition loop')
    }
  }

  // ========================================================================
  // Internal Helpers: Serial I/O
  // ========================================================================

  /**
   *
   * @param cmd
   */
  private async writeCommand(cmd: string): Promise<void> {
    if (!this.link) {
      throw new SerialIOError('Not connected')
    }

    const data = Buffer.from(cmd + INPUT_TERMINATOR, 'ascii')
    await this.link.write(data)
  }

  /**
   *
   * @param data
   */
  private async writeBytes(data: Buffer): Promise<void> {
    if (!this.link) {
      throw new SerialIOError('Not connected')
    }

    await this.link.write(data)
  }

  /**
   *
   * @param data
   */
  private handleSerialData(data: Buffer): void {
    // Feed data to parser
    const lines = this.parser.feed(data)

    // Add lines to buffer for prompt matching
    this.lineBuffer.push(...lines)

    // Trim line buffer to prevent memory growth
    if (this.lineBuffer.length > 100) {
      this.lineBuffer = this.lineBuffer.slice(-50)
    }

    // Process lines if in acquisition mode
    if (this.state === ConnectionState.ACQ_FREERUN) {
      this.processFreerunLines(lines)
    } else if (this.state === ConnectionState.ACQ_POLLED) {
      this.processPolledLines(lines)
    }
  }

  /**
   *
   * @param lines
   */
  private processFreerunLines(lines: string[]): void {
    for (const line of lines) {
      // Filter out menu/banner/diagnostic lines
      const menuMarkers = [
        'Select the letter of',
        ' to set ',
        'Operating in',
        'ADC sample rate',
        'Averaging',
        'Sensor temperature:',
        'Input Supply Voltage',
        'Calfactor:',
        'Reset ADC',
        'Start free run',
        'Starting Sampling',
        'Biospherical Instruments',
        'Digital Engine',
        'Unit ID',
        'Rebooting program',
        'gain ',
        'Buffer disabled',
      ]

      if (menuMarkers.some((marker) => line.includes(marker))) {
        continue
      }

      // Try parsing as freerun data
      try {
        const data = this.parser.parseFreerunLine(line)
        const reading = this.createReading(data, 'freerun')
        this.emitReading(reading)
      } catch (error) {
        if (error instanceof InvalidFrameError) {
          // Unparseable line - might be banner noise
          console.debug('[QSeriesSerial] Skipping unparseable freerun line:', line.slice(0, 60))
        } else {
          console.error('[QSeriesSerial] Error parsing freerun line:', error)
        }
      }
    }
  }

  /**
   *
   * @param lines
   */
  private processPolledLines(lines: string[]): void {
    if (!this.lastPolledTag) {
      return
    }

    for (const line of lines) {
      try {
        const data = this.parser.parsePolledLine(line, this.lastPolledTag)
        const reading = this.createReading(data, 'polled')
        this.emitReading(reading)
      } catch (error) {
        if (error instanceof InvalidFrameError) {
          console.debug('[QSeriesSerial] Skipping unparseable polled line:', line.slice(0, 60))
        } else {
          console.error('[QSeriesSerial] Error parsing polled line:', error)
        }
      }
    }
  }

  /**
   *
   * @param data
   * @param mode
   */
  private createReading(data: QSeriesData, mode: QSeriesMode): QSeriesReading {
    return {
      timestamp_utc: new Date().toISOString(),
      timestamp_monotonic_ns: BigInt(Math.floor(performance.now() * 1e6)),
      sensor_id: this.sensorId,
      mode,
      value: data.value,
      TempC: data.TempC,
      Vin: data.Vin,
    }
  }

  /**
   *
   * @param reading
   */
  private emitReading(reading: QSeriesReading): void {
    this.lastReadingTimestamp = Date.now()
    this.emit('reading', reading)
  }

  /**
   *
   * @param error
   */
  private handleSerialError(error: Error): void {
    console.error('[QSeriesSerial] Serial error:', error)
    this.emit('error', error)
    this.cleanupAfterUnexpectedDisconnect()
  }

  /**
   *
   */
  private handleSerialClose(): void {
    console.warn('[QSeriesSerial] Serial port closed unexpectedly')
    this.cleanupAfterUnexpectedDisconnect(new SerialIOError('Serial port closed unexpectedly'))
  }

  /**
   *
   * @param error
   */
  private cleanupAfterUnexpectedDisconnect(error?: Error): void {
    this.stopAcquisitionLoop()
    if (this.link) {
      this.link.removeAllListeners()
      this.link = null
    }
    this.state = ConnectionState.DISCONNECTED
    this.emitStateChange()
    if (error) {
      this.emit('error', error)
    }
  }

  /**
   *
   */
  private emitStateChange(): void {
    this.emit('state-change', this.state)
  }

  /**
   *
   * @param ms
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
