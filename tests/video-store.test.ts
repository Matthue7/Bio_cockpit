import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref } from 'vue'

// ---------------------------------------------------------------------------
// Array prototype helper used in Cockpit (cosmos extensions)
// ---------------------------------------------------------------------------
declare global {
  interface Array<T> {
    isEmpty(): boolean
  }
}

if (!Array.prototype.isEmpty) {
  // eslint-disable-next-line no-extend-native
  Array.prototype.isEmpty = function (): boolean {
    return this.length === 0
  }
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockShowDialog = vi.fn()
const mockEventTracker = { capture: vi.fn() }
const mockAlertStore = { pushAlert: vi.fn() }
const mockMainVehicleStore = {
  mainVehicle: { hostname: 'pilot.local' },
  globalAddress: ref('pilot.local'),
  rtcConfiguration: ref({}),
  webRTCSignallingURI: ref('ws://localhost'),
}
const mockMissionStore = { missionName: 'Test Mission' }

const mockQSensorStore = {
  apiBaseUrl: '',
  globalMissionName: '',
  isAnyRecording: true,
  currentSessionId: 'in-water-session',
  startBoth: vi.fn().mockResolvedValue({ success: true, errors: [] }),
  stopBoth: vi.fn().mockResolvedValue({ success: true, errors: [] }),
  reset: vi.fn(),
}

const tempVideoStorageStub = {
  keys: vi.fn().mockResolvedValue([]),
  localForage: {
    length: vi.fn().mockResolvedValue(0),
  },
  setItem: vi.fn(),
  getItem: vi.fn(),
}

const videoStorageStub = {
  getItem: vi.fn(),
  setItem: vi.fn(),
}

vi.mock('@vueuse/core', () => {
  return {
    useStorage: <T>(_: string, initial: T) => ref(initial),
    useThrottleFn: (fn: (...args: any[]) => unknown) => fn,
  }
})

vi.mock('@/composables/interactionDialog', () => ({
  useInteractionDialog: () => ({
    showDialog: mockShowDialog,
  }),
}))

vi.mock('@/composables/settingsSyncer', () => ({
  useBlueOsStorage: <T>(_: string, initial: T) => ref(initial),
}))

vi.mock('@/composables/snackbar', () => ({
  useSnackbar: () => ({
    openSnackbar: vi.fn(),
  }),
}))

vi.mock('@/composables/webRTC', () => {
  class MockWebRTCManager {
    availableStreams = ref([{ name: 'Stream 1' }])
    startStream() {
      const mediaStream = ref({ active: true })
      const connected = ref(true)
      return {
        mediaStream,
        connected,
      }
    }
    endAllSessions() {
      // noop
    }
  }
  return { WebRTCManager: MockWebRTCManager }
})

vi.mock('@/libs/videoStorage', () => ({
  tempVideoStorage: tempVideoStorageStub,
  videoStorage: videoStorageStub,
}))

vi.mock('@/libs/live-video-processor', () => {
  class MockLiveVideoProcessor {
    async startProcessing(): Promise<void> {
      return
    }
  }
  return {
    LiveVideoProcessor: MockLiveVideoProcessor,
    LiveVideoProcessorInitializationError: class {},
    LiveVideoProcessorChunkAppendingError: class {},
  }
})

vi.mock('@/libs/external-telemetry/event-tracking', () => ({
  default: mockEventTracker,
}))

vi.mock('@/libs/joystick/protocols/cockpit-actions', () => ({
  availableCockpitActions: {
    start_recording_all_streams: 'start',
    stop_recording_all_streams: 'stop',
    toggle_recording_all_streams: 'toggle',
  },
  registerActionCallback: vi.fn(),
}))

vi.mock('@/libs/utils', () => ({
  sleep: () => Promise.resolve(),
  isEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
}))

vi.mock('@/stores/mission', () => ({
  useMissionStore: () => mockMissionStore,
}))

vi.mock('@/stores/mainVehicle', () => ({
  useMainVehicleStore: () => mockMainVehicleStore,
}))

vi.mock('@/stores/alert', () => ({
  useAlertStore: () => mockAlertStore,
}))

vi.mock('@/stores/qsensor', () => ({
  useQSensorStore: () => mockQSensorStore,
}))

// Stub alert class imports
vi.mock('@/types/alert', () => ({
  Alert: class {
    constructor(public level: unknown, public message: unknown) {
      this.level = level
      this.message = message
    }
  },
  AlertLevel: {
    Success: 'success',
  },
}))

vi.mock('@/libs/blueos', () => ({
  getIpsInformationFromVehicle: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/libs/sensors-logging', () => ({
  datalogger: {
    log: vi.fn(),
  },
}))

import { useVideoStore } from '../src/stores/video'

class FakeMediaRecorder {
  public state = 'inactive'
  constructor(_: MediaStream) {}
  start = vi.fn()
  stop = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

;(globalThis as any).MediaRecorder = FakeMediaRecorder as any

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStreamEntry() {
  const mediaRecorder = {
    start: vi.fn(),
    stop: vi.fn(),
    state: 'inactive',
  }
  const videoTrack = {
    stop: vi.fn(),
    getSettings: () => ({ width: 1280, height: 720 }),
  }
  const mediaStream = {
    active: true,
    getVideoTracks: () => [videoTrack],
  }
  return {
    stream: undefined,
    webRtcManager: { availableICEIPs: [] },
    mediaStream,
    connected: { value: true },
    mediaRecorder,
    timeRecordingStart: undefined,
  }
}

describe('Video store dual-sensor integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    window.electronAPI = {
      startQSensorMirror: vi.fn(),
      stopQSensorMirror: vi.fn(),
    } as any
    mockQSensorStore.startBoth.mockResolvedValue({ success: true, errors: [] })
    mockQSensorStore.stopBoth.mockResolvedValue({ success: true, errors: [] })
    mockQSensorStore.reset.mockImplementation(() => {
      mockQSensorStore.isAnyRecording = false
      mockQSensorStore.currentSessionId = null
    })
    mockQSensorStore.isAnyRecording = true
    tempVideoStorageStub.keys.mockResolvedValue([])
    tempVideoStorageStub.localForage.length.mockResolvedValue(0)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('startRecording triggers qsensorStore.startBoth with mission metadata', async () => {
    const store = useVideoStore()
    store.activeStreams['Stream 1'] = createStreamEntry()

    await store.startRecording('Stream 1')

    expect(mockQSensorStore.startBoth).toHaveBeenCalledWith({
      mission: 'Test Mission',
      rateHz: 500,
      rollIntervalS: 60,
    })
    expect(mockQSensorStore.apiBaseUrl).toBe('http://pilot.local:9150')
    expect(mockQSensorStore.globalMissionName).toBe('Test Mission')
  })

  it('startRecording logs warning but continues when startBoth fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockQSensorStore.startBoth.mockResolvedValueOnce({
      success: false,
      errors: ['Surface failed'],
    })
    const store = useVideoStore()
    store.activeStreams['Stream 1'] = createStreamEntry()

    await store.startRecording('Stream 1')

    expect(mockQSensorStore.startBoth).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith('[Q-Sensor] Failed to start sensors:', ['Surface failed'])
    warnSpy.mockRestore()
  })

  it('stopRecording triggers qsensorStore.stopBoth and reset', async () => {
    const store = useVideoStore()
    const entry = createStreamEntry()
    store.activeStreams['Stream 1'] = entry

    await store.stopRecording('Stream 1')

    expect(mockQSensorStore.stopBoth).toHaveBeenCalled()
    const stopPromise = mockQSensorStore.stopBoth.mock.results[0]?.value
    if (stopPromise) {
      await stopPromise
    }
    await Promise.resolve()
    expect(mockQSensorStore.reset).toHaveBeenCalled()
    expect(entry.mediaRecorder.stop).toHaveBeenCalled()
  })
})
