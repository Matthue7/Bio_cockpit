<!--
  QSensorStatsDisplay.vue - Recording statistics display for a Q-Series sensor.
  Phase 4: Dual-sensor UI architecture.

  This component displays real-time recording statistics including bytes recorded,
  sync status, and other metrics.
-->
<template>
  <div class="flex flex-col gap-3">
    <div class="grid grid-cols-2 gap-3">
      <!-- Bytes recorded/mirrored -->
      <div class="p-3 bg-slate-800 rounded text-sm">
        <div class="font-medium text-gray-400 text-xs">{{ bytesLabel }}</div>
        <div class="text-lg mt-1">{{ formatBytes(sensor.bytesMirrored) }}</div>
      </div>

      <!-- Last sync -->
      <div class="p-3 bg-slate-800 rounded text-sm">
        <div class="font-medium text-gray-400 text-xs">Last Sync</div>
        <div class="text-lg mt-1">{{ sensor.lastSync ? formatTimestamp(sensor.lastSync) : 'N/A' }}</div>
      </div>
    </div>

    <!-- Session duration (if recording) -->
    <div v-if="sensor.currentSession && isRecording" class="p-3 bg-slate-800 rounded text-sm">
      <div class="font-medium text-gray-400 text-xs">Duration</div>
      <div class="text-lg mt-1">{{ formattedDuration }}</div>
    </div>

    <!-- Status indicator -->
    <div v-if="isRecording" class="flex items-center gap-2 p-3 bg-slate-800 rounded text-sm">
      <span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
      <span class="text-green-400 text-xs">Recording active</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { isSensorRecording } from '@/stores/qsensor-common'
import type { QSensorState } from '@/types/qsensor'

const props = defineProps<{
  /**
   *
   */
  sensor: QSensorState
}>()

const isRecording = computed(() => isSensorRecording(props.sensor))

const bytesLabel = computed(() => {
  return props.sensor.backendType === 'http' ? 'Bytes Mirrored' : 'Bytes Recorded'
})

// Duration tracking
const now = ref(Date.now())
let durationInterval: NodeJS.Timeout | null = null

const formattedDuration = computed(() => {
  if (!props.sensor.currentSession) return '0:00'

  const startTime = new Date(props.sensor.currentSession.startedAt).getTime()
  const durationMs = now.value - startTime

  const seconds = Math.floor(durationMs / 1000) % 60
  const minutes = Math.floor(durationMs / (1000 * 60)) % 60
  const hours = Math.floor(durationMs / (1000 * 60 * 60))

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
})

onMounted(() => {
  durationInterval = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (durationInterval) {
    clearInterval(durationInterval)
  }
})

/**
 *
 * @param bytes
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
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
