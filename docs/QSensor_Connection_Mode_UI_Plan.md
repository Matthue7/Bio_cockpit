# QSensor Connection Mode UI Plan

## Executive Summary

This document outlines a clean, incremental implementation plan for adding per-sensor connection type selection (API vs Serial) via a dropdown, and locking the rest of the UI for each sensor until the connection type is chosen. The design maintains backward compatibility while providing a clear user experience for selecting how each sensor should be connected.

## 1. Current State (Code-Level Summary)

### 1.1 How the dual-sensor system is wired today

#### In-water sensor path (API / mirror)
- **Backend Type**: HTTP (`backendType: 'http'`)
- **Connection Flow**: 
  1. UI sets `apiBaseUrl` (default: `http://blueos.local:9150`)
  2. `connectSensor('inWater')` calls `window.electronAPI.qsensorConnect()`
  3. Connection established to Pi's Q_Sensor_API
  4. Recording starts via `startRecordingSensor('inWater')` which:
     - Calls `qsensorStartAcquisition()` on Pi
     - Calls `qsensorStartRecording()` on Pi
     - Starts mirroring via `startQSensorMirror()` to download data

- **Key Files**:
  - [`src/electron/services/qsensor-mirror.ts`](src/electron/services/qsensor-mirror.ts) - Handles Pi HTTP API communication and data mirroring
  - [`src/stores/qsensor.ts`](src/stores/qsensor.ts) - Store functions like `connectSensor()` and `startRecordingSensor()`

#### Surface sensor path (serial pipeline)
- **Backend Type**: Serial (`backendType: 'serial'`)
- **Connection Flow**:
  1. UI selects serial port and baud rate
  2. `connectSensor('surface')` calls `window.electronAPI.qsensorSerialConnect()`
  3. Direct serial connection established to topside sensor
  4. Recording starts via `startRecordingSensor('surface')` which:
     - Calls `qsensorSerialStartRecording()` 
     - Data recorded locally via [`qsensor-local-recorder.ts`](src/electron/services/qsensor-local-recorder.ts)

- **Key Files**:
  - [`src/electron/services/qsensor-serial-recording.ts`](src/electron/services/qsensor-serial-recording.ts) - Handles serial connection and recording
  - [`src/electron/services/qsensor-local-recorder.ts`](src/electron/services/qsensor-local-recorder.ts) - Local data recording

### 1.2 Where the connect / disconnect flows live

#### Connection Functions
- **Store Level**: [`src/stores/qsensor.ts`](src/stores/qsensor.ts)
  - `connectSensor(sensorId: QSensorId)` (lines 357-451)
  - Routes to appropriate backend based on `sensor.backendType`

- **Service Level**:
  - HTTP: `qsensorConnect()` in electron services
  - Serial: `qsensorSerialConnect()` in [`qsensor-serial-recording.ts`](src/electron/services/qsensor-serial-recording.ts)

#### Disconnection Functions
- **Store Level**: `disconnectSensor(sensorId: QSensorId)` (lines 458-515)
- **Service Level**: `qsensorDisconnect()` and `qsensorSerialDisconnect()`

### 1.3 Where session state is modeled

#### Store State
- **File**: [`src/stores/qsensor.ts`](src/stores/qsensor.ts)
- **Data Structure**: `Map<QSensorId, QSensorState>` (line 31)
- **Key Interfaces**:
  - [`QSensorState`](src/types/qsensor.ts) (lines 120-179) - Main state structure
  - [`QSensorSessionInfo`](src/types/qsensor.ts) (lines 71-110) - Session metadata

#### Connection Status Tracking
- **Properties**:
  - `isConnected: boolean` - Connection status
  - `recordingState: QSensorRecordingState` - Recording status
  - `currentSession: QSensorSessionInfo | null` - Active session info
  - `lastError: string | null` - Error tracking

### 1.4 Where the user currently selects sensors and connects

#### UI Components
- **Main Cards**: [`src/components/qsensor/QSensorCard.vue`](src/components/qsensor/QSensorCard.vue)
- **Connection Controls**: [`src/components/qsensor/QSensorConnectionControl.vue`](src/components/qsensor/QSensorConnectionControl.vue)
- **Recording Controls**: [`src/components/qsensor/QSensorRecordingControl.vue`](src/components/qsensor/QSensorRecordingControl.vue)
- **Session Controls**: [`src/components/qsensor/QSensorSessionControl.vue`](src/components/qsensor/QSensorSessionControl.vue)

#### Current Connection Selection
- **In-water**: Fixed to HTTP backend (API URL input in connection control)
- **Surface**: Fixed to Serial backend (port selection in connection control)
- **No mode selection**: Backend type is hardcoded per sensor ID

### 1.5 Existing notions of "mode" or "connection type"

