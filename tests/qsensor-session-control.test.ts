import { mount } from '@vue/test-utils'

import QSensorSessionControl from '@/components/qsensor/QSensorSessionControl.vue'

type StoreState = {
  /**
   *
   */
  globalMissionName: string
  /**
   *
   */
  isAnyRecording: boolean
  /**
   *
   */
  areBothConnected: boolean
  /**
   *
   */
  areBothRecording: boolean
  /**
   *
   */
  totalBytesMirrored: number
  /**
   *
   */
  unifiedSessionId: string | null
  /**
   *
   */
  unifiedSessionPath: string | null
  /**
   *
   */
  combinedErrors: string[]
  /**
   *
   */
  startBoth: ReturnType<typeof vi.fn>
  /**
   *
   */
  stopBoth: ReturnType<typeof vi.fn>
}

const createStore = (overrides: Partial<StoreState> = {}): StoreState => ({
  globalMissionName: 'Cockpit',
  isAnyRecording: false,
  areBothConnected: true,
  areBothRecording: false,
  totalBytesMirrored: 0,
  unifiedSessionId: null,
  unifiedSessionPath: null,
  combinedErrors: [],
  startBoth: vi.fn().mockResolvedValue({ success: true, errors: [] }),
  stopBoth: vi.fn().mockResolvedValue({ success: true, errors: [] }),
  ...overrides,
})

let storeInstance: StoreState = createStore()

vi.mock('@/stores/qsensor', () => ({
  useQSensorStore: () => storeInstance,
}))

describe('QSensorSessionControl', () => {
  beforeEach(() => {
    storeInstance = createStore()
  })

  it('displays unified session folder when path is available', () => {
    storeInstance = createStore({
      isAnyRecording: true,
      areBothRecording: true,
      unifiedSessionPath: '/tmp/mission/session_2025-05-18T12-00-00Z',
      unifiedSessionId: 'unified-123',
      totalBytesMirrored: 4096,
    })

    const wrapper = mount(QSensorSessionControl)
    const wrapperEl = wrapper.get('[data-test="unified-session-path"]')
    const value = wrapper.get('[data-test="unified-session-path-value"]')

    expect(value.text()).toBe('session_2025-05-18T12-00-00Z')
    expect(value.attributes('title')).toBe('/tmp/mission/session_2025-05-18T12-00-00Z')
    expect(wrapperEl.text()).toContain('Unified Session Root')
  })

  it('hides session folder info when no session is active', () => {
    storeInstance = createStore({
      isAnyRecording: false,
      unifiedSessionPath: null,
    })

    const wrapper = mount(QSensorSessionControl)
    expect(wrapper.find('[data-test="unified-session-path"]').exists()).toBe(false)
  })
})
