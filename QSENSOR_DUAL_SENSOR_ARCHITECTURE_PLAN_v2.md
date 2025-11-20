# Q-Sensor Dual-Sensor Architecture Plan v2

**Date:** 2025-11-18
**Author:** Claude Code Analysis
**Version:** 2.0
**Status:** CORRECTED - Reflects Physical Constraints

---

## Critical Revision Notice

**This document supersedes v1.0** with corrected physical architecture constraints:

### NON-NEGOTIABLE REQUIREMENTS

1. **In-Water Sensor (Sensor A)**
   - Connected to Raspberry Pi on ROV
   - Controlled via existing Q_Sensor_API (HTTP/JSON on port 9150)
   - Timestamps from Pi system clock (NTP-synced)
   - **No changes to existing implementation**

2. **Surface Reference Sensor (Sensor B)**
   - **MUST be USB/serial connected directly to topside computer**
   - **CANNOT use Pi or BlueOS under any circumstances**
   - Protocol parsing, acquisition, and file writing done in Cockpit/Electron
   - Q-Series protocol **must be ported from Python to TypeScript**
   - Timestamps from Cockpit system clock (topside)

3. **Recording Synchronization**
   - Both sensors auto-start when video recording starts
   - Both sensors auto-stop when video recording stops
   - Timestamps must be aligned via metadata
   - Unified output directory structure

---

## Overview

This document provides a comprehensive architecture plan for extending the existing Q-Sensor integration in Cockpit to support **two simultaneous Q-Series instruments** with the corrected physical constraint that the surface sensor cannot connect to the Pi.

**Key Challenge:** The surface sensor requires direct serial communication from Cockpit, necessitating a TypeScript implementation of the Q-Series protocol parser (currently only exists in Python).

---

## Current State Analysis

### In-Water Sensor Architecture (PROVEN - No Changes)

**Current Data Flow:**
```
Cockpit Desktop (TypeScript)
    ↓ HTTP/JSON REST API (port 9150)
Q_Sensor_API (Python FastAPI on Pi)
    ↓ Serial Protocol Parsing (Python)
Q-Series In-Water Device (/dev/ttyUSB0, 9600 baud)
```

**Key Implementation Files:**
- `src/stores/qsensor.ts` (163 lines) - Pinia store managing state
- `src/libs/qsensor-client.ts` (212 lines) - HTTP client for Pi API
- `src/electron/services/qsensor-control.ts` (293 lines) - IPC proxy to API
- `src/electron/services/qsensor-mirror.ts` (618 lines) - Chunk download service
- `src/views/ToolsQSeriesView.vue` (674 lines) - Main UI

**API Endpoints Currently Used:**
```
POST /sensor/connect?port={path}&baud={rate}     → Connect to serial sensor
POST /sensor/start?poll_hz={rate}               → Start freerun acquisition
POST /record/start                               → Start chunked recording
  Body: { rate_hz, mission, roll_interval_s }
  Returns: { session_id, started_at, ... }
POST /record/stop                                → Stop recording
  Body: { session_id }
GET  /record/snapshots?session_id={id}           → List finalized chunks
GET  /files/{session_id}/{filename}              → Download chunk CSV
```

**CSV Output Format:**
```csv
timestamp,sensor_id,mode,value,TempC,Vin
2025-01-17T12:34:56.123456+00:00,SN12345,freerun,123.456789,21.34,12.345
```

**Timestamp Generation:** Python `datetime.now(timezone.utc)` at parse time (wall clock, microsecond precision)

**This pipeline is PROVEN and will remain unchanged.**

---

### Surface Sensor Architecture (NEW - Requires Implementation)

**Required Data Flow:**
```
Cockpit Desktop (TypeScript)
    ↓ Direct Serial Communication (USB/serial)
Q-Series Surface Device (/dev/ttyUSB1 or COM3, 9600 baud)
    ↑ TypeScript Protocol Parser (NEW)
    ↓ Local CSV Writer (NEW)
Local Storage (Combined with in-water data)
```

**Required Implementation:**

1. **TypeScript Q-Series Protocol Parser** (NEW)
   - Frame decoding and validation
   - CRC/checksum verification
   - State machine for menu navigation
   - Freerun vs polled mode handlers
   - Reading buffer management

2. **Electron Serial Service** (NEW)
   - SerialPort management using existing `serialport` library
   - Protocol state machine
   - Data buffering and CSV chunk writing
   - Session lifecycle management
   - IPC handlers for renderer communication

3. **Store Extension** (MODIFY)
   - Support two sensors with different backends (HTTP vs Serial)
   - Track sessions independently
   - Coordinate recording start/stop

4. **UI Updates** (MODIFY)
   - Dual-sensor panel layout
   - Connection method selection (HTTP vs Serial)
   - Unified session controls
   - Time sync status indicator

---

## Q-Series Protocol Analysis

### Protocol Complexity Assessment

Based on analysis of the Python implementation (Q_Sensor_API) and documentation:

**Protocol Characteristics:**

1. **Baud Rate:** 9600 bps (standard)

2. **Frame Structure:** (from documentation)
   ```
   $LITE<value>,<temp>,<voltage>\r\n
   ```
   Example: `$LITE123.456789,21.34,12.345\r\n`

3. **Acquisition Modes:**
   - **Freerun Mode:** Device continuously streams data
   - **Polled Mode:** Host requests readings on-demand

4. **Menu Navigation:** (at connection time)
   - Escape sequence to enter config menu
   - Command characters for mode selection
   - Menu state machine required

5. **State Machine:**
   ```
   DISCONNECTED
       ↓ (open serial)
   CONNECTED
       ↓ (send ESC)
   CONFIG_MENU
       ↓ (send command)
   ACQ_FREERUN / ACQ_POLLED
       ↓ (parse data stream)
   RECORDING
       ↓ (stop command)
   STOPPING
       ↓ (finalize files)
   DISCONNECTED
   ```

6. **Data Validation:**
   - Start marker: `$LITE`
   - End marker: `\r\n`
   - Comma-separated values
   - Optional CRC/checksum (implementation unclear)

7. **Error Handling:**
   - Serial port disconnect detection
   - Malformed frame rejection
   - Buffer overflow protection
   - Retry logic for commands

### Required TypeScript Components

**1. Protocol Parser** (`src/electron/services/qsensor-protocol.ts`)
   - Frame tokenizer (find start/end markers)
   - Field parser (split CSV, parse floats)
   - Validation logic
   - **Estimated:** 200-300 lines, 15-20 hours

**2. State Machine** (`src/electron/services/qsensor-serial-controller.ts`)
   - Connection lifecycle
   - Menu navigation sequences
   - Mode switching
   - **Estimated:** 300-400 lines, 20-25 hours

**3. Data Recorder** (`src/electron/services/qsensor-local-recorder.ts`)
   - Reading buffer
   - Chunked CSV writer (mimic Python implementation)
   - Atomic file operations (.tmp → .csv)
   - SHA256 checksum generation
   - Manifest.json generation
   - **Estimated:** 300-400 lines, 20-25 hours

**4. IPC Handlers** (integrate into existing files)
   - Connection management
   - Acquisition control
   - Recording lifecycle
   - Health monitoring
   - **Estimated:** 100-150 lines, 5-7 hours

**Total Protocol Porting Effort: 900-1250 lines, 60-77 hours**

### Reusable Infrastructure

**Already Available:**
- `serialport` library (v13.0.0) - installed and tested
- `src/electron/services/link/serial.ts` - serial port wrapper (162 lines)
- IPC architecture (preload.ts, electron.d.ts)
- CSV writing patterns (video recording metadata)
- File system operations (Node.js fs module)

**Reusability:** ~30% of serial infrastructure exists, 70% must be purpose-built for Q-Series protocol

---

## Time Synchronization Architecture

### Problem Statement

Three independent clocks must be aligned:

1. **Pi System Clock** (in-water sensor)
   - NTP-synced (assumed)
   - Generates UTC timestamps for in-water readings
   - Subject to NTP adjustments during recording

2. **Topside System Clock** (surface sensor)
   - May or may not be NTP-synced
   - Generates UTC timestamps for surface readings
   - Separate from Pi clock (potential drift)

3. **Video Recording Clock** (Cockpit)
   - Same as topside system clock
   - Marks start/stop of video files
   - Used to correlate sensor data with video frames

**Challenges:**
- Clock offset between Pi and topside (unknown magnitude)
- Clock drift over time (minutes to hours)
- NTP jumps during recording (can cause timestamp reversals)
- No monotonic clock tracking (wall clocks only)

### Proposed Time Sync Strategy

#### Phase 1: Metadata-Based Offset Tracking (MVP)

**At Recording Start:**

1. **Capture Timestamps:**
   ```typescript
   const recordingStartUtc = new Date().toISOString()  // Topside clock

   // Start in-water sensor
   const inWaterResponse = await qsensorApiClient.startRecord(...)
   const inWaterStartedAt = inWaterResponse.started_at  // Pi clock

   // Start surface sensor
   const surfaceStartedAt = new Date().toISOString()  // Topside clock
   ```

2. **Measure Clock Offset:**
   ```typescript
   // HTTP round-trip method for Pi offset
   async function measurePiClockOffset(apiBaseUrl: string): Promise<number> {
     const t0 = Date.now()  // Topside time before request
     const response = await fetch(`${apiBaseUrl}/instrument/health`)
     const data = await response.json()
     const t1 = Date.now()  // Topside time after request

     // Assume Pi timestamp is at midpoint of round-trip
     const tPi = new Date(data.timestamp).getTime()
     const tMidpoint = (t0 + t1) / 2

     return tPi - tMidpoint  // Offset in milliseconds
   }
   ```

3. **Write Sync Metadata:**
   ```json
   {
     "metadata_version": 1,
     "recording_started_topside_utc": "2025-11-18T12:00:00.123456+00:00",
     "video_file": "video_20251118_120000.webm",
     "sensors": {
       "in-water": {
         "session_id": "uuid-abc-123",
         "started_at_utc": "2025-11-18T12:00:00.456789+00:00",
         "sensor_id": "SN12345",
         "clock_source": "pi_system_clock",
         "hostname": "blueos.local",
         "estimated_offset_ms": 12.5,
         "offset_measurement_method": "http_roundtrip",
         "offset_uncertainty_ms": 5.0
       },
       "surface": {
         "session_id": "uuid-def-456",
         "started_at_utc": "2025-11-18T12:00:00.234567+00:00",
         "sensor_id": "SN67890",
         "clock_source": "topside_system_clock",
         "hostname": "LAPTOP-ABC",
         "estimated_offset_ms": 0.0,
         "offset_measurement_method": "same_clock"
       }
     },
     "warnings": []
   }
   ```

