<template>
  <BaseConfigurationView>
    <template #title>Q-Series</template>
    <template #content>
      <div
        class="max-h-[85vh] overflow-y-auto -mr-4"
        :class="interfaceStore.isOnSmallScreen ? 'max-w-[85vw]' : 'max-w-[60vw]'"
      >
        <!-- Connection Section -->
        <ExpansiblePanel :is-expanded="true" no-top-divider>
          <template #title>Connection</template>
          <template #content>
            <div class="flex flex-col gap-4 p-4">
              <div class="flex items-center gap-4">
                <label class="text-sm font-medium min-w-[120px]">API Base URL:</label>
                <input
                  v-model="apiBaseUrl"
                  type="text"
                  class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded"
                  placeholder="http://blueos.local:9150"
                  :disabled="isConnected"
                />
              </div>

              <div class="flex items-center gap-4">
                <label class="text-sm font-medium min-w-[120px]">Serial Port:</label>
                <input
                  v-model="serialPort"
                  type="text"
                  class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded"
                  placeholder="/dev/ttyUSB0"
                  :disabled="isConnected"
                />
              </div>

              <div class="flex items-center gap-4">
                <label class="text-sm font-medium min-w-[120px]">Baud Rate:</label>
                <input
                  v-model.number="baudRate"
                  type="number"
                  class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded"
                  placeholder="9600"
                  :disabled="isConnected"
                />
              </div>

              <div class="flex items-center gap-4">
                <button
                  v-if="!isConnected"
                  class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                  :disabled="isConnecting"
                  @click="handleConnect"
                >
                  {{ isConnecting ? 'Connecting...' : 'Connect' }}
                </button>
                <button
                  v-else
                  class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded"
                  @click="handleDisconnect"
                >
                  Disconnect
                </button>

                <div v-if="isConnected" class="flex items-center gap-2">
                  <span class="w-3 h-3 bg-green-500 rounded-full"></span>
                  <span class="text-sm text-green-400">Connected</span>
                </div>
                <div v-else-if="!isConnecting" class="flex items-center gap-2">
                  <span class="w-3 h-3 bg-gray-500 rounded-full"></span>
                  <span class="text-sm text-gray-400">Disconnected</span>
                </div>
              </div>

              <div v-if="healthData" class="mt-2 p-3 bg-slate-800 rounded text-sm">
                <div class="grid grid-cols-2 gap-2">
                  <div><span class="font-medium">Port:</span> {{ healthData.port || 'N/A' }}</div>
                  <div><span class="font-medium">Model:</span> {{ healthData.model || 'N/A' }}</div>
                  <div><span class="font-medium">Firmware:</span> {{ healthData.firmware || 'N/A' }}</div>
                  <div>
                    <span class="font-medium">Disk Free:</span>
                    {{ healthData.disk_free_bytes ? formatBytes(healthData.disk_free_bytes) : 'N/A' }}
                  </div>
                </div>
              </div>

              <div v-if="connectionError" class="mt-2 p-3 bg-red-900/50 border border-red-600 rounded text-sm">
                <span class="text-red-400">{{ connectionError }}</span>
              </div>
            </div>
          </template>
        </ExpansiblePanel>

        <!-- Acquisition Mode Section -->
        <ExpansiblePanel :is-expanded="false">
          <template #title>Acquisition Mode</template>
          <template #content>
            <div class="flex flex-col gap-4 p-4">
              <div class="flex items-center gap-4">
                <label class="flex items-center gap-2">
                  <input type="radio" value="freerun" v-model="acquisitionMode" :disabled="!isConnected" />
                  <span class="text-sm">Freerun (continuous)</span>
                </label>
                <label class="flex items-center gap-2">
                  <input type="radio" value="polled" v-model="acquisitionMode" disabled />
                  <span class="text-sm text-gray-500">Polled (coming soon)</span>
                </label>
              </div>
              <div class="text-xs text-gray-400">
                <p>Freerun mode: Sensor streams continuously at configured sample rate.</p>
                <p class="mt-1">Polled mode: On-demand polling with TAG identifiers (not yet implemented).</p>
              </div>
            </div>
          </template>
        </ExpansiblePanel>

        <!-- Session Controls Section -->
        <ExpansiblePanel :is-expanded="true">
          <template #title>Session Controls</template>
          <template #content>
            <div class="flex flex-col gap-4 p-4">
              <!-- Storage Path Selection -->
              <div class="flex items-center gap-4">
                <label class="text-sm font-medium min-w-[120px]">Storage folder:</label>
                <input
                  v-model="storagePath"
                  type="text"
                  class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded font-mono text-xs"
                  readonly
                  placeholder="Loading..."
                />
                <button
                  class="px-4 py-2 bg-slate-600 hover:bg-slate-700 text-white rounded"
                  @click="handleBrowseStoragePath"
                >
                  Browse...
                </button>
              </div>

              <div class="flex items-center gap-4">
                <button
                  v-if="!qsensorStore.isRecording"
                  class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded disabled:opacity-50"
                  :disabled="!isConnected || isStarting"
                  @click="handleStartRecording"
                >
                  {{ isStarting ? 'Starting...' : 'Start Q-Series Recording' }}
                </button>
                <button
                  v-else
                  class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded disabled:opacity-50"
                  :disabled="isStopping"
                  @click="handleStopRecording"
                >
                  {{ isStopping ? 'Stopping...' : 'Stop Q-Series Recording' }}
                </button>

                <div v-if="qsensorStore.isRecording" class="flex items-center gap-2">
                  <span class="w-3 h-3 bg-red-500 rounded-full animate-pulse"></span>
                  <span class="text-sm text-red-400">Recording</span>
                </div>
                <div v-else-if="qsensorStore.isArmed" class="flex items-center gap-2">
                  <span class="w-3 h-3 bg-yellow-500 rounded-full"></span>
                  <span class="text-sm text-yellow-400">Armed</span>
                </div>
              </div>

              <div v-if="qsensorStore.currentSessionId" class="mt-2 p-3 bg-slate-800 rounded text-sm space-y-2">
                <div>
                  <span class="font-medium">Session ID:</span>
                  <span class="ml-2 font-mono text-xs">{{ qsensorStore.currentSessionId }}</span>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <span class="font-medium">Cadence:</span>
                    <span class="ml-2">{{ qsensorStore.cadenceSec }}s</span>
                  </div>
                  <div>
                    <span class="font-medium">Bandwidth:</span>
                    <span class="ml-2">{{ qsensorStore.fullBandwidth ? 'Full (2s)' : 'Normal' }}</span>
                  </div>
                </div>
                <div v-if="qsensorStore.lastSync">
                  <span class="font-medium">Last Sync:</span>
                  <span class="ml-2">{{ formatTimestamp(qsensorStore.lastSync) }}</span>
                </div>
              </div>

              <div v-if="qsensorStore.lastError" class="mt-2 p-3 bg-red-900/50 border border-red-600 rounded text-sm">
                <span class="text-red-400">{{ qsensorStore.lastError }}</span>
              </div>
            </div>
          </template>
        </ExpansiblePanel>

        <!-- Mirroring Status Section -->
        <ExpansiblePanel :is-expanded="false">
          <template #title>Mirroring Status</template>
          <template #content>
            <div class="flex flex-col gap-4 p-4">
              <div v-if="mirrorStats" class="space-y-3">
                <div class="p-3 bg-slate-800 rounded text-sm">
                  <div class="font-medium mb-2">Local Mirror Path:</div>
                  <div class="font-mono text-xs text-gray-300 break-all">{{ mirrorStats.rootPath }}</div>
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <div class="p-3 bg-slate-800 rounded text-sm">
                    <div class="font-medium">Bytes Mirrored:</div>
                    <div class="text-lg mt-1">{{ formatBytes(mirrorStats.bytesMirrored) }}</div>
                  </div>
                  <div class="p-3 bg-slate-800 rounded text-sm">
                    <div class="font-medium">Last Chunk:</div>
                    <div class="text-lg mt-1">#{{ mirrorStats.lastChunkIndex }}</div>
                  </div>
                </div>

                <div v-if="mirrorStats.lastSync" class="p-3 bg-slate-800 rounded text-sm">
                  <div class="font-medium">Last Sync:</div>
                  <div class="mt-1">{{ formatTimestamp(mirrorStats.lastSync) }}</div>
                </div>
              </div>

              <div v-else class="text-sm text-gray-400">
                <p>No active mirroring session</p>
              </div>
            </div>
          </template>
        </ExpansiblePanel>

        <!-- Logs Section -->
        <ExpansiblePanel :is-expanded="false" no-bottom-divider>
          <template #title>Logs</template>
          <template #content>
            <div class="p-4">
              <div v-if="logs.length > 0" class="space-y-1 font-mono text-xs">
                <div v-for="(log, index) in logs" :key="index" :class="getLogClass(log.level)" class="p-2 rounded">
                  <span class="text-gray-500">{{ formatTimestamp(log.timestamp) }}</span>
                  <span class="ml-2 font-medium">[{{ log.level.toUpperCase() }}]</span>
                  <span class="ml-2">{{ log.message }}</span>
                </div>
              </div>
              <div v-else class="text-sm text-gray-400">
                <p>No logs yet</p>
              </div>
            </div>
          </template>
        </ExpansiblePanel>
      </div>
    </template>
  </BaseConfigurationView>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import ExpansiblePanel from '@/components/ExpansiblePanel.vue'
