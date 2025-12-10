<template>
  <BaseConfigurationView>
    <template #title>Q-Series Dual-Sensor</template>
    <template #content>
      <div
        class="max-h-[85vh] overflow-y-auto -mr-4"
        :class="interfaceStore.isOnSmallScreen ? 'max-w-[90vw]' : 'max-w-[80vw]'"
      >
        <!-- Storage Path Configuration (shared) -->
        <ExpansiblePanel :is-expanded="false" no-top-divider>
          <template #title>Storage Configuration</template>
          <template #content>
            <div class="p-4">
              <QSensorStoragePathSelector @path-changed="handleStoragePathChanged" />
            </div>
          </template>
        </ExpansiblePanel>

        <!-- Unified Session Controls -->
        <ExpansiblePanel :is-expanded="true">
          <template #title>Session Controls</template>
          <template #content>
            <div class="p-4">
              <QSensorSessionControl />
            </div>
          </template>
        </ExpansiblePanel>

        <!-- Dual-Panel Sensor Layout -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
          <!-- In-Water Sensor (Pi HTTP) -->
          <QSensorCard title="In-Water Sensor" :sensor="inWaterSensor">
            <div class="space-y-4">
              <!-- Connection -->
              <ExpansiblePanel :is-expanded="!inWaterSensor.isConnected" no-top-divider>
                <template #title>Connection</template>
                <template #content>
                  <div class="p-4">
                    <QSensorConnectionControl
                      sensor-id="inWater"
                      :sensor="inWaterSensor"
                      @connected="handleInWaterConnected"
                      @disconnected="handleInWaterDisconnected"
                      @error="handleError('inWater', $event)"
                    />
                  </div>
                </template>
              </ExpansiblePanel>

              <!-- Health -->
              <ExpansiblePanel v-if="inWaterSensor.isConnected" :is-expanded="true">
                <template #title>Sensor Info</template>
                <template #content>
                  <div class="p-4">
                    <QSensorHealthDisplay :sensor="inWaterSensor" />
                  </div>
                </template>
              </ExpansiblePanel>

              <!-- Recording Controls -->
              <ExpansiblePanel v-if="inWaterSensor.isConnected" :is-expanded="true">
                <template #title>Recording</template>
                <template #content>
                  <div class="p-4">
                    <QSensorRecordingControl
                      sensor-id="inWater"
                      :sensor="inWaterSensor"
                      :mission="qsensorStore.globalMissionName"
                      @started="handleRecordingStarted('inWater')"
                      @stopped="handleRecordingStopped('inWater')"
                      @error="handleError('inWater', $event)"
                    />
                  </div>
                </template>
              </ExpansiblePanel>

              <!-- Stats -->
              <ExpansiblePanel v-if="isInWaterRecording" :is-expanded="true">
                <template #title>Statistics</template>
                <template #content>
                  <div class="p-4">
                    <QSensorStatsDisplay :sensor="inWaterSensor" />
                  </div>
                </template>
              </ExpansiblePanel>
            </div>
          </QSensorCard>

          <!-- Surface Sensor (Serial) -->
          <QSensorCard title="Surface Sensor" :sensor="surfaceSensor">
            <div class="space-y-4">
              <!-- Connection -->
              <ExpansiblePanel :is-expanded="!surfaceSensor.isConnected" no-top-divider>
                <template #title>Connection</template>
                <template #content>
                  <div class="p-4">
                    <QSensorConnectionControl
                      sensor-id="surface"
                      :sensor="surfaceSensor"
                      @connected="handleSurfaceConnected"
                      @disconnected="handleSurfaceDisconnected"
                      @error="handleError('surface', $event)"
                    />
                  </div>
                </template>
              </ExpansiblePanel>

              <!-- Health -->
              <ExpansiblePanel v-if="surfaceSensor.isConnected" :is-expanded="true">
                <template #title>Sensor Info</template>
                <template #content>
                  <div class="p-4">
                    <QSensorHealthDisplay :sensor="surfaceSensor" />
                  </div>
                </template>
              </ExpansiblePanel>

              <!-- Recording Controls -->
              <ExpansiblePanel v-if="surfaceSensor.isConnected" :is-expanded="true">
                <template #title>Recording</template>
                <template #content>
                  <div class="p-4">
                    <QSensorRecordingControl
                      sensor-id="surface"
                      :sensor="surfaceSensor"
                      :mission="qsensorStore.globalMissionName"
                      @started="handleRecordingStarted('surface')"
                      @stopped="handleRecordingStopped('surface')"
                      @error="handleError('surface', $event)"
                    />
                  </div>
                </template>
              </ExpansiblePanel>

              <!-- Stats -->
              <ExpansiblePanel v-if="isSurfaceRecording" :is-expanded="true">
                <template #title>Statistics</template>
                <template #content>
                  <div class="p-4">
                    <QSensorStatsDisplay :sensor="surfaceSensor" />
                  </div>
                </template>
              </ExpansiblePanel>
            </div>
          </QSensorCard>
        </div>

        <!-- Logs Section -->
        <ExpansiblePanel :is-expanded="false" no-bottom-divider>
          <template #title>Logs</template>
          <template #content>
            <div class="p-4">
              <div v-if="logs.length > 0" class="space-y-1 font-mono text-xs max-h-[300px] overflow-y-auto">
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
import { computed, onMounted, onUnmounted, ref } from 'vue'