4. **Storage Location:**
   ```
   {storagePath}/
     {missionName}/
       session_20251118_120000/
         sync_metadata.json         ← Time sync info
         video_20251118_120000.webm
         in-water_uuid-abc-123/
           chunk_00000.csv
           session.csv
           manifest.json
         surface_uuid-def-456/
           chunk_00000.csv
           session.csv
           manifest.json
   ```

**Post-Processing Alignment:**

Downstream analysis script can align data using offset:

```python
import pandas as pd
import json

# Load metadata
with open('sync_metadata.json') as f:
    meta = json.load(f)

offset_ms = meta['sensors']['in-water']['estimated_offset_ms']

# Load data
df_inwater = pd.read_csv('in-water_uuid-abc-123/session.csv')
df_surface = pd.read_csv('surface_uuid-def-456/session.csv')

# Parse timestamps
df_inwater['timestamp'] = pd.to_datetime(df_inwater['timestamp'])
df_surface['timestamp'] = pd.to_datetime(df_surface['timestamp'])

# Apply offset to align clocks
df_inwater['timestamp'] -= pd.Timedelta(milliseconds=offset_ms)

# Merge on nearest timestamp
df_combined = pd.merge_asof(
    df_inwater.sort_values('timestamp'),
    df_surface.sort_values('timestamp'),
    on='timestamp',
    direction='nearest',
    tolerance=pd.Timedelta('100ms'),
    suffixes=('_inwater', '_surface')
)
```

#### Phase 2: Enhanced Timestamping (Future Enhancement)

**Add Monotonic Timestamps to CSV Schema:**

```csv
timestamp_utc,timestamp_monotonic_ns,sensor_id,mode,value,TempC,Vin
2025-11-18T12:00:01.000000+00:00,1234567890123456789,SN12345,freerun,123.45,21.3,12.34
```

**Implementation in Q_Sensor_API (Python):**
```python
import time
from datetime import datetime, timezone

reading = Reading(
    ts=datetime.now(timezone.utc),        # Wall clock (existing)
    ts_mono=time.monotonic_ns(),          # Monotonic clock (NEW)
    sensor_id=self._sensor_id,
    mode="freerun",
    data=data,
)
```

**Implementation in TypeScript (Surface Sensor):**
```typescript
interface QSeriesReading {
  timestamp_utc: string          // ISO 8601 wall clock
  timestamp_monotonic_ns: bigint // Monotonic clock (performance.now() * 1e6)
  sensor_id: string
  mode: 'freerun' | 'polled'
  value: number
  tempC?: number
  vin?: number
}

// At parse time
const reading: QSeriesReading = {
  timestamp_utc: new Date().toISOString(),
  timestamp_monotonic_ns: BigInt(Math.floor(performance.now() * 1e6)),
  // ... other fields
}
```

**Benefits:**
- Immune to NTP jumps (monotonic never goes backwards)
- Precise delta calculation between samples
- Can detect and flag wall clock adjustments
- Enables robust alignment even with clock drift

**Effort:** 3-4 hours API changes, schema version bump to 2

#### Phase 3: Active Clock Monitoring (Future Enhancement)

**Periodic Offset Re-Measurement:**

```typescript
// Every 60 seconds during recording
setInterval(async () => {
  const currentOffset = await measurePiClockOffset(apiBaseUrl)
  const initialOffset = metadata.sensors['in-water'].estimated_offset_ms
  const drift = Math.abs(currentOffset - initialOffset)

  if (drift > 50) {  // More than 50ms drift
    console.warn(`[Time Sync] Clock drift detected: ${drift}ms`)
    metadata.warnings.push({
      timestamp: new Date().toISOString(),
      type: 'clock_drift',
      severity: 'warning',
      message: `Clock offset changed by ${drift}ms`,
      initial_offset_ms: initialOffset,
      current_offset_ms: currentOffset
    })
  }
}, 60000)
```

**UI Indicator States:**
- 🟢 **Green "Synced"**: Offset < 50ms, stable
- 🟡 **Yellow "Warning"**: Offset 50-500ms or drift detected
- 🔴 **Red "Error"**: Offset > 500ms or NTP failure
- ⚪ **Gray "Unknown"**: Only one sensor active

**Effort:** 5-7 hours implementation + UI component

### MAVLink TIMESYNC Integration (Optional)

**Available Resource:** `src/libs/connection/m2r/dialects/ardupilotmega/TIMESYNC_DATA.ts`

**Concept:** Use MAVLink TIMESYNC messages to measure Pi-topside clock offset with sub-millisecond precision.

**Implementation:**
```typescript
// Send TIMESYNC request
const tc1 = BigInt(Date.now() * 1000000)  // Topside time in nanoseconds
mavlinkConnection.sendMessage({
  type: 'TIMESYNC',
  tc1,
  ts1: 0n
})

// Receive TIMESYNC response
mavlinkConnection.on('TIMESYNC', (msg) => {
  if (msg.tc1 === tc1 && msg.ts1 !== 0n) {
    const tc2 = BigInt(Date.now() * 1000000)
    const roundTripTime = tc2 - tc1
    const offset = msg.ts1 - tc1 - roundTripTime / 2n

    console.log(`MAVLink clock offset: ${Number(offset) / 1e6}ms`)
  }
})
```

**Pros:**
- Sub-millisecond precision
- Accounts for network latency
- Proven protocol (used by ArduPilot)

**Cons:**
- Requires MAVLink connection to ROV
- Not available for surface sensor (topside-only)
- Additional complexity

**Recommendation:** Phase 3 enhancement if HTTP round-trip precision insufficient

### Recommended Approach

**MVP (Implement First):**
1. ✅ HTTP round-trip offset measurement at recording start
2. ✅ Write `sync_metadata.json` with offsets and timestamps
3. ✅ UI indicator showing sync status (green/yellow/red)
4. ✅ Post-processing alignment documentation

**Phase 2 (If Needed):**
1. ⏱️ Add monotonic timestamps to CSV schema
2. ⏱️ Periodic offset drift monitoring
3. ⏱️ Warning alerts for large drift (>50ms)

**Phase 3 (Optional):**
1. 🔮 MAVLink TIMESYNC integration for precise Pi offset
2. 🔮 Real-time alignment preview in UI
3. 🔮 Automatic combined CSV export

---

## UI/UX Architecture

### Layout Design

**Main View: Side-by-Side Sensor Panels**

```
┌─────────────────────────────────────────────────────────────────┐
│ Q-Series Dual-Sensor Control                    [Settings] [?]  │
├─────────────────────────────────┬───────────────────────────────┤
│ IN-WATER SENSOR (ROV)           │ SURFACE REFERENCE (TOPSIDE)   │
├─────────────────────────────────┼───────────────────────────────┤
│ ● Connected (HTTP)              │ ○ Disconnected                │
│ Sensor ID: SN12345              │ Sensor ID: ---                │
│                                 │                               │
│ API: blueos.local:9150          │ Port: [/dev/ttyUSB1 ▼]        │
│ [Disconnect]                    │ Baud: [9600 ▼]                │
│                                 │ [Connect Serial]              │
│ ─────────────────────────────── │ ───────────────────────────── │
│ Acquisition: Running (500 Hz)   │ Acquisition: Stopped          │
│ Current: 123.456 (21.3°C)       │ Current: ---                  │
│ [Stop Acquisition]              │ [Start Acquisition]           │
│ ─────────────────────────────── │ ───────────────────────────── │
│ Recording: Active               │ Recording: Active             │
│ Session: abc-123                │ Session: def-456              │
│ Duration: 00:05:32              │ Duration: 00:05:32            │
│ Mirrored: 2.4 MB (5s ago)       │ Mirrored: 2.3 MB (4s ago)     │
│ ─────────────────────────────── │ ───────────────────────────── │
│ Health:                         │ Health:                       │
│   Temp: 21.3°C                  │   Temp: 22.1°C                │
│   Vin: 12.34V                   │   Vin: 12.28V                 │
│   Disk: 85% free                │   Local: 45% free             │
└─────────────────────────────────┴───────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ UNIFIED SESSION CONTROL                                          │
├─────────────────────────────────────────────────────────────────┤
│ Mission: [Hydrothermal Vent Survey______________]               │
│ Storage: [/Users/matt/qsensor_data/] [Browse]                   │
│                                                                  │
│ Status: ✓ Both sensors recording                                │
│ Time Sync: 🟢 Synced (offset: 12ms, drift: stable)              │
│ Video Link: ✓ Auto-start/stop enabled                           │
│                                                                  │
│ [🔴 Stop Both & Finalize]                                        │
└─────────────────────────────────────────────────────────────────┘
```

**Mobile/Tablet: Tabbed Interface**

```
┌─────────────────────────────────────────┐
│ [In-Water] [Surface] [Session]          │
├─────────────────────────────────────────┤
│ IN-WATER SENSOR                         │
│                                         │
│ ● Connected (HTTP)                      │
│ API: blueos.local:9150                  │
│ Sensor ID: SN12345                      │
│                                         │
│ [View Details]                          │
└─────────────────────────────────────────┘
```

### Component Breakdown

**New Components to Create:**

1. **QSensorPanel.vue** (~350 lines)
   ```vue
   <template>
     <v-card class="qsensor-panel">
       <v-card-title>
         {{ label }}
         <v-chip :color="connectionColor">{{ connectionStatus }}</v-chip>
       </v-card-title>

       <v-card-text>
         <!-- Connection Section -->
         <QSensorConnectionConfig
           :sensor-id="sensorId"
           :connection-type="connectionType"
           @connect="handleConnect"
           @disconnect="handleDisconnect"
         />

         <!-- Acquisition Section -->
         <QSensorAcquisitionControl
           :sensor-id="sensorId"
           :is-running="isAcquisitionRunning"
           :current-reading="currentReading"
           @start="handleStartAcquisition"
           @stop="handleStopAcquisition"
         />

         <!-- Recording Section -->
         <QSensorRecordingStatus
           :sensor-id="sensorId"
           :session-id="sessionId"
           :is-recording="isRecording"
           :bytes-mirrored="bytesMirrored"
           :last-sync="lastSync"
         />

         <!-- Health Section -->
         <QSensorHealthDisplay
           :health-data="healthData"
         />
       </v-card-text>
     </v-card>
   </template>

   <script setup lang="ts">
   const props = defineProps<{
     sensorId: 'in-water' | 'surface'
     label: string
   }>()

   const qsensorStore = useQSensorStore()
   const sensor = computed(() => qsensorStore.getSensor(props.sensorId))

   // Connection state
   const connectionType = computed(() => sensor.value?.connectionType ?? 'http')
   const connectionStatus = computed(() => sensor.value?.isConnected ? 'Connected' : 'Disconnected')
   const connectionColor = computed(() => sensor.value?.isConnected ? 'success' : 'error')

   // ... event handlers
   </script>
   ```