import { useAppInterfaceStore } from '@/stores/appInterface'
import { useQSensorStore } from '@/stores/qsensor'

import BaseConfigurationView from './BaseConfigurationView.vue'

// Type for health response (matches QSensorHealthResponse)
interface HealthData {
  connected: boolean
  port: string | null
  model: string | null
  firmware: string | null
  disk_free_bytes: number | null
}

const interfaceStore = useAppInterfaceStore()
const qsensorStore = useQSensorStore()

// Connection state
const apiBaseUrl = ref('http://blueos.local:9150')
const serialPort = ref('/dev/ttyUSB0')
const baudRate = ref(9600)
const isConnected = ref(false)
const isConnecting = ref(false)
const connectionError = ref<string | null>(null)
const healthData = ref<HealthData | null>(null)

// Acquisition mode
const acquisitionMode = ref<'freerun' | 'polled'>('freerun')

// Session state
const isStarting = ref(false)
const isStopping = ref(false)

// Storage path
const storagePath = ref<string>('')

// Mirroring stats
const mirrorStats = ref<any>(null)
let statsInterval: NodeJS.Timeout | null = null

// Logs
interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}
const logs = ref<LogEntry[]>([])

// Helpers

function addLog(level: 'info' | 'warn' | 'error', message: string) {
  logs.value.unshift({
    timestamp: new Date().toISOString(),
    level,
    message,
  })
  // Keep only last 50 logs
  if (logs.value.length > 50) {
    logs.value = logs.value.slice(0, 50)
  }
}

