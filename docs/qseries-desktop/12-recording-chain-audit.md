# Q-Sensor Recording Chain Audit & Correction Plan

**Date**: 2025-01-13 (Updated: 2025-11-13)
**Scope**: Freerun recording flow from Cockpit Desktop → Q_Sensor_API → Pi storage → Topside mirroring
**Goal**: Identify and fix root cause of 404 errors, failed recordings, and missing chunks

---

## ⚠️ CRITICAL UPDATE (2025-11-13): Pi Container Running Old Code

### Pi Terminal Test Results

Pi container at `localhost:9150` returns:
- ✅ `GET /health` → 200 OK
- ❌ `GET /instrument/health` → 404 Not Found
- ❌ `POST /record/start` → 404 Not Found
- ❌ `GET /record/status` → 404 Not Found

### Root Cause Identified

**The Pi container is running OLD CODE.** The recording endpoints (`/instrument/health`, `/record/start`, `/record/status`) are correctly defined in the current source code but are missing from the running Docker image.

**Evidence:**
1. All endpoints properly registered in [api/main.py](../../../qseries-noise/Q_Sensor_API/api/main.py) (lines 891, 977, 1031, 1071, 1107)
2. No APIRouter prefix issues or route misconfiguration
3. Dockerfile is correct, points to `api.main:app`
4. `/health` works → basic app running
5. Recording endpoints 404 → not in image

**Solution:** Rebuild Docker image and redeploy to Pi.

**See:** [Q_Sensor_API/RECORDING_CHAIN_AUDIT.md](../../../qseries-noise/Q_Sensor_API/RECORDING_CHAIN_AUDIT.md) for full audit report, fix instructions, and E2E test script.

---

## Previous Analysis (2025-01-13)

### Executive Summary

- **Root Cause #1**: Client uses **`/sensor/disconnect`** endpoint that doesn't exist on server (only `/disconnect` exists) — ✅ FIXED
- **Root Cause #2**: qsensor-client.ts uses fragile template literals for URL construction leading to double-slash issues — ✅ FIXED
- **Root Cause #3**: Cockpit bypasses qsensor-client.ts entirely, uses Electron IPC → qsensor-control.ts instead (CORS workaround) — ℹ️ BY DESIGN
- **Root Cause #4**: `poll_hz` param NOT sent to `/sensor/start`, defaulting to 1 Hz when freerun should be ~15 Hz — ✅ ACCEPTABLE (ignored in freerun)
- **Root Cause #5**: Client calls `/record/start` immediately after `/sensor/start` without stabilization delay — ⚠️ RECOMMENDED TO ADD 2s DELAY
- **NEW Root Cause #6**: **Pi container running old code without recording endpoints** — ❌ CRITICAL

**Status**: All URL construction issues fixed in qsensor-control.ts. **Pi container must be rebuilt before recording will work.**

---

## Recording Semantics: Cockpit vs Q_Sensor_API

### Endpoint Responsibility Matrix

| Endpoint | Method | Cockpit Calls | Server Function | Side Effects |
|----------|--------|---------------|-----------------|--------------|
| `/sensor/connect` | POST | ✅ Via IPC | Enter CONFIG_MENU, get sensor_id | Opens serial port |
| `/disconnect` | POST | ✅ Via IPC | Close serial, reset state | Stops recorder + acquisition |
| `/instrument/health` | GET | ✅ Via IPC (retry 3×) | Return connection status | None |
| `/sensor/start` | POST | ✅ Via IPC (no poll_hz!) | Start acquisition thread | Auto-starts DataRecorder if `auto_record=True` |
| `/sensor/stop` | POST | ✅ Via IPC | Stop acquisition thread | Defensive: stops recorder first |
| `/record/start` | POST | ✅ Via IPC | Create ChunkedDataStore, start recorder | Auto-starts acquisition if not running (BUG: wrong poll_hz calc) |
| `/record/stop` | POST | ✅ Via IPC | Finalize chunks, stop recorder | Returns chunk count |
| `/record/snapshots` | GET | ❌ Via mirror service | List finalized chunks | None |
| `/files/{id}/{file}` | GET | ❌ Via mirror service | Download chunk | None |

### Expected Flow (Freerun MVP)

**Cockpit User Flow**:
```
1. Connect → 2. Health Check (3× retry) → 3. Start Recording → 4. Mirror Chunks → 5. Stop Recording → 6. Disconnect
```