import ExpansiblePanel from '@/components/ExpansiblePanel.vue'
import {
  QSensorCard,
  QSensorConnectionControl,
  QSensorHealthDisplay,
  QSensorRecordingControl,
  QSensorSessionControl,
  QSensorStatsDisplay,
  QSensorStoragePathSelector,
} from '@/components/qsensor'
import { useAppInterfaceStore } from '@/stores/appInterface'
import { useQSensorStore } from '@/stores/qsensor'
import { isSensorRecording } from '@/stores/qsensor-common'
import type { QSensorId } from '@/types/qsensor'

import BaseConfigurationView from './BaseConfigurationView.vue'

const interfaceStore = useAppInterfaceStore()
const qsensorStore = useQSensorStore()

// Sensor state refs
const inWaterSensor = computed(() => qsensorStore.inWaterSensor)
const surfaceSensor = computed(() => qsensorStore.surfaceSensor)

// Recording states
const isInWaterRecording = computed(() => isSensorRecording(inWaterSensor.value))
const isSurfaceRecording = computed(() => isSensorRecording(surfaceSensor.value))

// Status polling interval
let statusInterval: ReturnType<typeof setInterval> | null = null

// Logs
/**
 *
 */
interface LogEntry {
  /**
   *
   */
  timestamp: string
  /**
   *
   */
  level: 'info' | 'warn' | 'error'
  /**
   *
   */
  message: string
}
const logs = ref<LogEntry[]>([])

// Helpers

/**
 *
 * @param level
 * @param message
 */
function addLog(level: 'info' | 'warn' | 'error', message: string) {
  logs.value.unshift({
    timestamp: new Date().toISOString(),
    level,
    message,
  })
  // Keep only last 100 logs
  if (logs.value.length > 100) {
    logs.value = logs.value.slice(0, 100)
  }
}

/**
 *
 * @param level
 */
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

/**
 *
 * @param iso
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleTimeString()
}

// Event handlers

/**
 *
 * @param path
 */
function handleStoragePathChanged(path: string) {
  addLog('info', `Storage path updated: ${path}`)
}

/**
 *
 */
function handleInWaterConnected() {
  addLog('info', 'In-water sensor connected')
  startStatusPolling()
}

/**
 *
 */
function handleInWaterDisconnected() {
  addLog('info', 'In-water sensor disconnected')
  checkStopPolling()
}

/**
 *
 */
function handleSurfaceConnected() {
  addLog('info', 'Surface sensor connected')
  startStatusPolling()
}

/**
 *
 */
function handleSurfaceDisconnected() {
  addLog('info', 'Surface sensor disconnected')
  checkStopPolling()
}

/**
 *
 * @param sensorId
 */
function handleRecordingStarted(sensorId: QSensorId) {
  addLog('info', `${sensorId === 'inWater' ? 'In-water' : 'Surface'} sensor recording started`)
}

/**
 *
 * @param sensorId
 */
function handleRecordingStopped(sensorId: QSensorId) {
  addLog('info', `${sensorId === 'inWater' ? 'In-water' : 'Surface'} sensor recording stopped`)
}

/**
 *
 * @param sensorId
 * @param error
 */
function handleError(sensorId: QSensorId, error: string) {
  addLog('error', `[${sensorId === 'inWater' ? 'In-water' : 'Surface'}] ${error}`)
}

// Status polling

/**
 *
 */
function startStatusPolling() {
  if (!statusInterval) {
    statusInterval = setInterval(refreshAllStatus, 2000)
    addLog('info', 'Started status polling')
  }
}

/**
 *
 */
function checkStopPolling() {
  // Stop polling if no sensors are connected
  if (!inWaterSensor.value.isConnected && !surfaceSensor.value.isConnected) {
    if (statusInterval) {
      clearInterval(statusInterval)
      statusInterval = null
      addLog('info', 'Stopped status polling')
    }
  }
}

/**
 *
 */
async function refreshAllStatus() {
  // Refresh in-water sensor status
  if (inWaterSensor.value.isConnected && inWaterSensor.value.currentSession) {
    await qsensorStore.refreshSensorStatus('inWater')
  }

  // Refresh surface sensor status
  if (surfaceSensor.value.isConnected && surfaceSensor.value.currentSession) {
    await qsensorStore.refreshSensorStatus('surface')
  }
}

// Lifecycle

onMounted(() => {
  addLog('info', 'Q-Series dual-sensor tool initialized')

  // Start polling if any sensor is already connected
  if (inWaterSensor.value.isConnected || surfaceSensor.value.isConnected) {
    startStatusPolling()
  }
})

onUnmounted(() => {
  if (statusInterval) {
    clearInterval(statusInterval)
    statusInterval = null
  }
})
</script>

<style scoped>
/* Add any custom styles here if needed */
</style>