2. **QSensorSessionControls.vue** (~200 lines)
   ```vue
   <template>
     <v-card class="session-controls">
       <v-card-title>Unified Session Control</v-card-title>
       <v-card-text>
         <v-text-field
           v-model="missionName"
           label="Mission Name"
           hint="Applied to both sensors"
         />

         <v-text-field
           v-model="storagePath"
           label="Storage Path"
           readonly
         >
           <template #append>
             <v-btn icon @click="browsePath">
               <v-icon>mdi-folder-open</v-icon>
             </v-btn>
           </template>
         </v-text-field>

         <QSensorTimeSyncIndicator
           :offset-ms="timeSyncOffsetMs"
           :drift-status="timeSyncDrift"
         />

         <v-checkbox
           v-model="videoLinkEnabled"
           label="Auto-start/stop with video recording"
         />

         <v-btn
           v-if="!bothRecording"
           color="success"
           block
           @click="startBoth"
           :disabled="!bothConnected"
         >
           Start Both Sensors
         </v-btn>

         <v-btn
           v-else
           color="error"
           block
           @click="stopBoth"
         >
           Stop Both & Finalize
         </v-btn>
       </v-card-text>
     </v-card>
   </template>
   ```

3. **QSensorTimeSyncIndicator.vue** (~120 lines)
   ```vue
   <template>
     <v-alert
       :color="statusColor"
       :icon="statusIcon"
       density="compact"
     >
       <div class="d-flex align-center">
         <span class="font-weight-medium">Time Sync:</span>
         <span class="ml-2">{{ statusText }}</span>
         <v-tooltip location="bottom">
           <template #activator="{ props }">
             <v-icon v-bind="props" class="ml-2">mdi-information</v-icon>
           </template>
           <div class="text-caption">
             <div>Offset: {{ offsetMs }}ms</div>
             <div>Method: {{ method }}</div>
             <div>Last Check: {{ lastCheck }}</div>
             <div v-if="warnings.length">
               <v-divider class="my-1" />
               <div v-for="warning in warnings" :key="warning">
                 ⚠️ {{ warning }}
               </div>
             </div>
           </div>
         </v-tooltip>
       </div>
     </v-alert>
   </template>

   <script setup lang="ts">
   const props = defineProps<{
     offsetMs: number | null
     driftStatus: 'stable' | 'warning' | 'error' | 'unknown'
   }>()

   const statusColor = computed(() => {
     if (props.offsetMs === null) return 'grey'
     if (props.driftStatus === 'error') return 'error'
     if (props.driftStatus === 'warning') return 'warning'
     if (Math.abs(props.offsetMs) < 50) return 'success'
     return 'warning'
   })

   const statusIcon = computed(() => {
     const colorMap = {
       'grey': 'mdi-help-circle',
       'error': 'mdi-alert-circle',
       'warning': 'mdi-alert',
       'success': 'mdi-check-circle'
     }
     return colorMap[statusColor.value]
   })

   const statusText = computed(() => {
     if (props.offsetMs === null) return 'Unknown (start both sensors)'
     if (Math.abs(props.offsetMs) < 50) return `Synced (${props.offsetMs}ms)`
     return `Offset: ${props.offsetMs}ms`
   })
   </script>
   ```

4. **QSensorConnectionConfig.vue** (~180 lines)
   ```vue
   <template>
     <div class="connection-config">
       <v-select
         v-if="sensorId === 'surface'"
         v-model="connectionType"
         :items="connectionTypes"
         label="Connection Type"
         density="compact"
       />

       <!-- HTTP Connection (In-Water Sensor) -->
       <template v-if="connectionType === 'http'">
         <v-text-field
           v-model="apiBaseUrl"
           label="API Base URL"
           placeholder="http://blueos.local:9150"
           density="compact"
         />
       </template>

       <!-- Serial Connection (Surface Sensor) -->
       <template v-else-if="connectionType === 'serial'">
         <v-select
           v-model="serialPort"
           :items="availablePorts"
           label="Serial Port"
           density="compact"
           @focus="refreshPorts"
         >
           <template #item="{ item }">
             <v-list-item :title="item.value" :subtitle="item.subtitle" />
           </template>
         </v-select>

         <v-select
           v-model="baudRate"
           :items="baudRates"
           label="Baud Rate"
           density="compact"
         />
       </template>

       <v-btn
         v-if="!isConnected"
         color="primary"
         block
         @click="connect"
         :loading="isConnecting"
       >
         Connect
       </v-btn>
       <v-btn
         v-else
         color="error"
         block
         @click="disconnect"
       >
         Disconnect
       </v-btn>
     </div>
   </template>

   <script setup lang="ts">
   const props = defineProps<{
     sensorId: 'in-water' | 'surface'
   }>()

   const connectionTypes = [
     { title: 'HTTP API (Pi)', value: 'http' },
     { title: 'Serial Direct', value: 'serial' }
   ]

   const connectionType = ref(props.sensorId === 'in-water' ? 'http' : 'serial')

   const baudRates = [9600, 19200, 38400, 57600, 115200]
   const baudRate = ref(9600)

   const availablePorts = ref<Array<{value: string, subtitle: string}>>([])

   async function refreshPorts() {
     if (window.electronAPI?.serialListPorts) {
       const ports = await window.electronAPI.serialListPorts()
       availablePorts.value = ports.map(p => ({
         value: p.path,
         subtitle: p.manufacturer || 'Unknown device'
       }))
     }
   }

   onMounted(() => {
     if (connectionType.value === 'serial') {
       refreshPorts()
     }
   })
   </script>
   ```

**Files to Modify:**

1. **src/views/ToolsQSeriesView.vue**
   - Replace single-sensor UI with dual-panel layout
   - Add `QSensorPanel` components for each sensor
   - Add `QSensorSessionControls` component
   - Update event handlers to route by `sensorId`

2. **src/stores/qsensor.ts**
   - Replace single-sensor state with Map-based multi-sensor state
   - Add `sensorId` parameter to all methods
   - Track connection type per sensor (HTTP vs Serial)
   - Maintain backward compatibility where possible

3. **src/components/mini-widgets/MiniQSensorRecorder.vue**
   - Add `sensorId` prop
   - Show status for specific sensor OR both sensors in compact view

### Video Integration Updates

**Current Integration** (src/stores/video.ts:447-477):
```typescript
// When video recording starts
const recordResponse = await client.startRecord(...)
qsensorStore.arm(recordResponse.session_id, missionName, vehicleAddress)
await qsensorStore.start()
```

**Updated Integration** (support both sensors):
```typescript
// When video recording starts
const videoStartTime = new Date().toISOString()

// Start in-water sensor (Pi API)
const inWaterClient = new QSensorClient(`http://${vehicleAddress}:9150`)
const inWaterResponse = await inWaterClient.startRecord({
  rate_hz: 500,
  mission: missionName,
  roll_interval_s: 60,
})

qsensorInWaterStore.arm(inWaterResponse.session_id, missionName, vehicleAddress)
await qsensorInWaterStore.start()

// Start surface sensor (Serial)
const surfaceResponse = await window.electronAPI.qsensorSerialStartRecord({
  sensorId: 'surface',
  rate_hz: 500,
  mission: missionName,
  roll_interval_s: 60,
})

qsensorSurfaceStore.arm(surfaceResponse.session_id, missionName, 'localhost')
await qsensorSurfaceStore.start()

// Write sync metadata
await window.electronAPI.writeSyncMetadata({
  videoStartTime,
  inWaterSessionId: inWaterResponse.session_id,
  inWaterStartedAt: inWaterResponse.started_at,
  surfaceSessionId: surfaceResponse.session_id,
  surfaceStartedAt: surfaceResponse.started_at,
  missionName,
})
```

---

## Unified Output Architecture

### Directory Structure

**Recommended Layout:**
```
{storagePath}/
  {missionName}/
    session_20251118_120000/                ← Combined session directory
      sync_metadata.json                    ← Time sync info + video link
      video_20251118_120000.webm            ← Video file (linked)
      in-water_{sessionId}/                 ← In-water sensor data
        manifest.json                       ← Chunk metadata
        chunk_00000.csv                     ← Raw chunks (during recording)
        chunk_00001.csv
        session.csv                         ← Combined CSV (after finalization)
      surface_{sessionId}/                  ← Surface sensor data
        manifest.json
        chunk_00000.csv
        chunk_00001.csv
        session.csv
```

**Sync Metadata Schema:**
```json
{
  "metadata_version": 1,
  "session_name": "session_20251118_120000",
  "mission_name": "Hydrothermal Vent Survey",
  "recording_started_topside_utc": "2025-11-18T12:00:00.123456+00:00",
  "recording_stopped_topside_utc": "2025-11-18T12:15:32.789012+00:00",
  "duration_seconds": 932.665556,

  "video": {
    "filename": "video_20251118_120000.webm",
    "start_time_utc": "2025-11-18T12:00:00.123456+00:00",
    "stop_time_utc": "2025-11-18T12:15:32.789012+00:00",
    "duration_seconds": 932.665556,
    "codec": "vp9",
    "resolution": "1920x1080"
  },

  "sensors": {
    "in-water": {
      "session_id": "abc-123-def-456",
      "directory": "in-water_abc-123-def-456",
      "sensor_id": "SN12345",
      "started_at_utc": "2025-11-18T12:00:00.456789+00:00",
      "stopped_at_utc": "2025-11-18T12:15:32.987654+00:00",
      "total_rows": 466500,
      "clock_source": "pi_system_clock",
      "hostname": "blueos.local",
      "estimated_offset_ms": 12.5,
      "offset_uncertainty_ms": 5.0,
      "offset_measurement_method": "http_roundtrip",
      "schema_version": 1
    },
    "surface": {
      "session_id": "ghi-789-jkl-012",
      "directory": "surface_ghi-789-jkl-012",
      "sensor_id": "SN67890",
      "started_at_utc": "2025-11-18T12:00:00.234567+00:00",
      "stopped_at_utc": "2025-11-18T12:15:32.876543+00:00",
      "total_rows": 466550,
      "clock_source": "topside_system_clock",
      "hostname": "LAPTOP-ABC",
      "estimated_offset_ms": 0.0,
      "offset_uncertainty_ms": 0.0,
      "offset_measurement_method": "same_clock",
      "schema_version": 1
    }
  },

  "clock_sync": {
    "initial_offset_ms": 12.5,
    "final_offset_ms": 13.2,
    "drift_total_ms": 0.7,
    "drift_rate_ms_per_minute": 0.0008,
    "measurements": [
      {
        "timestamp_utc": "2025-11-18T12:00:00.123456+00:00",
        "offset_ms": 12.5,
        "method": "http_roundtrip"
      },
      {
        "timestamp_utc": "2025-11-18T12:05:00.234567+00:00",
        "offset_ms": 12.8,
        "method": "http_roundtrip"
      },
      {
        "timestamp_utc": "2025-11-18T12:10:00.345678+00:00",
        "offset_ms": 13.0,
        "method": "http_roundtrip"
      },
      {
        "timestamp_utc": "2025-11-18T12:15:32.789012+00:00",
        "offset_ms": 13.2,
        "method": "http_roundtrip"
      }
    ]
  },

  "warnings": [],
  "notes": "Recording completed successfully. Clock drift within acceptable range."
}
```

### File Operations

**Session Creation:**
```typescript
// src/electron/services/qsensor-session-manager.ts