**API Call Sequence** (ToolsQSeriesView.vue:290-498):
```
CONNECT:
  POST /sensor/connect?port=/dev/ttyUSB0&baud=9600
  → Wait 500ms
  → GET /instrument/health (retry up to 3× with 300ms backoff)
  → Store: isConnected=true

START RECORDING (handleStartRecording:381-441):
  STEP 1: POST /sensor/start  (no poll_hz param - defaults to freerun)
  STEP 2: POST /record/start  (body: {rate_hz:500, mission, roll_interval_s:60})
          → Server returns session_id
  STEP 3: Store.arm(session_id, mission, vehicleAddress)
  STEP 4: IPC: startQSensorMirror(session_id, ...)
          → Electron starts polling /record/snapshots every 60s (or 2s if fullBandwidth)

STOP RECORDING (handleStopRecording:443-498):
  STEP 1: IPC: stopQSensorMirror(session_id)
  STEP 2: POST /record/stop  (body: {session_id})
  STEP 3: POST /sensor/stop
  STEP 4: Store.reset()

DISCONNECT:
  POST /disconnect
```

**Server Side-Effects**:
```
/sensor/start:
  - Spawns freerun thread (_start_freerun_thread)
  - Thread continuously reads serial port at ~15 Hz
  - Fills ring buffer with readings
  - If auto_record=True (default): starts DataRecorder polling buffer every 0.2s

/record/start:
  - Creates ChunkedDataStore with session directory
  - If acquisition NOT running: auto-starts with poll_hz = rate_hz / 500.0 (BUG!)
  - Starts DataRecorder (if not already started by /sensor/start)
  - DataRecorder polls buffer every 0.2s, writes to chunk files
  - Chunks roll every 60s OR 2MB size
  - Finalized chunks appear in /record/snapshots
```

---

## Findings

### 1. URL Contract Mismatches

#### Issue 1A: `/sensor/disconnect` doesn't exist ❌

**Client code** (qsensor-client.ts:81):
```typescript
async disconnect(): Promise<{ status: string }> {
  const response = await fetch(`${this.baseUrl}/sensor/disconnect`, {  // WRONG
    method: 'POST',
    signal: AbortSignal.timeout(this.timeout),
  })
```

**Server routes** (api/main.py:791-805):
```python
# Sensor aliases (line 796-801)
app.add_api_route("/sensor/connect", connect, methods=["POST"])
app.add_api_route("/sensor/config", get_config, methods=["GET"])
app.add_api_route("/sensor/start", start_acquisition, methods=["POST"])
app.add_api_route("/sensor/stop", stop_acquisition, methods=["POST"])
# NOTE: No /sensor/disconnect alias!

# Disconnect is only at root (line 581)
@app.post("/disconnect")
async def disconnect():
```

**Status**: ✅ **FIXED** in qsensor-control.ts:68 (now uses `/disconnect`)

**Note**: qsensor-client.ts is NOT actually used by Cockpit (CORS issue - Electron uses IPC instead)

#### Issue 1B: Fragile URL Construction in qsensor-client.ts

**Problem code** (qsensor-client.ts:60, 81, 98, 119, 143):
```typescript
// Line 60 - Template literal creates double slashes if baseUrl has trailing slash
const url = new URL(`${this.baseUrl}/sensor/connect`)

// If baseUrl = "http://blueos.local:9150/" then:
// result = "http://blueos.local:9150//sensor/connect" ❌
```

**Status**: ⚠️ **NOT USED** - Cockpit uses Electron IPC (qsensor-control.ts) instead due to CORS

**However**, qsensor-control.ts had same issue - now **FIXED** to use two-argument URL constructor:
```typescript
// qsensor-control.ts:44, 68, 112, 136 - NOW CORRECT ✅
const url = new URL('/sensor/connect', baseUrl)
```

### 2. Mode Awareness Gaps

#### Issue 2A: Cockpit doesn't send mode or poll_hz to API

**Client code** (ToolsQSeriesView.vue:243):
```typescript
const acquisitionMode = ref<'freerun' | 'polled'>('freerun')  // Defined but NEVER USED
```

**Client code** (ToolsQSeriesView.vue:392):
```typescript
// STEP 1: Start acquisition on the sensor (freerun mode)
addLog('info', 'Starting sensor acquisition (freerun)...')
const acqResult = await window.electronAPI.qsensorStartAcquisition(apiBaseUrl.value, undefined)
//                                                                                      ^^^^^^^^
//                                                                                      poll_hz is undefined!
```

**IPC handler** (qsensor-control.ts:107-129):
```typescript
async function startAcquisition(
  baseUrl: string,
  pollHz?: number  // Client sends undefined
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const url = new URL('/sensor/start', baseUrl)
    if (pollHz !== undefined) {  // This branch never executes
      url.searchParams.set('poll_hz', String(pollHz))
    }
    // NO poll_hz query param sent!
```

**Server behavior** (api/main.py:409):
```python
@app.post("/start")
async def start_acquisition(
    poll_hz: float = Query(1.0, description="Poll rate for polled mode (Hz)"),  # Defaults to 1.0
    auto_record: bool = Query(True, description="Automatically start DataRecorder")
):
```

