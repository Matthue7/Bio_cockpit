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

  // Function to update stats interval based on current cadence
  const updateStatsInterval = () => {
    const cadenceSec = qsensorStore.cadenceSec || 60
    // Refresh at 80% of cadence (min 2s, max 30s)
    const refreshMs = Math.min(30000, Math.max(2000, cadenceSec * 1000 * 0.8))

    if (statsInterval) {
      clearInterval(statsInterval)
    }

    statsInterval = setInterval(() => {
      if (qsensorStore.isRecording) {
        qsensorStore.refreshStatus()
      }
    }, refreshMs)
  }

  // Initialize interval
  updateStatsInterval()

  // Watch for cadence changes and update interval (for future recordings)
  // Note: Cadence changes don't affect ongoing recordings, but will apply to next one
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
