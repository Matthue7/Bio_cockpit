/**
 * Pinia store for Q-Sensor live recording state and settings.
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { QSensorClient } from '@/libs/qsensor-client'

export const useQSensorStore = defineStore('qsensor', () => {
  // Settings
  const apiBaseUrl = ref('http://blueos.local:9150')
  const cadenceSec = ref(60) // Mirroring cadence in seconds (15-300)
  const fullBandwidth = ref(false) // Fast polling mode (~2s)

  // Session state
  const currentSessionId = ref<string | null>(null)
  const vehicleAddress = ref('blueos.local')
  const missionName = ref('Cockpit')
  const isRecording = ref(false)
  const bytesMirrored = ref(0)
  const lastSync = ref<string | null>(null)
  const lastError = ref<string | null>(null)

  // Computed
  const isArmed = computed(() => currentSessionId.value !== null)

  // Actions

  /**
   * Arm the store with session parameters (before starting).
   */
  function arm(sessionId: string, mission: string, vehicle: string = 'blueos.local') {
    currentSessionId.value = sessionId
    missionName.value = mission
    vehicleAddress.value = vehicle
    lastError.value = null
  }

  /**
   * Start mirroring via Electron IPC.
   */
  async function start(): Promise<{ success: boolean; error?: string }> {
    if (!currentSessionId.value) {
      lastError.value = 'No session ID set (call arm() first)'
      return { success: false, error: lastError.value }
    }

    try {
      window.electronAPI?.systemLog(
        'info',
        `[QSensor Store] start() requested for session ${currentSessionId.value} (vehicle=${vehicleAddress.value}, cadence=${fullBandwidth.value ? 2 : cadenceSec.value}s)`
      )
      const result = await window.electronAPI.startQSensorMirror(
        currentSessionId.value,
        vehicleAddress.value,
        missionName.value,
        cadenceSec.value,
        fullBandwidth.value
      )

      if (result.success) {
        isRecording.value = true
        lastError.value = null
        window.electronAPI?.systemLog(
          'info',
          `[QSensor Store] Mirroring started for session ${currentSessionId.value} (bytes=${bytesMirrored.value})`
        )
      } else {
        lastError.value = result.error || 'Unknown error'
        window.electronAPI?.systemLog(
          'error',
          `[QSensor Store] Mirroring failed to start for session ${currentSessionId.value}: ${lastError.value}`
        )
      }

      return result
    } catch (error: any) {
      lastError.value = error.message
      window.electronAPI?.systemLog(
        'error',
        `[QSensor Store] start() threw for session ${currentSessionId.value}: ${error.message}`
      )
      return { success: false, error: error.message }
    }
  }

  /**
   * Stop mirroring via Electron IPC.
   */
  async function stop(): Promise<{ success: boolean; error?: string }> {
    if (!currentSessionId.value) {
      return { success: false, error: 'No active session' }
    }

    try {
      const result = await window.electronAPI.stopQSensorMirror(currentSessionId.value)

      if (result.success) {
        isRecording.value = false
      } else {
        lastError.value = result.error || 'Unknown error'
      }

      return result
    } catch (error: any) {
      lastError.value = error.message
      return { success: false, error: error.message }
    }
  }

  /**
   * Refresh mirroring statistics from Electron.
   */
  async function refreshStatus() {
    if (!currentSessionId.value) return

    try {
      const result = await window.electronAPI.getQSensorStats(currentSessionId.value)

      if (result.success && result.stats) {
        bytesMirrored.value = result.stats.bytesMirrored || 0
        lastSync.value = result.stats.lastSync || null
      }
    } catch (error: any) {
      console.warn('[QSensor Store] Failed to refresh stats:', error)
    }
  }

  /**
   * Reset session state (call after recording stops).
   */
  function reset() {
    currentSessionId.value = null
    isRecording.value = false
    bytesMirrored.value = 0
    lastSync.value = null
    lastError.value = null
  }

  return {
    // Settings
    apiBaseUrl,
    cadenceSec,
    fullBandwidth,

    // State
    currentSessionId,
    vehicleAddress,
    missionName,
    isRecording,
    bytesMirrored,
    lastSync,
    lastError,

    // Computed
    isArmed,

    // Actions
    arm,
    start,
    stop,
    refreshStatus,
    reset,
  }
})
