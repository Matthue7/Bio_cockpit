<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center gap-4">
      <label class="text-sm font-medium min-w-[100px]">Connection Type:</label>
      <select
        v-model="selectedConnectionMode"
        class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
        :disabled="sensor.isConnected || isConnecting"
        @change="handleConnectionModeChange"
      >
        <option value="">Select connection type...</option>
        <option value="api">API (HTTP/Pi)</option>
        <option value="serial">Serial (direct connection)</option>
      </select>
    </div>

    <!-- Helper text when no mode selected -->
    <div
      v-if="!sensor.connectionMode && !sensor.isConnected"
      class="p-3 bg-yellow-900/30 border border-yellow-600 rounded text-sm text-yellow-400"
    >
      <span class="font-medium">Connection Required</span>
      <p class="mt-1">Select a connection type to enable sensor controls</p>
    </div>

    <!-- Mode indicator when selected -->
    <div
      v-if="sensor.connectionMode && !sensor.isConnected"
      class="p-3 bg-blue-900/30 border border-blue-600 rounded text-sm text-blue-400"
    >
      <span class="font-medium">Connection Mode Selected</span>
      <p class="mt-1">Using {{ selectedModeLabel }} connection for this sensor</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useQSensorStore } from '@/stores/qsensor'
import type { QSensorId, QSensorState } from '@/types/qsensor'

const props = defineProps<{
  /**
   *
   */
  sensorId: QSensorId
  /**
   *
   */
  sensor: QSensorState
}>()

const emit = defineEmits<{
  (e: 'modeSelected', mode: 'api' | 'serial'): void
  (e: 'error', error: string): void
}>()

const store = useQSensorStore()

const selectedConnectionMode = ref<string>('')
const isConnecting = ref(false)

const selectedModeLabel = computed(() => {
  switch (selectedConnectionMode.value) {
    case 'api':
      return 'API (via Pi/HTTP)'
    case 'serial':
      return 'Serial (direct connection)'
    default:
      return ''
  }
})

// Initialize with current sensor connection mode
watch(
  () => props.sensor.connectionMode,
  (newMode) => {
    selectedConnectionMode.value = newMode || ''
  },
  { immediate: true }
)

/**
 *
 */
function handleConnectionModeChange() {
  if (!selectedConnectionMode.value) return

  const mode = selectedConnectionMode.value as 'api' | 'serial'

  // Update store
  store.setConnectionMode(props.sensorId, mode)

  emit('modeSelected', mode)
}
</script>