interface UnifiedSession {
  sessionName: string
  missionName: string
  rootPath: string
  videoFile?: string
  inWaterSessionId?: string
  surfaceSessionId?: string
  startedAt: string
}

async function createUnifiedSession(
  missionName: string,
  storagePath: string
): Promise<UnifiedSession> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const sessionName = `session_${timestamp}`
  const rootPath = path.join(storagePath, missionName, sessionName)

  await fs.promises.mkdir(rootPath, { recursive: true })

  return {
    sessionName,
    missionName,
    rootPath,
    startedAt: new Date().toISOString()
  }
}
```

**Metadata Writing:**
```typescript
async function writeSyncMetadata(
  session: UnifiedSession,
  metadata: SyncMetadata
): Promise<void> {
  const metadataPath = path.join(session.rootPath, 'sync_metadata.json')
  const json = JSON.stringify(metadata, null, 2)

  // Atomic write
  const tmpPath = metadataPath + '.tmp'
  await fs.promises.writeFile(tmpPath, json, 'utf8')
  await fs.promises.rename(tmpPath, metadataPath)
}
```

**Session Finalization:**
```typescript
async function finalizeSession(session: UnifiedSession): Promise<void> {
  // 1. Wait for both sensors to finalize chunks
  await Promise.all([
    finalizeInWaterSensor(session.inWaterSessionId),
    finalizeSurfaceSensor(session.surfaceSessionId)
  ])

  // 2. Update sync metadata with final stats
  const metadata = await readSyncMetadata(session)
  metadata.recording_stopped_topside_utc = new Date().toISOString()
  metadata.duration_seconds =
    (new Date(metadata.recording_stopped_topside_utc).getTime() -
     new Date(metadata.recording_started_topside_utc).getTime()) / 1000

  // 3. Write final metadata
  await writeSyncMetadata(session, metadata)

  // 4. Generate combined CSV (optional)
  // await generateCombinedCSV(session)
}
```

---

## Implementation Plan

### Phase 0: Preparation & Safety (No Behavior Change)

**Goal:** Refactor existing code to support multi-sensor without breaking current functionality

**Tasks:**

1. **Extract Types** (1 hour)
   - Create `src/types/qsensor.ts`
   - Define interfaces: `SensorState`, `SensorConfig`, `SessionInfo`, `HealthData`, `SyncMetadata`
   - Move types from `qsensor.ts` to dedicated file

2. **Create Placeholder Stores** (2 hours)
   - Create `src/stores/qsensor-common.ts` - shared types and utilities
   - Keep existing `src/stores/qsensor.ts` as-is (will become in-water specific)
   - Verify no regressions

3. **Extract Reusable Components** (3 hours)
   - Create `src/components/qsensor/` directory
   - Extract connection UI into `QSensorConnectionConfig.vue` stub
   - Extract health display into `QSensorHealthDisplay.vue` stub
   - Test with existing UI (backward compatible)

**Testing:**
- [ ] Existing Q-Sensor functionality works unchanged
- [ ] No console errors
- [ ] Types compile correctly

**Estimated Time:** 6 hours

---

### Phase 1: TypeScript Protocol Parser

**Goal:** Implement Q-Series serial protocol parser in TypeScript

**Tasks:**

1. **Protocol Parser Core** (15-20 hours)
   - File: `src/electron/services/qsensor-protocol.ts` (NEW)
   - Frame tokenizer (find `$LITE` start marker, `\r\n` end marker)
   - CSV field parser (split by comma, parse floats)
   - Validation (check field count, range checks)
   - Unit tests for parser

   ```typescript
   interface QSeriesFrame {
     value: number
     tempC?: number
     vin?: number
     raw: string
   }

   class QSeriesProtocolParser {
     private buffer: string = ''

     feed(data: Buffer): QSeriesFrame[] {
       this.buffer += data.toString('ascii')
       const frames: QSeriesFrame[] = []

       while (true) {
         const startIdx = this.buffer.indexOf('$LITE')
         if (startIdx === -1) break

         const endIdx = this.buffer.indexOf('\r\n', startIdx)
         if (endIdx === -1) break

         const frameStr = this.buffer.slice(startIdx, endIdx + 2)
         this.buffer = this.buffer.slice(endIdx + 2)

         const frame = this.parseFrame(frameStr)
         if (frame) frames.push(frame)
       }

       // Trim buffer if too large (prevent memory leak)
       if (this.buffer.length > 1024) {
         this.buffer = this.buffer.slice(-512)
       }

       return frames
     }

     private parseFrame(frameStr: string): QSeriesFrame | null {
       // Remove $LITE prefix and \r\n suffix
       const dataStr = frameStr.slice(5, -2)
       const fields = dataStr.split(',')

       if (fields.length < 1) return null

       const value = parseFloat(fields[0])
       if (isNaN(value)) return null

       return {
         value,
         tempC: fields[1] ? parseFloat(fields[1]) : undefined,
         vin: fields[2] ? parseFloat(fields[2]) : undefined,
         raw: frameStr
       }
     }
   }
   ```

2. **State Machine** (20-25 hours)
   - File: `src/electron/services/qsensor-serial-controller.ts` (NEW)
   - Connection state management
   - Menu navigation (if required - needs device testing)
   - Freerun mode initialization
   - Acquisition control (start/stop)
   - Error handling and recovery

   ```typescript
   enum QSeriesState {
     DISCONNECTED = 'disconnected',
     CONNECTING = 'connecting',
     CONNECTED = 'connected',
     CONFIG_MENU = 'config_menu',
     ACQ_FREERUN = 'acq_freerun',
     STOPPING = 'stopping'
   }

   class QSeriesSerialController extends EventEmitter {
     private state: QSeriesState = QSeriesState.DISCONNECTED
     private serialPort: SerialPort | null = null
     private parser: QSeriesProtocolParser = new QSeriesProtocolParser()
     private sensorId: string | null = null

     async connect(portPath: string, baudRate: number): Promise<void> {
       this.state = QSeriesState.CONNECTING

       this.serialPort = new SerialPort({
         path: portPath,
         baudRate,
         autoOpen: false
       })

       this.serialPort.on('data', (data) => this.handleData(data))
       this.serialPort.on('error', (error) => this.handleError(error))
       this.serialPort.on('close', () => this.handleClose())

       await this.serialPort.open()
       this.state = QSeriesState.CONNECTED

       // Read sensor ID (send query command if needed)
       this.sensorId = await this.readSensorId()

       this.emit('connected', { sensorId: this.sensorId })
     }

     async startAcquisition(mode: 'freerun' | 'polled', rateHz: number): Promise<void> {
       if (this.state !== QSeriesState.CONNECTED) {
         throw new Error('Not connected')
       }

       // Send command to enter freerun mode
       // (exact command sequence needs device documentation)
       if (mode === 'freerun') {
         await this.enterFreerunMode(rateHz)
         this.state = QSeriesState.ACQ_FREERUN
       }
     }

     private handleData(data: Buffer): void {
       if (this.state !== QSeriesState.ACQ_FREERUN) return

       const frames = this.parser.feed(data)
       for (const frame of frames) {
         this.emit('reading', {
           timestamp_utc: new Date().toISOString(),
           timestamp_monotonic_ns: BigInt(Math.floor(performance.now() * 1e6)),
           sensor_id: this.sensorId!,
           mode: 'freerun',
           ...frame
         })
       }
     }

     // ... more methods
   }
   ```

3. **Unit Tests** (10-12 hours)
   - File: `tests/qsensor-protocol.test.ts`
   - Test frame parsing with valid/invalid data
   - Test buffer overflow handling
   - Test state machine transitions
   - Mock serial port for testing

**Testing:**
- [ ] Parser correctly decodes sample frames
- [ ] Invalid frames are rejected
- [ ] Buffer doesn't grow unbounded
- [ ] State machine transitions correctly
- [ ] Real device connection successful (hardware test)

**Estimated Time:** 45-57 hours (6-7 days)

---

### Phase 2: Local Data Recording

**Goal:** Write sensor data to local CSV files with chunking and mirroring

**Tasks:**

1. **Local Chunk Writer** (20-25 hours)
   - File: `src/electron/services/qsensor-local-recorder.ts` (NEW)
   - Reading buffer (in-memory queue)
   - Chunked CSV writer (mimic Python Q_Sensor_API behavior)
   - Atomic file operations (`.tmp` → `.csv`)
   - Manifest.json generation
   - SHA256 checksum calculation
   - Session lifecycle management

   ```typescript
   interface LocalRecordingSession {
     sessionId: string
     sensorId: string
     mission: string
     rateHz: number
     rollIntervalS: number
     rootPath: string
     startedAt: string
     currentChunkIndex: number
     totalRows: number
     readingBuffer: QSeriesReading[]
     flushIntervalId: NodeJS.Timeout | null
   }

   class QSeriesLocalRecorder {
     private sessions = new Map<string, LocalRecordingSession>()

     async startSession(params: {
       sensorId: string
       mission: string
       rateHz: number
       rollIntervalS: number
       storagePath: string
     }): Promise<{ session_id: string; started_at: string }> {
       const sessionId = uuidv4()
       const startedAt = new Date().toISOString()
       const rootPath = path.join(
         params.storagePath,
         params.mission,
         `surface_${sessionId}`
       )

       await fs.promises.mkdir(rootPath, { recursive: true })

       const session: LocalRecordingSession = {
         sessionId,
         sensorId: params.sensorId,
         mission: params.mission,
         rateHz: params.rateHz,
         rollIntervalS: params.rollIntervalS,
         rootPath,
         startedAt,
         currentChunkIndex: 0,
         totalRows: 0,
         readingBuffer: [],
         flushIntervalId: null
       }

       // Start periodic flush (every 200ms, matching Python implementation)
       session.flushIntervalId = setInterval(
         () => this.flushChunk(sessionId),
         200
       )

       this.sessions.set(sessionId, session)

       return { session_id: sessionId, started_at: startedAt }
     }

     addReading(sessionId: string, reading: QSeriesReading): void {
       const session = this.sessions.get(sessionId)
       if (!session) throw new Error(`Session not found: ${sessionId}`)

       session.readingBuffer.push(reading)
     }

     private async flushChunk(sessionId: string): Promise<void> {
       const session = this.sessions.get(sessionId)
       if (!session || session.readingBuffer.length === 0) return

       const chunkFilename = `chunk_${session.currentChunkIndex.toString().padStart(5, '0')}.csv`
       const chunkPath = path.join(session.rootPath, chunkFilename)
       const tmpPath = chunkPath + '.tmp'

       // Build CSV content
       const header = 'timestamp,sensor_id,mode,value,TempC,Vin\n'
       const rows = session.readingBuffer.map(r =>
         `${r.timestamp_utc},${r.sensor_id},${r.mode},${r.value},${r.tempC ?? ''},${r.vin ?? ''}`
       ).join('\n')

       const content = session.currentChunkIndex === 0
         ? header + rows
         : rows

       // Atomic write
       await fs.promises.writeFile(tmpPath, content, 'utf8')
       await fs.promises.rename(tmpPath, chunkPath)

       // Calculate checksum
       const checksum = await this.calculateSHA256(chunkPath)

       // Update manifest
       await this.updateManifest(session, chunkFilename, session.readingBuffer.length, checksum)

       // Update session state
       session.totalRows += session.readingBuffer.length
       session.currentChunkIndex++
       session.readingBuffer = []
     }

     private async calculateSHA256(filePath: string): Promise<string> {
       const fileBuffer = await fs.promises.readFile(filePath)
       const hashSum = crypto.createHash('sha256')
       hashSum.update(fileBuffer)
       return hashSum.digest('hex')
     }

     private async updateManifest(
       session: LocalRecordingSession,
       chunkFilename: string,
       rowCount: number,
       checksum: string
     ): Promise<void> {
       const manifestPath = path.join(session.rootPath, 'manifest.json')

       let manifest: any = {
         session_id: session.sessionId,
         started_at: session.startedAt,
         next_chunk_index: 0,
         total_rows: 0,
         chunks: []
       }

       // Load existing manifest if exists
       if (await fs.promises.access(manifestPath).then(() => true).catch(() => false)) {
         const content = await fs.promises.readFile(manifestPath, 'utf8')
         manifest = JSON.parse(content)
       }

       // Add new chunk
       manifest.chunks.push({
         index: session.currentChunkIndex,
         name: chunkFilename,
         rows: rowCount,
         sha256: checksum
       })

       manifest.next_chunk_index = session.currentChunkIndex + 1
       manifest.total_rows += rowCount

       // Atomic write
       const tmpPath = manifestPath + '.tmp'
       await fs.promises.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf8')
       await fs.promises.rename(tmpPath, manifestPath)
     }

     async stopSession(sessionId: string): Promise<void> {
       const session = this.sessions.get(sessionId)
       if (!session) throw new Error(`Session not found: ${sessionId}`)

       // Stop flush interval
       if (session.flushIntervalId) {
         clearInterval(session.flushIntervalId)
       }

       // Final flush
       await this.flushChunk(sessionId)

       // Combine chunks into session.csv
       await this.combineChunks(session)

       this.sessions.delete(sessionId)
     }

     private async combineChunks(session: LocalRecordingSession): Promise<void> {
       const manifestPath = path.join(session.rootPath, 'manifest.json')
       const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'))

       const sessionCsvPath = path.join(session.rootPath, 'session.csv')
       const writeStream = fs.createWriteStream(sessionCsvPath)

       // Write header
       writeStream.write('timestamp,sensor_id,mode,value,TempC,Vin\n')

       // Append all chunks
       for (const chunk of manifest.chunks) {
         const chunkPath = path.join(session.rootPath, chunk.name)
         const content = await fs.promises.readFile(chunkPath, 'utf8')
         const lines = content.split('\n')

         // Skip header line (first line of first chunk, or if chunk starts with "timestamp")
         const dataLines = lines[0].startsWith('timestamp') ? lines.slice(1) : lines

         for (const line of dataLines) {
           if (line.trim()) writeStream.write(line + '\n')
         }

         // Delete chunk file
         await fs.promises.unlink(chunkPath)
       }

       writeStream.end()

       await new Promise((resolve) => writeStream.on('finish', resolve))
     }
   }
   ```

2. **IPC Handlers** (5-7 hours)
   - File: `src/electron/main.ts` (add handlers)
   - File: `src/electron/preload.ts` (add IPC methods)
   - File: `src/types/electron.d.ts` (add type definitions)

   ```typescript
   // In main.ts
   ipcMain.handle('qsensor-serial:connect', async (event, { sensorId, port, baud }) => {
     const controller = getOrCreateSerialController(sensorId)
     await controller.connect(port, baud)
     return { success: true, sensorId: controller.getSensorId() }
   })

   ipcMain.handle('qsensor-serial:start-recording', async (event, params) => {
     const recorder = getOrCreateLocalRecorder(params.sensorId)
     const controller = getSerialController(params.sensorId)

     // Start recording session
     const session = await recorder.startSession(params)

     // Hook controller readings to recorder
     controller.on('reading', (reading) => {
       recorder.addReading(session.session_id, reading)
     })

     return session
   })

   // ... more handlers
   ```

3. **Testing** (8-10 hours)
   - Mock serial device (emit test frames)
   - Verify chunk creation and finalization
   - Test manifest generation
   - Verify checksum calculation
   - Test session.csv combination
   - Test with real device

**Testing:**
- [ ] Chunks written correctly (CSV format)
- [ ] Manifest.json accurate
- [ ] SHA256 checksums valid
- [ ] session.csv combines all chunks
- [ ] No data loss during recording
- [ ] Handles high data rates (500 Hz)

**Estimated Time:** 33-42 hours (4-5 days)

---

### Phase 3: Dual-Sensor Store & UI

**Goal:** Update stores and UI to support both sensors simultaneously

**Tasks:**

1. **Store Refactoring** (15-20 hours)
   - File: `src/stores/qsensor.ts` (MODIFY)
   - Replace single-sensor state with Map-based structure
   - Add `sensorId` parameter to all methods
   - Track connection type per sensor (HTTP vs Serial)
   - Coordinate unified recording sessions

   ```typescript
   // src/stores/qsensor.ts

   interface SensorState {
     connectionType: 'http' | 'serial'
     apiBaseUrl?: string  // For HTTP
     serialPort?: string  // For serial
     baudRate?: number    // For serial
     isConnected: boolean
     sensorId: string | null
     sessionId: string | null
     isRecording: boolean
     bytesMirrored: number
     lastSync: string | null
     lastError: string | null
     healthData: HealthData | null
   }

   export const useQSensorStore = defineStore('qsensor', () => {
     // Multi-sensor state
     const sensors = ref(new Map<string, SensorState>())

     // Initialize both sensors
     sensors.value.set('in-water', {
       connectionType: 'http',
       apiBaseUrl: 'http://blueos.local:9150',
       isConnected: false,
       sensorId: null,
       sessionId: null,
       isRecording: false,
       bytesMirrored: 0,
       lastSync: null,
       lastError: null,
       healthData: null
     })

     sensors.value.set('surface', {
       connectionType: 'serial',
       serialPort: '/dev/ttyUSB1',
       baudRate: 9600,
       isConnected: false,
       sensorId: null,
       sessionId: null,
       isRecording: false,
       bytesMirrored: 0,
       lastSync: null,
       lastError: null,
       healthData: null
     })

     // Unified session tracking
     const unifiedSessionId = ref<string | null>(null)
     const missionName = ref<string>('Cockpit')
     const timeSyncOffsetMs = ref<number | null>(null)
     const timeSyncDrift = ref<'stable' | 'warning' | 'error' | 'unknown'>('unknown')

     // Methods with sensorId parameter
     function getSensor(sensorId: string): SensorState | undefined {
       return sensors.value.get(sensorId)
     }

     async function connect(sensorId: string): Promise<void> {
       const sensor = sensors.value.get(sensorId)
       if (!sensor) throw new Error(`Unknown sensor: ${sensorId}`)

       try {
         if (sensor.connectionType === 'http') {
           await window.electronAPI.qsensorConnect(
             sensorId,
             sensor.apiBaseUrl!
           )
         } else {
           await window.electronAPI.qsensorSerialConnect(
             sensorId,
             sensor.serialPort!,
             sensor.baudRate!
           )
         }

         sensor.isConnected = true
         sensor.lastError = null
       } catch (error) {
         sensor.lastError = error.message
         throw error
       }
     }

     async function startRecording(sensorId: string): Promise<string> {
       const sensor = sensors.value.get(sensorId)
       if (!sensor || !sensor.isConnected) {
         throw new Error('Sensor not connected')
       }

       try {
         let response
         if (sensor.connectionType === 'http') {
           response = await window.electronAPI.qsensorStartRecord(
             sensorId,
             { rate_hz: 500, mission: missionName.value, roll_interval_s: 60 }
           )
         } else {
           response = await window.electronAPI.qsensorSerialStartRecord(
             sensorId,
             { rate_hz: 500, mission: missionName.value, roll_interval_s: 60 }
           )
         }

         sensor.sessionId = response.session_id
         sensor.isRecording = true

         // Start mirroring
         await window.electronAPI.qsensorStartMirror(
           sensorId,
           response.session_id,
           missionName.value,
           60  // cadence
         )

         return response.session_id
       } catch (error) {
         sensor.lastError = error.message
         throw error
       }
     }

     async function startBoth(): Promise<void> {
       // Start in-water sensor
       const inWaterSessionId = await startRecording('in-water')

       // Start surface sensor
       const surfaceSessionId = await startRecording('surface')

       // Measure clock offset
       await measureClockOffset()

       // Create unified session metadata
       const sessionId = await window.electronAPI.createUnifiedSession({
         missionName: missionName.value,
         inWaterSessionId,
         surfaceSessionId,
         timeSyncOffsetMs: timeSyncOffsetMs.value
       })

       unifiedSessionId.value = sessionId
     }

     async function stopBoth(): Promise<void> {
       // Stop both sensors
       await Promise.all([
         stopRecording('in-water'),
         stopRecording('surface')
       ])

       // Finalize unified session
       if (unifiedSessionId.value) {
         await window.electronAPI.finalizeUnifiedSession(unifiedSessionId.value)
         unifiedSessionId.value = null
       }
     }

     async function measureClockOffset(): Promise<void> {
       const sensor = sensors.value.get('in-water')
       if (!sensor || sensor.connectionType !== 'http') {
         timeSyncOffsetMs.value = null
         return
       }

       try {
         const offset = await window.electronAPI.measureClockOffset(sensor.apiBaseUrl!)
         timeSyncOffsetMs.value = offset

         // Determine drift status
         if (Math.abs(offset) < 50) {
           timeSyncDrift.value = 'stable'
         } else if (Math.abs(offset) < 500) {
           timeSyncDrift.value = 'warning'
         } else {
           timeSyncDrift.value = 'error'
         }
       } catch (error) {
         console.error('Failed to measure clock offset:', error)
         timeSyncOffsetMs.value = null
         timeSyncDrift.value = 'unknown'
       }
     }

     // ... more methods

     return {
       sensors,
       unifiedSessionId,
       missionName,
       timeSyncOffsetMs,
       timeSyncDrift,
       getSensor,
       connect,
       disconnect,
       startRecording,
       stopRecording,
       startBoth,
       stopBoth,
       measureClockOffset
     }
   })
   ```

2. **UI Component Implementation** (12-15 hours)
   - Implement `QSensorPanel.vue` (reusable panel for each sensor)
   - Implement `QSensorSessionControls.vue` (unified controls)
   - Implement `QSensorTimeSyncIndicator.vue` (sync status)
   - Implement `QSensorConnectionConfig.vue` (connection settings)

3. **Update Main View** (8-10 hours)
   - File: `src/views/ToolsQSeriesView.vue` (MODIFY)
   - Replace single-sensor UI with dual-panel layout
   - Add unified session controls
   - Update event handlers

   ```vue
   <template>
     <v-container fluid>
       <v-row>
         <v-col cols="12">
           <h1>Q-Series Dual-Sensor Control</h1>
         </v-col>
       </v-row>

       <!-- Dual Sensor Panels -->
       <v-row>
         <v-col cols="12" md="6">
           <QSensorPanel
             sensor-id="in-water"
             label="In-Water Sensor (ROV)"
           />
         </v-col>
         <v-col cols="12" md="6">
           <QSensorPanel
             sensor-id="surface"
             label="Surface Reference (Topside)"
           />
         </v-col>
       </v-row>

       <!-- Unified Session Controls -->
       <v-row>
         <v-col cols="12">
           <QSensorSessionControls />
         </v-col>
       </v-row>
     </v-container>
   </template>

   <script setup lang="ts">
   import QSensorPanel from '@/components/qsensor/QSensorPanel.vue'
   import QSensorSessionControls from '@/components/qsensor/QSensorSessionControls.vue'

   const qsensorStore = useQSensorStore()

   onMounted(() => {
     // Initialize sensors if needed
   })
   </script>
   ```

4. **Update Mini Widget** (3-4 hours)
   - File: `src/components/mini-widgets/MiniQSensorRecorder.vue` (MODIFY)
   - Show status for both sensors in compact view

**Testing:**
- [ ] Both sensor panels render correctly
- [ ] Connection works for HTTP (in-water)
- [ ] Connection works for Serial (surface)
- [ ] Unified "Start Both" button works
- [ ] Time sync indicator shows correct status
- [ ] Recording status updates in real-time
- [ ] Video integration triggers both sensors

**Estimated Time:** 38-49 hours (5-6 days)

---

### Phase 4: Time Sync & Unified Output

**Goal:** Implement clock offset measurement and unified session management

**Tasks:**

1. **Time Sync Service** (10-12 hours)
   - File: `src/electron/services/qsensor-timesync.ts` (NEW)
   - HTTP round-trip offset measurement
   - Periodic drift monitoring (optional)
   - Metadata generation

   ```typescript
   // src/electron/services/qsensor-timesync.ts

   export interface ClockOffsetMeasurement {
     timestamp_utc: string
     offset_ms: number
     uncertainty_ms: number
     method: 'http_roundtrip' | 'mavlink_timesync' | 'manual'
   }

   export class QSensorTimeSyncService {
     async measureHttpRoundtripOffset(apiBaseUrl: string): Promise<ClockOffsetMeasurement> {
       const measurements: number[] = []

       // Take 5 measurements and average
       for (let i = 0; i < 5; i++) {
         const t0 = Date.now()
         const response = await fetch(`${apiBaseUrl}/instrument/health`)
         const data = await response.json()
         const t1 = Date.now()

         // Assume API response includes timestamp
         const tPi = new Date(data.timestamp || data.started_at).getTime()
         const tMidpoint = (t0 + t1) / 2
         const offset = tPi - tMidpoint

         measurements.push(offset)

         // Small delay between measurements
         if (i < 4) await new Promise(resolve => setTimeout(resolve, 100))
       }

       // Calculate mean and standard deviation
       const mean = measurements.reduce((a, b) => a + b, 0) / measurements.length
       const variance = measurements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / measurements.length
       const stdDev = Math.sqrt(variance)

       return {
         timestamp_utc: new Date().toISOString(),
         offset_ms: mean,
         uncertainty_ms: stdDev * 2,  // 95% confidence interval
         method: 'http_roundtrip'
       }
     }

     async monitorDrift(
       apiBaseUrl: string,
       initialOffset: number,
       callback: (drift: number) => void
     ): Promise<NodeJS.Timeout> {
       const intervalId = setInterval(async () => {
         try {
           const measurement = await this.measureHttpRoundtripOffset(apiBaseUrl)
           const drift = Math.abs(measurement.offset_ms - initialOffset)
           callback(drift)
         } catch (error) {
           console.error('[Time Sync] Failed to measure drift:', error)
         }
       }, 60000)  // Every 60 seconds

       return intervalId
     }
   }
   ```

2. **Unified Session Manager** (12-15 hours)
   - File: `src/electron/services/qsensor-session-manager.ts` (NEW)
   - Create unified session directory
   - Write sync metadata
   - Link video file
   - Finalize combined session

   ```typescript
   // src/electron/services/qsensor-session-manager.ts

   export interface UnifiedSessionParams {
     missionName: string
     storagePath: string
     inWaterSessionId?: string
     surfaceSessionId?: string
     videoFile?: string
     timeSyncOffset?: ClockOffsetMeasurement
   }

   export class QSensorSessionManager {
     async createUnifiedSession(params: UnifiedSessionParams): Promise<string> {
       const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
       const sessionName = `session_${timestamp}`
       const sessionId = `unified_${uuidv4()}`
       const rootPath = path.join(params.storagePath, params.missionName, sessionName)

       await fs.promises.mkdir(rootPath, { recursive: true })

       const metadata: SyncMetadata = {
         metadata_version: 1,
         session_id: sessionId,
         session_name: sessionName,
         mission_name: params.missionName,
         recording_started_topside_utc: new Date().toISOString(),
         sensors: {},
         clock_sync: {
           measurements: []
         },
         warnings: [],
         notes: ''
       }

       if (params.inWaterSessionId) {
         metadata.sensors['in-water'] = {
           session_id: params.inWaterSessionId,
           directory: `in-water_${params.inWaterSessionId}`,
           clock_source: 'pi_system_clock',
           estimated_offset_ms: params.timeSyncOffset?.offset_ms ?? null,
           offset_uncertainty_ms: params.timeSyncOffset?.uncertainty_ms ?? null,
           offset_measurement_method: params.timeSyncOffset?.method ?? 'unknown'
         }
       }

       if (params.surfaceSessionId) {
         metadata.sensors['surface'] = {
           session_id: params.surfaceSessionId,
           directory: `surface_${params.surfaceSessionId}`,
           clock_source: 'topside_system_clock',
           estimated_offset_ms: 0,
           offset_uncertainty_ms: 0,
           offset_measurement_method: 'same_clock'
         }
       }

       if (params.videoFile) {
         metadata.video = {
           filename: path.basename(params.videoFile),
           start_time_utc: new Date().toISOString()
         }
       }

       if (params.timeSyncOffset) {
         metadata.clock_sync.initial_offset_ms = params.timeSyncOffset.offset_ms
         metadata.clock_sync.measurements.push(params.timeSyncOffset)
       }

       await this.writeSyncMetadata(rootPath, metadata)

       return sessionId
     }

     async updateSyncMetadata(
       sessionId: string,
       updates: Partial<SyncMetadata>
     ): Promise<void> {
       const metadata = await this.loadSyncMetadata(sessionId)
       Object.assign(metadata, updates)
       await this.writeSyncMetadata(metadata.rootPath, metadata)
     }

     async finalizeUnifiedSession(sessionId: string): Promise<void> {
       const metadata = await this.loadSyncMetadata(sessionId)

       metadata.recording_stopped_topside_utc = new Date().toISOString()

       if (metadata.recording_started_topside_utc) {
         const durationMs =
           new Date(metadata.recording_stopped_topside_utc).getTime() -
           new Date(metadata.recording_started_topside_utc).getTime()
         metadata.duration_seconds = durationMs / 1000
       }

       // Add final clock offset measurement
       if (metadata.sensors['in-water']) {
         const timeSyncService = new QSensorTimeSyncService()
         // Assume we have API URL stored somewhere
         const finalMeasurement = await timeSyncService.measureHttpRoundtripOffset(
           'http://blueos.local:9150'
         )
         metadata.clock_sync.final_offset_ms = finalMeasurement.offset_ms
         metadata.clock_sync.measurements.push(finalMeasurement)

         // Calculate drift
         if (metadata.clock_sync.initial_offset_ms !== undefined) {
           metadata.clock_sync.drift_total_ms =
             finalMeasurement.offset_ms - metadata.clock_sync.initial_offset_ms

           if (metadata.duration_seconds) {
             metadata.clock_sync.drift_rate_ms_per_minute =
               metadata.clock_sync.drift_total_ms / (metadata.duration_seconds / 60)
           }
         }
       }

       metadata.notes = 'Recording completed successfully.'

       await this.writeSyncMetadata(metadata.rootPath, metadata)
     }

     private async writeSyncMetadata(rootPath: string, metadata: SyncMetadata): Promise<void> {
       const metadataPath = path.join(rootPath, 'sync_metadata.json')
       const json = JSON.stringify(metadata, null, 2)

       const tmpPath = metadataPath + '.tmp'
       await fs.promises.writeFile(tmpPath, json, 'utf8')
       await fs.promises.rename(tmpPath, metadataPath)
     }
   }
   ```

3. **IPC Integration** (5-7 hours)
   - Add handlers for time sync methods
   - Add handlers for unified session management
   - Update preload and type definitions

4. **Testing** (8-10 hours)
   - Test offset measurement accuracy
   - Test unified session creation
   - Test metadata writing and finalization
   - Test with real hardware (both sensors recording)
   - Verify output directory structure

**Testing:**
- [ ] Clock offset measured correctly
- [ ] Unified session directory created
- [ ] sync_metadata.json written with correct structure
- [ ] Both sensor data directories present
- [ ] Video file linked in metadata
- [ ] Finalization completes successfully

**Estimated Time:** 35-44 hours (4-5 days)

---

### Phase 5: Video Integration Update

**Goal:** Update video recording to auto-start/stop both sensors

**Tasks:**

1. **Update Video Store** (8-10 hours)
   - File: `src/stores/video.ts` (MODIFY)
   - Replace single-sensor logic with dual-sensor
   - Create unified session at video start
   - Stop both sensors at video stop
   - Link video file in metadata

   ```typescript
   // In src/stores/video.ts

   const startRecording = async (streamName: string): Promise<void> => {
     // ... existing video setup code ...

     activeStreams.value[streamName]!.mediaRecorder!.start(1000)
     const videoStartTime = new Date().toISOString()

     // [UPDATED] Start both Q-Sensors
     if (window.electronAPI?.qsensorStartBoth) {
       try {
         const qsensorStore = useQSensorStore()
         const missionStore = useMissionStore()

         // Start both sensors and create unified session
         await qsensorStore.startBoth()

         console.log('[Q-Sensor] Both sensors started and recording')
       } catch (error) {
         // Q-Sensors unavailable - log and continue with video only
         console.warn('[Q-Sensor] Failed to start dual sensors (may be offline):', error)
       }
     }
   }

   const stopRecording = (streamName: string): void => {
     // ... video teardown code ...

     // [UPDATED] Stop both Q-Sensors
     if (window.electronAPI?.qsensorStopBoth) {
       const qsensorStore = useQSensorStore()

       if (qsensorStore.unifiedSessionId) {
         void qsensorStore.stopBoth().catch((error) => {
           console.warn('[Q-Sensor] Error stopping dual sensors:', error)
         })
       }
     }

     activeStreams.value[streamName]!.mediaRecorder!.stop()
   }
   ```

2. **Testing** (4-5 hours)
   - Test video recording triggers both sensors
   - Test video stop triggers both sensors
   - Verify timing alignment
   - Test failure scenarios (one sensor offline)

**Testing:**
- [ ] Video start triggers both sensors
- [ ] Video stop triggers both sensors
- [ ] Metadata links video to sensor data
- [ ] Works if only one sensor connected
- [ ] Works if no sensors connected

**Estimated Time:** 12-15 hours (1-2 days)

---

### Phase 6: Testing & Validation

**Goal:** Comprehensive end-to-end testing of dual-sensor system

**Test Cases:**

1. **Connection Tests** (4 hours)
   - [ ] Connect in-water sensor (HTTP)
   - [ ] Connect surface sensor (Serial)
   - [ ] Connect both simultaneously
   - [ ] Disconnect one during recording
   - [ ] Reconnect after disconnect
   - [ ] Handle connection failures
   - [ ] Test with wrong serial port
   - [ ] Test with wrong baud rate

2. **Acquisition Tests** (4 hours)
   - [ ] Start acquisition on in-water sensor
   - [ ] Start acquisition on surface sensor
   - [ ] Start both simultaneously
   - [ ] Stop one while other continues
   - [ ] Verify live readings displayed
   - [ ] Check sample rates (500 Hz expected)
   - [ ] Test with different sample rates

3. **Recording Tests** (6 hours)
   - [ ] Start recording on in-water only
   - [ ] Start recording on surface only
   - [ ] Start recording on both (unified)
   - [ ] Stop recording on both
   - [ ] Verify chunks written correctly
   - [ ] Verify session.csv created
   - [ ] Verify row counts accurate
   - [ ] Verify SHA256 checksums
   - [ ] Test long recordings (>30 minutes)
   - [ ] Test rapid start/stop cycles

4. **Time Sync Tests** (4 hours)
   - [ ] Measure clock offset (HTTP)
   - [ ] Verify offset displayed in UI
   - [ ] Test with large manual offset
   - [ ] Verify warning shown for large offset
   - [ ] Test drift monitoring
   - [ ] Verify metadata contains offset

5. **Video Integration Tests** (4 hours)
   - [ ] Start video → both sensors auto-start
   - [ ] Stop video → both sensors auto-stop
   - [ ] Verify metadata links video + sensors
   - [ ] Test with one sensor offline
   - [ ] Test with both sensors offline

6. **Data Validation** (6 hours)
   - [ ] Load CSVs in pandas
   - [ ] Verify timestamp format (ISO 8601)
   - [ ] Check data continuity (no gaps)
   - [ ] Align data using offset from metadata
   - [ ] Verify merged data quality
   - [ ] Test post-processing script
   - [ ] Check for duplicate timestamps

7. **Edge Cases** (6 hours)
   - [ ] Disk full on topside
   - [ ] Network failure during recording (in-water sensor)
   - [ ] Serial port disconnect during recording
   - [ ] NTP jump during recording
   - [ ] Very high data rate (1000 Hz)
   - [ ] Multiple start/stop cycles
   - [ ] Resume after Cockpit crash

8. **Performance Tests** (3 hours)
   - [ ] CPU usage during dual recording
   - [ ] Memory usage over long recording
   - [ ] Disk I/O bandwidth
   - [ ] UI responsiveness during recording

**Estimated Time:** 37 hours (4-5 days)

---

## Implementation Summary

### Total Effort Estimate

| Phase | Description | Estimated Time |
|-------|-------------|---------------|
| **Phase 0** | Preparation & Safety | 6 hours |
| **Phase 1** | TypeScript Protocol Parser | 45-57 hours |
| **Phase 2** | Local Data Recording | 33-42 hours |
| **Phase 3** | Dual-Sensor Store & UI | 38-49 hours |
| **Phase 4** | Time Sync & Unified Output | 35-44 hours |
| **Phase 5** | Video Integration Update | 12-15 hours |
| **Phase 6** | Testing & Validation | 37 hours |
| **TOTAL** | | **206-250 hours** |

**Timeline: 26-31 working days (5-6 weeks at 8 hours/day)**

### Files to Create

**Services (Electron Main Process):**
- `src/electron/services/qsensor-protocol.ts` (~300 lines)
- `src/electron/services/qsensor-serial-controller.ts` (~400 lines)
- `src/electron/services/qsensor-local-recorder.ts` (~400 lines)
- `src/electron/services/qsensor-timesync.ts` (~150 lines)
- `src/electron/services/qsensor-session-manager.ts` (~300 lines)

**Components (Vue):**
- `src/components/qsensor/QSensorPanel.vue` (~350 lines)
- `src/components/qsensor/QSensorSessionControls.vue` (~200 lines)
- `src/components/qsensor/QSensorTimeSyncIndicator.vue` (~120 lines)
- `src/components/qsensor/QSensorConnectionConfig.vue` (~180 lines)
- `src/components/qsensor/QSensorHealthDisplay.vue` (~100 lines)
- `src/components/qsensor/QSensorAcquisitionControl.vue` (~150 lines)
- `src/components/qsensor/QSensorRecordingStatus.vue` (~150 lines)

**Types:**
- `src/types/qsensor.ts` (~200 lines)

**Tests:**
- `tests/qsensor-protocol.test.ts` (~300 lines)
- `tests/qsensor-local-recorder.test.ts` (~200 lines)

**Total: 15 new files, ~3400 lines of code**

### Files to Modify

**Stores:**
- `src/stores/qsensor.ts` (major refactor, +300 lines)
- `src/stores/video.ts` (+50 lines)

**Views:**
- `src/views/ToolsQSeriesView.vue` (major refactor, +200 lines)

**Components:**
- `src/components/mini-widgets/MiniQSensorRecorder.vue` (+50 lines)

**IPC:**
- `src/electron/main.ts` (+200 lines for handlers)
- `src/electron/preload.ts` (+100 lines)
- `src/types/electron.d.ts` (+150 lines)

**Total: 7 modified files, ~1050 lines added/changed**

---

## Risks & Mitigations

### Technical Risks

**1. Q-Series Protocol Complexity** (HIGH)
- **Risk:** Protocol may have undocumented edge cases or complex state machines
- **Impact:** Parsing failures, data loss, incorrect readings
- **Mitigation:**
  - Early hardware testing (Phase 1)
  - Keep Python Q_Sensor_API as reference
  - Implement comprehensive logging
  - Add protocol analyzer debug mode
  - Port unit tests from Python to TypeScript
- **Contingency:** If protocol too complex, keep surface sensor on separate laptop running Python API

**2. Clock Synchronization Accuracy** (MEDIUM)
- **Risk:** Clock offset >100ms or significant drift over time
- **Impact:** Data misalignment, unusable combined dataset
- **Mitigation:**
  - Measure offset multiple times and average
  - Monitor drift during recording
  - Add warnings to metadata if drift detected
  - Implement monotonic timestamps (Phase 2)
  - Provide post-processing alignment tools
- **Contingency:** Accept coarse alignment (±100ms) for MVP, refine later

**3. Serial Port Reliability** (MEDIUM)
- **Risk:** Serial disconnect, buffer overflow, frame corruption
- **Impact:** Recording stops, data loss
- **Mitigation:**
  - Implement robust error handling
  - Auto-reconnect on disconnect
  - Buffer overflow protection (ring buffer)
  - Frame validation and rejection
  - Log all errors to file for debugging
- **Contingency:** Add "resume recording" feature to recover from failures

**4. High CPU/Memory Usage** (LOW-MEDIUM)
- **Risk:** Two sensors + video recording overwhelm system resources
- **Impact:** Frame drops, UI lag, system instability
- **Mitigation:**
  - Profile performance early (Phase 3)
  - Use efficient data structures (ring buffers, typed arrays)
  - Offload heavy work to worker threads if needed
  - Implement backpressure (pause acquisition if buffer full)
- **Contingency:** Reduce sample rate or chunk writing frequency

**5. TypeScript Protocol Bugs** (MEDIUM)
- **Risk:** Parser bugs cause silent data corruption
- **Impact:** Invalid data, incorrect readings, analysis failures
- **Mitigation:**
  - Extensive unit tests with known-good data
  - Cross-validate with Python parser output
  - Add data sanity checks (range validation)
  - Implement checksum verification
  - Log raw frames for debugging
- **Contingency:** Record raw serial data alongside parsed CSV for re-parsing

### UX Risks

**6. UI Complexity** (MEDIUM)
- **Risk:** Dual-sensor UI overwhelms users
- **Impact:** User confusion, incorrect configuration, missed recordings
- **Mitigation:**
  - Clear visual separation (color-coded panels)
  - Tooltips and help text
  - "Quick Start" mode with sensible defaults
  - Video tutorials/documentation
- **Contingency:** Add "Simple Mode" that hides advanced controls

**7. Time Sync Confusion** (LOW-MEDIUM)
- **Risk:** Users don't understand clock offset indicator
- **Impact:** Incorrect interpretation of data alignment
- **Mitigation:**
  - Clear documentation in UI
  - Visual examples of good/bad sync
  - Link to troubleshooting guide
  - Automatic warnings for large offsets
- **Contingency:** Hide technical details, show simplified "Good/Warning/Bad" status

### Operational Risks

**8. Hardware Availability for Testing** (MEDIUM)
- **Risk:** Can't test with real Q-Series devices
- **Impact:** Delayed testing, bugs discovered in field
- **Mitigation:**
  - Create serial device simulator for testing
  - Use mock data from Python API
  - Test parser with recorded serial data
- **Contingency:** Ship beta version to users with hardware for field testing

**9. Breaking Existing Functionality** (LOW-MEDIUM)
- **Risk:** Refactoring breaks existing single-sensor workflow
- **Impact:** Regression, loss of working features
- **Mitigation:**
  - Incremental refactoring (Phase 0)
  - Maintain backward compatibility where possible
  - Comprehensive regression testing
  - Feature flags to enable/disable dual-sensor mode
- **Contingency:** Maintain separate code branch for single-sensor if needed

**10. Deployment Complexity** (LOW)
- **Risk:** Updated Cockpit requires Pi API changes (for enhanced timestamps)
- **Impact:** Version compatibility issues
- **Mitigation:**
  - Make enhanced features optional (graceful degradation)
  - Version negotiation in API
  - Clear documentation of requirements
- **Contingency:** Support both schema versions (v1 and v2)

---

## Open Questions

**Q1: What is the exact Q-Series protocol specification?**
- **Status:** Partially documented, needs device testing
- **Action:** Obtain protocol documentation from manufacturer or reverse-engineer
- **Decision:** Can start implementation with known frame format, refine during testing

**Q2: Should surface sensor support polled mode or freerun only?**
- **Impact:** Affects parser complexity
- **Recommendation:** Start with freerun only (simpler), add polled mode if needed
- **Decision Needed:** Check user requirements

**Q3: What is acceptable clock offset for users?**
- **Impact:** Determines warning thresholds in UI
- **Recommendation:** <50ms = good, 50-500ms = warning, >500ms = error
- **Decision Needed:** Validate with domain experts

**Q4: Should Cockpit auto-start both sensors or require manual control?**
- **Impact:** UX design (automatic vs manual workflow)
- **Recommendation:** Provide both options via settings toggle
- **Decision Needed:** User preference survey

**Q5: How to handle sensor failures during recording?**
- **Options:**
  - A: Stop both sensors (safe, but loses good data)
  - B: Continue other sensor, alert user (recommended)
  - C: Auto-reconnect and resume
- **Recommendation:** Option B for MVP, add C in future
- **Decision Needed:** User acceptance testing

**Q6: Should we provide real-time aligned data view?**
- **Impact:** Significant additional complexity
- **Recommendation:** Not for MVP, post-processing is sufficient
- **Decision Needed:** Defer to future enhancement

**Q7: What video formats should be linked in metadata?**
- **Status:** Currently WebM, may support MP4/H.264
- **Recommendation:** Support any format, store codec info in metadata
- **Decision Needed:** None, implement generically

**Q8: Should we support >2 sensors in future?**
- **Impact:** Architecture extensibility
- **Recommendation:** Design for N sensors, test with 2
- **Decision Needed:** None, implement generically from start

---

## Dependencies & Prerequisites

### Software Dependencies

**Already Installed:**
- Node.js (18+)
- Electron
- `serialport` v13.0.0
- Vue 3 + Pinia
- TypeScript

**No New Dependencies Required**

### Hardware Requirements

**Development:**
- Two Q-Series sensors (or one sensor + simulator)
- USB-to-serial adapters if needed
- ROV with Raspberry Pi (for in-water sensor testing)

**Deployment:**
- Cockpit-capable topside computer (Windows/macOS/Linux)
- USB port for surface sensor
- Network connection to ROV Pi

### External Systems

**Q_Sensor_API (Python):**
- Running on ROV Pi (port 9150)
- No changes required for MVP
- Optional enhancement: Add `/version` endpoint with timestamp
- Future: Support schema version 2 with monotonic timestamps

**BlueOS:**
- No changes required
- Q_Sensor_API registered as BlueOS extension

---

## Success Criteria

### Phase Completion Criteria

**Phase 0:** Refactoring complete, no regressions
**Phase 1:** Protocol parser decodes test data correctly, passes hardware test
**Phase 2:** Local recording creates valid CSV chunks, passes checksum validation
**Phase 3:** UI shows both sensors, can control independently
**Phase 4:** Time sync measured and displayed, unified session created
**Phase 5:** Video recording triggers both sensors automatically
**Phase 6:** All test cases pass, system stable under load

### MVP Definition

**Minimum Viable Product includes:**
- ✅ Connect to in-water sensor (Pi API)
- ✅ Connect to surface sensor (direct serial)
- ✅ Start/stop acquisition on both
- ✅ Record data to local CSV chunks
- ✅ Unified session directory structure
- ✅ Time sync metadata (offset measurement)
- ✅ Video integration (auto-start/stop)
- ✅ Basic UI for both sensors
- ✅ Time sync indicator in UI

**MVP does NOT include:**
- Real-time aligned data view
- Automatic combined CSV export
- MAVLink TIMESYNC integration
- Monotonic timestamps
- Advanced drift monitoring
- Multi-language support

### User Acceptance Criteria

**System is ready for deployment when:**
1. Users can connect both sensors without confusion
2. Recording starts automatically with video
3. Data files are valid and loadable in analysis tools
4. Time sync offset is documented in metadata
5. System handles sensor failures gracefully
6. UI responds quickly during dual recording
7. Documentation is complete (setup, troubleshooting, post-processing)

---

## Post-MVP Enhancements

### Short-Term (Next 3-6 months)

1. **Monotonic Timestamps** (3-4 hours)
   - Add `timestamp_monotonic_ns` column to CSV
   - Immune to NTP jumps
   - Enables precise alignment

2. **Advanced Drift Monitoring** (5-7 hours)
   - Periodic offset re-measurement during recording
   - Alert on significant drift (>50ms)
   - Log drift history in metadata

3. **Auto-Reconnect** (8-10 hours)
   - Detect serial disconnect
   - Attempt reconnection
   - Resume recording seamlessly

4. **Combined CSV Export** (10-12 hours)
   - One-click export of aligned data
   - Resampled to common time base
   - Interpolation of missing values

5. **Quick Start Wizard** (8-10 hours)
   - Guided setup for new users
   - Auto-detect serial ports
   - Test connection before recording

### Long-Term (6-12 months)

6. **MAVLink TIMESYNC Integration** (15-20 hours)
   - Sub-millisecond clock sync with ROV
   - Continuous sync monitoring
   - Fallback to HTTP round-trip

7. **Real-Time Aligned View** (30-40 hours)
   - Live chart showing both sensors
   - Time-aligned overlay
   - Zoom and pan controls

8. **Multi-Sensor Support (>2)** (20-30 hours)
   - Dynamic sensor list
   - Add/remove sensors at runtime
   - N-way time synchronization

9. **Advanced Post-Processing** (40-50 hours)
   - Built-in alignment tool
   - Outlier detection
   - Data quality metrics
   - Export to HDF5/Parquet

10. **Mobile Optimization** (20-30 hours)
    - Responsive layout for tablets
    - Touch-optimized controls
    - Simplified UI for small screens

---

## Documentation Plan

### Developer Documentation

1. **Architecture Guide** (this document)
2. **Protocol Implementation Guide**
   - Q-Series frame format
   - State machine diagrams
   - Error handling patterns
3. **API Reference**
   - Store methods
   - IPC handlers
   - Component props/events
4. **Testing Guide**
   - Running unit tests
   - Hardware test setup
   - Debugging tips

### User Documentation

1. **Setup Guide**
   - Hardware connection
   - Software installation
   - Configuration walkthrough
2. **User Manual**
   - Connecting sensors
   - Starting/stopping recording
   - Interpreting time sync status
3. **Troubleshooting Guide**
   - Common errors and solutions
   - Serial port issues
   - Clock sync problems
4. **Data Analysis Guide**
   - Loading CSV files
   - Applying time offset
   - Merging datasets
   - Python example scripts

---

## Conclusion

This updated architecture plan reflects the **correct physical constraint** that the surface reference sensor must connect directly to the topside computer. This necessitates a TypeScript implementation of the Q-Series protocol parser, significantly increasing implementation complexity compared to the v1 plan.

### Key Differences from v1:

1. **No Dual Pi API Option** - Surface sensor cannot use Pi under any circumstances
2. **Protocol Porting Required** - Full Q-Series parser must be implemented in TypeScript (~900-1250 lines)
3. **Increased Effort** - 206-250 hours (26-31 days) vs 43-55 hours in v1
4. **Different Time Sync Challenges** - Two independent clocks (Pi vs topside) instead of both on Pi
5. **More Complex Testing** - Serial protocol testing added to validation requirements

### Recommended Approach:

1. **Phase 1 Priority:** Validate protocol parser early with real hardware
2. **Incremental Deployment:** Test each phase thoroughly before proceeding
3. **Fallback Plan:** If protocol too complex, temporarily use separate laptop with Python API for surface sensor
4. **Risk Mitigation:** Extensive logging, error handling, and monitoring throughout

### Next Steps:

1. ✅ Review and approve this updated plan
2. ✅ Obtain Q-Series protocol documentation
3. ✅ Set up development environment with test hardware
4. ✅ Begin Phase 0 (preparation and safety refactoring)
5. ✅ Proceed incrementally through phases with testing at each stage

---

**End of Architecture Plan v2.0**
