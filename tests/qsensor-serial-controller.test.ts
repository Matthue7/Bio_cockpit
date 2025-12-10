/**
 * Unit tests for Q-Series Serial Controller
 *
 * These tests verify the controller's state machine, menu navigation,
 * and acquisition logic using mocked serial communication.
 */

import EventEmitter from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QSeriesReading } from '../src/electron/services/qsensor-protocol'
import {
  ConnectionState,
  InvalidConfigValueError,
  MenuTimeoutError,
  QSeriesSerialController,
  SerialIOError,
} from '../src/electron/services/qsensor-serial-controller'

// ============================================================================
// Mock Serial Link
// ============================================================================

/**
 *
 */
class MockSerialLink extends EventEmitter {
  isOpen = false
  private writeCallback?: (data: Buffer) => void
  private readBuffer: Buffer[] = []

  /**
   *
   */
  async open(): Promise<void> {
    this.isOpen = true
    console.log('[MockSerial] Port opened')
  }

  /**
   *
   */
  async close(): Promise<void> {
    this.isOpen = false
    this.removeAllListeners()
    console.log('[MockSerial] Port closed')
  }

  /**
   *
   * @param data
   */
  async write(data: Buffer): Promise<void> {
    if (!this.isOpen) {
      throw new Error('Port not open')
    }
    console.log('[MockSerial] Write:', data.toString('ascii').replace(/\r/g, '<CR>').replace(/\n/g, '<LF>'))

    if (this.writeCallback) {
      this.writeCallback(data)
    }
  }

  // Test helper: set callback for write operations
  /**
   *
   * @param callback
   */
  onWrite(callback: (data: Buffer) => void): void {
    this.writeCallback = callback
  }

  // Test helper: simulate incoming data
  /**
   *
   * @param data
   */
  simulateData(data: string): void {
    this.emit('data', Buffer.from(data, 'ascii'))
  }

  // Test helper: simulate error
  /**
   *
   * @param error
   */
  simulateError(error: Error): void {
    this.emit('error', error)
  }

  // Test helper: simulate close
  /**
   *
   */
  simulateClose(): void {
    this.isOpen = false
    this.emit('close')
  }
}

// ============================================================================
// Test Utilities
// ============================================================================

/**
 *
 */
function createMockLink(): MockSerialLink {
  return new MockSerialLink()
}

/**
 *
 * @param callback
 */
function deferResponse(callback: () => void): void {
  queueMicrotask(callback)
}

/**
 *
 */
async function flushAsync(): Promise<void> {
  await Promise.resolve()
}

/**
 *
 * @param controller
 * @param mockLink
 * @param configLine
 * @param extraHandler
 */
function setupMenuMocks(
  controller: QSeriesSerialController,
  mockLink: MockSerialLink,
  configLine: string,
  extraHandler?: (command: string) => void
): void {
  mockLink.onWrite((data) => {
    const str = data.toString('ascii')
    if (str.includes('\x1b')) {
      mockLink.simulateData('Select the letter of the menu entry:\r\n')
      return
    }
    if (str.includes('^')) {
      mockLink.simulateData(`${configLine}\r\n`)
      return
    }
    extraHandler?.(str)
  })
}

// ============================================================================
// Tests
// ============================================================================