function getLogClass(level: string): string {
  switch (level) {
    case 'error':
      return 'bg-red-900/30 text-red-400'
    case 'warn':
      return 'bg-yellow-900/30 text-yellow-400'
    default:
      return 'bg-slate-800 text-gray-300'
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString()
}

// Connection handlers

async function handleConnect() {
  isConnecting.value = true
  connectionError.value = null
  healthData.value = null

  try {
    // Call /sensor/connect via IPC (bypasses CORS)
    addLog('info', 'Connecting to sensor...')
    const connectResult = await window.electronAPI.qsensorConnect(apiBaseUrl.value, serialPort.value, baudRate.value)

    if (!connectResult.success) {
      throw new Error(`Connect failed: ${connectResult.error || 'Unknown error'}`)
    }

    addLog('info', `Connected to sensor: ${connectResult.data.sensor_id}`)

    // Wait 500ms for sensor to stabilize before health check
    await new Promise(resolve => setTimeout(resolve, 500))

    // Then check health to get full status (retry on failure)
    addLog('info', 'Checking sensor health...')
    let healthResult
    let healthSuccess = false

    // Retry health check up to 2 times with 300ms backoff
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        addLog('info', `Retrying health check (attempt ${attempt + 1}/3)...`)
        await new Promise(resolve => setTimeout(resolve, 300))
      }

      healthResult = await window.electronAPI.qsensorGetHealth(apiBaseUrl.value)

      if (healthResult.success && healthResult.data) {
        healthSuccess = true
        break
      }
    }

    if (healthSuccess && healthResult.data) {
      healthData.value = healthResult.data

      if (healthResult.data.connected) {
        isConnected.value = true
        addLog('info', `Sensor ready: ${healthResult.data.model || 'Unknown model'}, firmware ${healthResult.data.firmware || 'unknown'}`)
      } else {
        // Connected but health shows disconnected - warn but don't fail
        isConnected.value = true
        addLog('warn', 'Sensor connected but health check shows disconnected state')
      }
    } else {
      // Health check failed after retries but connect succeeded - mark connected anyway
      isConnected.value = true
      addLog('warn', `Health check failed after 3 attempts (${healthResult?.error}), but sensor is connected`)
    }

    // Update store API base URL
    qsensorStore.apiBaseUrl = apiBaseUrl.value

  } catch (error: any) {
    connectionError.value = error.message || 'Connection failed'
    addLog('error', `${error.message}`)
  } finally {
    isConnecting.value = false
  }
}