#### Current Backend Types
- **`QSensorBackendType`**: `'http' | 'serial'` (defined in [`src/types/qsensor.ts`](src/types/qsensor.ts) line 19)
- **Fixed Assignment**:
  - `inWater` sensor → `'http'` backend (hardcoded in store initialization, line 36)
  - `surface` sensor → `'serial'` backend (hardcoded in store initialization, line 45)

#### No Dynamic Connection Mode Selection
- Currently, connection type is implicit based on sensor ID
- No user-selectable connection mode
- No UI for switching connection types per sensor

## 2. Proposed Data Model Changes

### 2.1 New Fields for Connection Mode Selection

#### QSensorState Interface Updates
**File**: [`src/types/qsensor.ts`](src/types/qsensor.ts)

```typescript
export interface QSensorState {
  // ... existing fields ...
  
  // NEW: Connection mode selection
  connectionMode: 'api' | 'serial' | null
  
  // NEW: Flag to track if connection mode has been explicitly chosen
  connectionModeExplicitlySet: boolean
}
```

#### Store Initialization Changes
**File**: [`src/stores/qsensor.ts`](src/stores/qsensor.ts)

```typescript
// Initialize in-water sensor with null connection mode (user must choose)
sensors.value.set(
  'inWater',
  createInitialSensorState('inWater', null, { // backendType initially null
    apiBaseUrl: 'http://blueos.local:9150',
  })
)

// Initialize surface sensor with null connection mode (user must choose)
sensors.value.set(
  'surface',
  createInitialSensorState('surface', null, { // backendType initially null
    serialPort: null,
    baudRate: 9600,
  })
)
```

#### createInitialSensorState Function Updates
**File**: [`src/stores/qsensor-common.ts`](src/stores/qsensor-common.ts)

```typescript
export function createInitialSensorState(
  sensorId: QSensorId,
  backendType: QSensorBackendType | null, // Allow null initially
  config?: {
    apiBaseUrl?: string
    serialPort?: string
    baudRate?: number
  }
): QSensorState {
  return {
    sensorId,
    backendType, // Can be null initially
    
    // ... existing fields ...
    
    // NEW: Connection mode selection
    connectionMode: null,
    connectionModeExplicitlySet: false,
  }
}
```

### 2.2 Backend Type Dynamic Assignment

#### Connection Mode to Backend Type Mapping
**File**: [`src/stores/qsensor.ts`](src/stores/qsensor.ts)

```typescript
/**
 * Map connection mode to backend type
 */
function mapConnectionModeToBackend(connectionMode: 'api' | 'serial'): QSensorBackendType {
  return connectionMode === 'api' ? 'http' : 'serial'
}

/**
 * Update sensor's backend type based on connection mode
 */
function updateSensorBackendType(sensorId: QSensorId, connectionMode: 'api' | 'serial'): void {
  const sensor = sensors.value.get(sensorId)
  if (!sensor) return
  
  sensor.backendType = mapConnectionModeToBackend(connectionMode)
  sensor.connectionMode = connectionMode
  sensor.connectionModeExplicitlySet = true
}
```

### 2.3 Session Metadata Updates

#### QSensorSessionInfo Interface Updates
**File**: [`src/types/qsensor.ts`](src/types/qsensor.ts)

```typescript
export interface QSensorSessionInfo {
  // ... existing fields ...
  
  // NEW: Connection mode used for this session
  connectionMode: 'api' | 'serial'
  
  // NEW: Backend type used for this session (for backward compatibility)
  backendType: 'http' | 'serial'
}
```

### 2.4 Validation Updates

#### Connection Validation
**File**: [`src/stores/qsensor-common.ts`](src/stores/qsensor-common.ts)

```typescript
export function validateSensorConnection(state: QSensorState): string | null {
  // NEW: Check if connection mode is selected
  if (!state.connectionMode || !state.connectionModeExplicitlySet) {
    return 'Connection mode must be selected before connecting'
  }
  
  // Existing validation logic...
  return validateSensorConfig(state)
}
```

## 3. Proposed UI Changes

### 3.1 Connection Mode Selection Component

#### New Component: QSensorConnectionModeSelector.vue
**File**: [`src/components/qsensor/QSensorConnectionModeSelector.vue`](src/components/qsensor/QSensorConnectionModeSelector.vue)

