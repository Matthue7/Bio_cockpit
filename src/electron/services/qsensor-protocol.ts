/**
 * Q-Series Sensor Protocol Parser (TypeScript)
 *
 * This module implements the Q-Series serial protocol parser for firmware 4.003.
 * It is a port of the Python implementation in q_sensor_lib/protocol.py and
 * q_sensor_lib/parsing.py, designed to match the behavior exactly.
 *
 * ARCHITECTURE:
 * - Tokenizes raw byte streams from serial into Q-Series frames
 * - Validates frame format (preamble, value, optional temp/vin)
 * - Maps frames to strongly-typed reading objects
 * - Supports both freerun and polled modes
 *
 * PROTOCOL REFERENCE:
 * Based on reverse-engineered Q-Series firmware 2150REV4.003.bas
 * Source: /Users/matthuewalsh/qseries-noise/Q_Sensor_API/q_sensor_lib/protocol.py
 */

// ============================================================================
// Protocol Constants
// ============================================================================

/** Line termination used by device output (CRLF) */
export const OUTPUT_TERMINATOR = '\r\n'

/** Line termination expected by device input (CR) */
export const INPUT_TERMINATOR = '\r'

/** Control character to enter menu from any mode */
export const ESC = '\x1b'

/** Alternative menu entry character */
export const QUESTION_MARK = '?'

// ============================================================================
// Menu Commands (single character + CR)
// ============================================================================

export const MENU_CMD_AVERAGING = 'A' // Set averaging
export const MENU_CMD_RATE = 'R' // Set ADC sample rate
export const MENU_CMD_MODE = 'M' // Set operating mode (freerun/polled)
export const MENU_CMD_CONFIG_DUMP = '^' // Get configuration CSV dump
export const MENU_CMD_EXIT = 'X' // Exit menu (triggers device reset)
export const MENU_CMD_OUTPUTS = 'O' // Configure temp/voltage outputs
export const MENU_CMD_QUIET = 'Q' // Set quiet mode (suppress banner)
export const MENU_CMD_REDISPLAY = '?' // Redisplay menu

// ============================================================================
// Polled Mode Commands
// ============================================================================

export const POLLED_INIT_PREFIX = '*'
export const POLLED_INIT_CMD = 'Q'
export const POLLED_INIT_PADDING = '000'
export const POLLED_INIT_TERM = '!'

/**
 *
 * @param tag
 */
export function makePolledInitCmd(tag: string): string {
  return `${POLLED_INIT_PREFIX}${tag}${POLLED_INIT_CMD}${POLLED_INIT_PADDING}${POLLED_INIT_TERM}`
}

export const POLLED_QUERY_PREFIX = '>'

/**
 *
 * @param tag
 */
export function makePolledQueryCmd(tag: string): string {
  return `${POLLED_QUERY_PREFIX}${tag}*`
}

// ============================================================================
// Timing Constants (milliseconds, converted from Python seconds)
// ============================================================================

export const DELAY_POST_OPEN = 1200 // Wait for power-on banner before sending ESC
export const DELAY_POST_RESET = 3500 // Wait after 'X' command for device reboot
export const TIMEOUT_MENU_PROMPT = 3000 // Timeout for menu prompt appearance
export const TIMEOUT_READ_LINE = 500 // Serial readline timeout
export const POLL_INTERVAL_MIN = 100 // Minimum polled mode query interval
export const MENU_DISPLAY_DELAY = 1000
export const MENU_REDISPLAY_DELAY = 500
export const BANNER_SETTLE_TIME = 2500
export const BANNER_SETTLE_TIME_QUIET = 500
export const MENU_RESPONSE_TIMEOUT = 25000
export const DATA_LINE_TIMEOUT = 5000

// ============================================================================
// Regular Expressions for Parsing
// ============================================================================

/** Menu entry prompt */
export const RE_MENU_PROMPT = /^Select the letter of the menu entry:\s*$/i

/** Signon banner contains version */
export const RE_SIGNON_BANNER = /Biospherical Instruments Inc.*Digital.*Engine.*Vers\s+([\d.]+)/i

/** Serial number in banner: "Unit ID <serial>" */
export const RE_UNIT_ID = /Unit ID\s+(.+)/i

/** Operating mode in banner */
export const RE_OPERATING_MODE_FREERUN = /Operating in free run mode/i
export const RE_OPERATING_MODE_POLLED = /Operating in polled mode with tag of\s+(\w)/i

/** Averaging set confirmation */
export const RE_AVERAGING_SET = /ADC set to averaging\s+(\d+)/i

