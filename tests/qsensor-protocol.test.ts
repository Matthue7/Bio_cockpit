/**
 * Unit tests for Q-Series Protocol Parser
 *
 * These tests verify that the TypeScript parser produces equivalent output
 * to the Python reference implementation for all frame types and edge cases.
 *
 * Test fixtures are derived from actual Q-Series sensor output and the
 * Python q_sensor_lib test suite.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  QSeriesProtocolParser,
  InvalidFrameError,
  OUTPUT_TERMINATOR,
  makePolledInitCmd,
  makePolledQueryCmd,
} from '../src/electron/services/qsensor-protocol'

describe('QSeriesProtocolParser', () => {
  let parser: QSeriesProtocolParser

  beforeEach(() => {
    parser = new QSeriesProtocolParser()
  })

  describe('feed() - Line Tokenization', () => {
    it('should extract complete lines terminated by CRLF', () => {
      const data = Buffer.from('line1\r\nline2\r\n', 'ascii')
      const lines = parser.feed(data)

      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe('line1')
      expect(lines[1]).toBe('line2')
    })

    it('should buffer incomplete lines until CRLF received', () => {
      const part1 = Buffer.from('incomplete', 'ascii')
      const part2 = Buffer.from(' line\r\n', 'ascii')

      const lines1 = parser.feed(part1)
      expect(lines1).toHaveLength(0)

      const lines2 = parser.feed(part2)
      expect(lines2).toHaveLength(1)
      expect(lines2[0]).toBe('incomplete line')
    })

    it('should handle multiple partial feeds', () => {
      const feeds = ['$LITE', '123.', '456', '789\r\n']

      for (let i = 0; i < feeds.length - 1; i++) {
        const lines = parser.feed(Buffer.from(feeds[i], 'ascii'))
        expect(lines).toHaveLength(0)
      }

      const finalLines = parser.feed(Buffer.from(feeds[feeds.length - 1], 'ascii'))
      expect(finalLines).toHaveLength(1)
      expect(finalLines[0]).toBe('$LITE123.456789')
    })

    it('should skip empty lines', () => {
      const data = Buffer.from('\r\n\r\nvalid\r\n\r\n', 'ascii')
      const lines = parser.feed(data)

      expect(lines).toHaveLength(1)
      expect(lines[0]).toBe('valid')
    })

    it('should protect against buffer overflow', () => {
      // Feed 5KB of garbage without CRLF
      const garbage = 'X'.repeat(5000)
      parser.feed(Buffer.from(garbage, 'ascii'))

      // Buffer should be trimmed to prevent unbounded growth
      expect(parser.getBufferSize()).toBeLessThan(1000)
    })
  })

  describe('parseFreerunLine() - Basic Value Only', () => {
    it('should parse simple numeric value', () => {
      const data = parser.parseFreerunLine('123.456789')

      expect(data.value).toBeCloseTo(123.456789, 6)
      expect(data.TempC).toBeUndefined()
      expect(data.Vin).toBeUndefined()
    })

    it('should parse value with preamble ($LITE)', () => {
      const data = parser.parseFreerunLine('$LITE123.456789')

      expect(data.value).toBeCloseTo(123.456789, 6)
    })

    it('should parse negative values', () => {
      const data = parser.parseFreerunLine('-45.678')

      expect(data.value).toBeCloseTo(-45.678, 3)
    })

    it('should parse integer values', () => {
      const data = parser.parseFreerunLine('$LITE42')

      expect(data.value).toBe(42)
    })

    it('should parse values with arbitrary preamble', () => {
      const data = parser.parseFreerunLine('CUSTOM_PREAMBLE999.111')

      expect(data.value).toBeCloseTo(999.111, 3)
    })
  })

  describe('parseFreerunLine() - With Temperature', () => {
    it('should parse value with temperature', () => {
      const data = parser.parseFreerunLine('$LITE123.456789, 21.34')

      expect(data.value).toBeCloseTo(123.456789, 6)
      expect(data.TempC).toBeCloseTo(21.34, 2)
      expect(data.Vin).toBeUndefined()
    })

    it('should handle temperature without spaces', () => {
      const data = parser.parseFreerunLine('$LITE123.456789,21.34')

      expect(data.value).toBeCloseTo(123.456789, 6)
      expect(data.TempC).toBeCloseTo(21.34, 2)
    })

    it('should parse negative temperature', () => {
      const data = parser.parseFreerunLine('100.0, -5.5')

      expect(data.value).toBe(100.0)
      expect(data.TempC).toBe(-5.5)
    })
  })

  describe('parseFreerunLine() - With Temperature and Vin', () => {
    it('should parse complete frame with all fields', () => {
      const data = parser.parseFreerunLine('$LITE123.456789, 21.34, 12.345')

      expect(data.value).toBeCloseTo(123.456789, 6)
      expect(data.TempC).toBeCloseTo(21.34, 2)
      expect(data.Vin).toBeCloseTo(12.345, 3)
    })

    it('should handle fields without spaces', () => {
      const data = parser.parseFreerunLine('$LITE123.456789,21.34,12.345')

      expect(data.value).toBeCloseTo(123.456789, 6)
      expect(data.TempC).toBeCloseTo(21.34, 2)
      expect(data.Vin).toBeCloseTo(12.345, 3)
    })

    it('should parse real sensor output example', () => {
      // Example from actual Q-Series device
      const data = parser.parseFreerunLine('$LITE0.000123, 22.5, 12.00')

      expect(data.value).toBeCloseTo(0.000123, 6)
      expect(data.TempC).toBe(22.5)
      expect(data.Vin).toBe(12.0)
    })
  })

  describe('parseFreerunLine() - Error Cases', () => {
    it('should reject empty line', () => {
      expect(() => parser.parseFreerunLine('')).toThrow(InvalidFrameError)
      expect(() => parser.parseFreerunLine('   ')).toThrow(InvalidFrameError)
    })

    it('should reject non-numeric value', () => {
      expect(() => parser.parseFreerunLine('$LITEabc')).toThrow(InvalidFrameError)
    })

    it('should reject malformed data', () => {
      expect(() => parser.parseFreerunLine('completely invalid')).toThrow(InvalidFrameError)
    })

    it('should reject value with non-numeric temperature', () => {
      expect(() => parser.parseFreerunLine('123.45, ABC')).toThrow(InvalidFrameError)
    })

    it('should reject value with non-numeric Vin', () => {
      expect(() => parser.parseFreerunLine('123.45, 21.0, XYZ')).toThrow(InvalidFrameError)
    })
  })

  describe('parsePolledLine() - Basic Functionality', () => {
    it('should parse polled line with TAG prefix', () => {
      const data = parser.parsePolledLine('A,123.456789', 'A')

      expect(data.value).toBeCloseTo(123.456789, 6)
      expect(data.TempC).toBeUndefined()
      expect(data.Vin).toBeUndefined()
    })

    it('should parse polled line with temperature', () => {
      const data = parser.parsePolledLine('B,123.456789, 21.34', 'B')

      expect(data.value).toBeCloseTo(123.456789, 6)
      expect(data.TempC).toBeCloseTo(21.34, 2)
    })

    it('should parse polled line with all fields', () => {
      const data = parser.parsePolledLine('Z,123.456789, 21.34, 12.345', 'Z')

      expect(data.value).toBeCloseTo(123.456789, 6)
      expect(data.TempC).toBeCloseTo(21.34, 2)
      expect(data.Vin).toBeCloseTo(12.345, 3)
    })

    it('should parse polled line with preamble', () => {
      const data = parser.parsePolledLine('C,$LITE123.456', 'C')

      expect(data.value).toBeCloseTo(123.456, 3)
    })

    it('should validate TAG matches expected', () => {
      expect(() => parser.parsePolledLine('A,123.456', 'B')).toThrow(InvalidFrameError)
      expect(() => parser.parsePolledLine('A,123.456', 'B')).toThrow(/TAG mismatch/)
    })

    it('should support all valid TAG characters A-Z', () => {
      for (const tag of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const data = parser.parsePolledLine(`${tag},100.0`, tag)
        expect(data.value).toBe(100.0)
      }
    })
  })

  describe('parsePolledLine() - Error Cases', () => {
    it('should reject empty line', () => {
      expect(() => parser.parsePolledLine('', 'A')).toThrow(InvalidFrameError)
    })

    it('should reject line without TAG', () => {
      expect(() => parser.parsePolledLine('123.456', 'A')).toThrow(InvalidFrameError)
    })

    it('should reject line with lowercase TAG', () => {
      expect(() => parser.parsePolledLine('a,123.456', 'a')).toThrow(InvalidFrameError)
    })

    it('should reject non-numeric value', () => {
      expect(() => parser.parsePolledLine('A,abc', 'A')).toThrow(InvalidFrameError)
    })
  })

  describe('parseConfigCsv() - Configuration Parsing', () => {
    it('should parse valid freerun config CSV', () => {
      // Example from actual device in freerun mode
      const csv =
        '12,9600,1.234567,Q-Series Sensor,E,4.003,G,H,SN12345,0.0,0.0,12.34,0,,'

      const config = parser.parseConfigCsv(csv)

      expect(config.averaging).toBe(12)
      expect(config.calfactor).toBeCloseTo(1.234567, 6)
      expect(config.firmware_version).toBe('4.003')
      expect(config.serial_number).toBe('SN12345')
      expect(config.mode).toBe('freerun')
      expect(config.tag).toBeNull()
    })

    it('should parse valid polled config CSV', () => {
      // Example from device in polled mode with TAG 'A'
      const csv =
        '24,9600,2.345678,Q-Series Polled,E,4.003,G,H,SN67890,0.0,0.0,12.34,1,A,'

      const config = parser.parseConfigCsv(csv)

      expect(config.averaging).toBe(24)
      expect(config.calfactor).toBeCloseTo(2.345678, 6)
      expect(config.serial_number).toBe('SN67890')
      expect(config.mode).toBe('polled')
      expect(config.tag).toBe('A')
    })

    it('should reject malformed CSV', () => {
      expect(() => parser.parseConfigCsv('not,a,valid,csv')).toThrow(InvalidFrameError)
    })

    it('should reject empty line', () => {
      expect(() => parser.parseConfigCsv('')).toThrow(InvalidFrameError)
    })
  })

  describe('extractVersionFromBanner()', () => {
    it('should extract firmware version from banner', () => {
      const banner = 'Biospherical Instruments Inc. Digital Engine Vers 4.003'

      const version = parser.extractVersionFromBanner(banner)
      expect(version).toBe('4.003')
    })

    it('should return null if version not found', () => {
      const banner = 'No version here'
      expect(parser.extractVersionFromBanner(banner)).toBeNull()
    })
  })

  describe('extractSerialFromBanner()', () => {
    it('should extract serial number from banner', () => {
      const banner = `
Unit ID SN12345
      `

      const serial = parser.extractSerialFromBanner(banner)
      expect(serial).toBe('SN12345')
    })

    it('should trim whitespace from serial number', () => {
      const banner = 'Unit ID   SN67890   '
      const serial = parser.extractSerialFromBanner(banner)
      expect(serial).toBe('SN67890')
    })

    it('should return null if serial not found', () => {
      const banner = 'No serial here'
      expect(parser.extractSerialFromBanner(banner)).toBeNull()
    })
  })

  describe('extractModeFromBanner()', () => {
    it('should extract freerun mode from banner', () => {
      const banner = `
Operating in free run mode
      `

      const [mode, tag] = parser.extractModeFromBanner(banner)
      expect(mode).toBe('freerun')
      expect(tag).toBeNull()
    })

    it('should extract polled mode with TAG from banner', () => {
      const banner = `
Operating in polled mode with tag of A
      `

      const [mode, tag] = parser.extractModeFromBanner(banner)
      expect(mode).toBe('polled')
      expect(tag).toBe('A')
    })

    it('should normalize TAG to uppercase', () => {
      const banner = 'Operating in polled mode with tag of b'
      const [, tag] = parser.extractModeFromBanner(banner)
      expect(tag).toBe('B')
    })

    it('should return null for both if mode not found', () => {
      const banner = 'No mode information'
      const [mode, tag] = parser.extractModeFromBanner(banner)
      expect(mode).toBeNull()
      expect(tag).toBeNull()
    })
  })

  describe('Command Builders', () => {
    it('makePolledInitCmd should format correctly', () => {
      expect(makePolledInitCmd('A')).toBe('*AQ000!')
      expect(makePolledInitCmd('Z')).toBe('*ZQ000!')
    })

    it('makePolledQueryCmd should format correctly', () => {
      expect(makePolledQueryCmd('A')).toBe('>A*')
      expect(makePolledQueryCmd('Z')).toBe('>Z*')
    })
  })

  describe('Buffer Management', () => {
    it('clearBuffer should reset internal state', () => {
      parser.feed(Buffer.from('incomplete line', 'ascii'))
      expect(parser.getBufferSize()).toBeGreaterThan(0)

      parser.clearBuffer()
      expect(parser.getBufferSize()).toBe(0)
    })

    it('getBufferSize should return current buffer length', () => {
      const data = 'test data without terminator'
      parser.feed(Buffer.from(data, 'ascii'))
      expect(parser.getBufferSize()).toBe(data.length)
    })
  })

  describe('Integration: Full Frame Processing', () => {
    it('should process realistic sensor data stream', () => {
      // Simulate realistic sensor output with multiple readings
      const stream = [
        '$LITE123.456789, 21.34, 12.345\r\n',
        '$LITE123.467890, 21.35, 12.346\r\n',
        '$LITE123.478901, 21.36, 12.347\r\n',
      ].join('')

      const lines = parser.feed(Buffer.from(stream, 'ascii'))
      expect(lines).toHaveLength(3)

      const data1 = parser.parseFreerunLine(lines[0])
      expect(data1.value).toBeCloseTo(123.456789, 6)
      expect(data1.TempC).toBeCloseTo(21.34, 2)
      expect(data1.Vin).toBeCloseTo(12.345, 3)

      const data2 = parser.parseFreerunLine(lines[1])
      expect(data2.value).toBeCloseTo(123.467890, 6)

      const data3 = parser.parseFreerunLine(lines[2])
      expect(data3.value).toBeCloseTo(123.478901, 6)
    })

    it('should handle mixed valid and invalid lines', () => {
      const stream = [
        '$LITE100.0\r\n',
        'GARBAGE LINE\r\n',
        '$LITE200.0, 20.0\r\n',
        'More garbage\r\n',
        '$LITE300.0, 20.5, 12.0\r\n',
      ].join('')

      const lines = parser.feed(Buffer.from(stream, 'ascii'))
      expect(lines).toHaveLength(5)

      // First valid line
      const data1 = parser.parseFreerunLine(lines[0])
      expect(data1.value).toBe(100.0)

      // Second line should throw
      expect(() => parser.parseFreerunLine(lines[1])).toThrow(InvalidFrameError)

      // Third valid line
      const data3 = parser.parseFreerunLine(lines[2])
      expect(data3.value).toBe(200.0)
      expect(data3.TempC).toBe(20.0)

      // Fourth line should throw
      expect(() => parser.parseFreerunLine(lines[3])).toThrow(InvalidFrameError)

      // Fifth valid line
      const data5 = parser.parseFreerunLine(lines[4])
      expect(data5.value).toBe(300.0)
      expect(data5.TempC).toBe(20.5)
      expect(data5.Vin).toBe(12.0)
    })
  })

  describe('Edge Cases and Robustness', () => {
    it('should handle very large values', () => {
      const data = parser.parseFreerunLine('999999999.123456789')
      expect(data.value).toBeCloseTo(999999999.123456789, 6)
    })

    it('should handle very small values', () => {
      const data = parser.parseFreerunLine('0.000000001')
      expect(data.value).toBeCloseTo(0.000000001, 9)
    })

    it('should handle decimal notation (device format)', () => {
      // Q-Series devices use decimal notation, not scientific notation
      const data = parser.parseFreerunLine('0.00000123')
      expect(data.value).toBeCloseTo(0.00000123, 8)
    })

    it('should handle whitespace in field separators', () => {
      // trim() is applied before parsing, regex allows spaces after commas
      const data = parser.parseFreerunLine('$LITE123.456, 21.34, 12.345')
      expect(data.value).toBeCloseTo(123.456, 3)
      expect(data.TempC).toBeCloseTo(21.34, 2)
      expect(data.Vin).toBeCloseTo(12.345, 3)
    })

    it('should handle zero values', () => {
      const data = parser.parseFreerunLine('0.0, 0.0, 0.0')
      expect(data.value).toBe(0.0)
      expect(data.TempC).toBe(0.0)
      expect(data.Vin).toBe(0.0)
    })

    it('should handle negative values in all fields', () => {
      const data = parser.parseFreerunLine('-123.456, -21.34, -12.345')
      expect(data.value).toBeCloseTo(-123.456, 3)
      expect(data.TempC).toBeCloseTo(-21.34, 2)
      expect(data.Vin).toBeCloseTo(-12.345, 3)
    })
  })
})