```vue
<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center gap-4">
      <label class="text-sm font-medium min-w-[100px]">Connection Type:</label>
      <select
        v-model="selectedConnectionMode"
        class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
        :disabled="sensor.isConnected || isConnecting"
        @change="handleConnectionModeChange"
      >
        <option value="">Select connection type...</option>
        <option value="api">API (via Pi/HTTP)</option>
        <option value="serial">Serial (direct connection)</option>
      </select>
    </div>
    
    <!-- Helper text when no mode selected -->
    <div v-if="!sensor.connectionMode && !sensor.isConnected" 
         class="p-3 bg-yellow-900/30 border border-yellow-600 rounded text-sm text-yellow-400">
      <span class="font-medium">⚠️ Connection Required</span>
      <p class="mt-1">Select a connection type to enable sensor controls</p>
    </div>
    
    <!-- Mode indicator when selected -->
    <div v-if="sensor.connectionMode && !sensor.isConnected" 
         class="p-3 bg-blue-900/30 border border-blue-600 rounded text-sm text-blue-400">
      <span class="font-medium">✓ Connection Mode Selected</span>
      <p class="mt-1">
        Using {{ selectedModeLabel }} connection for this sensor
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQSensorStore } from '@/stores/qsensor'
import type { QSensorId, QSensorState } from '@/types/qsensor'

const props = defineProps<{
  sensorId: QSensorId
  sensor: QSensorState
}>()

const emit = defineEmits<{
  (e: 'modeSelected', mode: 'api' | 'serial'): void
  (e: 'error', error: string): void
}>()

const store = useQSensorStore()

const selectedConnectionMode = ref<string>('')
const isConnecting = ref(false)

const selectedModeLabel = computed(() => {
  switch (selectedConnectionMode.value) {
    case 'api': return 'API (via Pi/HTTP)'
    case 'serial': return 'Serial (direct connection)'
    default: return ''
  }
})

// Initialize with current sensor connection mode
watch(() => props.sensor.connectionMode, (newMode) => {
  selectedConnectionMode.value = newMode || ''
}, { immediate: true })

function handleConnectionModeChange() {
  if (!selectedConnectionMode.value) return
  
  const mode = selectedConnectionMode.value as 'api' | 'serial'
  
  // Update store
  store.setConnectionMode(props.sensorId, mode)
  
  emit('modeSelected', mode)
}
</script>
```

### 3.2 Updated QSensorConnectionControl.vue

#### Modified Component: QSensorConnectionControl.vue
**File**: [`src/components/qsensor/QSensorConnectionControl.vue`](src/components/qsensor/QSensorConnectionControl.vue)

```vue
<template>
  <div class="flex flex-col gap-4">
    <!-- NEW: Connection mode selector -->
    <QSensorConnectionModeSelector
      :sensor-id="sensorId"
      :sensor="sensor"
      @mode-selected="handleModeSelected"
      @error="emit('error', $event)"
    />
    
    <!-- Existing connection fields - now conditional on connection mode -->
    <template v-if="sensor.connectionMode === 'api'">
      <!-- HTTP backend fields (existing) -->
      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">API URL:</label>
        <input
          v-model="localApiBaseUrl"
          type="text"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          placeholder="http://blueos.local:9150"
          :disabled="sensor.isConnected || isConnecting || !sensor.connectionMode"
        />
      </div>
    </template>
    
    <template v-else-if="sensor.connectionMode === 'serial'">
      <!-- Serial backend fields (existing) -->
      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">Serial Port:</label>
        <select
          v-model="selectedSurfacePort"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          :disabled="sensor.isConnected || isConnecting || isRefreshingPorts || !sensor.connectionMode"
        >
          <option v-if="availableSurfacePorts.length === 0" value="">No serial ports detected</option>
          <option
            v-for="port in availableSurfacePorts"
            :key="port.path"
            :value="port.path"
          >
            {{ formatPortLabel(port) }}
          </option>
        </select>
        <button
          type="button"
          class="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm disabled:opacity-50"
          :disabled="sensor.isConnected || isConnecting || isRefreshingPorts || !sensor.connectionMode"
          @click="handleRefreshPorts"
        >
          {{ isRefreshingPorts ? 'Refreshing…' : 'Refresh' }}
        </button>
      </div>
      
      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">Baud Rate:</label>
        <input
          v-model.number="localBaudRate"
          type="number"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          placeholder="9600"
          :disabled="sensor.isConnected || isConnecting || !sensor.connectionMode"
        />
      </div>
    </template>
    
    <!-- Connect/Disconnect buttons - disabled until connection mode selected -->
    <div class="flex items-center gap-4">
      <button
        v-if="!sensor.isConnected"
        class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="isConnecting || !sensor.connectionMode || !sensor.connectionModeExplicitlySet"
        @click="handleConnect"
      >
        {{ isConnecting ? 'Connecting...' : 'Connect' }}
      </button>
      <button
        v-else
        class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="isDisconnecting"
        @click="handleDisconnect"
      >
        {{ isDisconnecting ? 'Disconnecting...' : 'Disconnect' }}
      </button>
      
      <!-- Connection mode indicator -->
      <div v-if="sensor.connectionMode" class="ml-auto flex items-center gap-2">
        <span class="text-xs px-2 py-1 rounded" :class="modeBadgeClass">
          {{ modeLabel }}
        </span>
      </div>
    </div>
    
    <!-- Error display -->
    <div v-if="sensor.lastError" class="p-3 bg-red-900/50 border border-red-600 rounded text-sm">
      <span class="text-red-400">{{ sensor.lastError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { useQSensorStore } from '@/stores/qsensor'
import type { SerialPortInfo } from '@/stores/qsensor'
import type { QSensorId, QSensorState } from '@/types/qsensor'
import QSensorConnectionModeSelector from './QSensorConnectionModeSelector.vue'

const props = defineProps<{
  sensorId: QSensorId
  sensor: QSensorState
}>()

const emit = defineEmits<{
  (e: 'connected'): void
  (e: 'disconnected'): void
  (e: 'error', error: string): void
}>()

const store = useQSensorStore()

// Local state for form fields
const localApiBaseUrl = ref(props.sensor.apiBaseUrl || 'http://blueos.local:9150')
const localBaudRate = ref(props.sensor.baudRate || 9600)
const isRefreshingPorts = ref(false)

// Connection state flags
const isConnecting = ref(false)
const isDisconnecting = ref(false)

const availableSurfacePorts = computed(() => store.availableSurfacePorts)
const selectedSurfacePort = computed<string | null>({
  get: () => store.selectedSurfacePortPath,
  set: (value) => store.selectSurfaceSerialPort(value || null),
})

// Mode badge styling
const modeLabel = computed(() => {
  if (!props.sensor.connectionMode) return ''
  return props.sensor.connectionMode === 'api' ? 'API' : 'Serial'
})

const modeBadgeClass = computed(() => {
  if (!props.sensor.connectionMode) return ''
  return props.sensor.connectionMode === 'api' 
    ? 'bg-blue-600/30 text-blue-400' 
    : 'bg-purple-600/30 text-purple-400'
})

// Handle connection mode selection
function handleModeSelected(mode: 'api' | 'serial') {
  console.log(`[QSensorConnectionControl] Connection mode selected: ${mode}`)
  // Store will handle backend type updates
}

// ... rest of existing connection logic ...
</script>
```