async function handleDisconnect() {
  try {
    const result = await window.electronAPI.qsensorDisconnect(apiBaseUrl.value)

    if (!result.success) {
      addLog('warn', `Disconnect warning: ${result.error}`)
    } else {
      addLog('info', 'Disconnected from Q-Sensor')
    }

    // Mark as disconnected locally
    isConnected.value = false
    healthData.value = null
    connectionError.value = null
  } catch (error: any) {
    addLog('warn', `Disconnect warning: ${error.message}`)
    // Still mark as disconnected locally even if API call fails
    isConnected.value = false
    healthData.value = null
  }
}

// Session handlers

async function handleStartRecording() {
  if (!isConnected.value) return

  isStarting.value = true

  try {
    const missionName = qsensorStore.missionName || 'Cockpit'
    const vehicleAddress = apiBaseUrl.value.replace('http://', '').replace(':9150', '')

    // STEP 1: Start acquisition on the sensor (freerun mode)
    addLog('info', 'Starting sensor acquisition (freerun)...')
    const acqResult = await window.electronAPI.qsensorStartAcquisition(apiBaseUrl.value, undefined)

    if (!acqResult.success) {
      throw new Error(`Failed to start acquisition: ${acqResult.error}`)
    }
    addLog('info', 'Acquisition started (freerun)')

    // STEP 2: Start recording session on API
    addLog('info', 'Starting recording session...')
    const recordResult = await window.electronAPI.qsensorStartRecording(apiBaseUrl.value, {
      rate_hz: 500,
      schema_version: 1,
      mission: missionName,
      roll_interval_s: 60,
    })

    if (!recordResult.success) {
      // Rollback: stop acquisition
      await window.electronAPI.qsensorStopAcquisition(apiBaseUrl.value)
      throw new Error(`Failed to start recording: ${recordResult.error}`)
    }

    const sessionId = recordResult.data.session_id
    addLog('info', `Recording session created: ${sessionId}`)

    // STEP 3: Arm the store with the API-provided session ID
    qsensorStore.arm(sessionId, missionName, vehicleAddress)

    // STEP 4: Start mirroring
    const mirrorResult = await qsensorStore.start()

    if (mirrorResult.success) {
      addLog('info', `Mirroring started for session ${sessionId}`)

      // Start stats refresh
      if (!statsInterval) {
        statsInterval = setInterval(refreshStats, 5000)
      }
    } else {
      // Rollback: stop recording and acquisition
      await window.electronAPI.qsensorStopRecording(apiBaseUrl.value, sessionId)
      await window.electronAPI.qsensorStopAcquisition(apiBaseUrl.value)
      throw new Error(`Failed to start mirroring: ${mirrorResult.error}`)
    }
  } catch (error: any) {
    addLog('error', `Error starting recording: ${error.message}`)
  } finally {
    isStarting.value = false
  }
}

