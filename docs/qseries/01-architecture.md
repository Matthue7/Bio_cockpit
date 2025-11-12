# Q-Series Live-Mirroring Architecture

## Overview

This document describes the architecture for integrating Q-Series sensor data recording into Cockpit with **live continuous mirroring** to the topside computer. The design ensures that if power or tether fails mid-mission, the topside already has nearly all recorded data.

## Architecture Decision

**Chosen Approach**: **Extension Boundary with Live Chunk Pull**

- Q_Sensor_API remains a BlueOS extension (Docker container, port 9150)
- Exposes REST API + Server-Sent Events (SSE)
- Cockpit Electron service polls for new chunks and downloads them continuously
- No reliance on end-of-recording export

## Justification from Code Inspection

### Cockpit Patterns Observed

1. **Electron Background Services** (`Bio_cockpit/src/electron/main.ts:83-90`):
   ```typescript
   setupFilesystemStorage()
   setupNetworkService()
   setupResourceMonitoringService()
   setupSystemInfoService()
   setupUserAgentService()
   setupWorkspaceService()
   setupJoystickMonitoring()
   setupVideoRecordingService()
   ```
   - Cockpit already uses background services with periodic polling
   - Pattern: `setInterval()` in main process, IPC to renderer

2. **Chunk-Based Processing** (`Bio_cockpit/src/libs/live-video-processor.ts:85-96`):
   ```typescript
   async addChunk(chunkBlob: Blob, chunkNumber: number): Promise<void> {
     this.chunkQueue.push({ blob: chunkBlob, chunkNumber })
     await this.processQueuedChunks()
   }
   ```
   - Video recording already uses chunk queue pattern
   - Chunks processed sequentially with error handling

3. **Electron Storage** (`Bio_cockpit/src/electron/services/storage.ts`):
   ```typescript
   export const cockpitFolderPath = app.getPath('userData')
   // macOS: ~/Library/Application Support/Cockpit/
   ```
   - Standard location for persistent data
   - Follows Electron conventions