### 3.3 Updated QSensorRecordingControl.vue

#### Modified Component: QSensorRecordingControl.vue
**File**: [`src/components/qsensor/QSensorRecordingControl.vue`](src/components/qsensor/QSensorRecordingControl.vue)

```vue
<template>
  <div class="flex flex-col gap-4">
    <!-- Connection mode warning -->
    <div v-if="!sensor.connectionMode" 
         class="p-3 bg-yellow-900/30 border border-yellow-600 rounded text-sm text-yellow-400">
      <span class="font-medium">⚠️ Connection Mode Required</span>
      <p class="mt-1">Select a connection type before recording</p>
    </div>
    
    <!-- Recording parameters - disabled until connection mode selected -->
    <div v-if="!isRecording && sensor.isConnected && sensor.connectionMode" 
         class="flex flex-col gap-3">
      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">Rate (Hz):</label>
        <input
          v-model.number="localRateHz"
          type="number"
          step="0.1"
          min="0.1"
          max="500"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          :disabled="isRecording || !sensor.connectionMode"
        />
        <span class="text-xs text-gray-400">(0.1-500)</span>
      </div>

      <div class="flex items-center gap-4">
        <label class="text-sm font-medium min-w-[100px]">Roll Interval:</label>
        <input
          v-model.number="localRollIntervalS"
          type="number"
          min="1"
          max="300"
          class="flex-1 px-3 py-2 bg-slate-800 text-white border border-slate-600 rounded text-sm"
          :disabled="isRecording || !sensor.connectionMode"
        />
        <span class="text-xs text-gray-400">seconds</span>
      </div>
    </div>

    <!-- Start/Stop buttons - disabled until connection mode selected -->
    <div class="flex items-center gap-4">
      <button
        v-if="!isRecording"
        class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="!sensor.isConnected || !sensor.connectionMode || !sensor.connectionModeExplicitlySet || isStarting"
        @click="handleStart"
      >
        {{ isStarting ? 'Starting...' : 'Start Recording' }}
      </button>
      <button
        v-else
        class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50"
        :disabled="isStopping"
        @click="handleStop"
      >
        {{ isStopping ? 'Stopping...' : 'Stop Recording' }}
      </button>
    </div>
    
    <!-- Session info with connection mode indicator -->
    <div v-if="sensor.currentSession" class="p-3 bg-slate-800 rounded text-sm space-y-2">
      <div>
        <span class="font-medium">Session ID:</span>
        <span class="ml-2 font-mono text-xs">{{ sensor.currentSession.sessionId }}</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <span class="font-medium">Rate:</span>
          <span class="ml-2">{{ sensor.currentSession.rateHz }} Hz</span>
        </div>
        <div>
          <span class="font-medium">Roll:</span>
          <span class="ml-2">{{ sensor.currentSession.rollIntervalS }}s</span>
        </div>
      </div>
      <div>
        <span class="font-medium">Connection:</span>
        <span class="ml-2">{{ sensor.currentSession.connectionMode || 'Unknown' }}</span>
      </div>
      <div v-if="sensor.lastSync">
        <span class="font-medium">Last Sync:</span>
        <span class="ml-2">{{ formatTimestamp(sensor.lastSync) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import { useQSensorStore } from '@/stores/qsensor'
import { isSensorRecording } from '@/stores/qsensor-common'
import type { QSensorId, QSensorState } from '@/types/qsensor'

const props = defineProps<{
  sensorId: QSensorId
  sensor: QSensorState
  mission: string
}>()

const emit = defineEmits<{
  (e: 'started'): void
  (e: 'stopped'): void
  (e: 'error', error: string): void
}>()

const store = useQSensorStore()

// Recording state
const isStarting = ref(false)
const isStopping = ref(false)

// Local recording parameters
const localRateHz = ref(500)
const localRollIntervalS = ref(60)

// Computed for current recording state
const isRecording = computed(() => isSensorRecording(props.sensor))

// Start recording request handler
async function handleStart() {
  if (!props.sensor.connectionMode) {
    emit('error', 'Connection mode must be selected before recording')
    return
  }
  
  isStarting.value = true

  try {
    const result = await store.startRecordingSensor(props.sensorId, {
      mission: props.mission,
      rateHz: localRateHz.value,
      rollIntervalS: localRollIntervalS.value,
    })

    if (result.success) {
      emit('started')
    } else {
      emit('error', result.error || 'Failed to start recording')
    }
  } catch (error: any) {
    emit('error', error.message)
  } finally {
    isStarting.value = false
  }
}

// ... rest of existing recording logic ...
</script>
```

