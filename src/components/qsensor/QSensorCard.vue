<!--
  QSensorCard.vue - Container component for displaying a single Q-Series sensor.
  Phase 4: Dual-sensor UI architecture.

  This component provides the card layout for a sensor, including header with status
  indicator, connection controls, health display, and recording controls.
-->
<template>
  <div class="bg-slate-900 border border-slate-700 rounded-lg overflow-hidden">
    <!-- Header -->
    <div class="flex items-center justify-between p-4 border-b border-slate-700 bg-slate-800">
      <div class="flex items-center gap-3">
        <h3 class="text-lg font-semibold">{{ title }}</h3>
        <span class="text-xs px-2 py-0.5 rounded" :class="backendBadgeClass">
          {{ backendLabel }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span class="w-3 h-3 rounded-full" :class="statusIndicatorClass"></span>
        <span class="text-sm" :class="statusTextClass">{{ statusText }}</span>
      </div>
    </div>

    <!-- Content -->
    <div class="p-4">
      <slot></slot>
    </div>

    <!-- Footer (optional) -->
    <div v-if="$slots.footer" class="p-4 border-t border-slate-700 bg-slate-800/50">
      <slot name="footer"></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { isSensorRecording } from '@/stores/qsensor-common'
import type { QSensorState } from '@/types/qsensor'

const props = defineProps<{
  // * Display title for the card
  title: string
  // * Sensor state rendered in the card
  sensor: QSensorState
}>()

// * Backend type badge
const backendLabel = computed(() => {
  return props.sensor.backendType === 'http' ? 'HTTP (Pi)' : 'Serial (Topside)'
})

const backendBadgeClass = computed(() => {
  return props.sensor.backendType === 'http' ? 'bg-blue-600/30 text-blue-400' : 'bg-purple-600/30 text-purple-400'
})

// * Status indicator styling
const statusIndicatorClass = computed(() => {
  if (isSensorRecording(props.sensor)) {
    return 'bg-red-500 animate-pulse'
  }
  if (props.sensor.isConnected) {
    return 'bg-green-500'
  }
  return 'bg-gray-500'
})

const statusTextClass = computed(() => {
  if (isSensorRecording(props.sensor)) {
    return 'text-red-400'
  }
  if (props.sensor.isConnected) {
    return 'text-green-400'
  }
  return 'text-gray-400'
})

const statusText = computed(() => {
  if (isSensorRecording(props.sensor)) {
    return 'Recording'
  }
  if (props.sensor.isConnected) {
    return 'Connected'
  }
  return 'Disconnected'
})
</script>