4. **REST API Client** (`Bio_cockpit/src/libs/blueos.ts:83-99`):
   ```typescript
   export const getBagOfHoldingFromVehicle = async (
     vehicleAddress: string,
     bagPath: string
   ): Promise<Record<string, any> | any> => {
     return await ky.get(`${protocol}//${vehicleAddress}/bag/v1.0/get/${bagPath}`, options).json()
   }
   ```
   - Uses `ky` HTTP client with timeout/retry
   - Already calls BlueOS services

5. **Action Callbacks** (`Bio_cockpit/src/stores/video.ts:416,310`):
   ```typescript
   activeStreams.value[streamName]!.mediaRecorder!.start(1000)  // Line 416
   activeStreams.value[streamName]!.mediaRecorder!.stop()       // Line 310
   ```
   - Can hook into start/stop events
   - Register callbacks for parallel operations

### Q_Sensor_API Foundation

**Existing Components** (`Q_Sensor_API/`):
- `api/main.py` - FastAPI server with 26 endpoints
- `data_store/store.py` - DataFrame with 100k row capacity
- `q_sensor_lib/controller.py` - Serial acquisition threads
- `q_sensor_lib/ring_buffer.py` - Thread-safe circular buffer

**Ready for Extension**:
- Already containerized with Docker
- BlueOS extension metadata in place
- REST API patterns established
- Thread-safe data structures

## Complete Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ USER (Topside Computer)                                                 │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │ Cockpit UI (Bio_cockpit/src/components/mini-widgets/           │   │
│  │              MiniQSensorRecorder.vue)                           │   │
│  │                                                                  │   │
│  │  [●REC]  00:05:23  |  2.4 MB mirrored  |  Last sync: 5s ago   │   │
│  │                                                                  │   │
│  │  Status: Recording  |  Backlog: 0 chunks                       │   │
│  └──────────────┬───────────────────────────────────────────────────┘   │
│                 │ User clicks Record                                    │
│                 │ POST /record/start                                    │
└─────────────────┼───────────────────────────────────────────────────────┘
                  │ HTTP over tether (192.168.2.x network)
┌─────────────────┼───────────────────────────────────────────────────────┐
│ COMPANION COMPUTER (Raspberry Pi running BlueOS)                        │
│                 ↓                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Q_Sensor_API Docker Container (Port 9150)                        │  │
│  │                                                                   │  │
│  │  FastAPI Backend (api/main.py)                                   │  │
│  │  ├─ POST /record/start                                           │  │
│  │  │    └→ RecordingManager.start_session()                        │  │
│  │  │         └→ Create session dir + manifest.json                 │  │
│  │  │         └→ Start ChunkWriter thread                           │  │
│  │  │         └→ Start SSE broadcaster                              │  │
│  │  │                                                                │  │
│  │  ├─ GET /record/snapshots?session_id=...                         │  │
│  │  │    └→ Return list of available chunks with SHA256             │  │
│  │  │                                                                │  │
│  │  ├─ GET /files/<session>/<chunk>                                 │  │
│  │  │    └→ Stream chunk CSV with Range support                     │  │
│  │  │                                                                │  │
│  │  └─ GET /events?session_id=... (SSE)                             │  │
│  │       └→ Real-time: {rows, bytes, last_chunk, state}             │  │
│  │                                                                   │  │
│  │  RecordingManager (api/recording_manager.py)                     │  │
│  │  ├─ Session FSM: idle → recording → stopping → stopped           │  │
│  │  ├─ ChunkWriter thread (every 60s by default)                    │  │
│  │  │    └→ Pull rows from DataFrame                                │  │
│  │  │    └→ Write chunk-NNNNNN.csv.tmp                              │  │
│  │  │    └→ fsync()                                                 │  │
│  │  │    └→ rename() to chunk-NNNNNN.csv                            │  │
│  │  │    └→ Update manifest.json atomically                         │  │
│  │  │    └→ Broadcast SSE event                                     │  │
│  │  │                                                                │  │
│  │  └─ manifest.json format:                                        │  │
│  │      {                                                            │  │
│  │        "session_id": "550e8400-e29b-41d4...",                    │  │
│  │        "started_at": "2025-11-11T14:30:52Z",                     │  │
│  │        "chunk_interval_s": 60,                                   │  │
│  │        "chunks": [                                               │  │
│  │          {                                                        │  │
│  │            "index": 0,                                           │  │
│  │            "name": "chunk-000000.csv",                           │  │
│  │            "size": 524288,                                       │  │
│  │            "sha256": "a1b2c3...",                                │  │
│  │            "row_start": 0,                                       │  │
│  │            "row_end": 3599,                                      │  │
│  │            "timestamp": "2025-11-11T14:31:52Z"                   │  │
│  │          },                                                       │  │
│  │          ...                                                      │  │
│  │        ]                                                          │  │
│  │      }                                                            │  │
│  │                                                                   │  │
│  │  SensorController (q_sensor_lib/controller.py)                   │  │
│  │  └─ FreerunReader/PolledReader thread                            │  │
│  │       └→ Serial port → RingBuffer → DataRecorder → DataFrame     │  │
│  │                                                                   │  │
│  │  Volume Mount:                                                   │  │
│  │  /usr/blueos/userdata/qsensor/sessions/<session_id>/            │  │
│  │  ├── chunk-000000.csv                                            │  │
│  │  ├── chunk-000001.csv                                            │  │
│  │  ├── chunk-000002.csv                                            │  │
│  │  └── manifest.json                                               │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ USB Port → Q-Series Sensor (Serial 9600 baud)                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                  ↑ HTTP polling (every 15s)
┌─────────────────┼───────────────────────────────────────────────────────┐
│ TOPSIDE COMPUTER (Cockpit Electron)                                     │
│                 │                                                        │
│  ┌──────────────┴───────────────────────────────────────────────────┐  │
│  │ Electron Main Process (Bio_cockpit/src/electron/main.ts)         │  │
│  │                                                                   │  │
│  │  QSensorStorageService (services/qsensor-storage.ts)             │  │
│  │                                                                   │  │
│  │  setInterval(15000, async () => {                                │  │
│  │    if (!activeSessionId) return                                  │  │
│  │                                                                   │  │
│  │    // 1. Fetch remote manifest                                   │  │
│  │    const remote = await fetch(                                   │  │
│  │      `http://${vehicleAddress}:9150/record/snapshots?session_id=${sessionId}` │  │
│  │    )                                                              │  │
│  │                                                                   │  │
│  │    // 2. Compare with local directory                            │  │
│  │    const localChunks = await fs.readdir(sessionDir)              │  │
│  │    const missing = remote.chunks.filter(                         │  │
│  │      c => !localChunks.includes(c.name)                          │  │
│  │    )                                                              │  │
│  │                                                                   │  │
│  │    // 3. Download each missing chunk                             │  │
│  │    for (const chunk of missing) {                                │  │
│  │      const data = await fetch(                                   │  │
│  │        `http://${vehicleAddress}:9150/files/${sessionId}/${chunk.name}` │  │
│  │      )                                                            │  │
│  │                                                                   │  │
│  │      // 4. Verify SHA256                                         │  │
│  │      const hash = crypto.createHash('sha256')                    │  │
│  │        .update(data).digest('hex')                               │  │
│  │      if (hash !== chunk.sha256) {                                │  │
│  │        throw new Error('Chunk integrity check failed')           │  │
│  │      }                                                            │  │
│  │                                                                   │  │
│  │      // 5. Atomic write                                          │  │
│  │      const tmpPath = path.join(sessionDir, `.${chunk.name}.tmp`) │  │
│  │      await fs.writeFile(tmpPath, data)                           │  │
│  │      await fs.fsync(tmpPath)                                     │  │
│  │      await fs.rename(tmpPath, path.join(sessionDir, chunk.name)) │  │
│  │                                                                   │  │
│  │      // 6. Update metrics                                        │  │
│  │      bytesMirrored += chunk.size                                 │  │
│  │      lastSyncTimestamp = Date.now()                              │  │
│  │    }                                                              │  │
│  │                                                                   │  │
│  │    // 7. Notify renderer via IPC                                 │  │
│  │    mainWindow.webContents.send('qsensor:sync-update', {          │  │
│  │      bytesMirrored,                                              │  │
│  │      lastSync: Date.now(),                                       │  │
│  │      backlogCount: missing.length                                │  │
│  │    })                                                             │  │
│  │  })                                                               │  │
│  │                                                                   │  │
│  │  Local Storage Path:                                             │  │
│  │  ~/Library/Application Support/Cockpit/qsensor/                  │  │
│  │    └── <mission_name>/                                           │  │
│  │         └── <session_id>/                                        │  │
│  │              ├── chunk-000000.csv                                │  │
│  │              ├── chunk-000001.csv                                │  │
│  │              ├── chunk-000002.csv                                │  │
│  │              └── manifest.json (local copy)                      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Renderer Process (Bio_cockpit/src/stores/qsensor.ts)             │  │
│  │                                                                   │  │
│  │  State:                                                           │  │
│  │  - activeSessionId: string | null                                │  │
│  │  - recordingState: 'idle' | 'recording' | 'stopping'             │  │
│  │  - bytesMirrored: number                                         │  │
│  │  - lastSyncTimestamp: number                                     │  │
│  │  - backlogCount: number                                          │  │
│  │  - chunkIntervalSeconds: number (default 60)                     │  │
│  │  - bandwidthCapKBps: number | null (default 500)                 │  │
│  │                                                                   │  │
│  │  Actions:                                                         │  │
│  │  - startRecording() → POST /record/start → IPC 'start-session'  │  │
│  │  - stopRecording() → POST /record/stop → IPC 'stop-session'     │  │
│  │  - updateSyncStatus() ← IPC 'qsensor:sync-update'               │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### 1. Q_Sensor_API (Companion/Pi)

