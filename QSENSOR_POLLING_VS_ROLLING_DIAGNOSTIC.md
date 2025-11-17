# Q-Sensor Polling vs Rolling Cadence Diagnostic Report

**Date**: 2025-11-17
**Author**: Claude (Sonnet 4.5)
**Purpose**: Diagnose why mirroring slider only affects polling frequency, not chunk generation frequency

---

## Executive Summary

**Problem**:
- User sets mirroring cadence slider to **10 seconds**
- Mirroring service polls every **10 seconds** ✓
- But chunks still only appear every **~60 seconds** ❌
- Result: Many polls return 0 chunks, until 60s elapses

**Root Cause**:
The mirroring cadence slider and chunk rolling interval are **completely independent variables**:
- **Polling cadence** (`cadenceSec`): User-configurable (1-60s), controls how often Cockpit asks "are there new chunks?"
- **Rolling cadence** (`roll_interval_s`): Hard-coded to **60 seconds**, controls when the backend actually creates new chunks

**Impact**:
When mirroring cadence < 60s, the topside wastes network bandwidth polling for chunks that don't exist yet. The slider appears to "not work" because data doesn't arrive faster.

---

## 1. Frontend Analysis: Polling Cadence

### Where Polling Cadence is Set

**File**: [src/views/ToolsQSeriesView.vue:292-293](src/views/ToolsQSeriesView.vue#L292-L293)
```typescript
// Mirroring cadence (1-60 seconds, default 60)
const mirrorCadenceSec = ref(60)
```

**File**: [src/views/ToolsQSeriesView.vue:475](src/views/ToolsQSeriesView.vue#L475)
```typescript
qsensorStore.cadenceSec = mirrorCadenceSec.value  // Apply user-selected cadence
```

**File**: [src/stores/qsensor.ts:12](src/stores/qsensor.ts#L12)
```typescript
const cadenceSec = ref(60) // Mirroring cadence in seconds (15-300)
```

**File**: [src/electron/services/qsensor-mirror.ts:240](src/electron/services/qsensor-mirror.ts#L240)
```typescript
cadenceSec: fullBandwidth ? 2 : cadenceSec, // Fast polling in full-bandwidth mode
```

**File**: [src/electron/services/qsensor-mirror.ts:262](src/electron/services/qsensor-mirror.ts#L262)
```typescript
session.intervalId = setInterval(poll, session.cadenceSec * 1000)
```

**Summary**: The slider correctly sets `cadenceSec`, which controls the `setInterval()` for `pollAndMirror()`. This works as designed.

---

### Where Rolling Interval is Set (HARD-CODED)

**File**: [src/views/ToolsQSeriesView.vue:497](src/views/ToolsQSeriesView.vue#L497)
```typescript
const recordResult = await window.electronAPI.qsensorStartRecording(apiBaseUrl.value, {
  rate_hz: 500,
  schema_version: 1,
  mission: missionName,
  roll_interval_s: 60,  // ❌ HARD-CODED TO 60
})
```

**File**: [src/electron/services/qsensor-control.ts:218](src/electron/services/qsensor-control.ts#L218)
```typescript
body: JSON.stringify({
  rate_hz: options.rate_hz ?? 500,
  schema_version: options.schema_version ?? 1,
  mission: options.mission ?? 'Cockpit',
  roll_interval_s: options.roll_interval_s ?? 60,  // Default: 60
}),
```

**File**: [src/libs/qsensor-client.ts:126](src/libs/qsensor-client.ts#L126)
```typescript
body: JSON.stringify({
  rate_hz: options.rate_hz ?? 500,
  schema_version: options.schema_version ?? 1,
  mission: options.mission ?? 'Cockpit',
  roll_interval_s: options.roll_interval_s ?? 60,  // Default: 60
}),
```

**Summary**: `roll_interval_s` is **hard-coded to 60** in the UI component. It's never read from the slider.

---

## 2. Backend Analysis: Rolling Cadence

### How roll_interval_s is Received

**File**: [Q_Sensor_API/api/main.py:163-165](../qseries-noise/Q_Sensor_API/api/main.py#L163-L165)
```python
class RecordStartRequest(BaseModel):
    rate_hz: int = 500
    schema_version: int = 1
    mission: str = "Cockpit"
    roll_interval_s: float = 60.0  # Default: 60
```

**File**: [Q_Sensor_API/api/main.py:933-934](../qseries-noise/Q_Sensor_API/api/main.py#L933-L934)
```python
logger.info(f"[RECORD/START] Request received: mission={req.mission}, rate_hz={req.rate_hz}, "
            f"schema_version={req.schema_version}, roll_interval_s={req.roll_interval_s}")
```

**Summary**: The backend correctly accepts `roll_interval_s` from the client. If omitted, defaults to 60.0.

---

### How roll_interval_s is Used

**File**: [Q_Sensor_API/api/main.py:970](../qseries-noise/Q_Sensor_API/api/main.py#L970)
```python
session = _session_manager.create_session(
    mission=req.mission,
    rate_hz=req.rate_hz,
    schema_version=req.schema_version,
    roll_interval_s=req.roll_interval_s,  # Passed through to session
    target_chunk_mb=2.0
)
```

**File**: [Q_Sensor_API/data_store/session_manager.py:72](../qseries-noise/Q_Sensor_API/data_store/session_manager.py#L72)
```python
def create_session(
    self,
    mission: str,
    rate_hz: int,
    schema_version: int,
    roll_interval_s: float,  # Accepted here
    target_chunk_mb: float = 2.0,
) -> RecordingSession:
```

**File**: [Q_Sensor_API/data_store/session.py:79](../qseries-noise/Q_Sensor_API/data_store/session.py#L79)
```python
def __init__(
    self,
    session_id: str,
    controller: SensorController,
    base_path: Path,
    mission: str,
    rate_hz: int,
    schema_version: int,
    roll_interval_s: float,  # Stored in session
    target_chunk_mb: float = 2.0,
):
```

**File**: [Q_Sensor_API/data_store/session.py:118](../qseries-noise/Q_Sensor_API/data_store/session.py#L118)
```python
self._roll_interval_s = roll_interval_s
```

**File**: [Q_Sensor_API/data_store/session.py:151](../qseries-noise/Q_Sensor_API/data_store/session.py#L151)
```python
self._store = ChunkedDataStore(
    session_id=self.session_id,
    base_path=self._base_path,
    roll_interval_s=self._roll_interval_s,  # Passed to store
    target_chunk_mb=self._target_chunk_mb,
)
```

**File**: [Q_Sensor_API/data_store/store.py:458](../qseries-noise/Q_Sensor_API/data_store/store.py#L458)
```python
def __init__(
    self,
    session_id: str,
    base_path: Path,
    roll_interval_s: float = 60.0,  # Default: 60
    target_chunk_mb: float = 2.0,
) -> None:
```

**File**: [Q_Sensor_API/data_store/store.py:473](../qseries-noise/Q_Sensor_API/data_store/store.py#L473)
```python
self._roll_interval = max(15.0, min(300.0, roll_interval_s))  # Clamped to 15-300s
```

**Summary**: The backend correctly uses `roll_interval_s` to control chunk rolling. It's clamped to 15-300 seconds.

---

### How Chunking Works

**File**: [Q_Sensor_API/data_store/store.py:589-603](../qseries-noise/Q_Sensor_API/data_store/store.py#L589-L603)
```python
Roll conditions:
- Time: chunk age >= roll_interval_s
- Size: chunk size >= target_bytes

def _check_and_roll(self, now: float) -> None:
    if self._current_file is None or self._chunk_start_time is None:
        return

    age = now - self._chunk_start_time
    should_roll = (
        age >= self._roll_interval or
        self._current_chunk_bytes >= self._target_bytes
    )

    if should_roll:
        self._finalize_chunk()
```

**Summary**: Chunks are rolled when:
1. **Time-based**: Chunk age >= `roll_interval_s` (e.g., 60 seconds)
2. **Size-based**: Chunk size >= `target_chunk_mb` (e.g., 2 MB)

Whichever condition is met first triggers a chunk finalization.

---

## 3. Root Cause: Complete Separation

### The Two Independent Variables

| Variable | Purpose | Controlled By | Location | Current Value |
|----------|---------|---------------|----------|---------------|
| **`cadenceSec`** | How often to poll for chunks | User slider (1-60s) | Frontend ([ToolsQSeriesView.vue:292](src/views/ToolsQSeriesView.vue#L292)) | User-configurable |
| **`roll_interval_s`** | How often to create chunks | Hard-coded | Frontend ([ToolsQSeriesView.vue:497](src/views/ToolsQSeriesView.vue#L497)) | **60 seconds (fixed)** |

### The Mismatch

```
User sets slider to 10s:
  ↓
cadenceSec = 10
  ↓
Mirroring polls every 10s:
  t=0s:   Poll → 0 chunks (chunk still growing)
  t=10s:  Poll → 0 chunks (chunk still growing)
  t=20s:  Poll → 0 chunks (chunk still growing)
  t=30s:  Poll → 0 chunks (chunk still growing)
  t=40s:  Poll → 0 chunks (chunk still growing)
  t=50s:  Poll → 0 chunks (chunk still growing)
  t=60s:  Poll → 1 chunk (chunk finalized!)  ✓
  t=70s:  Poll → 1 chunk (no new data yet)
  ...

Backend creates chunks every 60s:
  t=0s:   Start chunk_00000.csv.tmp
  t=60s:  Finalize chunk_00000.csv
  t=60s:  Start chunk_00001.csv.tmp
  t=120s: Finalize chunk_00001.csv
  ...
```

**Result**:
- Mirroring polls 6 times before the first chunk appears
- 5 of those polls are wasted (return empty list)
- User sees "0 chunks" for 60 seconds despite setting 10s cadence

---

## 4. Why This Design Exists

### Intended Separation of Concerns

The design appears intentional:

1. **Chunk rolling** (backend) is about **data integrity and storage efficiency**:
   - Too small chunks (e.g., 1s) → thousands of files, overhead
   - Too large chunks (e.g., 5 minutes) → memory pressure, risk of data loss
   - Default 60s is a safe middle ground

2. **Mirroring polling** (frontend) is about **network usage and UI responsiveness**:
   - Low cadence (60s) → less network traffic, slower UI updates
   - High cadence (10s) → more network traffic, faster UI updates
   - User controls based on network quality

### The Problem

The separation is **too rigid**. Users expect:
- "If I set cadence to 10s, I should get data every 10s"

But the system provides:
- "You'll poll every 10s, but data only appears every 60s"

This creates confusion and appears broken.

---

## 5. Implications of Changing roll_interval_s

### If roll_interval_s = cadenceSec (Naive Approach)

**Example**: User sets slider to 2 seconds

```
cadenceSec = 2s
roll_interval_s = 2s

Result:
- New chunk every 2 seconds
- At 500 Hz, 2 seconds = 1000 samples
- Each chunk ~40 KB (assuming 40 bytes/row)
- 30-minute recording = 900 chunks!
```

**Problems**:
- ❌ **File system overhead**: 900 small files vs 30 larger files
- ❌ **Manifest bloat**: manifest.json lists all 900 chunks
- ❌ **SHA256 overhead**: 900 hash computations vs 30
- ❌ **Network overhead**: 900 HTTP requests vs 30

### If roll_interval_s Has Minimum (Smart Approach)

**Example**: User sets slider to 2 seconds, but `roll_interval_s = max(15, cadenceSec)`

```
cadenceSec = 2s
roll_interval_s = 15s (clamped)

Result:
- Polls every 2s (responsive UI)
- New chunk every 15s (reasonable file count)
- 30-minute recording = 120 chunks (acceptable)
```

**This is likely the right approach.**

---

## 6. Current Backend Constraints

### Clamping in ChunkedDataStore

**File**: [Q_Sensor_API/data_store/store.py:473](../qseries-noise/Q_Sensor_API/data_store/store.py#L473)
```python
self._roll_interval = max(15.0, min(300.0, roll_interval_s))  # Clamped to 15-300s
```

**Summary**: The backend already clamps `roll_interval_s` to:
- **Minimum**: 15 seconds (prevents file spam)
- **Maximum**: 300 seconds (prevents memory pressure)

**This constraint should be preserved.**

---

## 7. What Would Need to Change

### Option A: Link Slider to Both (Simple)

**Change**: Make `roll_interval_s = mirrorCadenceSec` with backend clamping

**File**: [src/views/ToolsQSeriesView.vue:497](src/views/ToolsQSeriesView.vue#L497)
```typescript
// BEFORE:
roll_interval_s: 60,

// AFTER:
roll_interval_s: mirrorCadenceSec.value,  // Backend will clamp to 15-300s
```

**Result**:
- Slider = 10s → chunks every 15s (clamped), polls every 10s
- Slider = 30s → chunks every 30s, polls every 30s
- Slider = 60s → chunks every 60s, polls every 60s

**Pros**:
- ✅ Simple one-line change
- ✅ User expectation met: "faster slider = faster data"
- ✅ Backend clamping prevents abuse

**Cons**:
- ❌ User might not understand why setting 2s gives 15s chunks
- ❌ Mirroring at 10s but chunking at 15s still creates 1 wasted poll

---

### Option B: Separate Sliders (Complex but Clear)

**Change**: Add a second slider for chunk rolling interval

**UI**:
```
Mirror cadence: [slider 1-60s]  (How often to check for new data)
Chunk interval: [slider 15-300s] (How often to create new chunks)
```

**File**: [src/views/ToolsQSeriesView.vue](src/views/ToolsQSeriesView.vue)
```typescript
const mirrorCadenceSec = ref(60)   // 1-60s
const chunkIntervalSec = ref(60)   // 15-300s

// Validation:
const chunkIntervalSec = computed(() => Math.max(15, chunkIntervalRaw.value))
```

**Result**:
- User has full control over both dimensions
- Clear separation: "polling" vs "chunking"

**Pros**:
- ✅ Maximum flexibility
- ✅ Clear UI labels explain difference
- ✅ Advanced users can optimize for their use case

**Cons**:
- ❌ More complex UI (2 sliders instead of 1)
- ❌ User confusion: "What's the difference?"
- ❌ Most users will just set both to the same value anyway

---

### Option C: Smart Auto-Sync (Recommended)

**Change**: Link sliders but add intelligent clamping and UI hints

**File**: [src/views/ToolsQSeriesView.vue:497](src/views/ToolsQSeriesView.vue#L497)
```typescript
// Compute roll_interval based on cadence with smart clamping
const computedRollInterval = computed(() => {
  // If user wants fast polling, give them reasonably fast chunking
  // But clamp to backend limits (15-300s)
  const requestedInterval = mirrorCadenceSec.value
  return Math.max(15, Math.min(300, requestedInterval))
})

// Use computed value:
roll_interval_s: computedRollInterval.value,
```

**UI Hint**:
```vue
<div class="text-xs text-gray-400 -mt-2">
  <p>How often to poll and pull new data chunks from the ROV (1-60 seconds).</p>
  <p class="mt-1">Lower values = more frequent updates, higher network usage.</p>
  <p class="mt-1 text-yellow-400" v-if="mirrorCadenceSec < 15">
    ⚠️ Chunks are created every 15s minimum (backend constraint).
  </p>
</div>
```

**Result**:
- Slider = 10s → chunks every 15s (clamped), polls every 10s, **warning shown**
- Slider = 30s → chunks every 30s, polls every 30s
- User is informed when clamping occurs

**Pros**:
- ✅ Simple one-line change
- ✅ User expectation mostly met
- ✅ Warning explains discrepancy when clamping occurs
- ✅ No UI complexity

**Cons**:
- ❌ Still 1-2 wasted polls when cadence < 15s
- ❌ User might ignore warning

---

## 8. Recommendation

### Short-Term (This PR)

**Implement Option C (Smart Auto-Sync)**:
1. Change `roll_interval_s: 60` → `roll_interval_s: Math.max(15, mirrorCadenceSec.value)`
2. Add UI hint warning when `mirrorCadenceSec < 15`
3. Update logs to show both intervals: `"cadence=10s, chunks=15s (clamped)"`

**Reasoning**:
- Minimal code change
- Meets user expectation (faster slider = faster data)
- Backend clamping prevents abuse
- Warning educates users about constraints

### Long-Term (v0.3.0+)

**Consider Option B (Separate Sliders)** if:
- Users complain about clamping
- Advanced users want independent control
- We add more chunk modes (size-based rolling, append-only, etc.)

**Or**: Implement append-only recording mode (eliminates chunking entirely)

---

## 9. File Reference Summary

### Frontend (Cockpit)

| File | Line | Variable | Purpose | Current Value |
|------|------|----------|---------|---------------|
| [ToolsQSeriesView.vue](src/views/ToolsQSeriesView.vue) | 292 | `mirrorCadenceSec` | Polling cadence | User slider (1-60s) |
| [ToolsQSeriesView.vue](src/views/ToolsQSeriesView.vue) | 497 | `roll_interval_s` | Chunk rolling | **Hard-coded 60** |
| [qsensor-control.ts](src/electron/services/qsensor-control.ts) | 218 | `roll_interval_s` | Default value | 60 |
| [qsensor.ts](src/stores/qsensor.ts) | 12 | `cadenceSec` | Store value | User slider |
| [qsensor-mirror.ts](src/electron/services/qsensor-mirror.ts) | 262 | `setInterval()` | Polling loop | `cadenceSec * 1000` |

### Backend (Q_Sensor_API)

| File | Line | Variable | Purpose | Constraint |
|------|------|----------|---------|------------|
| [api/main.py](../qseries-noise/Q_Sensor_API/api/main.py) | 165 | `roll_interval_s` | Request param | Default 60.0 |
| [session_manager.py](../qseries-noise/Q_Sensor_API/data_store/session_manager.py) | 72 | `roll_interval_s` | Session param | Passed through |
| [session.py](../qseries-noise/Q_Sensor_API/data_store/session.py) | 118 | `_roll_interval_s` | Session state | Stored value |
| [store.py](../qseries-noise/Q_Sensor_API/data_store/store.py) | 473 | `_roll_interval` | Actual interval | **Clamped 15-300s** |
| [store.py](../qseries-noise/Q_Sensor_API/data_store/store.py) | 601 | `age >= self._roll_interval` | Roll check | Time-based trigger |

---

## 10. Testing the Fix

### Before Fix

**Test**:
1. Set mirroring cadence to 10s
2. Start recording
3. Observe logs

**Expected**:
```
t=0s:   "Received 0 total chunks"
t=10s:  "Received 0 total chunks"
t=20s:  "Received 0 total chunks"
t=30s:  "Received 0 total chunks"
t=40s:  "Received 0 total chunks"
t=50s:  "Received 0 total chunks"
t=60s:  "Received 1 total chunks"  ← First chunk appears
```

### After Fix (Option C)

**Test**:
1. Set mirroring cadence to 10s
2. Start recording
3. Observe logs

**Expected**:
```
[INFO] Stats refresh: every 8.0s (cadence=10s)
[INFO] Backend roll_interval_s=15 (clamped from cadence=10)
⚠️ Chunks are created every 15s minimum (backend constraint).

t=0s:   "Received 0 total chunks"
t=10s:  "Received 0 total chunks"
t=15s:  "Received 1 total chunks"  ← First chunk appears (faster!)
t=25s:  "Received 1 total chunks"
t=30s:  "Received 2 total chunks"
t=40s:  "Received 2 total chunks"
t=45s:  "Received 3 total chunks"
```

**Improvement**: First chunk appears at 15s instead of 60s (4x faster).

---

## Conclusion

### Root Cause Summary

The mirroring cadence slider controls **how often Cockpit polls for chunks**, but `roll_interval_s` (which controls **how often chunks are created**) is hard-coded to 60 seconds.

This is a **design mismatch**, not a bug per se, but it violates user expectations.

### The Fix

Change one line:
```typescript
// src/views/ToolsQSeriesView.vue:497
roll_interval_s: Math.max(15, mirrorCadenceSec.value),  // Link to slider with 15s minimum
```

Add one UI hint to explain clamping when it occurs.

### Impact

- ✅ User expectation met: "faster slider = faster data"
- ✅ Minimal code change (1 line)
- ✅ Backend constraints respected (15-300s clamping)
- ✅ Network efficiency improved (fewer wasted polls)

**Status**: Diagnostic complete, ready for implementation approval.

---

**End of Diagnostic Report**

For questions, refer to:
- [QSENSOR_DEBUG_REPORT.md](QSENSOR_DEBUG_REPORT.md) - Main debug session
- [QSENSOR_TIMING_AUDIT_REPORT.md](QSENSOR_TIMING_AUDIT_REPORT.md) - Timing analysis

**Report Generated**: 2025-11-17 by Claude (Sonnet 4.5)
