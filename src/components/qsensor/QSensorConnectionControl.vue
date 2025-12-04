<!--
  QSensorConnectionControl.vue - Connection controls for a Q-Series sensor.
  Phase 4: Dual-sensor UI architecture.

  This component provides connection fields and buttons for either HTTP (in-water)
  or Serial (surface) backend types.
-->
<template>
  <div class="flex flex-col gap-4">
    <!-- Phase 2: Connection mode selector -->
    <QSensorConnectionModeSelector
      :sensor-id="sensorId"
      :sensor="sensor"
      @mode-selected="handleModeSelected"
      @error="emit('error', $event)"
    />

    <!-- HTTP backend fields -->
    <template v-if="sensor.connectionMode === 'api'">
      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">API URL:</label>
        <input
          v-model="localApiBaseUrl"
          type="text"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          :placeholder="apiUrlPlaceholder"
          :disabled="sensor.isConnected || isConnecting || !sensor.connectionMode"
          @blur="handleApiUrlBlur"
        />
      </div>

      <!-- Helper text for unconfigured surface sensor -->
      <div
        v-if="sensorId === 'surface' && !sensor.apiBaseUrl"
        class="p-2 bg-blue-900/20 border border-blue-600/30 rounded text-xs text-blue-400"
      >
        Enter the API URL of your surface reference sensor's Pi (e.g., http://surfaceref.local:9150)
      </div>
    </template>

    <!-- Serial backend fields -->
    <template v-else-if="sensor.connectionMode === 'serial'">
      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">Serial Port:</label>
        <select
          v-model="selectedSurfacePort"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          :disabled="sensor.isConnected || isConnecting || isRefreshingPorts || !sensor.connectionMode"
        >
          <option v-if="availableSurfacePorts.length === 0" value="">No serial ports detected</option>
          <option
            v-for="port in availableSurfacePorts"
            :key="port.path"
            :value="port.path"
          >
            {{ formatPortLabel(port) }}
          </option>
        </select>
        <button
          type="button"
          class="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm disabled:opacity-50"
          :disabled="sensor.isConnected || isConnecting || isRefreshingPorts || !sensor.connectionMode"
          @click="handleRefreshPorts"
        >
          {{ isRefreshingPorts ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>

      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">Baud Rate:</label>
        <input
          v-model.number="localBaudRate"
          type="number"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          placeholder="9600"
          :disabled="sensor.isConnected || isConnecting || !sensor.connectionMode"
        />
      </div>
    </template>

    <!-- Connect/Disconnect buttons -->
    <div class="flex items-center gap-4">
      <button
        v-if="!sensor.isConnected"
        class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="isConnecting || !sensor.connectionMode || !sensor.connectionModeExplicitlySet"
        @click="handleConnect"
      >
        {{ isConnecting ? 'Connecting...' : 'Connect' }}
      </button>
      <button
        v-else
        class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="isDisconnecting"
        @click="handleDisconnect"
      >
        {{ isDisconnecting ? 'Disconnecting...' : 'Disconnect' }}
      </button>

      <!-- Connection mode indicator -->
      <div v-if="sensor.connectionMode" class="ml-auto flex items-center gap-2">
        <span class="text-xs px-2 py-1 rounded" :class="modeBadgeClass">
          {{ modeLabel }}
        </span>
      </div>
    </div>

    <!-- Error display -->
    <div v-if="sensor.lastError" class="p-3 bg-red-900/50 border border-red-600 rounded text-sm">
      <span class="text-red-400">{{ sensor.lastError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { useQSensorStore } from '@/stores/qsensor'
import type { SerialPortInfo } from '@/stores/qsensor'
import type { QSensorId, QSensorState } from '@/types/qsensor'
import QSensorConnectionModeSelector from './QSensorConnectionModeSelector.vue'

const props = defineProps<{
  // * Sensor identifier this control manages
  sensorId: QSensorId
  // * Sensor state backing the control
  sensor: QSensorState
}>()

const emit = defineEmits<{
  (e: 'connected'): void
  (e: 'disconnected'): void
  (e: 'error', error: string): void
}>()

const store = useQSensorStore()

// * Local state for form fields
const localApiBaseUrl = ref(props.sensor.apiBaseUrl || 'http://blueos.local:9150')
const localBaudRate = ref(props.sensor.baudRate || 9600)
const isRefreshingPorts = ref(false)

// * Connection state flags
const isConnecting = ref(false)
const isDisconnecting = ref(false)

const availableSurfacePorts = computed(() => store.availableSurfacePorts)
const selectedSurfacePort = computed<string | null>({
  get: () => store.selectedSurfacePortPath,
  set: (value) => store.selectSurfaceSerialPort(value || null),
})

// Phase 2: Mode badge styling
const modeLabel = computed(() => {
  if (!props.sensor.connectionMode) return ''
  return props.sensor.connectionMode === 'api' ? 'API' : 'Serial'
})

const modeBadgeClass = computed(() => {
  if (!props.sensor.connectionMode) return ''
  return props.sensor.connectionMode === 'api'
    ? 'bg-blue-600/30 text-blue-400'
    : 'bg-purple-600/30 text-purple-400'
})

// Phase 1: Dynamic placeholder based on sensor ID
const apiUrlPlaceholder = computed(() => {
  return props.sensorId === 'inWater'
    ? 'http://blueos.local:9150'
    : 'http://surfaceref.local:9150'
})

// Phase 1: Auto-save surface URL on blur
async function handleApiUrlBlur() {
  if (props.sensorId === 'surface' && props.sensor.connectionMode === 'api') {
    const result = await store.setSurfaceApiUrl(localApiBaseUrl.value)
    if (!result.success && result.error) {
      emit('error', result.error)
    }
  }
}

// Phase 2: Handle connection mode selection
function handleModeSelected(mode: 'api' | 'serial') {
  console.log(`[QSensorConnectionControl] Connection mode selected: ${mode}`)
  // Store will handle backend type updates
}

// * Format dropdown label for a port
function formatPortLabel(port: SerialPortInfo): string {
  const details = [port.manufacturer, port.serialNumber].filter(Boolean).join(' • ')
  return details ? `${port.path} (${details})` : port.path
}

// * Refresh available serial ports for surface sensor
async function handleRefreshPorts(): Promise<void> {
  if (props.sensor.connectionMode !== 'serial') return
  isRefreshingPorts.value = true
  const result = await store.refreshSurfaceSerialPorts()
  isRefreshingPorts.value = false
  if (!result.success && result.error) {
    emit('error', result.error)
  }
}

onMounted(() => {
  if (props.sensor.connectionMode === 'serial') {
    handleRefreshPorts()
  }
})

watch(
  () => props.sensor.connectionMode,
  (newVal) => {
    if (newVal === 'serial') {
      handleRefreshPorts()
    }
  }
)

// NOTE: Sync local state with sensor state changes
watch(
  () => props.sensor.apiBaseUrl,
  (newVal) => {
    if (newVal) localApiBaseUrl.value = newVal
  }
)

watch(
  () => props.sensor.baudRate,
  (newVal) => {
    if (newVal) localBaudRate.value = newVal
  }
)

// * Handle connect button click.
async function handleConnect(): Promise<void> {
  isConnecting.value = true

  try {
    // * Update sensor configuration in store before connecting
    const sensorState = store.getSensor(props.sensorId)
    if (sensorState) {
      if (props.sensor.connectionMode === 'api') {
        sensorState.apiBaseUrl = localApiBaseUrl.value
      } else if (props.sensor.connectionMode === 'serial') {
        store.selectSurfaceSerialPort(selectedSurfacePort.value || null)
        sensorState.baudRate = localBaudRate.value
      }
    }

    const result = await store.connectSensor(props.sensorId)

    if (result.success) {
      emit('connected')
    } else {
      emit('error', result.error || 'Connection failed')
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    emit('error', message)
  } finally {
    isConnecting.value = false
  }
}

// * Handle disconnect button click.
async function handleDisconnect(): Promise<void> {
  isDisconnecting.value = true

  try {
    const result = await store.disconnectSensor(props.sensorId)

    if (result.success) {
      emit('disconnected')
    } else {
      emit('error', result.error || 'Disconnection failed')
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    emit('error', message)
  } finally {
    isDisconnecting.value = false
  }
}
</script>