**Role**: Data acquisition, chunking, serving

**Components**:
- `RecordingManager` - Session lifecycle, FSM
- `ChunkWriter` - Periodic chunk export with atomic writes
- `ManifestManager` - Maintain chunk index with SHA256
- `SSEBroadcaster` - Real-time event stream
- `FileServer` - Serve chunks with Range headers

**Guarantees**:
- Chunks written atomically (temp + rename)
- Manifest always consistent (updated after chunk finalized)
- Continue recording even if topside disconnects
- Chunks survive container restart (persistent volume)

### 2. Cockpit Electron Service (Topside)

**Role**: Background chunk puller, local storage

**Components**:
- `QSensorStorageService` - Main polling loop
- `ChunkDownloader` - HTTP fetch with retry
- `IntegrityVerifier` - SHA256 validation
- `AtomicWriter` - Temp file + fsync + rename
- `IPCBridge` - Communicate status to renderer

**Guarantees**:
- Pull chunks continuously while recording active
- Verify integrity before accepting chunk
- Atomic writes prevent partial files
- Resume on restart (compare manifest vs local dir)
- Rate-limit downloads to respect bandwidth cap

### 3. Cockpit UI Widget (Topside)

**Role**: User interface, control

**Components**:
- `MiniQSensorRecorder.vue` - Mini-widget UI
- `qsensorStore` - Pinia state management
- `qsensorClient` - HTTP + SSE client wrapper