**Impact**:
- Client sends no `poll_hz` param
- Server defaults to `poll_hz=1.0`
- Server reads sensor config to determine mode (freerun vs polled)
- If config.mode == "freerun", `poll_hz` is **IGNORED** (line 425)
- If config.mode == "polled", uses `poll_hz=1.0` which is too slow

**Resolution**:
- ✅ For freerun MVP: Current behavior is ACCEPTABLE (poll_hz ignored in freerun)
- ⚠️ For polled mode: Cockpit must send explicit `poll_hz` value (e.g., 10-15 Hz)

#### Issue 2B: Server defaults to freerun based on sensor config

**Server code** (controller.py:425-434):
```python
if config.mode == "freerun":
    self._state = ConnectionState.ACQ_FREERUN
    self._start_freerun_thread()
elif config.mode == "polled":
    self._state = ConnectionState.ACQ_POLLED
    self._last_poll_hz = poll_hz
    self._start_polled_thread(config.tag or "A", poll_hz)
```

**Where config.mode is determined** (controller.py:317-383):
```python
async def connect(...):
    # Enters config menu, sends '?' command
    # Parses response like:
    #   Freerun mode: "OQ1..."
    #   Polled mode: "TAG A Q..."
    # Stores in self._config.mode
```

**Conclusion**: Mode is sensor-side setting, not client-controlled. Client must accept whatever mode the sensor is configured for.

### 3. Pi Recording vs Topside Mirroring

#### Architecture: Dual Recording (CORRECT Design)

**Q**: Does Pi record AND topside mirror, or only one?
**A**: BOTH - this is intentional and correct:

1. **Pi-side recording** (ChunkedDataStore):
   - Writes to `/data/qsensor_recordings/{session_id}/`
   - Creates chunk files: `chunk_00000.csv`, `chunk_00001.csv`, ...
   - Rolls every 60s or 2MB
   - Purpose: **Backup** in case topside disconnects

2. **Topside mirroring** (qsensor-mirror.ts):
   - Polls `/record/snapshots` every 60s (or 2s in fullBandwidth mode)
   - Downloads new chunks via `/files/{session_id}/{filename}`
   - Verifies SHA256 hash
   - Writes to local storage (configurable path)
   - Purpose: **Live access** for real-time processing

**Benefits**:
- Resilience: If topside loses connection, Pi keeps recording
- Recovery: Topside can catch up after reconnection (checks last_chunk_index in mirror.json)
- Redundancy: Two copies of data

**No conflict**: These are independent write paths - no race conditions or locking issues.

#### Mirroring Implementation (qsensor-mirror.ts:130-181)

```typescript
async function pollAndMirror(session: MirrorSession): Promise<void> {
  // 1. GET /record/snapshots?session_id={session_id}
  const chunks = await fetch(`http://${vehicleAddress}:9150/record/snapshots?session_id=${sessionId}`)

  // 2. Find new chunks (index > lastChunkIndex)
  const newChunks = chunks.filter(chunk => chunk.index > session.lastChunkIndex)

  // 3. Download each new chunk
  for (const chunk of newChunks) {
    // Download to .tmp file
    // Verify SHA256
    // Atomic rename .tmp → .csv
    // Update mirror.json with lastChunkIndex
  }
}
```

**Polling cadence**:
- Normal: 60s (cadenceSec setting)
- Full bandwidth: 2s (fullBandwidth=true)

**Atomic writes**: Same pattern as server - write to `.tmp`, rename when complete.

### 4. Timing & Race Conditions

#### Race 1: Health check immediately after connect ⚠️

**Client code** (ToolsQSeriesView.vue:306-327):
```typescript
// Wait 500ms for sensor to stabilize before health check
await new Promise(resolve => setTimeout(resolve, 500))

// Then check health to get full status (retry on failure)
for (let attempt = 0; attempt < 3; attempt++) {
  if (attempt > 0) {
    await new Promise(resolve => setTimeout(resolve, 300))  // 300ms backoff
  }
  healthResult = await window.electronAPI.qsensorGetHealth(apiBaseUrl.value)
  if (healthResult.success && healthResult.data) {
    healthSuccess = true
    break
  }
}
```

**Status**: ✅ **GOOD** - 500ms initial delay + 3 retries with 300ms backoff

#### Race 2: /record/start immediately after /sensor/start ❌

**Client code** (ToolsQSeriesView.vue:390-406):
```typescript
// STEP 1: Start acquisition
const acqResult = await window.electronAPI.qsensorStartAcquisition(apiBaseUrl.value, undefined)
addLog('info', 'Acquisition started (freerun)')