async function handleStopRecording() {
  isStopping.value = true

  try {
    const sessionId = qsensorStore.currentSessionId

    // STEP 1: Stop mirroring
    addLog('info', 'Stopping mirroring...')
    const mirrorResult = await qsensorStore.stop()

    if (!mirrorResult.success) {
      addLog('warn', `Failed to stop mirroring: ${mirrorResult.error}`)
    } else {
      addLog('info', 'Mirroring stopped')
    }

    // STEP 2: Stop recording session on API
    if (sessionId) {
      addLog('info', 'Stopping recording session...')
      const recordResult = await window.electronAPI.qsensorStopRecording(apiBaseUrl.value, sessionId)

      if (recordResult.success) {
        addLog(
          'info',
          `Recording stopped: ${recordResult.data.chunks} chunks, ${recordResult.data.rows} rows`
        )
      } else {
        addLog('warn', `Failed to stop recording session: ${recordResult.error}`)
      }
    }

    // STEP 3: Stop acquisition on the sensor
    addLog('info', 'Stopping sensor acquisition...')
    const acqResult = await window.electronAPI.qsensorStopAcquisition(apiBaseUrl.value)

    if (acqResult.success) {
      addLog('info', 'Acquisition stopped')
    } else {
      addLog('warn', `Failed to stop acquisition: ${acqResult.error}`)
    }

    // STEP 4: Reset store state
    qsensorStore.reset()

    // Stop stats refresh
    if (statsInterval) {
      clearInterval(statsInterval)
      statsInterval = null
    }
    mirrorStats.value = null
  } catch (error: any) {
    addLog('error', `Error stopping recording: ${error.message}`)
  } finally {
    isStopping.value = false
  }
}

// Storage path handlers

async function handleBrowseStoragePath() {
  try {
    const selectedPath = await window.electronAPI.selectQSensorStorageDirectory()
    if (selectedPath) {
      storagePath.value = selectedPath
      await window.electronAPI.setQSensorStoragePath(selectedPath)
      addLog('info', `Storage path updated: ${selectedPath}`)
    }
  } catch (error: any) {
    addLog('error', `Failed to select storage path: ${error.message}`)
  }
}

async function loadStoragePath() {
  try {
    const path = await window.electronAPI.getQSensorStoragePath()
    storagePath.value = path
  } catch (error: any) {
    addLog('error', `Failed to load storage path: ${error.message}`)
  }
}

// Mirroring stats refresh

async function refreshStats() {
  if (!qsensorStore.currentSessionId) return

  try {
    await qsensorStore.refreshStatus()

    // Fetch detailed stats from Electron
    const result = await window.electronAPI.getQSensorStats(qsensorStore.currentSessionId)

    if (result.success && result.stats) {
      mirrorStats.value = result.stats
    }
  } catch (error: any) {
    console.warn('[Q-Series Tool] Failed to refresh stats:', error)
  }
}

// Lifecycle

onMounted(() => {
  // Auto-connect check on mount (optional)
  addLog('info', 'Q-Series tool initialized')

  // Load storage path from config
  loadStoragePath()
})

onUnmounted(() => {
  if (statsInterval) {
    clearInterval(statsInterval)
    statsInterval = null
  }
})
</script>

<style scoped>
/* Add any custom styles here if needed */
</style>