### 3.4 Store Actions for Connection Mode

#### New Store Functions
**File**: [`src/stores/qsensor.ts`](src/stores/qsensor.ts)

```typescript
/**
 * Set connection mode for a sensor
 * @param sensorId - Sensor identifier
 * @param connectionMode - Connection mode ('api' or 'serial')
 */
function setConnectionMode(sensorId: QSensorId, connectionMode: 'api' | 'serial'): void {
  const sensor = sensors.value.get(sensorId)
  if (!sensor) {
    console.error(`[QSensor Store] Unknown sensor: ${sensorId}`)
    return
  }
  
  // Update backend type based on connection mode
  const backendType = connectionMode === 'api' ? 'http' : 'serial'
  
  // Update sensor state
  sensor.backendType = backendType
  sensor.connectionMode = connectionMode
  sensor.connectionModeExplicitlySet = true
  
  console.log(`[QSensor Store] Set ${sensorId} connection mode: ${connectionMode} (backend: ${backendType})`)
}

/**
 * Reset connection mode for a sensor
 * @param sensorId - Sensor identifier
 */
function resetConnectionMode(sensorId: QSensorId): void {
  const sensor = sensors.value.get(sensorId)
  if (!sensor) return
  
  sensor.backendType = null
  sensor.connectionMode = null
  sensor.connectionModeExplicitlySet = false
  
  console.log(`[QSensor Store] Reset connection mode for ${sensorId}`)
}
```

## 4. Wiring / Behavior Changes

### 4.1 Connection Mode Influence on Service Selection

#### Updated connectSensor Function
**File**: [`src/stores/qsensor.ts`](src/stores/qsensor.ts)

```typescript
async function connectSensor(sensorId: QSensorId): Promise<{
  success: boolean
  error?: string
}> {
  const sensor = sensors.value.get(sensorId)
  if (!sensor) {
    return { success: false, error: `Unknown sensor: ${sensorId}` }
  }

  // NEW: Validate connection mode is selected
  if (!sensor.connectionMode || !sensor.connectionModeExplicitlySet) {
    return { success: false, error: 'Connection mode must be selected before connecting' }
  }

  try {
    let result: {
      success: boolean
      data?: any
      error?: string
    }

    // MODIFIED: Use dynamic backend type instead of hardcoded
    if (sensor.backendType === 'http') {
      // API connection logic (existing)
      if (!sensor.apiBaseUrl) {
        return { success: false, error: 'No API base URL configured' }
      }

      result = await window.electronAPI.qsensorConnect(sensor.apiBaseUrl, '/dev/ttyUSB0', 9600)
      // ... rest of existing HTTP connection logic
    } else if (sensor.backendType === 'serial') {
      // Serial connection logic (existing)
      let portPath = selectedSurfacePortPath.value || sensor.serialPort
      if (!portPath) {
        const refreshResult = await refreshSurfaceSerialPorts()
        if (refreshResult.success && availableSurfacePorts.value.length > 0) {
          portPath = availableSurfacePorts.value[0].path
          selectSurfaceSerialPort(portPath)
        }
      }
      if (!portPath) {
        return { success: false, error: 'No serial ports available to connect' }
      }

      const baudRate = sensor.baudRate || 9600
      result = await window.electronAPI.qsensorSerialConnect(portPath, baudRate)
      // ... rest of existing serial connection logic
    } else {
      return { success: false, error: `Unknown backend type: ${sensor.backendType}` }
    }

    return { success: result.success, error: result.error }
  } catch (error: any) {
    sensor.lastError = error.message
    return { success: false, error: error.message }
  }
}
```