**Features**:
- Single Record/Stop button
- Live timer display
- Bytes mirrored counter
- Last sync indicator
- Backlog alert (if chunks not pulling)
- Health indicator (sensor connected/disconnected)

## State Machines

### Recording Session FSM (Pi)

```
┌──────────┐
│   IDLE   │
└────┬─────┘
     │ POST /record/start
     ↓
┌──────────┐
│RECORDING │ ←──────────────────┐
└────┬─────┘                    │
     │                          │
     │ ChunkWriter thread runs  │
     │ every chunk_interval_s   │
     │                          │
     │ Exports chunk-NNNNNN.csv │
     │ Updates manifest.json    │
     │ Emits SSE event          │
     └──────────────────────────┘
     │
     │ POST /record/stop
     ↓
┌──────────┐
│ STOPPING │  (finalizing last chunk)
└────┬─────┘
     │
     │ Last chunk written
     │ Manifest finalized
     ↓
┌──────────┐
│ STOPPED  │
└──────────┘
```

### Cockpit Sync FSM (Topside)

```
┌──────────┐
│   IDLE   │  (no active session)
└────┬─────┘
     │ User clicks Record
     │ POST /record/start succeeds
     ↓
┌──────────┐
│  ACTIVE  │ ←─────────────────────────┐
└────┬─────┘                           │
     │                                 │
     │ setInterval(15000) fires        │
     │                                 │
     │ GET /record/snapshots           │
     │ Compare remote vs local         │
     │ Download missing chunks         │
     │ Verify + atomic write           │
     │ Update UI metrics               │
     └─────────────────────────────────┘
     │
     │ User clicks Stop
     │ POST /record/stop
     ↓
┌──────────┐
│FINALIZING│  (pulling last chunks)
└────┬─────┘
     │
     │ All chunks synced
     │ (backlogCount == 0)
     ↓
┌──────────┐
│ COMPLETE │
└──────────┘
```

## Recovery Scenarios

### Scenario 1: Tether Disconnect During Recording

**Timeline**:
```
T+0:00  Recording started, chunk-000000.csv written
T+1:00  Chunk-000001.csv written, topside pulls it
T+2:00  Chunk-000002.csv written, topside pulls it
T+2:30  TETHER DISCONNECTS
T+3:00  Chunk-000003.csv written on Pi (topside doesn't know)
T+4:00  Chunk-000004.csv written on Pi
T+4:30  TETHER RECONNECTS
T+4:45  Topside polls snapshots, sees chunks 000003, 000004
T+4:50  Topside downloads chunk-000003.csv
T+4:55  Topside downloads chunk-000004.csv
T+5:00  Chunk-000005.csv written, topside pulls it
        (back in sync)
```