/** Averaging prompt (when user presses 'A') */
export const RE_AVERAGING_PROMPT = /Enter # readings to average/i

/** Rate set confirmation */
export const RE_RATE_SET = /ADC rate set to\s+(\d+)/i

/** Rate prompt (when user presses 'R') */
export const RE_RATE_PROMPT = /Enter ADC rate|Sample rate selection/i

/** Mode prompt (when user presses 'M') */
export const RE_MODE_PROMPT = /Select mode|Enter.*mode/i

/** TAG prompt (for polled mode) */
export const RE_TAG_PROMPT = /Enter TAG|TAG character/i

/** Error messages */
export const RE_ERROR_INVALID_AVERAGING = /Invalid number.*averaging set to 12/i
export const RE_ERROR_INVALID_RATE = /Invalid rate.*Command is ignored/i
export const RE_ERROR_BAD_TAG = /Bad TAG/i

/**
 * Freerun data line: <preamble><value>[, <temp>][, <vin>] CRLF
 * Example: "$LITE123.456789, 21.34, 12.345"
 * Group 1: optional preamble (non-numeric prefix)
 * Group 2: value (may be negative)
 * Group 3: optional temp
 * Group 4: optional vin
 */
export const RE_FREERUN_LINE = /^([^\d-]*?)([-\d.]+)(?:,\s*([-\d.]+))?(?:,\s*([-\d.]+))?\s*$/

/**
 * Polled data line: <TAG>,<preamble><value>[, <temp>][, <vin>] CRLF
 * Example: "A,123.456789, 21.34"
 * Group 1: TAG
 * Group 2: optional preamble
 * Group 3: value
 * Group 4: optional temp
 * Group 5: optional vin
 */
export const RE_POLLED_LINE = /^([A-Z]),([^\d-]*?)([-\d.]+)(?:,\s*([-\d.]+))?(?:,\s*([-\d.]+))?\s*$/

/**
 * Configuration CSV dump from "^" command
 * Format: <adcToAverage>,<baudrate>,<CalFactor>,<Description>,E,<Version>,G,H,<Serial>,...
 */
export const RE_CONFIG_CSV =
  /^(\d+),(\d+),([\d.]+),([^,]*),E,([\d.]+),G,H,([^,]*),([\d.]+),([\d.]+),([\d.]+),([^,]+),([^,]*),/

// ============================================================================
// Valid Configuration Values
// ============================================================================

export const VALID_ADC_RATES = new Set([4, 8, 16, 33, 62, 125, 250, 500])
export const AVERAGING_MIN = 1
export const AVERAGING_MAX = 65535
export const VALID_TAGS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// ============================================================================
// Type Definitions
// ============================================================================

export type QSeriesMode = 'freerun' | 'polled'

/**
 * Parsed sensor data from a single frame
 */
export interface QSeriesData {
  /**
   *
   */
  value: number
  /**
   *
   */
  TempC?: number
  /**
   *
   */
  Vin?: number
}

/**
 * Timestamped reading with metadata
 */
export interface QSeriesReading {
  /**
   *
   */
  timestamp_utc: string // ISO 8601 wall clock
  /**
   *
   */
  timestamp_monotonic_ns: bigint // Monotonic clock (performance.now() * 1e6)
  /**
   *
   */
  sensor_id: string
  /**
   *
   */
  mode: QSeriesMode
  /**
   *
   */
  value: number
  /**
   *
   */
  TempC?: number
  /**
   *
   */
  Vin?: number
}

/**
 * Sensor configuration
 */
export interface QSeriesSensorConfig {
  /**
   *
   */
  averaging: number
  /**
   *
   */
  adc_rate_hz: number
  /**
   *
   */
  mode: QSeriesMode
  /**
   *
   */
  tag: string | null
  /**
   *
   */
  include_temp: boolean
  /**
   *
   */
  include_vin: boolean
  /**
   *
   */
  preamble: string
  /**
   *
   */
  calfactor: number
  /**
   *
   */
  serial_number: string
  /**
   *
   */
  firmware_version: string
}

/**
 * Frame parsing result
 */
export interface ParsedFrame {
  /**
   *
   */
  data: QSeriesData
  /**
   *
   */
  raw: string
}

// ============================================================================
// Custom Errors
// ============================================================================

/**
 *
 */
export class InvalidFrameError extends Error {
  /**
   *
   * @param message
   */
  constructor(message: string) {
    super(message)
    this.name = 'InvalidFrameError'
  }
}

/**
 *
 */
