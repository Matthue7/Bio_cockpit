<!--
  QSensorSessionControl.vue - Unified session controls for dual-sensor recording.
  Phase 4: Dual-sensor UI architecture.

  This component provides controls to start/stop both sensors simultaneously
  with shared mission name and parameters.
-->
<template>
  <div class="flex flex-col gap-4 p-4 bg-slate-900 border border-slate-700 rounded-lg">
    <h3 class="text-lg font-semibold">Unified Session Controls</h3>

    <!-- Mission name input -->
    <div class="flex items-center gap-4">
      <label class="text-sm font-medium min-w-[100px]">Mission:</label>
      <input
        v-model="localMissionName"
        type="text"
        class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
        placeholder="Enter mission name"
        :disabled="store.isAnyRecording"
      />
    </div>

    <!-- Shared recording parameters -->
    <div class="flex items-center gap-4">
      <label class="text-sm font-medium min-w-[100px]">Roll Interval:</label>
      <input
        v-model.number="localRollIntervalS"
        type="number"
        min="1"
        max="300"
        class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
        :disabled="store.isAnyRecording"
      />
      <span class="text-xs text-gray-400">seconds</span>
    </div>

    <!-- Start Both / Stop Both buttons -->
    <div class="flex items-center gap-4">
      <button
        v-if="!store.isAnyRecording"
        class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="!store.areBothConnected || isStarting"
        @click="handleStartBoth"
      >
        {{ isStarting ? 'Starting...' : 'Start Both Sensors' }}
      </button>
      <button
        v-else
        class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="isStopping"
        @click="handleStopBoth"
      >
        {{ isStopping ? 'Stopping...' : 'Stop Both Sensors' }}
      </button>

      <!-- Connection status indicator -->
      <div v-if="!store.areBothConnected" class="flex items-center gap-2 text-xs text-yellow-400">
        <span class="w-2 h-2 bg-yellow-500 rounded-full"></span>
        <span>Connect both sensors first</span>
      </div>
    </div>

    <!-- Recording status -->
    <div v-if="store.isAnyRecording" class="space-y-2">
      <div class="flex items-center gap-2 p-3 bg-slate-800 rounded">
        <span class="w-3 h-3 bg-red-500 rounded-full animate-pulse"></span>
        <span class="text-sm text-red-400">
          {{ store.areBothRecording ? 'Both sensors recording' : 'Recording in progress' }}
        </span>
      </div>

      <!-- Stats summary -->
      <div class="grid grid-cols-2 gap-3">
        <div class="p-3 bg-slate-800 rounded text-sm">
          <div class="font-medium text-gray-400 text-xs">Total Bytes</div>
          <div class="text-lg mt-1">{{ formatBytes(store.totalBytesMirrored) }}</div>
        </div>
        <div v-if="store.unifiedSessionId" class="p-3 bg-slate-800 rounded text-sm">
          <div class="font-medium text-gray-400 text-xs">Session</div>
          <div class="text-xs mt-1 font-mono truncate">{{ store.unifiedSessionId }}</div>
        </div>
      </div>

      <div
        v-if="store.unifiedSessionPath && sessionFolderName"
        class="p-3 bg-slate-800 rounded text-sm"
        data-test="unified-session-path"
      >
        <div class="font-medium text-gray-400 text-xs">Unified Session Root</div>
        <div
          class="text-xs mt-1 font-mono truncate"
          :title="store.unifiedSessionPath"
          data-test="unified-session-path-value"
        >
          {{ sessionFolderName }}
        </div>
      </div>
    </div>

    <!-- Fusion Status (shown after recording stops) -->
    <div
      v-if="store.fusionStatus && store.fusionStatus.status"
      class="p-3 bg-slate-800 rounded text-sm"
      data-test="fusion-status"
    >
      <div class="font-medium text-gray-400 text-xs">Fusion Status</div>
      <div class="flex items-center gap-2 mt-1">
        <span
          class="w-2 h-2 rounded-full"
          :class="{
            'bg-green-500': store.fusionStatus.status === 'complete',
            'bg-yellow-500': store.fusionStatus.status === 'pending',
            'bg-gray-500': store.fusionStatus.status === 'skipped',
            'bg-red-500': store.fusionStatus.status === 'failed',
          }"
        ></span>
        <span
          class="text-sm"
          :class="{
            'text-green-400': store.fusionStatus.status === 'complete',
            'text-yellow-400': store.fusionStatus.status === 'pending',
            'text-gray-400': store.fusionStatus.status === 'skipped',
            'text-red-400': store.fusionStatus.status === 'failed',
          }"
        >
          {{ store.fusionStatus.status === 'complete' ? 'Complete' : store.fusionStatus.status }}
        </span>
        <span v-if="store.fusionStatus.rowCount" class="text-xs text-gray-400">
          ({{ store.fusionStatus.rowCount.toLocaleString() }} rows)
        </span>
      </div>

      <!-- Unified CSV file info -->
      <div v-if="store.fusionStatus.unifiedCsv" class="mt-2">
        <div class="font-medium text-gray-400 text-xs">Unified File</div>
        <div
          class="text-xs mt-1 font-mono truncate text-blue-400"
          :title="store.fusionStatus.unifiedCsvPath || store.fusionStatus.unifiedCsv"
        >
          {{ store.fusionStatus.unifiedCsv }}
        </div>
      </div>

      <!-- Row breakdown -->
      <div
        v-if="store.fusionStatus.status === 'complete' && store.fusionStatus.inWaterRows && store.fusionStatus.surfaceRows"
        class="mt-2 text-xs text-gray-400"
      >
        In-water: {{ store.fusionStatus.inWaterRows.toLocaleString() }} |
        Surface: {{ store.fusionStatus.surfaceRows.toLocaleString() }}
      </div>

      <!-- Error message -->
      <div v-if="store.fusionStatus.error && store.fusionStatus.status !== 'skipped'" class="mt-2 text-xs text-red-400">
        {{ store.fusionStatus.error }}
      </div>
    </div>

    <!-- Errors -->
    <div v-if="store.combinedErrors.length > 0" class="space-y-2">
      <div
        v-for="(error, index) in store.combinedErrors"
        :key="index"
        class="p-3 bg-red-900/50 border border-red-600 rounded text-sm"
      >
        <span class="text-red-400">{{ error }}</span>
      </div>
    </div>

    <!-- Error from last operation -->
    <div v-if="lastOperationError" class="p-3 bg-red-900/50 border border-red-600 rounded text-sm">
      <span class="text-red-400">{{ lastOperationError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useQSensorStore } from '@/stores/qsensor'

const store = useQSensorStore()

// * Local state for unified session controls
const localMissionName = ref(store.globalMissionName || 'Cockpit')
const localRollIntervalS = ref(60)
const isStarting = ref(false)
const isStopping = ref(false)
const lastOperationError = ref<string | null>(null)
const lastSessionPath = ref<string | null>(null)
const sessionFolderName = computed(() => {
  if (!store.unifiedSessionPath) return null
  const normalized = store.unifiedSessionPath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts.pop() || store.unifiedSessionPath
})

// NOTE: Sync mission name with store
watch(localMissionName, (newVal) => {
  store.globalMissionName = newVal
})

// * Start both sensors with shared mission parameters
async function handleStartBoth() {
  isStarting.value = true
  lastOperationError.value = null

  try {
    const result = await store.startBoth({
      mission: localMissionName.value,
      rollIntervalS: localRollIntervalS.value,
    })

    if (!result.success) {
      lastOperationError.value = result.errors.join('; ')
    }
  } catch (error: any) {
    lastOperationError.value = error.message
  } finally {
    isStarting.value = false
  }
}

// * Stop both sensors and capture any combined errors
async function handleStopBoth() {
  isStopping.value = true
  lastOperationError.value = null

  // Save session path before it gets cleared by stopBoth
  lastSessionPath.value = store.unifiedSessionPath

  try {
    const result = await store.stopBoth()

    if (!result.success) {
      lastOperationError.value = result.errors.join('; ')
    }

    // Refresh fusion status after stopping (fusion runs automatically)
    // Give a small delay for fusion to complete
    if (lastSessionPath.value) {
      setTimeout(async () => {
        await store.refreshFusionStatus(lastSessionPath.value!)
      }, 500)
    }
  } catch (error: any) {
    lastOperationError.value = error.message
  } finally {
    isStopping.value = false
  }
}

// * Format bytes for unified status summary
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
</script>
