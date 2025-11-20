import { flushPromises, mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import type { MiniWidget } from '@/types/widgets'

const emptyComponent = { render: () => null }

vi.mock('vuetify/lib/components/VBadge/index.mjs', () => ({ VBadge: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VBadge/VBadge.mjs', () => ({ VBadge: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VBtn/index.mjs', () => ({ VBtn: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VBtn/VBtn.mjs', () => ({ VBtn: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VIcon/index.mjs', () => ({ VIcon: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VIcon/VIcon.mjs', () => ({ VIcon: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VDialog/index.mjs', () => ({ VDialog: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VDialog/VDialog.mjs', () => ({ VDialog: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VDivider/index.mjs', () => ({ VDivider: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VDivider/VDivider.mjs', () => ({ VDivider: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VSelect/index.mjs', () => ({ VSelect: emptyComponent }), { virtual: true })
vi.mock('vuetify/lib/components/VSelect/VSelect.mjs', () => ({ VSelect: emptyComponent }), { virtual: true })

import MiniVideoRecorder from '@/components/mini-widgets/MiniVideoRecorder.vue'

const startRecordingMock = vi.fn()
const stopRecordingMock = vi.fn()
const externalStreamIdMock = vi.fn()
const getStreamDataMock = vi.fn()
const isRecordingMock = vi.fn()
const tempStorageKeys = vi.fn().mockResolvedValue([])
const videoStorageKeys = vi.fn().mockResolvedValue([])
let isRecordingFlag = false

const streamsCorrespondency = ref([{ name: 'Stream 1', externalId: 'stream-1' }])
const abstractedStreams = ref(['Stream 1'])

const videoStoreMock = {
  startRecording: startRecordingMock,
  stopRecording: stopRecordingMock,
  externalStreamId: externalStreamIdMock,
  getStreamData: getStreamDataMock,
  isRecording: isRecordingMock,
  videoStorage: {
    keys: videoStorageKeys,
    setItem: vi.fn(),
    getItem: vi.fn(),
  },
  tempVideoStorage: {
    keys: tempStorageKeys,
  },
  isVideoFilename: vi.fn().mockReturnValue(false),
  lastRenamedStreamName: '',
  streamsCorrespondency,
  namessAvailableAbstractedStreams: abstractedStreams,
}

vi.mock('@vueuse/core', () => ({
  useMouseInElement: () => ({ isOutside: ref(false) }),
  useTimestamp: () => ref(0),
}))

vi.mock('@/stores/video', () => ({
  useVideoStore: () => videoStoreMock,
}))

const widgetStates: Record<string, { configMenuOpen: boolean }> = {}

vi.mock('@/stores/widgetManager', () => ({
  useWidgetManagerStore: () => ({
    miniWidgetManagerVars: (hash: string) => {
      if (!widgetStates[hash]) {
        widgetStates[hash] = reactive({ configMenuOpen: false })
      }
      return widgetStates[hash]
    },
    isRealMiniWidget: () => false,
  }),
}))

vi.mock('@/stores/appInterface', () => ({
  useAppInterfaceStore: () =>
    reactive({
      videoLibraryMode: 'videos',
      videoLibraryVisibility: false,
      globalGlassMenuStyles: {},
    }),
}))

vi.mock('@/composables/interactionDialog', () => ({
  useInteractionDialog: () => ({
    showDialog: vi.fn(),
  }),
}))

const stubs = {
  'v-btn': {
    template: '<button><slot /></button>',
  },
  'v-icon': {
    template: '<span><slot /></span>',
  },
  'v-dialog': {
    template: '<div><slot /></div>',
  },
  'v-badge': {
    template: '<div><slot /></slot></div>',
  },
  'v-divider': {
    template: '<div><slot /></slot></div>',
  },
  FontAwesomeIcon: {
    template: '<span><slot /></span>',
  },
}

function createMiniWidget(overrides: Partial<MiniWidget> = {}): MiniWidget {
  return {
    hash: 'widget-1',
    title: 'Recorder',
    options: { internalStreamName: 'Stream 1' },
    ...overrides,
  } as MiniWidget
}

describe('MiniVideoRecorder.vue', () => {
  beforeEach(() => {
    startRecordingMock.mockReset()
    stopRecordingMock.mockReset()
    externalStreamIdMock.mockReturnValue('stream-1')
    getStreamDataMock.mockImplementation(() => ({ connected: true, timeRecordingStart: new Date() }))
    tempStorageKeys.mockResolvedValue([])
    videoStorageKeys.mockResolvedValue([])
    isRecordingFlag = false
    isRecordingMock.mockImplementation(() => isRecordingFlag)
  })

  async function mountRecorder(props = {}) {
    const wrapper = mount(MiniVideoRecorder, {
      props: {
        miniWidget: createMiniWidget(props),
      },
      global: {
        stubs,
      },
    })
    await flushPromises()
    return wrapper
  }

  it('invokes video store startRecording when record button is clicked', async () => {
    isRecordingFlag = false

    const wrapper = await mountRecorder()
    await wrapper.get('[data-test="record-toggle"]').trigger('click')

    expect(startRecordingMock).toHaveBeenCalledWith('stream-1')
  })

  it('invokes video store stopRecording when stop is clicked', async () => {
    isRecordingFlag = true

    const wrapper = await mountRecorder()
    await wrapper.get('[data-test="record-toggle"]').trigger('click')

    expect(stopRecordingMock).toHaveBeenCalledWith('stream-1')
    expect(startRecordingMock).not.toHaveBeenCalled()
  })
})