// STEP 2: Start recording session (NO DELAY!)
addLog('info', 'Starting recording session...')
const recordResult = await window.electronAPI.qsensorStartRecording(apiBaseUrl.value, {
  rate_hz: 500,
  ...
})
```

**Problem**:
- `/sensor/start` spawns background thread
- Thread needs time to:
  1. Send 'X' command to sensor (freerun)
  2. Wait for sensor to start streaming
  3. Read first samples into buffer
- `/record/start` is called immediately - might see empty buffer initially

**Impact**: LOW - DataRecorder polls buffer every 0.2s, so it will catch up within 200ms

**Recommendation**: Add 1-2 second stabilization delay:
```typescript
// STEP 1: Start acquisition
const acqResult = await window.electronAPI.qsensorStartAcquisition(apiBaseUrl.value, undefined)
addLog('info', 'Acquisition started (freerun)')

// STEP 1.5: Wait for sensor to stabilize
await new Promise(resolve => setTimeout(resolve, 2000))  // 2s delay

// STEP 2: Start recording session
addLog('info', 'Starting recording session...')
```

#### Race 3: Mirroring starts before first chunk finalized ✅

**Q**: Can mirroring call `/record/snapshots` before Pi has created first chunk?
**A**: Yes, but SAFELY handled:

**Timeline**:
```
T+0s:    Client calls /record/start → server creates session, starts recorder
T+0s:    Client starts mirroring → polls /record/snapshots
T+0-60s: Server writes rows to chunk_00000.csv.tmp
T+60s:   Server finalizes chunk_00000.csv (fsync, rename, update manifest)
T+60s:   Client's next poll sees chunk_00000.csv in snapshots list
```

**Server implementation** (store.py:677-689):
```python
def snapshot_list(self) -> list[ChunkMetadata]:
    """Return list of FINALIZED chunks only (excludes .tmp files)."""
    with self._manifest_lock:
        manifest = json.loads(self._manifest_path.read_text())
        return [ChunkMetadata(**c) for c in manifest.get("chunks", [])]
```

**Safety**: `.tmp` files are never exposed. Client only sees finalized chunks.

**Client behavior** (qsensor-mirror.ts:146-149):
```typescript
const newChunks = chunks.filter((chunk: any) => chunk.index > session.lastChunkIndex)
if (newChunks.length === 0) {
  return  // No new data - this is normal for first 60s
}
```

**Status**: ✅ **NO BUG** - designed correctly

### 5. Additional Bugs Found in Server

#### Bug 1: poll_hz calculation in /record/start

**Server code** (api/main.py:932):
```python
if not _controller.is_acquiring():
    logger.info("Auto-starting acquisition for chunked recording")
    _controller.start_acquisition(poll_hz=req.rate_hz / 500.0)  # ❌ BUG
```

**Problem**:
- If client requests `rate_hz=500`, this calculates `poll_hz = 500/500 = 1.0` Hz
- For polled mode, this is way too slow (should be 10-15 Hz minimum)

**Fix**: Should use `rate_hz` directly:
```python
_controller.start_acquisition(poll_hz=min(req.rate_hz, 15.0))  # Cap at 15 Hz
```

**Impact on Cockpit**: NONE - Cockpit calls `/sensor/start` BEFORE `/record/start`, so auto-start never triggers

#### Bug 2: No session_id validation in /record/stop

**Server code** (api/main.py:969-970):
```python
if not _chunked_store:
    raise HTTPException(status_code=500, detail="Chunked store not initialized")
# Missing: if _chunked_store._session_id != req.session_id: raise error
```

**Impact**: Low - only one active session at a time, but could confuse clients

---

## Fix Plan (Minimal Client-Side Changes)

### Fix 1: Add stabilization delay after /sensor/start ⚠️ RECOMMENDED

**File**: `src/views/ToolsQSeriesView.vue`
**Line**: 398 (after acquisition starts)

```diff
  const acqResult = await window.electronAPI.qsensorStartAcquisition(apiBaseUrl.value, undefined)

  if (!acqResult.success) {
    throw new Error(`Failed to start acquisition: ${acqResult.error}`)
  }
  addLog('info', 'Acquisition started (freerun)')

+ // Wait for sensor to stabilize and buffer to fill
+ addLog('info', 'Waiting for sensor to stabilize...')
+ await new Promise(resolve => setTimeout(resolve, 2000))

  // STEP 2: Start recording session on API
  addLog('info', 'Starting recording session...')
```

**Rationale**: Prevents calling `/record/start` before acquisition thread has read first samples

### Fix 2: Send explicit poll_hz for future polled mode support 🔮 FUTURE

**File**: `src/views/ToolsQSeriesView.vue`
**Line**: 243, 392

```diff
  // Acquisition mode
  const acquisitionMode = ref<'freerun' | 'polled'>('freerun')
+ const pollHz = ref(15.0)  // For polled mode

  ...

  // STEP 1: Start acquisition on the sensor