### 4.2 Recording Functions with Connection Mode

#### Updated startRecordingSensor Function
**File**: [`src/stores/qsensor.ts`](src/stores/qsensor.ts)

```typescript
async function startRecordingSensor(
  sensorId: QSensorId,
  params: {
    mission: string
    rateHz?: number
    rollIntervalS?: number
    schemaVersion?: number
    unifiedSessionTimestamp?: string
    syncId?: string
  }
): Promise<{
  success: boolean
  error?: string
}> {
  const sensor = sensors.value.get(sensorId)
  if (!sensor) {
    return { success: false, error: `Unknown sensor: ${sensorId}` }
  }

  // NEW: Validate connection mode is selected
  if (!sensor.connectionMode || !sensor.connectionModeExplicitlySet) {
    return { success: false, error: `Connection mode must be selected before recording ${sensorId}` }
  }

  if (!sensor.isConnected) {
    return { success: false, error: `Sensor ${sensorId} not connected` }
  }

  if (isSensorRecording(sensor)) {
    return { success: false, error: `Sensor ${sensorId} already recording` }
  }

  try {
    let result: {
      success: boolean
      data?: any
      error?: string
    }

    // MODIFIED: Use dynamic backend type routing
    if (sensor.backendType === 'http') {
      // API recording logic (existing)
      result = await window.electronAPI.qsensorStartRecording(sensor.apiBaseUrl, {
        mission: params.mission,
        rate_hz: params.rateHz,
        roll_interval_s: params.rollIntervalS,
        schema_version: params.schemaVersion,
      })
      // ... rest of existing HTTP recording logic
    } else if (sensor.backendType === 'serial') {
      // Serial recording logic (existing)
      result = await window.electronAPI.qsensorSerialStartRecording({
        mission: params.mission,
        rateHz: params.rateHz || 1.0,
        rollIntervalS: params.rollIntervalS || 60,
        storagePath,
        unifiedSessionTimestamp: params.unifiedSessionTimestamp,
        syncId: params.syncId,
      })
      // ... rest of existing serial recording logic
    } else {
      return { success: false, error: `Unknown backend type: ${sensor.backendType}` }
    }

    // NEW: Include connection mode in session info
    if (result.success && sensor.currentSession) {
      sensor.currentSession.connectionMode = sensor.connectionMode
      sensor.currentSession.backendType = sensor.backendType
    }

    return { success: result.success, error: result.error }
  } catch (error: any) {
    sensor.lastError = error.message
    return { success: false, error: error.message }
  }
}
```

### 4.3 Session Management with Connection Modes

#### Updated startBoth Function
**File**: [`src/stores/qsensor.ts`](src/stores/qsensor.ts)

```typescript
async function startBoth(params: {
  mission: string
  rateHz?: number
  rollIntervalS?: number
}): Promise<{
  success: boolean
  errors: string[]
}> {
  const errors: string[] = []
  clearUnifiedSessionState()

  // NEW: Validate both sensors have connection modes selected
  const inWaterSensor = sensors.value.get('inWater')
  const surfaceSensor = sensors.value.get('surface')
  
  if (!inWaterSensor?.connectionMode || !inWaterSensor?.connectionModeExplicitlySet) {
    errors.push('In-water sensor: Connection mode must be selected')
  }
  
  if (!surfaceSensor?.connectionMode || !surfaceSensor?.connectionModeExplicitlySet) {
    errors.push('Surface sensor: Connection mode must be selected')
  }
  
  if (errors.length > 0) {
    return { success: false, errors }
  }

  // Generate unified session timestamp for shared directory structure
  const now = new Date()
  const unifiedSessionTimestamp = now.toISOString().replace(/[:.]/g, '-')
  const syncId = uuidv4()

  // Rest of existing startBoth logic...
  // This now works with dynamic backend types
}
```

### 4.4 Error Handling and Validation