**Outcome**: Topside has all data, maximum lag = tether down time + pull interval (15s)

### Scenario 2: Cockpit Restart During Recording

**Timeline**:
```
T+0:00  Recording started
T+3:00  Chunks 0-2 already on topside
T+3:15  COCKPIT CRASHES
T+4:00  Chunk-000003.csv written on Pi
T+5:00  Chunk-000004.csv written on Pi
T+5:30  COCKPIT RESTARTS
T+5:31  QSensorStorageService initializes
T+5:32  Checks for active sessions (GET /record/status)
T+5:33  Finds session still recording
T+5:34  Compares local dir vs remote manifest
T+5:35  Sees chunks 000003, 000004 missing
T+5:40  Downloads chunk-000003.csv
T+5:45  Downloads chunk-000004.csv
T+6:00  Chunk-000005.csv written, pulls normally
        (fully recovered)
```

**Outcome**: Idempotent recovery, no user intervention needed

### Scenario 3: Pi Reboot Mid-Recording

**Timeline**:
```
T+0:00  Recording started
T+2:00  Chunks 0-1 on topside, chunk-000002.csv being written
T+2:30  PI POWER LOSS (chunk-000002.csv incomplete)
T+3:00  Pi boots, BlueOS starts, Q_Sensor_API container starts
T+3:05  RecordingManager checks for incomplete sessions
T+3:06  Finds session with chunk-000002.csv.tmp (partial)
T+3:07  Deletes .tmp file, manifest shows last good = chunk-000001
T+3:08  Sensor still connected, recording CAN resume if user re-starts
```

**Outcome**: Data loss limited to unflushed chunk (~60s). Topside has everything up to last finalized chunk.

### Scenario 4: Disk Full on Pi

**Timeline**:
```
T+0:00  Recording started
T+5:00  Chunks 0-4 written and synced
T+5:30  ChunkWriter tries to write chunk-000005.csv
T+5:31  ENOSPC error (disk full)
T+5:32  RecordingManager transitions to ERROR state
T+5:33  SSE emits error event
T+5:34  Cockpit UI shows "Disk full on Pi" alert
T+5:35  Recording stops automatically
```

**Outcome**: Graceful degradation, topside has all data up to chunk-000004

### Scenario 5: Disk Full on Topside

**Timeline**:
```
T+0:00  Recording started
T+3:00  Chunks 0-2 on topside
T+3:15  Chunk-000003.csv download succeeds
T+3:16  Atomic write fails (ENOSPC)
T+3:17  QSensorStorageService logs error
T+3:18  IPC sends error to renderer
T+3:19  Cockpit UI shows "Local disk full" alert
T+3:20  Polling continues but doesn't download new chunks
```

**Outcome**: User alerted, recording continues on Pi, can free space and resume pulling

## Network Bandwidth Analysis

### Typical Data Rates

**Q-Series at 1 Hz**:
- 7 CSV columns × ~15 bytes/column = ~105 bytes/row
- 3,600 rows/hour = 378 KB/hour
- 60-second chunk = 6.3 KB

**Q-Series at 10 Hz**:
- 36,000 rows/hour = 3.78 MB/hour
- 60-second chunk = 63 KB

**Q-Series at 100 Hz** (high-resolution):
- 360,000 rows/hour = 37.8 MB/hour
- 60-second chunk = 630 KB

### Bandwidth Requirements

**Default (60s chunks, 500 KB/s cap)**:
- 1 Hz: 6.3 KB / 60s = **105 bytes/s** ✅ (far below cap)
- 10 Hz: 63 KB / 60s = **1.05 KB/s** ✅
- 100 Hz: 630 KB / 60s = **10.5 KB/s** ✅

**Full-Passthrough Mode (1s chunks)**:
- 100 Hz: 6.3 KB / 1s = **6.3 KB/s** ✅ (still below cap)

**Extreme Case (500 Hz, 1s chunks)**:
- 3.15 KB / 1s = **3.15 KB/s** ✅

**Conclusion**: Even at max sensor rate (500 Hz), bandwidth is negligible compared to video (typically 2-5 Mbps).

