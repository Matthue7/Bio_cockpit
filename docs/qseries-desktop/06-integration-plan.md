# Q-Series Integration Plan: Single-Button Recording

**Goal**: When user clicks Record in Cockpit, both video and Q-Series data record automatically. Data streams live to topside. Zero extra buttons or manual steps.

## User Experience Flow

```
User opens Cockpit desktop app
    ↓
(Background: Q_Sensor_API running on ROV at http://blueos.local:9150)
    ↓
User clicks single Record button
    ↓
Cockpit starts video recording (existing behavior)
    ↓
[NEW] Cockpit automatically:
  1. POST http://blueos.local:9150/record/start
  2. Receives session_id
  3. Starts background chunk mirror timer (every 15s)
    ↓
[Recording in progress]
  - Video: MediaRecorder → FFmpeg → ~/Cockpit/videos/Mission_2025-11-11_143022.mp4
  - Q-Sensor: Serial → DataFrame → chunks on Pi → mirrored to ~/Cockpit/qsensor/Mission/session_id/
    ↓
User clicks Stop button
    ↓
Cockpit stops video recording (existing behavior)
    ↓
[NEW] Cockpit automatically:
  1. POST http://blueos.local:9150/record/stop
  2. Pulls final chunks (blocking, ~5s)
  3. Stops mirror timer
    ↓
Done: Both video and Q-Series data are local
  - Video: ~/Cockpit/videos/Mission_2025-11-11_143022.mp4
  - Q-Sensor: ~/Cockpit/qsensor/Mission/550e8400.../chunk-*.csv
```

## Architecture: Transparent Background Mirroring