#### Connection Mode Validation
**File**: [`src/stores/qsensor-common.ts`](src/stores/qsensor-common.ts)

```typescript
export function validateConnectionMode(state: QSensorState): string | null {
  if (!state.connectionMode) {
    return 'Connection mode must be selected'
  }
  
  if (!state.connectionModeExplicitlySet) {
    return 'Connection mode must be explicitly selected'
  }
  
  return null
}

export function canConnectSensor(state: QSensorState): boolean {
  return !!(state.connectionMode && 
           state.connectionModeExplicitlySet && 
           validateSensorConfig(state) === null)
}

export function canRecordSensor(state: QSensorState): boolean {
  return !!(state.isConnected && 
           state.connectionMode && 
           state.connectionModeExplicitlySet &&
           !isSensorRecording(state))
}
```

## 5. Phased Implementation Plan

### Phase 1 – Data Model Only

#### Goals
- Add connection mode fields to data structures
- Implement backend type dynamic assignment
- No UI changes yet, just wiring and defaults

#### Files to Change
1. **[`src/types/qsensor.ts`](src/types/qsensor.ts)**
   - Add `connectionMode` and `connectionModeExplicitlySet` to `QSensorState`
   - Add `connectionMode` and `backendType` to `QSensorSessionInfo`

2. **[`src/stores/qsensor-common.ts`](src/stores/qsensor-common.ts)**
   - Update `createInitialSensorState()` to accept null backend type initially
   - Add connection mode validation functions

3. **[`src/stores/qsensor.ts`](src/stores/qsensor.ts)**
   - Add `setConnectionMode()` and `resetConnectionMode()` functions
   - Update sensor initialization to use null backend type initially
   - Add connection mode validation to `connectSensor()` and `startRecordingSensor()`

#### High-Level Steps
1. Update type definitions with connection mode fields
2. Modify store initialization to start with null connection modes
3. Implement connection mode setter functions
4. Add validation logic for connection mode requirements
5. Update existing connection/recording functions to validate connection mode

#### Acceptance Criteria
- Store initializes with null connection modes for both sensors
- Connection mode can be set programmatically via store functions
- Connection and recording functions reject operations when connection mode is null
- All existing functionality continues to work when connection modes are set

#### Testing Strategy
- Unit tests for new store functions
- Integration tests for connection mode validation
- Backward compatibility tests with existing workflows

### Phase 2 – Basic UI Mode Selection

#### Goals
- Add dropdown controls for connection mode selection
- Lock connect/record buttons until mode is chosen
- Show mode in UI, but still use existing default pipelines under the hood

#### Files to Change
1. **New: [`src/components/qsensor/QSensorConnectionModeSelector.vue`](src/components/qsensor/QSensorConnectionModeSelector.vue)**
   - Create connection mode dropdown component
   - Add helper text and mode indicators
   - Handle mode selection events

2. **[`src/components/qsensor/QSensorConnectionControl.vue`](src/components/qsensor/QSensorConnectionControl.vue)**
   - Import and integrate connection mode selector
   - Disable connection fields until mode is selected
   - Add mode badge to connected state
   - Update button disabled states

3. **[`src/components/qsensor/QSensorRecordingControl.vue`](src/components/qsensor/QSensorRecordingControl.vue)**
   - Add connection mode warning when no mode selected
   - Disable recording controls until mode is selected
   - Show connection mode in session info

4. **[`src/stores/qsensor.ts`](src/stores/qsensor.ts)**
   - Expose `setConnectionMode()` function to components
   - Add computed properties for UI state

#### High-Level Steps
1. Create connection mode selector component
2. Integrate selector into connection control component
3. Update recording control with connection mode awareness
4. Add visual indicators for selected connection mode
5. Implement proper disabled states for all controls

#### Acceptance Criteria
- Connection mode dropdown appears for both sensors
- Connect button is disabled until connection mode is selected
- Recording controls are disabled until connection mode is selected
- Selected connection mode is clearly displayed in UI
- Helper text guides user when no mode is selected
- All existing functionality works when mode is selected

#### Testing Strategy
- UI component unit tests
- Integration tests for mode selection flow
- User interaction testing for disabled states
- Visual regression testing for new UI elements

### Phase 3 – Fully Routed Mode Behavior

#### Goals
- Connect/disconnect/start/stop flows branch on chosen mode
- Clean error handling and edge cases
- Full integration with existing backend services

#### Files to Change
1. **[`src/stores/qsensor.ts`](src/stores/qsensor.ts)**
   - Update `connectSensor()` to use dynamic backend routing
   - Update `startRecordingSensor()` to use dynamic backend routing
   - Update `startBoth()` to validate connection modes
   - Add error handling for invalid mode combinations

