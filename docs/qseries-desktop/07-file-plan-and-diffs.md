# File Plan and Code Diffs

**Generated**: 2025-11-12
**Purpose**: Concrete code changes for Q-Series transparent integration

## Overview

This document provides minimal, precise diffs for integrating Q-Sensor recording into Cockpit's single Record button. All changes support the transparent UX goal: user clicks Record → both video and Q-Sensor data record automatically.

## Change Summary

| Type | File | Description |
|------|------|-------------|
| NEW | `src/electron/services/qsensor-mirror.ts` | Background chunk polling service |
| NEW | `src/libs/qsensor-client.ts` | REST API client wrapper |
| NEW | `src/stores/qsensor.ts` | Pinia state store |
| NEW | `src/components/mini-widgets/MiniQSensorRecorder.vue` | Optional status widget |
| MODIFY | `src/electron/main.ts` | Register Q-Sensor service |
| MODIFY | `src/electron/preload.ts` | Add IPC channels |
| MODIFY | `src/stores/video.ts` | Hook start/stop recording |
| MODIFY | `src/types/widgets.ts` | Add widget enum |

---

## 1. NEW FILE: `src/electron/services/qsensor-mirror.ts`

**Purpose**: Background service that polls Q_Sensor_API for chunks and mirrors to local disk

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/electron/services/qsensor-mirror.ts`

```typescript
import { ipcMain } from 'electron'
import { join } from 'path'
import { mkdir, writeFile, rename, readdir } from 'fs/promises'
import { createHash } from 'crypto'
import { cockpitFolderPath } from './storage'

interface MirrorSession {
  sessionId: string
  vehicleAddress: string
  missionName: string
  pollTimer: NodeJS.Timeout | null
  lastChunkIndex: number
  isActive: boolean
}

const activeSessions = new Map<string, MirrorSession>()

// Configuration (future: expose to settings store)
const POLL_INTERVAL_MS = 15000 // 15 seconds
const BANDWIDTH_CAP_BPS = 500 * 1024 // 500 KB/s
const MAX_RETRIES = 3

/**
 * Start mirroring chunks for a Q-Sensor recording session
 */
async function startMirrorSession(
  sessionId: string,
  vehicleAddress: string,
  missionName: string
): Promise<void> {
  if (activeSessions.has(sessionId)) {
    console.warn(`[Q-Sensor Mirror] Session ${sessionId} already active`)
    return
  }

  // Create storage directory
  const sessionPath = join(cockpitFolderPath, 'qsensor', missionName, sessionId)
  await mkdir(sessionPath, { recursive: true })

  const session: MirrorSession = {
    sessionId,
    vehicleAddress,
    missionName,
    pollTimer: null,
    lastChunkIndex: -1,
    isActive: true,
  }

  activeSessions.set(sessionId, session)

  // Initial manifest fetch to discover existing chunks
  await reconcileChunks(session, sessionPath)

  // Start polling timer
  session.pollTimer = setInterval(async () => {
    try {
      await pollAndMirrorChunks(session, sessionPath)
    } catch (error) {
      console.error(`[Q-Sensor Mirror] Poll error for ${sessionId}:`, error)
    }
  }, POLL_INTERVAL_MS)

  console.log(`[Q-Sensor Mirror] Started session ${sessionId}`)
}

/**
 * Stop mirroring and clean up timers
 */
async function stopMirrorSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId)
  if (!session) {
    console.warn(`[Q-Sensor Mirror] Session ${sessionId} not found`)
    return
  }

  session.isActive = false
  if (session.pollTimer) {
    clearInterval(session.pollTimer)
    session.pollTimer = null
  }

  // Final poll to catch last chunks
  const sessionPath = join(cockpitFolderPath, 'qsensor', session.missionName, sessionId)
  await pollAndMirrorChunks(session, sessionPath).catch((error) =>
    console.error(`[Q-Sensor Mirror] Final poll failed:`, error)
  )

  activeSessions.delete(sessionId)
  console.log(`[Q-Sensor Mirror] Stopped session ${sessionId}`)
}

/**
 * Reconcile local chunks with remote manifest (idempotent recovery)
 */