```
┌─────────────────────────────────────────────────────────────────┐
│ USER (Topside - Cockpit Desktop App)                            │
│                                                                  │
│  User clicks Record button once                                 │
│         ↓                                                        │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ MiniVideoRecorder.vue (UNCHANGED)                        │  │
│  │   toggleRecording() → videoStore.startRecording()       │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     │                                            │
│  ┌──────────────────▼───────────────────────────────────────┐  │
│  │ videoStore (src/stores/video.ts)                         │  │
│  │                                                           │  │
│  │  startRecording() - Line 323                             │  │
│  │    ├─ Start MediaRecorder (existing)                     │  │
│  │    └─ [NEW] qsensorStore.startMirroringForRecording()   │  │
│  │         └→ Calls Electron IPC automatically              │  │
│  │                                                           │  │
│  │  stopRecording() - Line 294                              │  │
│  │    ├─ Stop MediaRecorder (existing)                      │  │
│  │    └─ [NEW] qsensorStore.stopMirroringForRecording()    │  │
│  │         └→ Waits for final chunks (5s timeout)           │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     │                                            │
│  ┌──────────────────▼───────────────────────────────────────┐  │
│  │ qsensorStore (NEW: src/stores/qsensor.ts)                │  │
│  │                                                           │  │
│  │  State:                                                   │  │
│  │    - activeSessionId: string | null                      │  │
│  │    - mirroringActive: boolean                            │  │
│  │    - bytesMirrored: number                               │  │
│  │    - lastChunkIndex: number                              │  │
│  │    - settings: { baseUrl, pollIntervalMs }               │  │
│  │                                                           │  │
│  │  Actions:                                                 │  │
│  │    - startMirroringForRecording()                        │  │
│  │        └→ POST /record/start                             │  │
│  │        └→ IPC: start-mirror                              │  │
│  │    - stopMirroringForRecording()                         │  │
│  │        └→ IPC: stop-mirror                               │  │
│  │        └→ POST /record/stop                              │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     │ Electron IPC                              │
└─────────────────────┼───────────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────────┐
│ ELECTRON MAIN PROCESS                                            │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ qsensor-mirror.ts (NEW)                                  │  │
│  │                                                           │  │
│  │  setupQSensorMirrorService()                             │  │
│  │    ├─ IPC: 'qsensor:start-mirror'                        │  │
│  │    │    └→ startMirrorSession()                          │  │
│  │    │         ├─ Create session dir                       │  │
│  │    │         │  ~/Cockpit/qsensor/Mission/session_id/    │  │
│  │    │         └─ Start poll timer (15s)                   │  │
│  │    │              └→ pollAndDownloadChunks()             │  │
│  │    │                   ├─ GET /record/snapshots          │  │
│  │    │                   ├─ Compare local vs remote        │  │
│  │    │                   ├─ Download missing chunks        │  │
│  │    │                   ├─ Verify SHA256                  │  │
│  │    │                   └─ Atomic write (.tmp → rename)   │  │
│  │    │                                                      │  │
│  │    └─ IPC: 'qsensor:stop-mirror'                         │  │
│  │         └→ stopMirrorSession()                           │  │
│  │              ├─ Stop poll timer                           │  │
│  │              └─ Do final poll (get remaining chunks)     │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     │ HTTP requests                             │
└─────────────────────┼───────────────────────────────────────────┘
                      │ Network (Ethernet tether)
┌─────────────────────▼───────────────────────────────────────────┐
│ ROV (Raspberry Pi running BlueOS)                               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Q_Sensor_API Docker Container (Port 9150)                │  │
│  │                                                           │  │
│  │  POST /record/start                                       │  │
│  │    └→ RecordingManager.start_session()                   │  │
│  │         ├─ Start serial acquisition                       │  │
│  │         ├─ Start ChunkWriter thread                       │  │
│  │         │    └→ Every 60s: export chunk, update manifest │  │
│  │         └─ Return {session_id, started_at, ...}          │  │
│  │                                                           │  │
│  │  GET /record/snapshots?session_id=...                    │  │
│  │    └→ Return list of chunks with SHA256 hashes           │  │
│  │                                                           │  │
│  │  GET /files/{session_id}/{chunk_name}                    │  │
│  │    └→ Stream chunk CSV bytes                             │  │
│  │                                                           │  │
│  │  POST /record/stop                                        │  │
│  │    └→ RecordingManager.stop_session()                    │  │
│  │         ├─ Stop ChunkWriter (flushes final chunk)        │  │
│  │         ├─ Finalize manifest.json                        │  │
│  │         └─ Return {total_chunks, total_rows, ...}        │  │
│  │                                                           │  │
│  │  Storage: /usr/blueos/userdata/qsensor/sessions/         │  │
│  │           └─ {session_id}/                               │  │
│  │                ├─ manifest.json                           │  │
│  │                ├─ chunk-000000.csv                        │  │
│  │                ├─ chunk-000001.csv                        │  │
│  │                └─ chunk-000002.csv                        │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     │                                            │
│  ┌──────────────────▼───────────────────────────────────────┐  │
│  │ USB Serial → Q-Series Sensor (9600 baud)                 │  │
│  └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Settings (Hidden from User)

User never configures Q-Sensor settings directly. Defaults work automatically.

**Stored in**: `~/Cockpit/.config/qsensor-settings.json`

```json
{
  "enabled": true,
  "apiBaseUrl": "http://blueos.local:9150",
  "pollIntervalMs": 15000,
  "chunkIntervalS": 60,
  "bandwidthCapKBps": 500,
  "autoStart": true
}
```

**Settings UI** (optional, advanced users only):
- Location: Cockpit Settings → Extensions → Q-Sensor
- Fields:
  - Enable Q-Sensor recording (checkbox, default: true)
  - API URL (text, default: http://blueos.local:9150)
  - Mirror poll interval (slider, 15-60s, default: 15s)
  - Bandwidth cap (slider, 100-1000 KB/s, default: 500, or "unlimited")

## Fail-Safe Behavior

### Scenario 1: Tether Disconnect During Recording

```
T+0:00  Recording started, video + Q-Sensor
T+1:00  Chunk-000000.csv mirrored to topside
T+2:00  Chunk-000001.csv mirrored to topside
T+2:30  TETHER DISCONNECTS
T+3:00  (Pi writes chunk-000002.csv, topside doesn't know)
T+4:00  (Pi writes chunk-000003.csv, topside doesn't know)
T+4:30  TETHER RECONNECTS
T+4:45  Mirror timer fires → polls /record/snapshots
T+4:50  Sees chunks 000002, 000003 missing → downloads
T+5:00  Chunk-000004.csv written → mirrored
        BACK IN SYNC ✓
```

**Outcome**: Topside has all data, max lag = tether outage + 15s

### Scenario 2: Cockpit Crashes During Recording

```
T+0:00  Recording started
T+2:00  Chunks 0-1 already on topside
T+2:30  COCKPIT CRASHES
T+3:00  (Pi continues writing chunk-000002.csv)
T+4:00  (Pi continues writing chunk-000003.csv)
T+4:30  USER RESTARTS COCKPIT
T+4:35  qsensor-mirror service initializes
T+4:36  Checks: "Do I have an active session?"
T+4:37  NO → no action (video recording also stopped)
```

**Outcome**: User must restart recording manually. Chunks 2-3 on Pi but not mirrored.

**Improvement** (future): Persist active session ID, resume on restart.

### Scenario 3: ROV Powers Off Mid-Recording

```
T+0:00  Recording started
T+2:00  Chunks 0-1 on topside
T+2:30  ROV POWER LOSS
T+2:31  Topside mirror timer fires → HTTP timeout
T+2:32  Mirror service logs error, continues polling
```

**Outcome**: Topside has chunks 0-1. Pi lost chunk-000002 (in RAM). Session unrecoverable.

### Scenario 4: Q-Sensor API Not Available

```
User clicks Record
    ↓
videoStore.startRecording()
    ├─ Video recording starts (existing) ✓
    └─ qsensorStore.startMirroringForRecording()
         └─ POST http://blueos.local:9150/record/start
              └─ HTTP error: Connection refused
                   └─ Log warning, continue video recording ✓
```

**Outcome**: Video records normally. Q-Sensor silently disabled.

**UI Indicator** (optional): Small red dot on Q-Sensor mini-widget if API unreachable.

## Performance & Bandwidth

### Byte Math

**Q-Series at 1 Hz** (typical):
- Schema: 7 columns × 15 bytes/col = ~105 bytes/row
- 3600 rows/hour = 378 KB/hour
- 60s chunk = 6.3 KB
- **Bandwidth**: 6.3 KB / 60s = **105 bytes/s** (negligible)

**Q-Series at 10 Hz**:
- 36,000 rows/hour = 3.78 MB/hour
- 60s chunk = 63 KB
- **Bandwidth**: 63 KB / 60s = **1.05 KB/s**

**Q-Series at 100 Hz** (high-res):
- 360,000 rows/hour = 37.8 MB/hour
- 60s chunk = 630 KB
- **Bandwidth**: 630 KB / 60s = **10.5 KB/s**

**Comparison to video**:
- Video: 2-5 Mbps = 250-625 KB/s
- Q-Sensor (100 Hz): 10.5 KB/s = **~1.6% of video bandwidth**

### Recommended Defaults

**Chunk Cadence**: 60 seconds
- Rationale: Balances latency vs CPU/fsync overhead
- 1 Hz: 6 KB chunks (tiny, but acceptable)
- 100 Hz: 630 KB chunks (reasonable)

**Mirror Poll Interval**: 15 seconds
- Rationale: 4 polls per 60s chunk = catches new chunks quickly
- Max sync lag: 15s + 5s download = 20s typical

**Bandwidth Cap**: 500 KB/s
- Rationale: Won't saturate even on slow WiFi tethers
- At 100 Hz, uses ~2% of cap

### Backpressure Handling

**If topside can't keep up** (network congestion):
1. Mirror timer continues firing every 15s
2. Downloads queue up (backlog increases)
3. Bandwidth throttler enforces cap (500 KB/s)
4. Chunks download slowly but eventually catch up

**UI Indication**:
- Q-Sensor mini-widget shows: "Backlog: 3 chunks"
- Yellow warning if backlog > 5 chunks
- Red error if backlog > 20 chunks (network problem)

## Security

### Input Validation

**Session ID**: UUID format only
```typescript
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
  throw new Error('Invalid session ID format')
}
```

**Chunk Names**: Prevent path traversal
```typescript
if (chunkName.includes('..') || chunkName.includes('/')) {
  throw new Error('Invalid chunk name')
}
```

**Chunk Indexes**: Numeric only, reasonable range
```typescript
if (!Number.isInteger(index) || index < 0 || index > 999999) {
  throw new Error('Invalid chunk index')
}
```

### Rate Limiting (Pi-Side)

**Implemented in Q_Sensor_API**:
- GET /record/snapshots: 4 req/min (1 per 15s)
- GET /files/{session}/{chunk}: 10 req/min
- POST /record/start: 5 req/min
- POST /record/stop: 10 req/min

**Cockpit respects limits** by using 15s poll interval.

### Log Redaction

**Do NOT log**:
- Session IDs in full (use first 8 chars only)
- File paths with user home directories
- Sensor serial numbers (if sensitive)

**Example**:
```typescript
// BAD:
console.log(`Mirroring session ${sessionId}`)

// GOOD:
console.log(`Mirroring session ${sessionId.slice(0, 8)}...`)
```

## Recovery Strategy

### Idempotent Resume

**On Cockpit restart** during active recording:
1. qsensor-mirror service initializes
2. Checks localStorage for `lastActiveSessionId`
3. If found: GET http://blueos.local:9150/record/status?session_id=...
4. If still recording: resume mirroring
5. Compare local chunks vs remote manifest
6. Download missing chunks

**Implementation**:
```typescript
// In qsensor-mirror.ts setupService():
const lastSessionId = localStorage.getItem('qsensor_last_session')
if (lastSessionId) {
  try {
    const status = await fetch(
      `${baseUrl}/record/status?session_id=${lastSessionId}`
    ).then(r => r.json())

    if (status.state === 'recording') {
      console.log(`Resuming mirror for session ${lastSessionId.slice(0, 8)}...`)
      await startMirrorSession(lastSessionId, vehicleAddress, status.mission_name)
    }
  } catch (error) {
    console.warn('Failed to resume session:', error)
  }
}
```

### Manifest Reconciliation

**After reconnect or resume**:
1. Read local directory: `fs.readdir(sessionPath)`
2. Fetch remote manifest: GET /record/snapshots
3. Find missing chunks: `remote.chunks.filter(c => !localChunks.includes(c.name))`
4. Download missing chunks in order
5. Verify each with SHA256

## Implementation Checklist

- [ ] Q_Sensor_API endpoints implemented (see 08-qsensor-api-minimal.md)
- [ ] Electron service: `src/electron/services/qsensor-mirror.ts`
- [ ] IPC channels added to preload.ts
- [ ] Store: `src/stores/qsensor.ts`
- [ ] Hook into videoStore.startRecording() after line 416
- [ ] Hook into videoStore.stopRecording() before line 308
- [ ] Mini-widget: `src/components/mini-widgets/MiniQSensorRecorder.vue`
- [ ] Widget enum: Add `QSensorRecorder` to types/widgets.ts
- [ ] Service registration: Add `setupQSensorMirrorService()` to main.ts:90
- [ ] Settings persistence: Save to localStorage/config
- [ ] Error handling: Network failures, API unavailable
- [ ] Testing: Unit tests, E2E test with Q-Sensor on Pi

## Summary

This integration achieves:
- ✅ **Single button**: User clicks Record once, both video + Q-Sensor record
- ✅ **Transparent**: No extra UI except optional status widget
- ✅ **Automatic**: Mirroring starts/stops with video recording
- ✅ **Fail-safe**: Topside always has data up to last sync
- ✅ **Local storage**: Files written to ~/Cockpit/qsensor/ atomically
- ✅ **Low bandwidth**: ~1-10 KB/s typical, 500 KB/s cap
- ✅ **Recoverable**: Resume on reconnect, idempotent downloads

Next: Concrete file changes and code diffs (07-file-plan-and-diffs.md).
