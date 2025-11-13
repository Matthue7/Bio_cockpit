<template>
  <div class="mini-qsensor-recorder">
    <div class="header">
      <span class="title">Q-Sensor</span>
      <span :class="['status-indicator', isConnected ? 'connected' : 'disconnected']">
        {{ isConnected ? '●' : '○' }}
      </span>
    </div>

    <div class="info">
      <div class="info-row">
        <span class="label">State:</span>
        <span class="value">{{ recordingState }}</span>
      </div>

      <div v-if="qsensorStore.isRecording" class="info-row">
        <span class="label">Mirrored:</span>
        <span class="value">{{ formattedBytes }}</span>
      </div>

      <div v-if="qsensorStore.lastSync" class="info-row">
        <span class="label">Last Sync:</span>
        <span class="value">{{ timeSinceSync }}</span>
      </div>

      <div v-if="qsensorStore.lastError" class="info-row error">
        <span class="label">Error:</span>
        <span class="value">{{ qsensorStore.lastError }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useQSensorStore } from '@/stores/qsensor'

const qsensorStore = useQSensorStore()

const isConnected = ref(false)
let statsInterval: NodeJS.Timeout | null = null

// Computed

const recordingState = computed(() => {
  if (qsensorStore.isRecording) return 'Recording'
  if (qsensorStore.isArmed) return 'Armed'
  return 'Idle'
})

const formattedBytes = computed(() => {
  const bytes = qsensorStore.bytesMirrored
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
})

const timeSinceSync = computed(() => {
  if (!qsensorStore.lastSync) return 'Never'

  const syncTime = new Date(qsensorStore.lastSync)
  const now = new Date()
  const diffSec = Math.floor((now.getTime() - syncTime.getTime()) / 1000)

  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  return `${Math.floor(diffSec / 3600)}h ago`
})

// Lifecycle

onMounted(() => {
  // Check connection (basic health check placeholder)
  // In production, this would call the API health endpoint
  isConnected.value = true

  // Refresh stats every 5 seconds while recording
  statsInterval = setInterval(() => {
    if (qsensorStore.isRecording) {
      qsensorStore.refreshStatus()
    }
  }, 5000)
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

.status-indicator.disconnected {
  color: #f44336;
}

.info {
  display: flex;
  flex-direction: column;
  gap: 4px;
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
</style>