export class ProtocolError extends Error {
  /**
   *
   * @param message
   */
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

// ============================================================================
// Protocol Parser Class
// ============================================================================

/**
 * Tokenizer and parser for Q-Series serial frames.
 *
 * This class handles the low-level protocol parsing:
 * - Accepts raw byte buffers from serial port
 * - Maintains internal line buffer with CRLF tokenization
 * - Validates and parses freerun and polled frames
 * - Protects against buffer overflow
 *
 * IMPORTANT: This parser mirrors the behavior of the Python implementation
 * in q_sensor_lib/parsing.py. Any changes should maintain semantic equivalence.
 */
export class QSeriesProtocolParser {
  private buffer = ''
  private readonly maxBufferSize: number = 4096

  /**
   * Feed raw bytes from serial port into the parser.
   * @param data - Raw buffer from serial port
   * @returns Array of complete lines ready for parsing (CRLF stripped)
   */
  feed(data: Buffer): string[] {
    // Convert buffer to ASCII string (Q-Series protocol is ASCII-only)
    this.buffer += data.toString('ascii')

    const lines: string[] = []

    // Extract complete lines (terminated by CRLF)
    // eslint-disable-next-line no-constant-condition -- intentional infinite loop with break
    while (true) {
      const endIdx = this.buffer.indexOf(OUTPUT_TERMINATOR)
      if (endIdx === -1) {
        break // No complete line yet
      }

      // Extract line without CRLF terminator
      const line = this.buffer.slice(0, endIdx)
      this.buffer = this.buffer.slice(endIdx + OUTPUT_TERMINATOR.length)

      // Only return non-empty lines
      if (line.trim()) {
        lines.push(line)
      }
    }

    // Prevent unbounded buffer growth (discard old garbage if buffer too large)
    if (this.buffer.length > this.maxBufferSize) {
      console.warn(`[QSeriesProtocol] Buffer overflow protection: trimming ${this.buffer.length} -> 512 bytes`)
      this.buffer = this.buffer.slice(-512)
    }

    return lines
  }

  /**
   * Parse a freerun mode data line.
   *
   * Expected format: <preamble><value>[, <temp>][, <vin>]
   * Example: "$LITE123.456789, 21.34, 12.345"
   * @param line - Complete line from device (CRLF should be stripped by caller)
   * @returns Parsed data object
   * @throws InvalidFrameError if line doesn't match expected pattern
   */
  parseFreerunLine(line: string): QSeriesData {
    const trimmed = line.trim()
    if (!trimmed) {
      throw new InvalidFrameError('Empty data line')
    }

    const match = RE_FREERUN_LINE.exec(trimmed)
    if (!match) {
      throw new InvalidFrameError(`Freerun line doesn't match expected pattern: ${line}`)
    }

    // Group 1 is preamble (ignored), Group 2 is value, 3=temp, 4=vin
    try {
      const data: QSeriesData = {
        value: parseFloat(match[2]),
      }

      if (match[3]) {
        data.TempC = parseFloat(match[3])
      }

      if (match[4]) {
        data.Vin = parseFloat(match[4])
      }

      // Validate parsed numbers
      if (isNaN(data.value)) {
        throw new InvalidFrameError(`Failed to parse value from: ${line}`)
      }

      if (data.TempC !== undefined && isNaN(data.TempC)) {
        throw new InvalidFrameError(`Failed to parse TempC from: ${line}`)
      }

      if (data.Vin !== undefined && isNaN(data.Vin)) {
        throw new InvalidFrameError(`Failed to parse Vin from: ${line}`)
      }

      return data
    } catch (error) {
      if (error instanceof InvalidFrameError) {
        throw error
      }
      throw new InvalidFrameError(`Failed to parse numeric values in line: ${line}`)
    }
  }

  /**
   * Parse a polled mode data line and validate TAG.
   *
   * Expected format: <TAG>,<preamble><value>[, <temp>][, <vin>]
   * Example: "A,123.456789, 21.34"
   * @param line - Complete line from device
   * @param expectedTag - Single uppercase character A-Z to validate against
   * @returns Parsed data object
   * @throws InvalidFrameError if line doesn't match pattern or TAG doesn't match
   */
  parsePolledLine(line: string, expectedTag: string): QSeriesData {
    const trimmed = line.trim()
    if (!trimmed) {
      throw new InvalidFrameError('Empty polled data line')
    }

    const match = RE_POLLED_LINE.exec(trimmed)
    if (!match) {
      throw new InvalidFrameError(`Polled line doesn't match expected pattern: ${line}`)
    }

    // Group 1 is TAG, validate it
    const tag = match[1]
    if (tag !== expectedTag) {
      throw new InvalidFrameError(`TAG mismatch: expected '${expectedTag}', got '${tag}' in line: ${line}`)
    }

    // Group 2 is preamble (ignored), Group 3=value, 4=temp, 5=vin
    try {
      const data: QSeriesData = {
        value: parseFloat(match[3]),
      }

      if (match[4]) {
        data.TempC = parseFloat(match[4])
      }

      if (match[5]) {
        data.Vin = parseFloat(match[5])
      }

      // Validate parsed numbers
      if (isNaN(data.value)) {
        throw new InvalidFrameError(`Failed to parse value from: ${line}`)
      }

      if (data.TempC !== undefined && isNaN(data.TempC)) {
        throw new InvalidFrameError(`Failed to parse TempC from: ${line}`)
      }

      if (data.Vin !== undefined && isNaN(data.Vin)) {
        throw new InvalidFrameError(`Failed to parse Vin from: ${line}`)
      }

      return data
    } catch (error) {
      if (error instanceof InvalidFrameError) {
        throw error
      }
      throw new InvalidFrameError(`Failed to parse numeric values in polled line: ${line}`)
    }
  }