describe('QSeriesSerialController', () => {
  let controller: QSeriesSerialController
  let mockLink: MockSerialLink
  let timeoutSpy: ReturnType<typeof vi.spyOn>
  let delaySpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    controller = new QSeriesSerialController()
    timeoutSpy = vi.spyOn(global, 'setTimeout' as any).mockImplementation(((fn: (...args: any[]) => void) => {
      fn()
      return 0 as unknown as NodeJS.Timeout
    }) as any)
    // Short-circuit internal delay() calls so we don't need to advance timers for them
    delaySpy = vi.spyOn(controller as any, 'delay').mockImplementation(() => Promise.resolve())
    mockLink = createMockLink()
  })

  afterEach(async () => {
    if (controller.isConnected()) {
      await controller.disconnect()
    }
    timeoutSpy.mockRestore()
    delaySpy.mockRestore()
  })

  /**
   * Helper to connect the controller and allow any queued microtasks to flush.
   * @param port
   * @param baudRate
   */
  async function connectController(port = '/dev/ttyUSB0', baudRate = 9600): Promise<void> {
    await controller.connect(port, baudRate)
    await flushAsync()
  }

  describe('Connection Management', () => {
    it('should start in DISCONNECTED state', () => {
      expect(controller.getState()).toBe(ConnectionState.DISCONNECTED)
      expect(controller.isConnected()).toBe(false)
    })

    it('should prevent connection when already connected', async () => {
      // Mock the serial link creation
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      // Simulate successful connection
      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          // ESC sent, respond with menu prompt
          setTimeout(() => {
            mockLink.simulateData('Select the letter of the menu entry:\r\n')
          }, 10)
        } else if (str.includes('^')) {
          // Config dump requested
          setTimeout(() => {
            mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n')
          }, 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)
      expect(controller.getState()).toBe(ConnectionState.CONFIG_MENU)

      // Try connecting again
      await expect(controller.connect('/dev/ttyUSB0', 9600)).rejects.toThrow(SerialIOError)
    })

    it('should clean up on disconnect', async () => {
      // Setup mock link
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          mockLink.simulateData('Select the letter of the menu entry:\r\n')
        } else if (str.includes('^')) {
          mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n')
        }
      })

      await connectController('/dev/ttyUSB0', 9600)

      await controller.disconnect()

      expect(controller.getState()).toBe(ConnectionState.DISCONNECTED)
      expect(controller.isConnected()).toBe(false)
      expect(mockLink.isOpen).toBe(false)
    })

    it('should allow reconnection after disconnect', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          setTimeout(() => mockLink.simulateData('Select the letter of the menu entry:\r\n'), 10)
        } else if (str.includes('^')) {
          setTimeout(() => mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n'), 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)
      await controller.disconnect()

      // Should be able to reconnect
      await controller.reconnect()
      expect(controller.getState()).toBe(ConnectionState.CONFIG_MENU)
    })
  })

  describe('State Machine', () => {
    it('should emit state-change events', async () => {
      const stateChanges: ConnectionState[] = []
      controller.on('state-change', (state: ConnectionState) => {
        stateChanges.push(state)
      })

      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          setTimeout(() => mockLink.simulateData('Select the letter of the menu entry:\r\n'), 10)
        } else if (str.includes('^')) {
          setTimeout(() => mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n'), 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)

      expect(stateChanges).toContain(ConnectionState.CONFIG_MENU)
    })

    it('should enforce state requirements for operations', () => {
      // Try to get config when not connected
      expect(() => controller.getConfig()).toThrow(SerialIOError)

      // Try to start acquisition when not in menu
      expect(() => controller.startAcquisition()).rejects.toThrow(SerialIOError)
    })
  })

  describe('Configuration Operations', () => {
    beforeEach(async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          setTimeout(() => mockLink.simulateData('Select the letter of the menu entry:\r\n'), 10)
        } else if (str.includes('^')) {
          setTimeout(() => mockLink.simulateData('12,9600,1.5,TestSensor,E,4.003,G,H,SN12345,0,0,12.0,0,,\r\n'), 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)
    })

    it('should retrieve current configuration', () => {
      const config = controller.getConfig()

      expect(config).toBeDefined()
      expect(config.serial_number).toBe('SN12345')
      expect(config.averaging).toBe(12)
      expect(config.firmware_version).toBe('4.003')
      expect(config.mode).toBe('freerun')
    })

    it('should validate averaging range', async () => {
      await expect(controller.setAveraging(0)).rejects.toThrow(InvalidConfigValueError)
      await expect(controller.setAveraging(70000)).rejects.toThrow(InvalidConfigValueError)
    })

    it('should validate ADC rate values', async () => {
      await expect(controller.setAdcRate(99)).rejects.toThrow(InvalidConfigValueError)
      await expect(controller.setAdcRate(1000)).rejects.toThrow(InvalidConfigValueError)
    })

    it('should validate mode and TAG', async () => {
      // Polled mode requires TAG
      await expect(controller.setMode('polled', null)).rejects.toThrow(InvalidConfigValueError)

      // TAG must be single uppercase A-Z
      await expect(controller.setMode('polled', 'ab')).rejects.toThrow(InvalidConfigValueError)
      await expect(controller.setMode('polled', '1')).rejects.toThrow(InvalidConfigValueError)
    })
  })

  describe('Data Acquisition - Freerun Mode', () => {
    it('should emit reading events for valid freerun data', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          setTimeout(() => mockLink.simulateData('Select the letter of the menu entry:\r\n'), 10)
        } else if (str.includes('^')) {
          setTimeout(() => mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n'), 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)

      const readings: QSeriesReading[] = []
      controller.on('reading', (reading: QSeriesReading) => {
        readings.push(reading)
      })

      await controller.startAcquisition()

      // Wait for readings to arrive
      mockLink.simulateData('$LITE123.456789, 21.34, 12.345\r\n')
      mockLink.simulateData('$LITE123.467890, 21.35, 12.346\r\n')
      await flushAsync()

      expect(readings.length).toBeGreaterThan(0)
      expect(readings[0].value).toBeCloseTo(123.456789, 6)
      expect(readings[0].mode).toBe('freerun')
      expect(readings[0].sensor_id).toBe('SN123')
    })

    it('should filter out banner and menu lines during acquisition', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          mockLink.simulateData('Select the letter of the menu entry:\r\n')
        } else if (str.includes('^')) {
          mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n')
        }
      })

      await connectController('/dev/ttyUSB0', 9600)

      const readings: QSeriesReading[] = []
      controller.on('reading', (reading: QSeriesReading) => {
        readings.push(reading)
      })

      await controller.startAcquisition()
      mockLink.simulateData('Biospherical Instruments\r\n')
      mockLink.simulateData('Unit ID SN123\r\n')
      mockLink.simulateData('Operating in free run mode\r\n')
      mockLink.simulateData('$LITE100.0\r\n')
      await flushAsync()

      // Should only have the valid data reading, not banner lines
      expect(readings.length).toBe(1)
      expect(readings[0].value).toBe(100.0)
    })
  })

  describe('Data Acquisition - Polled Mode', () => {
    it('should send init command before polling', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      let initCmdSent = false
      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          setTimeout(() => mockLink.simulateData('Select the letter of the menu entry:\r\n'), 10)
        } else if (str.includes('^')) {
          setTimeout(() => mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,1,A,\r\n'), 10)
        } else if (str.includes('*AQ000!')) {
          initCmdSent = true
        } else if (str.includes('>A*')) {
          // Respond to query
          setTimeout(() => mockLink.simulateData('A,123.456\r\n'), 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)
      await controller.startAcquisition(1.0)

      await flushAsync()
      expect(initCmdSent).toBe(true)
    })

    it('should poll at specified rate', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      const queriesSent: number[] = []
      const intervalCallbacks: Array<() => Promise<void> | void> = []
      let scheduledPeriod = 0

      vi.spyOn(controller as any, 'scheduleInterval').mockImplementation(
        (callback: () => void | Promise<void>, period: number) => {
          scheduledPeriod = period
          intervalCallbacks.push(callback)
          return { id: intervalCallbacks.length } as unknown as NodeJS.Timeout
        }
      )
      vi.spyOn(controller as any, 'clearScheduledInterval').mockImplementation(() => {})

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          mockLink.simulateData('Select the letter of the menu entry:\r\n')
        } else if (str.includes('^')) {
          mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,1,A,\r\n')
        } else if (str.includes('>A*')) {
          queriesSent.push(Date.now())
          mockLink.simulateData('A,100.0\r\n')
        }
      })

      await connectController('/dev/ttyUSB0', 9600)
      await controller.startAcquisition(2.0) // 2 Hz = 500ms period

      expect(scheduledPeriod).toBeCloseTo(500)
      // Manually trigger two poll ticks
      const pollCallback = intervalCallbacks[0]
      expect(pollCallback).toBeDefined()
      await pollCallback?.()
      await pollCallback?.()

      expect(queriesSent.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Pause and Resume', () => {
    it('should pause acquisition and enter menu', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          setTimeout(() => mockLink.simulateData('Select the letter of the menu entry:\r\n'), 10)
        } else if (str.includes('^')) {
          setTimeout(() => mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n'), 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)
      await controller.startAcquisition()

      expect(controller.getState()).toBe(ConnectionState.ACQ_FREERUN)

      await controller.pause()

      expect(controller.getState()).toBe(ConnectionState.PAUSED)
    })

    it('should resume acquisition after pause', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          setTimeout(() => mockLink.simulateData('Select the letter of the menu entry:\r\n'), 10)
        } else if (str.includes('^')) {
          setTimeout(() => mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n'), 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)
      await controller.startAcquisition()
      await controller.pause()

      await controller.resume()

      expect(controller.getState()).toBe(ConnectionState.ACQ_FREERUN)
    })

    it('should reject pause when not acquiring', async () => {
      await expect(controller.pause()).rejects.toThrow(SerialIOError)
    })

    it('should reject resume when not paused', async () => {
      await expect(controller.resume()).rejects.toThrow(SerialIOError)
    })
  })

  describe('Health and Status', () => {
    it('should provide health data', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          mockLink.simulateData('Select the letter of the menu entry:\r\n')
        } else if (str.includes('^')) {
          mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n')
        }
      })

      await connectController('/dev/ttyUSB0', 9600)

      const health = controller.getHealth()

      expect(health.sensor_id).toBe('SN123')
      expect(health.state).toBe(ConnectionState.CONFIG_MENU)
      expect(health.buffer_size).toBeDefined()
    })

    it('should track last reading timestamp', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          mockLink.simulateData('Select the letter of the menu entry:\r\n')
        } else if (str.includes('^')) {
          mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n')
        }
      })

      await connectController('/dev/ttyUSB0', 9600)
      await controller.startAcquisition()
      mockLink.simulateData('Biospherical Instruments\r\n')
      mockLink.simulateData('Unit ID SN123\r\n')
      mockLink.simulateData('Operating in free run mode\r\n')
      mockLink.simulateData('$LITE100.0\r\n')
      await flushAsync()

      const health = controller.getHealth()
      expect(health.last_reading_age_ms).toBeDefined()
      expect(health.last_reading_age_ms).toBeLessThan(1000)
    })
  })

  describe('Error Handling', () => {
    it('should emit error events on serial errors', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          setTimeout(() => mockLink.simulateData('Select the letter of the menu entry:\r\n'), 10)
        } else if (str.includes('^')) {
          setTimeout(() => mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n'), 10)
        }
      })

      await connectController('/dev/ttyUSB0', 9600)

      const errors: Error[] = []
      controller.on('error', (error: Error) => {
        errors.push(error)
      })

      mockLink.simulateError(new Error('Serial port disconnected'))

      expect(errors.length).toBeGreaterThan(0)
      expect(controller.getState()).toBe(ConnectionState.DISCONNECTED)
      expect(controller.isConnected()).toBe(false)
    })

    it('should handle unexpected port close', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          mockLink.simulateData('Select the letter of the menu entry:\r\n')
        } else if (str.includes('^')) {
          mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n')
        }
      })

      await connectController('/dev/ttyUSB0', 9600)

      const stateChanges: ConnectionState[] = []
      controller.on('state-change', (state: ConnectionState) => {
        stateChanges.push(state)
      })

      const errors: Error[] = []
      controller.on('error', (error: Error) => errors.push(error))

      mockLink.simulateClose()

      expect(stateChanges).toContain(ConnectionState.DISCONNECTED)
      expect(controller.getState()).toBe(ConnectionState.DISCONNECTED)
      expect(errors.pop()?.message).toContain('closed unexpectedly')
      expect(controller.isConnected()).toBe(false)
    })
  })

  describe('Reading Timestamps', () => {
    it('should include both UTC and monotonic timestamps', async () => {
      vi.spyOn(controller as any, 'createSerialLink').mockReturnValue(mockLink)

      mockLink.onWrite((data) => {
        const str = data.toString('ascii')
        if (str.includes('\x1b')) {
          mockLink.simulateData('Select the letter of the menu entry:\r\n')
        } else if (str.includes('^')) {
          mockLink.simulateData('12,9600,1.0,Test,E,4.003,G,H,SN123,0,0,12.0,0,,\r\n')
        }
      })

      await connectController('/dev/ttyUSB0', 9600)

      const readings: QSeriesReading[] = []
      controller.on('reading', (reading: QSeriesReading) => {
        readings.push(reading)
      })

      await controller.startAcquisition()
      mockLink.simulateData('$LITE100.0, 20.0, 12.0\r\n')
      await flushAsync()

      expect(readings.length).toBeGreaterThan(0)

      const reading = readings[0]
      expect(reading.timestamp_utc).toBeDefined()
      expect(new Date(reading.timestamp_utc).getTime()).toBeGreaterThan(0)

      expect(reading.timestamp_monotonic_ns).toBeDefined()
      expect(typeof reading.timestamp_monotonic_ns).toBe('bigint')
      expect(reading.timestamp_monotonic_ns).toBeGreaterThan(0n)
    })
  })
})