## Failure Modes and Handling

| Failure | Detection | Response | User Impact |
|---------|-----------|----------|-------------|
| Sensor disconnect | Controller detects `SerialException` | Stop recording, SSE error event | UI shows "Sensor disconnected" |
| USB cable unplug | No data for 5s | Attempt reconnect (10 retries) | UI shows "Reconnecting..." |
| Pi disk full | `ENOSPC` on chunk write | Stop recording, keep last chunk | UI shows "Pi disk full" alert |
| Topside disk full | `ENOSPC` on atomic write | Stop pulling, keep recording on Pi | UI shows "Local disk full" |
| Tether disconnect | HTTP timeout on poll | Continue recording on Pi, queue chunks | UI shows "Syncing paused" |
| Manifest corruption | JSON parse error | Retry fetch, fallback to directory scan | Continue recording |
| Chunk integrity fail | SHA256 mismatch | Delete partial, retry download | Log error, retry on next poll |
| Pi reboot | Session lost from memory | Detect on startup, offer resume | User can restart or discard |
| Cockpit crash | Service restart | Resume pulling on startup | Brief sync pause (~30s) |
| Network congestion | Slow download | Respect bandwidth cap, accumulate backlog | UI shows backlog count |

## Design Principles

1. **Fail-Safe**: Topside always has most recent data (lag = chunk interval + poll interval)
2. **Atomic**: All writes use temp file + fsync + rename
3. **Idempotent**: Can retry any operation without corruption
4. **Verifiable**: SHA256 on every chunk
5. **Resumable**: Recovery from any failure without user action
6. **Observable**: UI shows real-time sync status
7. **Bounded**: Bandwidth cap prevents network saturation
8. **Graceful**: Errors don't stop recording, just sync

## Performance Targets

| Metric | Target | Rationale |
|--------|--------|-----------|
| Chunk write latency (Pi) | < 100 ms | Don't block acquisition thread |
| Chunk download time | < 5 s (1 MB chunk @ 200 KB/s) | Stay within poll interval |
| Manifest update latency | < 10 ms | Atomic JSON write |
| Sync lag (normal) | 15-75 s (poll + chunk interval) | Acceptable for minute-scale backup |
| Sync lag (extreme mode) | < 5 s | Full-passthrough option |
| Recovery time | < 30 s | Resume within 2 poll intervals |
| CPU overhead (Pi) | < 2% | Don't impact vehicle control |
| CPU overhead (topside) | < 1% | Background service |
| Memory (Pi) | < 50 MB | DataFrame + chunk buffer |
| Memory (topside) | < 20 MB | Manifest cache |

## Configuration Options

**Pi-Side** (Q_Sensor_API):
```yaml
chunk_interval_s: 60          # Default 60s, range 15-300
max_chunk_size_mb: 5          # Roll to new chunk if exceeded
enable_sse: true              # Server-sent events for real-time updates
bind_address: "127.0.0.1"     # Localhost only (security)
```

**Topside** (Cockpit Settings UI):
```yaml
poll_interval_s: 15           # How often to check for new chunks
bandwidth_cap_kbps: 500       # Max download rate (null = unlimited)
full_passthrough_mode: false  # If true, set chunk_interval_s = 1
auto_resume: true             # Resume on reconnect
max_backlog_chunks: 100       # Warn if backlog exceeds
```

## Summary

This architecture provides:
- ✅ **Live continuous mirroring** (default 60s lag, configurable to <5s)
- ✅ **Whale-proof fail-safe** (topside always has recent data)
- ✅ **No end-of-run reliance** (chunks pulled continuously)
- ✅ **Idempotent recovery** (resume from any failure)
- ✅ **Single-button UX** (user only sees Record/Stop + status)
- ✅ **Atomic writes** (both sides use temp + rename)
- ✅ **Bandwidth control** (adjustable cap + backlog monitoring)
- ✅ **Security** (localhost binding, input validation, rate limits)

Next documents detail the API contract, implementation specifics, and migration plan.