  /**
   * Parse configuration CSV dump from '^' command.
   *
   * CSV format (from SendAllParameters):
   * <adcToAverage>,<baudrate>,<CalFactor>,<Description>,E,<Version>,G,H,<Serial>,...
   * @param line - Raw CSV line from device
   * @returns Parsed sensor configuration
   * @throws InvalidFrameError if CSV doesn't match expected pattern
   */
  parseConfigCsv(line: string): Partial<QSeriesSensorConfig> {
    const trimmed = line.trim()
    const match = RE_CONFIG_CSV.exec(trimmed)
    if (!match) {
      throw new InvalidFrameError(`Config CSV doesn't match expected pattern: ${line}`)
    }

    try {
      const adcToAverage = parseInt(match[1], 10)
      const _baudrate = parseInt(match[2], 10) // Parsed but not currently used
      const calFactor = parseFloat(match[3])
      const _description = match[4] // Parsed but not currently used
      const firmwareVersion = match[5]
      const serialNumber = match[6]
      const operatingModeChar = match[10] // "0" = freerun, "1" = polled
      const tagStr = match[11]

      // Determine mode and tag
      let mode: QSeriesMode
      let tag: string | null = null

      if (operatingModeChar === '0') {
        mode = 'freerun'
      } else if (operatingModeChar === '1') {
        mode = 'polled'
        tag = tagStr || null
      } else {
        throw new InvalidFrameError(`Unknown operating mode: ${operatingModeChar}`)
      }

      return {
        averaging: adcToAverage,
        adc_rate_hz: 125, // Default - not in CSV
        mode,
        tag,
        include_temp: false, // Not in CSV
        include_vin: false, // Not in CSV
        preamble: '', // Not captured by current regex
        calfactor: calFactor,
        serial_number: serialNumber,
        firmware_version: firmwareVersion,
      }
    } catch (error) {
      if (error instanceof InvalidFrameError) {
        throw error
      }
      throw new InvalidFrameError(`Failed to parse config CSV values: ${line}`)
    }
  }

  /**
   * Extract firmware version from signon banner.
   * @param bannerText - Multi-line signon banner text
   * @returns Version string (e.g., "4.003") or null if not found
   */
  extractVersionFromBanner(bannerText: string): string | null {
    const match = RE_SIGNON_BANNER.exec(bannerText)
    return match ? match[1] : null
  }

  /**
   * Extract serial number from signon banner.
   * @param bannerText - Multi-line signon banner text
   * @returns Serial number string or null if not found
   */
  extractSerialFromBanner(bannerText: string): string | null {
    const match = RE_UNIT_ID.exec(bannerText)
    return match ? match[1].trim() : null
  }

  /**
   * Extract operating mode and TAG from signon banner.
   * @param bannerText - Multi-line signon banner text
   * @returns Tuple of [mode, tag] where mode is "freerun" or "polled" or null
   */
  extractModeFromBanner(bannerText: string): [QSeriesMode | null, string | null] {
    // Check for freerun
    if (RE_OPERATING_MODE_FREERUN.test(bannerText)) {
      return ['freerun', null]
    }

    // Check for polled
    const match = RE_OPERATING_MODE_POLLED.exec(bannerText)
    if (match) {
      const tag = match[1].toUpperCase()
      return ['polled', tag]
    }

    return [null, null]
  }

  /**
   * Clear internal buffer (useful for testing or error recovery).
   */
  clearBuffer(): void {
    this.buffer = ''
  }

  /**
   * Get current buffer size (for diagnostics/debugging).
   */
  getBufferSize(): number {
    return this.buffer.length
  }
}