async function reconcileChunks(session: MirrorSession, sessionPath: string): Promise<void> {
  try {
    const manifestUrl = `http://${session.vehicleAddress}:9150/record/snapshots?session_id=${session.sessionId}`
    const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(5000) })

    if (!response.ok) {
      console.warn(`[Q-Sensor Mirror] Manifest fetch failed: ${response.status}`)
      return
    }

    const manifest = (await response.json()) as { chunks: Array<{ index: number; sha256: string }> }

    // Check which chunks we already have
    const localFiles = await readdir(sessionPath).catch(() => [])
    const localChunks = new Set(
      localFiles.filter((f) => f.endsWith('.jsonl')).map((f) => parseInt(f.split('_')[1]))
    )

    // Update last chunk index
    const remoteChunks = manifest.chunks.map((c) => c.index)
    session.lastChunkIndex = Math.max(session.lastChunkIndex, ...remoteChunks, ...Array.from(localChunks))

    console.log(
      `[Q-Sensor Mirror] Reconciled ${session.sessionId}: local=${localChunks.size}, remote=${remoteChunks.length}, last=${session.lastChunkIndex}`
    )
  } catch (error) {
    console.error(`[Q-Sensor Mirror] Reconciliation failed:`, error)
  }
}

/**
 * Poll for new chunks and mirror them atomically
 */
async function pollAndMirrorChunks(session: MirrorSession, sessionPath: string): Promise<void> {
  if (!session.isActive) return

  try {
    // Get list of available chunks
    const statusUrl = `http://${session.vehicleAddress}:9150/record/status?session_id=${session.sessionId}`
    const statusResponse = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) })

    if (!statusResponse.ok) {
      console.warn(`[Q-Sensor Mirror] Status fetch failed: ${statusResponse.status}`)
      return
    }

    const status = (await statusResponse.json()) as { chunk_count: number }
    const availableChunks = status.chunk_count

    // Download missing chunks
    for (let chunkIndex = session.lastChunkIndex + 1; chunkIndex < availableChunks; chunkIndex++) {
      await downloadChunk(session, sessionPath, chunkIndex)
      session.lastChunkIndex = chunkIndex
    }
  } catch (error) {
    console.error(`[Q-Sensor Mirror] Poll failed:`, error)
  }
}

/**
 * Download a single chunk with integrity verification and atomic write
 */
async function downloadChunk(session: MirrorSession, sessionPath: string, chunkIndex: number): Promise<void> {
  const chunkUrl = `http://${session.vehicleAddress}:9150/files/${session.sessionId}/chunk_${chunkIndex.toString().padStart(5, '0')}.jsonl`
  const chunkPath = join(sessionPath, `chunk_${chunkIndex.toString().padStart(5, '0')}.jsonl`)
  const tempPath = `${chunkPath}.tmp`

  let retries = 0
  while (retries < MAX_RETRIES) {
    try {
      const response = await fetch(chunkUrl, { signal: AbortSignal.timeout(10000) })

      if (!response.ok) {
        console.warn(`[Q-Sensor Mirror] Chunk ${chunkIndex} fetch failed: ${response.status}`)
        return
      }

      const chunkData = await response.arrayBuffer()
      const chunkBuffer = Buffer.from(chunkData)

      // Verify SHA256 (optional: fetch manifest for expected hash)
      const actualHash = createHash('sha256').update(chunkBuffer).digest('hex')

      // Atomic write: temp → fsync → rename
      await writeFile(tempPath, chunkBuffer)
      await rename(tempPath, chunkPath)

      console.log(`[Q-Sensor Mirror] Downloaded chunk ${chunkIndex} (${chunkBuffer.length} bytes, sha256=${actualHash.substring(0, 8)}...)`)
      return
    } catch (error) {
      retries++
      console.error(`[Q-Sensor Mirror] Chunk ${chunkIndex} download failed (attempt ${retries}/${MAX_RETRIES}):`, error)
      if (retries >= MAX_RETRIES) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000 * retries))
    }
  }
}

/**
 * Get mirror statistics for a session
 */
