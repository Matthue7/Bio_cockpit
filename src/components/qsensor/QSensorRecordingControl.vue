<!--
  QSensorRecordingControl.vue - Recording controls for a Q-Series sensor.
  Phase 4: Dual-sensor UI architecture.

  This component provides start/stop recording buttons and configuration
  for individual sensor recording.
-->
<template>
  <div class="flex flex-col gap-4">
    <!-- Recording parameters -->
    <div v-if="!isRecording && sensor.isConnected" class="flex flex-col gap-3">
      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">Rate (Hz):</label>
        <input
          v-model.number="localRateHz"
          type="number"
          step="0.1"
          min="0.1"
          max="500"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          :disabled="isRecording"
        />
        <span class="text-xs text-gray-400">(0.1-500)</span>
      </div>

      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">Roll Interval:</label>
        <input
          v-model.number="localRollIntervalS"
          type="number"
          min="1"
          max="300"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          :disabled="isRecording"
        />
        <span class="text-xs text-gray-400">seconds</span>
      </div>
    </div>

    <!-- Start/Stop buttons -->
    <div class="flex items-center gap-4">
      <button
        v-if="!isRecording"
        class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="!sensor.isConnected || isStarting"
        @click="handleStart"
      >
        {{ isStarting ? 'Starting...' : 'Start Recording' }}
      </button>
      <button
        v-else
        class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="isStopping"
        @click="handleStop"
      >
        {{ isStopping ? 'Stopping...' : 'Stop Recording' }}
      </button>
    </div>

    <!-- Session info -->
    <div v-if="sensor.currentSession" class="p-3 bg-slate-800 rounded text-sm space-y-2">
      <div>
        <span class="font-medium">Session ID:</span>
        <span class="ml-2 font-mono text-xs">{{ sensor.currentSession.sessionId }}</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <span class="font-medium">Rate:</span>
          <span class="ml-2">{{ sensor.currentSession.rateHz }} Hz</span>
        </div>
        <div>
          <span class="font-medium">Roll:</span>
          <span class="ml-2">{{ sensor.currentSession.rollIntervalS }}s</span>
        </div>
      </div>
      <div v-if="sensor.lastSync">
        <span class="font-medium">Last Sync:</span>
        <span class="ml-2">{{ formatTimestamp(sensor.lastSync) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { useQSensorStore } from '@/stores/qsensor'
import { isSensorRecording } from '@/stores/qsensor-common'
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
  /**
   *
   */
  mission: string
}>()

const emit = defineEmits<{
  (e: 'started'): void
  (e: 'stopped'): void
  (e: 'error', error: string): void
}>()

const store = useQSensorStore()

// Recording state
const isStarting = ref(false)
const isStopping = ref(false)

// Local recording parameters with defaults
// Both backends support up to 500 Hz for synchronized sampling
const localRateHz = ref(500)
const localRollIntervalS = ref(60)

// Computed for current recording state
const isRecording = computed(() => isSensorRecording(props.sensor))

/**
 *
 */
async function handleStart() {
  isStarting.value = true

  try {
    const result = await store.startRecordingSensor(props.sensorId, {
      mission: props.mission,
      rateHz: localRateHz.value,
      rollIntervalS: localRollIntervalS.value,
    })

    if (result.success) {
      emit('started')
    } else {
      emit('error', result.error || 'Failed to start recording')
    }
  } catch (error: any) {
    emit('error', error.message)
  } finally {
    isStarting.value = false
  }
}

/**
 *
 */
async function handleStop() {
  isStopping.value = true

  try {
    const result = await store.stopRecordingSensor(props.sensorId)

    if (result.success) {
      emit('stopped')
    } else {
      emit('error', result.error || 'Failed to stop recording')
    }
  } catch (error: any) {
    emit('error', error.message)
  } finally {
    isStopping.value = false
  }
}

/**
 *
 * @param iso
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString()
}
</script>