- const acqResult = await window.electronAPI.qsensorStartAcquisition(apiBaseUrl.value, undefined)
+ const poll_hz = acquisitionMode.value === 'polled' ? pollHz.value : undefined
+ const acqResult = await window.electronAPI.qsensorStartAcquisition(apiBaseUrl.value, poll_hz)
```

**Rationale**: Future-proof for when polled mode is needed (currently freerun is default)

### Fix 3: Update qsensor-client.ts for consistency 🧹 CLEANUP

Even though qsensor-client.ts is not used (Electron uses IPC), fix for consistency:

**File**: `src/libs/qsensor-client.ts`
**Lines**: 60, 81, 98, 119, 143

```diff
  async connect(port: string = '/dev/ttyUSB0', baud: number = 9600) {
-   const url = new URL(`${this.baseUrl}/sensor/connect`)
+   const url = new URL('/sensor/connect', this.baseUrl)
    url.searchParams.set('port', port)
    ...
  }

  async disconnect() {
-   const response = await fetch(`${this.baseUrl}/sensor/disconnect`, {
+   const response = await fetch(new URL('/disconnect', this.baseUrl).href, {
      method: 'POST',
      ...
  }

  async health() {
-   const response = await fetch(`${this.baseUrl}/instrument/health`, {
+   const response = await fetch(new URL('/instrument/health', this.baseUrl).href, {
      method: 'GET',
      ...
  }

  async startRecord(options) {
-   const response = await fetch(`${this.baseUrl}/record/start`, {
+   const response = await fetch(new URL('/record/start', this.baseUrl).href, {
      method: 'POST',
      ...
  }

  async stopRecord(sessionId) {
-   const response = await fetch(`${this.baseUrl}/record/stop`, {
+   const response = await fetch(new URL('/record/stop', this.baseUrl).href, {
      method: 'POST',
      ...
  }
```

### Summary of Changes

| Fix | File | Priority | Status |
|-----|------|----------|--------|
| URL construction (IPC) | qsensor-control.ts | HIGH | ✅ DONE |
| Stabilization delay | ToolsQSeriesView.vue | MEDIUM | ⚠️ RECOMMENDED |
| Send poll_hz | ToolsQSeriesView.vue | LOW (future) | 🔮 OPTIONAL |
| URL construction (HTTP) | qsensor-client.ts | LOW (cleanup) | 🧹 OPTIONAL |

---

## Corrected Recording Sequence (Freerun MVP)

### Start Recording Flow

```
User clicks "Start Q-Series Recording"
  ↓
handleStartRecording() [ToolsQSeriesView.vue:381]
  ↓
STEP 1: Start acquisition
  IPC → qsensorStartAcquisition(baseUrl, undefined)
    ↓
  [Electron Main] qsensor-control.ts:startAcquisition()
    ↓
  POST http://blueos.local:9150/sensor/start
    (no poll_hz param - defaults to 1.0, but IGNORED in freerun)
    ↓
  [Server] api/main.py:start_acquisition()
    - Reads sensor config (determines freerun vs polled)
    - Calls controller.start_acquisition(poll_hz=1.0)
    - Controller spawns _start_freerun_thread()
    - Thread reads serial port continuously (~15 Hz)
    - If auto_record=True: starts DataRecorder (in-memory DataStore)
    ↓
  Response: {"status": "started", "mode": "freerun", "recording": true}
    ↓
  [Client] addLog('Acquisition started (freerun)')

  ⏱️ WAIT 2000ms (stabilization delay) ← NEW

STEP 2: Start recording session
  IPC → qsensorStartRecording(baseUrl, {rate_hz: 500, mission, roll_interval_s: 60})
    ↓
  [Electron Main] qsensor-control.ts:startRecording()
    ↓
  POST http://blueos.local:9150/record/start
    Body: {"rate_hz": 500, "schema_version": 1, "mission": "Cockpit", "roll_interval_s": 60}
    ↓
  [Server] api/main.py:start_chunked_recording()
    - Checks disk space (>100MB required)
    - Generates session_id (UUID)
    - Creates ChunkedDataStore:
      - mkdir /data/qsensor_recordings/{session_id}/
      - Creates manifest.json
    - Acquisition already running (skip auto-start)
    - Starts DataRecorder with ChunkedDataStore
      - Polls buffer every 0.2s
      - Writes rows to chunk_00000.csv.tmp
    ↓
  Response: {"session_id": "550e8400-...", "started_at": "2025-01-13T10:30:00Z", ...}
    ↓
  [Client] addLog('Recording session created: 550e8400-...')

STEP 3: Arm store
  qsensorStore.arm(sessionId, missionName, vehicleAddress)
    ↓
  Store state:
    currentSessionId = "550e8400-..."
    missionName = "Cockpit"
    vehicleAddress = "blueos.local"

STEP 4: Start mirroring
  qsensorStore.start()
    ↓
  IPC → startQSensorMirror(sessionId, vehicleAddress, missionName, cadenceSec=60, fullBandwidth=false)
    ↓
  [Electron Main] qsensor-mirror.ts:startMirrorSession()
    - Creates local directory: {storagePath}/Cockpit/{session_id}/
    - Loads mirror.json if exists (for resume)
    - Starts polling:
      - Interval: 60s (or 2s if fullBandwidth)
      - Poll target: GET http://blueos.local:9150/record/snapshots?session_id=...
    ↓
  [Client] addLog('Mirroring started for session ...')

  --- Recording in progress ---

  Every 60s:
    [Mirror Service] pollAndMirror()
      GET /record/snapshots?session_id=...
        ↓
      Receives: [{"index": 0, "name": "chunk_00000.csv", "sha256": "...", ...}]
        ↓
      Downloads new chunks:
        GET /files/{session_id}/chunk_00000.csv
        - Save to .tmp
        - Verify SHA256
        - Rename .tmp → .csv
        - Update mirror.json with lastChunkIndex
```

### Stop Recording Flow

```
User clicks "Stop Q-Series Recording"
  ↓
handleStopRecording() [ToolsQSeriesView.vue:443]
  ↓
STEP 1: Stop mirroring
  qsensorStore.stop()
    ↓
  IPC → stopQSensorMirror(sessionId)
    ↓
  [Electron Main] qsensor-mirror.ts:stopMirrorSession()
    - session.running = false
    - clearInterval(intervalId)
    - Final poll to catch remaining chunks
    - Write final mirror.json
    ↓
  [Client] addLog('Mirroring stopped')

STEP 2: Stop recording session
  IPC → qsensorStopRecording(baseUrl, sessionId)
    ↓
  [Electron Main] qsensor-control.ts:stopRecording()
    ↓
  POST http://blueos.local:9150/record/stop
    Body: {"session_id": "550e8400-..."}
    ↓
  [Server] api/main.py:stop_chunked_recording()
    - Stops DataRecorder
    - Finalizes current chunk
    - Updates manifest.json
    - Returns stats
    ↓
  Response: {"session_id": "...", "stopped_at": "...", "chunks": 5, "rows": 15000}
    ↓
  [Client] addLog('Recording stopped: 5 chunks, 15000 rows')

STEP 3: Stop acquisition
  IPC → qsensorStopAcquisition(baseUrl)
    ↓
  [Electron Main] qsensor-control.ts:stopAcquisition()
    ↓
  POST http://blueos.local:9150/sensor/stop
    ↓
  [Server] api/main.py:stop_acquisition()
    - Defensive: stops recorder if still running
    - Calls controller.stop()
    - Stops freerun thread
    - Returns to CONFIG_MENU
    ↓
  Response: {"status": "stopped"}
    ↓
  [Client] addLog('Acquisition stopped')

STEP 4: Reset store
  qsensorStore.reset()
    - currentSessionId = null
    - isRecording = false
    - Clear stats
```

---

## Verification Plan

### Build & Run

```bash
cd /Users/matthuewalsh/Bio_cockpit

# Install dependencies (if needed)
yarn install --update-checksums

# Type check
yarn typecheck

# Run in dev mode
yarn dev:electron
```

### Test Procedure

**Prerequisites**:
- Q_Sensor_API running on `http://blueos.local:9150` (or configure custom URL)
- Q-Sensor connected to `/dev/ttyUSB0` at 9600 baud (or configure custom port)
- Sensor must be configured for **freerun mode** (check via `?` command in terminal)

**Steps**:

1. **Connect**
   ```
   Tools → Q-Series
   Set API Base URL: http://blueos.local:9150
   Set Serial Port: /dev/ttyUSB0
   Set Baud Rate: 9600
   Click "Connect"

   Expected logs:
   ✓ "Connecting to sensor..."
   ✓ "Connected to sensor: BSI_Q12345"
   ✓ "Checking sensor health..."
   ✓ "Sensor ready: BSI_Q12345, firmware unknown"

   UI state:
   ✓ Disconnect button visible
   ✓ Health panel shows green "Connected"
   ```

2. **Health Check**
   ```
   Observe health panel

   Expected:
   ✓ Connected: Yes
   ✓ Port: /dev/ttyUSB0
   ✓ Model: BSI_Q12345
   ✓ Disk Free: ~XX GB
   ```

3. **Start Recording**
   ```
   Select storage folder (or use default)
   Click "Start Q-Series Recording"

   Expected logs (with timing):
   T+0s   ✓ "Starting sensor acquisition (freerun)..."
   T+0.5s ✓ "Acquisition started (freerun)"
   T+2.5s ✓ "Waiting for sensor to stabilize..." ← NEW
   T+2.5s ✓ "Starting recording session..."
   T+3s   ✓ "Recording session created: 550e8400-..."
   T+3s   ✓ "Mirroring started for session 550e8400-..."

   UI state:
   ✓ "Stop Q-Series Recording" button visible
   ✓ Session ID displayed
   ```

4. **Monitor Mirroring**
   ```
   Wait 60-90 seconds
   Check storage folder: {storagePath}/Cockpit/{session_id}/

   Expected files:
   ✓ mirror.json (updated every 60s)
   ✓ chunk_00000.csv (appears after ~60s)
   ✓ chunk_00001.csv (appears after ~120s)

   Verify mirror.json content:
   {
     "session_id": "550e8400-...",
     "mission": "Cockpit",
     "last_chunk_index": 0,
     "bytes_mirrored": 2048576,
     "last_sync": "2025-01-13T10:31:00Z"
   }
   ```

5. **Stop Recording**
   ```
   Click "Stop Q-Series Recording"

   Expected logs:
   ✓ "Stopping mirroring..."
   ✓ "Mirroring stopped"
   ✓ "Stopping recording session..."
   ✓ "Recording stopped: 2 chunks, 3000 rows"
   ✓ "Stopping sensor acquisition..."
   ✓ "Acquisition stopped"

   UI state:
   ✓ "Start Q-Series Recording" button visible
   ✓ Session ID cleared
   ```

6. **Disconnect**
   ```
   Click "Disconnect"

   Expected logs:
   ✓ "Disconnected from Q-Sensor"

   UI state:
   ✓ Connect button visible
   ✓ Health panel shows "Disconnected"
   ```

### Expected Console Output (Electron Main)

Enable console logging to verify URL construction:

```
[QSensor][HTTP] POST http://blueos.local:9150/sensor/connect?port=/dev/ttyUSB0&baud=9600
[QSensor][HTTP] POST http://blueos.local:9150/sensor/connect → 200 OK

[QSensor][HTTP] GET http://blueos.local:9150/instrument/health
[QSensor][HTTP] GET http://blueos.local:9150/instrument/health → 200 OK

[QSensor][HTTP] POST http://blueos.local:9150/sensor/start
[QSensor][HTTP] POST http://blueos.local:9150/sensor/start → 200 OK

[QSensor][HTTP] POST http://blueos.local:9150/record/start
[QSensor][HTTP] POST http://blueos.local:9150/record/start → 200 OK

[QSensor Mirror] Started session 550e8400-...: cadence=60s, path=/Users/.../qsensor/Cockpit/550e8400-...
[QSensor Mirror] Found 0 new chunks for session 550e8400-... (T+60s, no data yet)
[QSensor Mirror] Found 1 new chunks for session 550e8400-... (T+120s)
[QSensor Mirror] Downloaded chunk chunk_00000.csv: 2048576 bytes

[QSensor][HTTP] POST http://blueos.local:9150/record/stop
[QSensor][HTTP] POST http://blueos.local:9150/record/stop → 200 OK

[QSensor][HTTP] POST http://blueos.local:9150/sensor/stop
[QSensor][HTTP] POST http://blueos.local:9150/sensor/stop → 200 OK

[QSensor][HTTP] POST http://blueos.local:9150/disconnect
[QSensor][HTTP] POST http://blueos.local:9150/disconnect → 200 OK
```

### Failure Scenarios to Test

1. **404 on /instrument/health** (should retry 3×)
   - Expected: Retries, then warns but continues if connect succeeded

2. **No chunks after 90s**
   - Check: Is acquisition actually running? (call /record/status)
   - Check: Is sensor streaming data? (use serial terminal)

3. **Disconnect during recording**
   - Expected: Mirror service continues polling, catches up when reconnected

4. **Disk full on Pi**
   - Expected: /record/start returns 507 Insufficient Storage

### Success Criteria

- ✅ No 404 errors on any endpoint
- ✅ All URLs use correct paths (no double slashes)
- ✅ Health check succeeds after connect (or warns gracefully)
- ✅ Acquisition starts without errors
- ✅ Recording session created with valid session_id
- ✅ First chunk appears in storage folder within 60-90s
- ✅ Mirroring continues every 60s, downloading new chunks
- ✅ Stop sequence completes cleanly (mirror → record → acquisition)
- ✅ Disconnect closes port cleanly

---

## Appendix: File/Line Reference Index

### Cockpit Desktop

| Component | File | Lines | Description |
|-----------|------|-------|-------------|
| **UI** | src/views/ToolsQSeriesView.vue | | |
| - Connection handler | | 290-355 | handleConnect() - calls /sensor/connect, /instrument/health |
| - Disconnect handler | | 357-377 | handleDisconnect() - calls /disconnect |
| - Start recording | | 381-441 | handleStartRecording() - 4-step flow |
| - Stop recording | | 443-498 | handleStopRecording() - 4-step flow |
| - Storage path picker | | 502-522 | handleBrowseStoragePath(), loadStoragePath() |
| **IPC Control** | src/electron/services/qsensor-control.ts | | |
| - Connect | | 38-60 | connect() - POST /sensor/connect |
| - Disconnect | | 65-81 | disconnect() - POST /disconnect |
| - Health check | | 86-102 | getHealth() - GET /instrument/health |
| - Start acquisition | | 107-129 | startAcquisition() - POST /sensor/start |
| - Stop acquisition | | 134-150 | stopAcquisition() - POST /sensor/stop |
| - Start recording | | 155-186 | startRecording() - POST /record/start |
| - Stop recording | | 191-209 | stopRecording() - POST /record/stop |
| **Mirroring** | src/electron/services/qsensor-mirror.ts | | |
| - Start mirror | | 186-240 | startMirrorSession() |
| - Stop mirror | | 245-277 | stopMirrorSession() |
| - Poll & download | | 130-181 | pollAndMirror() |
| - Download chunk | | 81-125 | downloadChunk() - GET /files/{id}/{file} |
| **Store** | src/stores/qsensor.ts | | |
| - Arm session | | 32-37 | arm() |
| - Start mirroring | | 42-69 | start() |
| - Stop mirroring | | 74-93 | stop() |
| - Refresh stats | | 98-111 | refreshStatus() |
| **HTTP Client** | src/libs/qsensor-client.ts | | |
| - Connect | | 59-75 | connect() |
| - Disconnect | | 80-92 | disconnect() ← BUG: uses /sensor/disconnect |
| - Health | | 97-108 | health() |
| - Start record | | 113-137 | startRecord() |
| - Stop record | | 142-156 | stopRecord() |
| - Snapshots | | 180-194 | snapshots() |
| - Download file | | 199-210 | getFile() |

### Q_Sensor_API

| Component | File | Lines | Description |
|-----------|------|-------|-------------|
| **Endpoints** | api/main.py | | |
| - POST /sensor/connect | | 315-354 | connect() |
| - POST /disconnect | | 581-614 | disconnect() |
| - GET /instrument/health | | 1091-1126 | get_instrument_health() |
| - POST /sensor/start | | 409-456 | start_acquisition() |
| - POST /sensor/stop | | 545-578 | stop_acquisition() |
| - POST /record/start | | 874-945 | start_chunked_recording() |
| - POST /record/stop | | 948-994 | stop_chunked_recording() |
| - GET /record/snapshots | | 1031-1050 | get_chunk_snapshots() |
| - GET /files/{id}/{file} | | 1053-1088 | download_chunk_file() |
| - Route aliases | | 796-805 | add_api_route() for /sensor/* |
| **Controller** | q_sensor_lib/controller.py | | |
| - Connect logic | | 292-383 | connect() - enter menu, parse config |
| - Start acquisition | | 386-435 | start_acquisition() |
| - Freerun mode | | 425-428, 733-742 | _start_freerun_thread() |
| - Polled mode | | 430-434, 744-779 | _start_polled_thread() |
| - Freerun reader | | 793-854 | _freerun_reader() |
| - Polled reader | | 856-918 | _polled_reader() |
| **Data Store** | data_store/store.py | | |
| - ChunkedDataStore | | 447-732 | class ChunkedDataStore |
| - Append readings | | 521-565 | append_readings() |
| - Finalize chunk | | 608-669 | _finalize_chunk() |
| - Snapshot list | | 677-689 | snapshot_list() |
| - Shutdown order comment | | 318-319 | Critical order: recorder → controller |

---

## Conclusion

The recording chain is **fundamentally sound** - the architecture is correct, and both Pi-side recording and topside mirroring work as designed. The primary issues were:

1. **URL construction bugs** - ✅ Fixed in qsensor-control.ts
2. **Missing `/sensor/disconnect` alias** - ✅ Client now uses `/disconnect`
3. **No stabilization delay** - ⚠️ Recommended to add 2s delay after `/sensor/start`
4. **Mode awareness** - ✅ Acceptable for freerun MVP (poll_hz ignored anyway)

**Next Steps**:
1. Apply Fix #1 (stabilization delay) - recommended but not critical
2. Test full recording flow end-to-end
3. Verify chunks appear in storage folder after 60-90s
4. Monitor console logs for any remaining 404 errors
5. Consider implementing Fix #2 (send poll_hz) for future polled mode support

**Expected Outcome**: With current fixes, recording should work reliably in freerun mode with no 404 errors and chunks appearing every 60s.
