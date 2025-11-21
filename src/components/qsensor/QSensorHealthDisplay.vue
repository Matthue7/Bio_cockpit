<!--
  QSensorHealthDisplay.vue - Health status display for a Q-Series sensor.
  Phase 4: Dual-sensor UI architecture.

  This component displays sensor health information like model, firmware,
  serial number, and disk space.
-->
<template>
  <div v-if="sensor.healthData" class="p-3 bg-slate-800 rounded text-sm">
    <div class="grid grid-cols-2 gap-2">
      <div v-if="sensor.healthData.sensorId">
        <span class="font-medium">Serial:</span> {{ sensor.healthData.sensorId }}
      </div>
      <div v-if="sensor.healthData.model"><span class="font-medium">Model:</span> {{ sensor.healthData.model }}</div>
      <div v-if="sensor.healthData.firmware">
        <span class="font-medium">Firmware:</span> {{ sensor.healthData.firmware }}
      </div>
      <div v-if="sensor.healthData.port"><span class="font-medium">Port:</span> {{ sensor.healthData.port }}</div>
      <div v-if="sensor.healthData.diskFreeBytes !== undefined">
        <span class="font-medium">Disk Free:</span> {{ formatBytes(sensor.healthData.diskFreeBytes) }}
      </div>
      <div v-if="sensor.healthData.state"><span class="font-medium">State:</span> {{ sensor.healthData.state }}</div>
      <div v-if="sensor.healthData.tempC !== undefined">
        <span class="font-medium">Temp:</span> {{ sensor.healthData.tempC.toFixed(1) }}°C
      </div>
      <div v-if="sensor.healthData.vin !== undefined">
        <span class="font-medium">Voltage:</span> {{ sensor.healthData.vin.toFixed(1) }}V
      </div>
    </div>

    <!-- Additional sensor config if available -->
    <div v-if="sensor.healthData.config" class="mt-2 pt-2 border-t border-slate-700">
      <div class="grid grid-cols-2 gap-2 text-xs text-gray-400">
        <div v-if="sensor.healthData.config.integrationTimeMs">
          <span class="font-medium">Int. Time:</span> {{ sensor.healthData.config.integrationTimeMs }}ms
        </div>
        <div v-if="sensor.healthData.config.internalAveraging">
          <span class="font-medium">Avg:</span> {{ sensor.healthData.config.internalAveraging }}
        </div>
      </div>
    </div>
  </div>
  <div v-else class="text-sm text-gray-400">
    <p>No health data available</p>
  </div>
</template>

<script setup lang="ts">
import type { QSensorState } from '@/types/qsensor'

defineProps<{
  // * Sensor state providing health details
  sensor: QSensorState
}>()

// * Human-readable formatter for byte values displayed in health info
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
</script>