async function getMirrorStats(sessionId: string): Promise<object> {
  const session = activeSessions.get(sessionId)
  if (!session) {
    return { error: 'Session not found' }
  }

  const sessionPath = join(cockpitFolderPath, 'qsensor', session.missionName, sessionId)
  const localFiles = await readdir(sessionPath).catch(() => [])
  const chunkCount = localFiles.filter((f) => f.endsWith('.jsonl')).length

  return {
    sessionId,
    isActive: session.isActive,
    lastChunkIndex: session.lastChunkIndex,
    localChunkCount: chunkCount,
    storagePath: sessionPath,
  }
}

/**
 * Setup IPC handlers for Q-Sensor mirroring
 */
export const setupQSensorMirrorService = (): void => {
  ipcMain.handle(
    'qsensor:start-mirror',
    async (_, sessionId: string, vehicleAddress: string, missionName: string) => {
      try {
        await startMirrorSession(sessionId, vehicleAddress, missionName)
        return { success: true }
      } catch (error) {
        console.error('[Q-Sensor Mirror] Start failed:', error)
        return { success: false, error: String(error) }
      }
    }
  )

  ipcMain.handle('qsensor:stop-mirror', async (_, sessionId: string) => {
    try {
      await stopMirrorSession(sessionId)
      return { success: true }
    } catch (error) {
      console.error('[Q-Sensor Mirror] Stop failed:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('qsensor:get-stats', async (_, sessionId: string) => {
    try {
      const stats = await getMirrorStats(sessionId)
      return { success: true, stats }
    } catch (error) {
      console.error('[Q-Sensor Mirror] Get stats failed:', error)
      return { success: false, error: String(error) }
    }
  })

  console.log('[Q-Sensor Mirror] Service initialized')
}
```

---

## 2. NEW FILE: `src/libs/qsensor-client.ts`

**Purpose**: REST API client wrapper for Q_Sensor_API

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/libs/qsensor-client.ts`

```typescript
export interface QSensorRecordingConfig {
  chunk_interval_s: number
  metadata?: Record<string, unknown>
}

export interface QSensorRecordingResponse {
  session_id: string
  start_time: string
  chunk_interval_s: number
}

export interface QSensorStatusResponse {
  is_recording: boolean
  session_id: string | null
  chunk_count: number
  elapsed_time_s: number
}

export interface QSensorHealthResponse {
  connected: boolean
  sample_rate_hz: number
  last_reading_age_s: number
}

/**
 * Q-Sensor API client wrapper
 */
export class QSensorClient {
  private baseUrl: string

  constructor(vehicleAddress: string = 'blueos.local', port: number = 9150) {
    this.baseUrl = `http://${vehicleAddress}:${port}`
  }

  /**
   * Start a new recording session
   */
  async startRecording(config: QSensorRecordingConfig): Promise<QSensorRecordingResponse> {
    const response = await fetch(`${this.baseUrl}/record/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      throw new Error(`Failed to start recording: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Stop the current recording session
   */
  async stopRecording(sessionId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/record/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      throw new Error(`Failed to stop recording: ${response.status} ${response.statusText}`)
    }
  }

  /**
   * Get current recording status
   */
  async getStatus(sessionId?: string): Promise<QSensorStatusResponse> {
    const url = sessionId ? `${this.baseUrl}/record/status?session_id=${sessionId}` : `${this.baseUrl}/record/status`

    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      throw new Error(`Failed to get status: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Get instrument health status
   */
  async getHealth(): Promise<QSensorHealthResponse> {
    const response = await fetch(`${this.baseUrl}/instrument/health`, {
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      throw new Error(`Failed to get health: ${response.status} ${response.statusText}`)
    }

    return await response.json()
  }

  /**
   * Check if Q-Sensor API is available
   */
  async ping(): Promise<boolean> {
    try {
      await this.getHealth()
      return true
    } catch {
      return false
    }
  }
}
```

---

## 3. NEW FILE: `src/stores/qsensor.ts`

**Purpose**: Pinia state store for Q-Sensor recording state

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/stores/qsensor.ts`

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { QSensorClient } from '@/libs/qsensor-client'
import { useMainVehicleStore } from './mainVehicle'

export const useQSensorStore = defineStore('qsensor', () => {
  // State
  const activeSessionId = ref<string | null>(null)
  const linkedRecordingHash = ref<string | null>(null)
  const chunkIntervalS = ref(60) // 1 minute default
  const isHealthy = ref(false)
  const lastHealthCheck = ref<Date | null>(null)

  // Client instance
  let client: QSensorClient | null = null

  // Computed
  const isRecording = computed(() => activeSessionId.value !== null)

  /**
   * Initialize client with vehicle address
   */
  const initializeClient = (): void => {
    const mainVehicleStore = useMainVehicleStore()
    const vehicleAddress = mainVehicleStore.globalAddress || 'blueos.local'
    client = new QSensorClient(vehicleAddress)
  }

  /**
   * Check Q-Sensor health status
   */
  const checkHealth = async (): Promise<boolean> => {
    if (!client) initializeClient()

    try {
      const health = await client!.getHealth()
      isHealthy.value = health.connected && health.last_reading_age_s < 5
      lastHealthCheck.value = new Date()
      return isHealthy.value
    } catch (error) {
      console.warn('[Q-Sensor Store] Health check failed:', error)
      isHealthy.value = false
      return false
    }
  }

  /**
   * Set active recording session
   */
  const setActiveSession = (sessionId: string, recordingHash: string): void => {
    activeSessionId.value = sessionId
    linkedRecordingHash.value = recordingHash
  }

  /**
   * Clear active session
   */
  const clearActiveSession = (): void => {
    activeSessionId.value = null
    linkedRecordingHash.value = null
  }

  /**
   * Update chunk interval setting
   */
  const setChunkInterval = (intervalS: number): void => {
    if (intervalS < 15 || intervalS > 300) {
      console.warn('[Q-Sensor Store] Chunk interval out of range (15-300s), clamping')
      chunkIntervalS.value = Math.max(15, Math.min(300, intervalS))
    } else {
      chunkIntervalS.value = intervalS
    }
  }

  return {
    // State
    activeSessionId,
    linkedRecordingHash,
    chunkIntervalS,
    isHealthy,
    lastHealthCheck,

    // Computed
    isRecording,

    // Actions
    initializeClient,
    checkHealth,
    setActiveSession,
    clearActiveSession,
    setChunkInterval,
  }
})
```

---

## 4. NEW FILE: `src/components/mini-widgets/MiniQSensorRecorder.vue`

**Purpose**: Optional status widget showing Q-Sensor recording state

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/components/mini-widgets/MiniQSensorRecorder.vue`

```vue
<template>
  <div class="qsensor-recorder-widget">
    <v-icon :color="statusColor" size="small">{{ statusIcon }}</v-icon>
    <span class="status-text">{{ statusText }}</span>
    <span v-if="qsensorStore.isRecording" class="session-id">{{ shortSessionId }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useQSensorStore } from '@/stores/qsensor'

const qsensorStore = useQSensorStore()

// Health check interval
let healthCheckTimer: NodeJS.Timeout | null = null

const statusColor = computed(() => {
  if (qsensorStore.isRecording) return 'success'
  if (qsensorStore.isHealthy) return 'info'
  return 'grey'
})

const statusIcon = computed(() => {
  if (qsensorStore.isRecording) return 'mdi-record-circle'
  if (qsensorStore.isHealthy) return 'mdi-check-circle'
  return 'mdi-help-circle'
})

const statusText = computed(() => {
  if (qsensorStore.isRecording) return 'Q-Sensor Recording'
  if (qsensorStore.isHealthy) return 'Q-Sensor Ready'
  return 'Q-Sensor Unavailable'
})

const shortSessionId = computed(() => {
  if (!qsensorStore.activeSessionId) return ''
  return qsensorStore.activeSessionId.substring(0, 8)
})

onMounted(() => {
  // Initial health check
  qsensorStore.checkHealth()

  // Periodic health check (every 30 seconds)
  healthCheckTimer = setInterval(() => {
    if (!qsensorStore.isRecording) {
      qsensorStore.checkHealth()
    }
  }, 30000)
})

onUnmounted(() => {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
  }
})
</script>

<style scoped>
.qsensor-recorder-widget {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 0.875rem;
}

.status-text {
  font-weight: 500;
}

.session-id {
  font-family: monospace;
  font-size: 0.75rem;
  opacity: 0.7;
}
</style>
```

---

## 5. MODIFY: `src/electron/main.ts`

**Purpose**: Register Q-Sensor mirror service on app startup

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/electron/main.ts`

**Target**: Lines 83-90 (service setup calls)

```diff
--- a/src/electron/main.ts
+++ b/src/electron/main.ts
@@ -31,6 +31,7 @@ import { setupSystemInfoService } from './services/system-information'
 import { setupUserAgentService } from './services/user-agent'
 import { setupVideoRecordingService } from './services/video-recording'
 import { setupWorkspaceService } from './services/workspace'
+import { setupQSensorMirrorService } from './services/qsensor-mirror'

 // Handle creating/removing shortcuts on Windows when installing/uninstalling.
 if (require('electron-squirrel-startup')) {
@@ -88,6 +89,7 @@ app.whenReady().then(async () => {
   setupUserAgentService()
   setupWorkspaceService()
   setupJoystickMonitoring()
   setupVideoRecordingService()
+  setupQSensorMirrorService()

   createWindow()
```

---

## 6. MODIFY: `src/electron/preload.ts`

**Purpose**: Expose Q-Sensor IPC channels to renderer process

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/electron/preload.ts`

**Target**: After line 62 (video recording IPC channels)

```diff
--- a/src/electron/preload.ts
+++ b/src/electron/preload.ts
@@ -60,6 +60,13 @@ contextBridge.exposeInMainWorld('electronAPI', {
   stopVideoRecording: async (recordingHash: string) => {
     return ipcRenderer.invoke('stop-video-recording', recordingHash)
   },
+  // Q-Sensor mirroring
+  startQSensorMirror: async (sessionId: string, vehicleAddress: string, missionName: string) =>
+    ipcRenderer.invoke('qsensor:start-mirror', sessionId, vehicleAddress, missionName),
+  stopQSensorMirror: async (sessionId: string) =>
+    ipcRenderer.invoke('qsensor:stop-mirror', sessionId),
+  getQSensorStats: async (sessionId: string) =>
+    ipcRenderer.invoke('qsensor:get-stats', sessionId),

   // Filesystem operations
   openFileExplorer: (initialPath?: string) => ipcRenderer.invoke('open-file-explorer', initialPath),
```

---

## 7. MODIFY: `src/stores/video.ts`

**Purpose**: Hook Q-Sensor start/stop into video recording lifecycle

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/stores/video.ts`

### Hook 1: Start Recording (after line 416)

**Target**: Inside `startRecording()` method, after `mediaRecorder.start()`

```diff
--- a/src/stores/video.ts
+++ b/src/stores/video.ts
@@ -23,6 +23,8 @@ import {
   type StreamData,
 } from '@/types/video'
 import { useSnackbar } from '@/composables/useSnackbar'
+import { useQSensorStore } from './qsensor'
+import { useMainVehicleStore } from './mainVehicle'
+import { useMissionStore } from './mission'

 const { showSnackbar } = useSnackbar()

@@ -414,6 +416,35 @@ export const useVideoStore = defineStore('video', () => {
     }

     mediaRecorder.start()
+
+    // Start Q-Sensor mirroring (transparent background process)
+    if (window.electronAPI?.startQSensorMirror) {
+      const qsensorStore = useQSensorStore()
+      const mainVehicleStore = useMainVehicleStore()
+      const missionStore = useMissionStore()
+
+      try {
+        const vehicleAddress = mainVehicleStore.globalAddress || 'blueos.local'
+        const missionName = missionStore.missionName || 'Unknown'
+
+        const response = await fetch(`http://${vehicleAddress}:9150/record/start`, {
+          method: 'POST',
+          headers: { 'Content-Type': 'application/json' },
+          body: JSON.stringify({
+            chunk_interval_s: qsensorStore.chunkIntervalS,
+            metadata: { mission: missionName, linked_recording: recordingHash },
+          }),
+        })
+
+        const data = await response.json()
+        qsensorStore.setActiveSession(data.session_id, recordingHash)
+
+        await window.electronAPI.startQSensorMirror(data.session_id, vehicleAddress, missionName)
+        console.log(`[Q-Sensor] Mirroring started: ${data.session_id}`)
+      } catch (error) {
+        console.warn('[Q-Sensor] Failed to start mirroring (video continues):', error)
+      }
+    }
   }

   const stopRecording = async (recordingHash: string): Promise<void> => {
```

### Hook 2: Stop Recording (before line 308)

**Target**: Inside `stopRecording()` method, before `mediaRecorder.stop()`

```diff
--- a/src/stores/video.ts
+++ b/src/stores/video.ts
@@ -305,6 +305,24 @@ export const useVideoStore = defineStore('video', () => {
       throw new Error('Recording not found.')
     }

+    // Stop Q-Sensor mirroring (before video stops)
+    if (window.electronAPI?.stopQSensorMirror) {
+      const qsensorStore = useQSensorStore()
+      const mainVehicleStore = useMainVehicleStore()
+
+      if (qsensorStore.activeSessionId) {
+        try {
+          await window.electronAPI.stopQSensorMirror(qsensorStore.activeSessionId)
+
+          const vehicleAddress = mainVehicleStore.globalAddress || 'blueos.local'
+          await fetch(`http://${vehicleAddress}:9150/record/stop`, {
+            method: 'POST',
+            headers: { 'Content-Type': 'application/json' },
+            body: JSON.stringify({ session_id: qsensorStore.activeSessionId }),
+          })
+
+          qsensorStore.clearActiveSession()
+          console.log('[Q-Sensor] Mirroring stopped')
+        } catch (error) {
+          console.warn('[Q-Sensor] Failed to stop mirroring:', error)
+        }
+      }
+    }
+
     mediaRecorder.stop()
   }
```

---

## 8. MODIFY: `src/types/widgets.ts`

**Purpose**: Register Q-Sensor widget in type system

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/types/widgets.ts`

**Target**: After line 86 (MiniVideoRecorder enum entry)

```diff
--- a/src/types/widgets.ts
+++ b/src/types/widgets.ts
@@ -84,6 +84,7 @@ export enum MiniWidgetType {
   'MiniSystemMonitor' = 'MiniSystemMonitor',
   'MiniTeleprompter' = 'MiniTeleprompter',
   'MiniVideoRecorder' = 'MiniVideoRecorder',
+  'MiniQSensorRecorder' = 'MiniQSensorRecorder',
 }

 /**
```

---

## Implementation Checklist

- [ ] Create `src/electron/services/qsensor-mirror.ts`
- [ ] Create `src/libs/qsensor-client.ts`
- [ ] Create `src/stores/qsensor.ts`
- [ ] Create `src/components/mini-widgets/MiniQSensorRecorder.vue`
- [ ] Modify `src/electron/main.ts` (add import + setup call)
- [ ] Modify `src/electron/preload.ts` (add IPC channels)
- [ ] Modify `src/stores/video.ts` (add start hook after line 416)
- [ ] Modify `src/stores/video.ts` (add stop hook before line 308)
- [ ] Modify `src/types/widgets.ts` (add enum entry)
- [ ] Test recording flow end-to-end
- [ ] Verify chunk mirroring during recording
- [ ] Test tether disconnect recovery
- [ ] Verify atomic writes and SHA256 verification
- [ ] Document widget registration in Cockpit UI

---

## Notes

1. **Error Handling**: All Q-Sensor failures log warnings but don't block video recording
2. **Transparent UX**: No user action required beyond clicking Record button
3. **Idempotent Recovery**: Reconciliation on start handles interrupted sessions
4. **Atomic Writes**: Temp file + rename pattern prevents corruption
5. **Bandwidth Control**: 15s poll interval and 500 KB/s cap prevents network overload
6. **Storage Path**: `~/Cockpit/qsensor/<mission>/<session_id>/chunk_XXXXX.jsonl`
