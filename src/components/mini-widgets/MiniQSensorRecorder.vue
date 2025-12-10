<template>
  <div class="mini-qsensor-recorder">
    <div class="header">
      <span class="title">Q-Sensors</span>
      <span :class="['status-indicator', overallStatusClass]">
        {{ overallStatusIcon }}
      </span>
    </div>

    <!-- In-Water Sensor Summary -->
    <div class="sensor-row">
      <span class="sensor-label">In-Water:</span>
      <span :class="['sensor-status', inWaterStatusClass]">{{ inWaterStatus }}</span>
    </div>

    <!-- Surface Sensor Summary -->
    <div class="sensor-row">
      <span class="sensor-label">Surface:</span>
      <span :class="['sensor-status', surfaceStatusClass]">{{ surfaceStatus }}</span>
    </div>

    <!-- Combined Stats (when recording) -->
    <div v-if="qsensorStore.isAnyRecording" class="info">
      <div class="info-row">
        <span class="label">Total:</span>
        <span class="value">{{ formattedTotalBytes }}</span>
      </div>

      <div v-if="latestSync" class="info-row">
        <span class="label">Last Sync:</span>
        <span class="value">{{ timeSinceSync }}</span>
      </div>
    </div>

    <!-- Errors -->
    <div v-if="qsensorStore.combinedErrors.length > 0" class="info-row error">
      <span class="label">Error:</span>
      <span class="value">{{ qsensorStore.combinedErrors.length }} issues</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'

import { useQSensorStore } from '@/stores/qsensor'
import { isSensorRecording } from '@/stores/qsensor-common'

const qsensorStore = useQSensorStore()

let statsInterval: ReturnType<typeof setInterval> | null = null

// In-Water sensor status
const inWaterStatusClass = computed(() => {
  const sensor = qsensorStore.inWaterSensor
  if (isSensorRecording(sensor)) return 'recording'
  if (sensor.isConnected) return 'connected'
  return 'disconnected'
})

const inWaterStatus = computed(() => {
  const sensor = qsensorStore.inWaterSensor
  if (isSensorRecording(sensor)) return 'REC'
  if (sensor.isConnected) return 'OK'
  return 'OFF'
})

// Surface sensor status
const surfaceStatusClass = computed(() => {
  const sensor = qsensorStore.surfaceSensor
  if (isSensorRecording(sensor)) return 'recording'
  if (sensor.isConnected) return 'connected'
  return 'disconnected'
})

const surfaceStatus = computed(() => {
  const sensor = qsensorStore.surfaceSensor
  if (isSensorRecording(sensor)) return 'REC'
  if (sensor.isConnected) return 'OK'
  return 'OFF'
})

// Overall status indicator
const overallStatusClass = computed(() => {
  if (qsensorStore.areBothRecording) return 'recording'
  if (qsensorStore.isAnyRecording) return 'partial-recording'
  if (qsensorStore.areBothConnected) return 'connected'
  if (qsensorStore.inWaterSensor.isConnected || qsensorStore.surfaceSensor.isConnected) return 'partial'
  return 'disconnected'
})

const overallStatusIcon = computed(() => {
  if (qsensorStore.areBothRecording) return '●'
  if (qsensorStore.isAnyRecording) return '◐'
  if (qsensorStore.areBothConnected) return '●'
  if (qsensorStore.inWaterSensor.isConnected || qsensorStore.surfaceSensor.isConnected) return '◐'
  return '○'
})

// Combined stats
const formattedTotalBytes = computed(() => {
  const bytes = qsensorStore.totalBytesMirrored
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
})

const latestSync = computed(() => {
  const inWaterSync = qsensorStore.inWaterSensor.lastSync
  const surfaceSync = qsensorStore.surfaceSensor.lastSync

  if (!inWaterSync && !surfaceSync) return null
  if (!inWaterSync) return surfaceSync
  if (!surfaceSync) return inWaterSync

  // Return the most recent sync
  return new Date(inWaterSync) > new Date(surfaceSync) ? inWaterSync : surfaceSync
})

const timeSinceSync = computed(() => {
  if (!latestSync.value) return 'Never'

  const syncTime = new Date(latestSync.value)
  const now = new Date()
  const diffSec = Math.floor((now.getTime() - syncTime.getTime()) / 1000)

  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  return `${Math.floor(diffSec / 3600)}h ago`
})

// Lifecycle

onMounted(() => {
  // Update stats interval based on current cadence
  const updateStatsInterval = () => {
    const cadenceSec = qsensorStore.cadenceSec || 60
    // Refresh at 80% of cadence (min 2s, max 30s)
    const refreshMs = Math.min(30000, Math.max(2000, cadenceSec * 1000 * 0.8))

    if (statsInterval) {
      clearInterval(statsInterval)
    }

    statsInterval = setInterval(async () => {
      // Refresh both sensors if they're recording
      if (isSensorRecording(qsensorStore.inWaterSensor)) {
        await qsensorStore.refreshSensorStatus('inWater')
      }
      if (isSensorRecording(qsensorStore.surfaceSensor)) {
        await qsensorStore.refreshSensorStatus('surface')
      }
    }, refreshMs)
  }

  // Initialize interval
  updateStatsInterval()
})

onUnmounted(() => {
  if (statsInterval) {
    clearInterval(statsInterval)
    statsInterval = null
  }
})
</script>

<style scoped>
.mini-qsensor-recorder {
  padding: 8px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
  font-size: 12px;
  min-width: 180px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.title {
  font-weight: bold;
  color: #fff;
}

.status-indicator {
  font-size: 14px;
}

.status-indicator.connected {
  color: #4caf50;
}

.status-indicator.recording {
  color: #f44336;
  animation: pulse 1s infinite;
}

.status-indicator.partial-recording {
  color: #ff9800;
  animation: pulse 1s infinite;
}

.status-indicator.partial {
  color: #ff9800;
}

.status-indicator.disconnected {
  color: #9e9e9e;
}

.sensor-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
  color: rgba(255, 255, 255, 0.8);
}

.sensor-label {
  font-size: 11px;
}

.sensor-status {
  font-family: monospace;
  font-size: 11px;
  font-weight: bold;
}

.sensor-status.connected {
  color: #4caf50;
}

.sensor-status.recording {
  color: #f44336;
}

.sensor-status.disconnected {
  color: #9e9e9e;
}

.info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.info-row {
  display: flex;
  justify-content: space-between;
  color: rgba(255, 255, 255, 0.8);
}

.info-row.error {
  color: #f44336;
}

.label {
  font-weight: 500;
}

.value {
  font-family: monospace;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style>