2. **[`src/components/qsensor/QSensorSessionControl.vue`](src/components/qsensor/QSensorSessionControl.vue)**
   - Add connection mode validation for unified session controls
   - Update error handling for mixed-mode scenarios

3. **Service Files** (minimal changes needed):
   - [`src/electron/services/qsensor-mirror.ts`](src/electron/services/qsensor-mirror.ts) - Add connection mode logging
   - [`src/electron/services/qsensor-serial-recording.ts`](src/electron/services/qsensor-serial-recording.ts) - Add connection mode logging

#### High-Level Steps
1. Update connection functions to dynamically route based on backend type
2. Update recording functions to use appropriate backend services
3. Add validation for unified session operations
4. Implement error handling for unsupported mode combinations
5. Add logging and debugging information for mode routing

#### Acceptance Criteria
- In-water sensor can connect via either API or Serial mode
- Surface sensor can connect via either API or Serial mode
- Connection attempts are properly routed to correct backend services
- Recording uses appropriate pipeline based on selected mode
- Clear error messages for unsupported combinations
- All existing dual-sensor workflows continue to work

#### Testing Strategy
- End-to-end testing for all mode combinations
- Backend routing verification tests
- Error handling tests for invalid combinations
- Dual-sensor recording tests with mixed modes
- Performance regression tests

## 6. Constraints & Style

### 6.1 Backward Compatibility
- Existing single-sensor workflows must continue to work
- Default behavior should match current system when modes are selected
- No breaking changes to existing API interfaces
- Legacy functions should maintain compatibility

### 6.2 Future Extensibility
- Connection mode enum should be easily extensible
- Backend routing should support new connection types
- UI components should be reusable for new modes
- Validation logic should be adaptable to new requirements

### 6.3 Error Handling
- Clear, user-friendly error messages for all failure modes
- Graceful degradation when connection modes are invalid
- Proper state cleanup when operations fail
- Consistent error reporting across all components

### 6.4 Performance Considerations
- Minimal overhead for connection mode validation
- Efficient state updates in Vue components
- Fast UI response for mode selection
- No impact on recording performance

### 6.5 Code Quality
- Follow existing TypeScript patterns and conventions
- Maintain consistent naming and structure
- Add comprehensive type safety for new features
- Include proper documentation for new functions

## 7. Risk Assessment

### 7.1 Technical Risks
- **Backend Compatibility**: Existing services may assume fixed backend types
  - *Mitigation*: Add logging and validation to catch assumptions
- **State Management Complexity**: Dynamic backend types may increase state complexity
  - *Mitigation*: Clear separation of concerns and comprehensive testing
- **UI State Synchronization**: Multiple components may have conflicting state
  - *Mitigation*: Centralized state management with proper reactivity

### 7.2 User Experience Risks
- **Confusion About Modes**: Users may not understand the difference between API and Serial
  - *Mitigation*: Clear helper text and tooltips in UI
- **Mode Selection Errors**: Users may select wrong mode for their setup
  - *Mitigation*: Validation and clear error messages
- **Workflow Disruption**: New requirement may disrupt existing workflows
  - *Mitigation*: Phased implementation with backward compatibility

### 7.3 Implementation Risks
- **Complexity Increase**: Dynamic routing may increase code complexity
  - *Mitigation*: Clear architecture and comprehensive testing
- **Testing Coverage**: New mode combinations may increase testing complexity
  - *Mitigation*: Systematic test matrix and automated testing
- **Documentation**: New features may not be properly documented
  - *Mitigation*: Inline documentation and user guides

## 8. Success Metrics

### 8.1 Functional Metrics
- 100% of existing workflows continue to work
- Connection mode selection works for both sensors
- All mode combinations route to correct backends
- Error handling covers all failure modes

### 8.2 User Experience Metrics
- Time to select connection mode: < 10 seconds
- Error rate for mode selection: < 5%
- User satisfaction score: > 4/5
- Support ticket reduction: < 10% of QSensor issues

### 8.3 Technical Metrics
- Code coverage: > 90% for new features
- Performance impact: < 5% overhead for validation
- Bug count: < 5 critical issues in first month
- Documentation completeness: 100% of new APIs documented

## 9. Conclusion

This plan provides a clean, incremental approach to adding per-sensor connection type selection while maintaining backward compatibility and ensuring future extensibility. The phased implementation allows for careful testing and validation at each stage, minimizing risk while delivering user value incrementally.

The key architectural decision is to make connection mode an explicit user choice rather than an implicit property of the sensor ID. This provides maximum flexibility for future experiments and different deployment scenarios while maintaining a clear, understandable user experience.

The design emphasizes minimal invasive changes to the existing codebase, leveraging the current dual-sensor architecture rather than replacing it. This approach reduces implementation risk and ensures that existing proven functionality remains intact.