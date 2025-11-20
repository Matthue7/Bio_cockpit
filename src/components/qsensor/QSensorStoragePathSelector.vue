<!--
  QSensorStoragePathSelector.vue - Storage path configuration for Q-Sensor recordings.
  Phase 4: Dual-sensor UI architecture.

  This component allows users to view and change the storage path for Q-Sensor recordings.
-->
<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-4">
      <label class="text-sm font-medium min-w-[100px]">Storage:</label>
      <input
        v-model="storagePath"
        type="text"
        class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded font-mono text-xs"
        readonly
        placeholder="Loading..."
      />
      <button class="px-4 py-2 bg-slate-600 hover:bg-slate-700 text-white rounded text-sm" @click="handleBrowse">
        Browse...
      </button>
    </div>

    <div class="text-xs text-gray-400">
      <p>All Q-Sensor recordings will be saved to this directory.</p>
    </div>

    <div v-if="error" class="p-3 bg-red-900/50 border border-red-600 rounded text-sm">
      <span class="text-red-400">{{ error }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

const emit = defineEmits<{
  (e: 'pathChanged', path: string): void
}>()

const storagePath = ref<string>('')
const error = ref<string | null>(null)

/**
 *
 */
async function loadStoragePath() {
  try {
    const path = await window.electronAPI.getQSensorStoragePath()
    storagePath.value = path
  } catch (err: any) {
    error.value = `Failed to load storage path: ${err.message}`
  }
}

/**
 *
 */
async function handleBrowse() {
  try {
    error.value = null
    const selectedPath = await window.electronAPI.selectQSensorStorageDirectory()
    if (selectedPath) {
      storagePath.value = selectedPath
      await window.electronAPI.setQSensorStoragePath(selectedPath)
      emit('pathChanged', selectedPath)
    }
  } catch (err: any) {
    error.value = `Failed to select storage path: ${err.message}`
  }
}

onMounted(() => {
  loadStoragePath()
})
</script>
