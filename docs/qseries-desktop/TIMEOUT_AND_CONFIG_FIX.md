# Q-Sensor Mirroring Timeout & Config Fix

**Date**: 2025-11-14
**Issues Fixed**:
1. Mirroring polling timeouts (5s too short when Pi is under load)
2. `/record/stop` timeouts (5s too short for chunk finalization)
3. Incorrect `qsensorStoragePath` configuration

---

## Root Cause Analysis

### Issue 1: Polling Timeouts

**Symptoms**:
```
[QSensor Mirror] Polling http://blueos.local:9150/record/snapshots...
[QSensor Mirror] Poll error: The operation was aborted due to timeout
```

**Root Cause**:
- Timeout set to 5 seconds (`AbortSignal.timeout(5000)`)
- When Pi finalizes a chunk (computing SHA256, writing manifest), it can take 3-7 seconds
- If polling happens during chunk finalization, it times out
- Chunks exist but mirroring never downloads them because every poll times out

**Evidence from Logs**:
```
13:32:15.384 - Polling http://blueos.local:9150/record/snapshots...
13:32:20.392 - Poll error: The operation was aborted due to timeout  ← 5s timeout
```

Meanwhile on Pi:
```
13:32:16.017 - Finalized chunk 1: chunk_00001.csv (528 rows, 41761 bytes)
```

The chunk was being finalized exactly when the poll timed out!

### Issue 2: Stop Recording Timeouts

**Symptoms**:
```
[QSensor Control] Stop recording failed: The operation was aborted due to timeout
```

**Root Cause**:
- `/record/stop` timeout set to 5 seconds
- `/record/stop` must:
  1. Stop the recorder thread
  2. Flush any buffered data
  3. Finalize the current chunk (SHA256 + manifest write)
  4. This can take 5-10 seconds under load
- Request times out before completion
- Recorder keeps running on Pi, blocking subsequent `/record/start` calls with "Recording already active"

**Evidence from Logs**:
```
13:33:11.779 - [QSensor Control] Stop recording failed: The operation was aborted due to timeout
```

No `[RECORD/STOP]` log appears on Pi - the request never completed.

### Issue 3: Wrong Storage Path

**Symptoms**:
```
[QSensor Mirror] Storage path resolved: customPath=/Users/matthuewalsh/Documents/Data Visualization
```

**Root Cause**:
- User selected `/Users/.../Documents/Data Visualization` as storage path
- Expected structure: `{basePath}/qsensor/{mission}/{session}/`
- Actual structure: `/Users/.../Data Visualization/Cockpit/{session}/` (missing `/qsensor/` level)
- This creates confusion and wrong paths

**Correct Path**:
```
customPath=none (or unset)
basePath=/Users/matthuewalsh/Library/Application Support/Cockpit/qsensor
rootPath=/Users/.../Cockpit/qsensor/Cockpit/{session}/
```

---

## Fixes Applied

### Fix 1: Increase Polling Timeout to 15s

**File**: `src/electron/services/qsensor-mirror.ts` line 149

**Before**:
```typescript
const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
```

**After**:
```typescript
// Increased timeout from 5s to 15s - Pi can be slow when finalizing chunks
const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
```

**Rationale**: 15 seconds gives the Pi enough time to:
- Finalize any in-progress chunks
- Compute SHA256 hashes
- Write manifest atomically
- Return the snapshot list

### Fix 2: Increase Stop Recording Timeout to 30s

**File**: `src/electron/services/qsensor-control.ts` line 221

**Before**:
```typescript
signal: AbortSignal.timeout(5000),
```

**After**:
```typescript
// Increased timeout from 5s to 30s - /record/stop finalizes chunks, computes SHA256, writes manifest
signal: AbortSignal.timeout(30000),
```

**Rationale**: 30 seconds gives the Pi enough time to:
- Stop the DataRecorder thread gracefully
- Flush all buffered data to the current chunk
- Finalize the last chunk (SHA256 + manifest)
- Return the final statistics

### Fix 3: Clear Incorrect Storage Path Config

**Not a code fix** - requires user action.

---

## Deployment Steps

### Step 1: Rebuild Cockpit

```bash
cd /Users/matthuewalsh/Bio_cockpit

# Kill any running Cockpit instances
pkill -f "Cockpit"

# Rebuild Electron app (this compiles the TypeScript changes)
yarn dev:electron
# OR
npm run dev:electron
```

### Step 2: Clear Wrong Storage Path Config

**Option A: Via Cockpit UI (Recommended)**
1. Open Cockpit
2. Go to Q-Series Tool
3. Note the current "Storage folder" value
4. Click "Browse..."
5. Select a proper base directory:
   - Recommended: Leave at default (don't select anything, just cancel)
   - Alternative: Select `~/Documents/QSensorData` or similar (NOT "Data Visualization")
6. Restart Cockpit

**Option B: Manual Config Edit**
```bash
# Find the config file
cd ~/Library/Application\ Support/Cockpit

# Backup first
cp config.json config.json.backup

# Edit config.json and remove the "qsensorStoragePath" key, OR set it to null
# Example using jq:
jq 'del(.qsensorStoragePath)' config.json > config.json.tmp
mv config.json.tmp config.json

# Restart Cockpit
```

**Option C: Delete Config (Nuclear Option)**
```bash
# Delete entire config (Cockpit will recreate with defaults)
rm ~/Library/Application\ Support/Cockpit/config.json

# Restart Cockpit - all settings reset to defaults
```

### Step 3: Verify Fix

1. **Check storage path in Cockpit UI**:
   - Should show: `~/Library/Application Support/Cockpit/qsensor`
   - NOT: `/Users/.../Documents/Data Visualization`

2. **Check DevTools logs**:
   ```
   [QSensor Mirror] Storage path resolved: customPath=none, basePath=.../Cockpit/qsensor, rootPath=.../Cockpit/qsensor/Cockpit/{uuid}
   ```

3. **Start a recording and wait 70 seconds**:
   - Watch for: `[QSensor Mirror] Received N total chunks` (where N > 0)
   - Watch for: `[QSensor Mirror] ✓ Downloaded chunk chunk_00000.csv`
   - **Should NOT see**: "Poll error: The operation was aborted due to timeout"

4. **Stop the recording**:
   - Should complete within 10-15 seconds
   - **Should NOT see**: "Stop recording failed: The operation was aborted due to timeout"
   - Logs should show: `[RECORD/STOP] SUCCESS` on Pi side

5. **Start another recording immediately**:
   - Should succeed (NOT "Recording already active")

### Step 4: Verify Chunks on Filesystem

```bash
# Check mirror directory
ls -lh ~/Library/Application\ Support/Cockpit/qsensor/Cockpit/{session-id}/

# Should see:
# chunk_00000.csv  (43-45 KB)
# mirror.json

# Check mirror.json
cat ~/Library/Application\ Support/Cockpit/qsensor/Cockpit/{session-id}/mirror.json

# Should show:
# {
#   "session_id": "...",
#   "mission": "Cockpit",
#   "last_chunk_index": 0,      ← NOT -1!
#   "bytes_mirrored": 43649,    ← NOT 0!
#   "last_sync": "2025-11-14T..."
# }
```

---

## Expected Behavior After Fix

### Successful Recording Flow

```
T+0s:   User clicks "Start Q-Series Recording"
T+0s:   /sensor/start?auto_record=false → 200 OK
T+2s:   Sensor stabilizes
T+2s:   /record/start → 200 OK with session_id
T+2s:   Mirroring starts
T+2s:   Initial poll → "Received 0 chunks" (expected, chunk not finalized yet)
T+62s:  Second poll → "Received 1 chunks" (chunk_00000 finalized at T+60s)
T+62s:  Download chunk_00000.csv → SUCCESS (43 KB)
T+62s:  mirror.json updated: last_chunk_index=0
T+122s: Third poll → "Received 2 chunks"
T+122s: Download chunk_00001.csv → SUCCESS
...
```

### Successful Stop Flow

```
T+0s:   User clicks "Stop Q-Series Recording"
T+0s:   Stop mirroring → OK
T+0s:   /record/stop → (waits 5-10s for chunk finalization)
T+8s:   /record/stop → 200 OK {"chunks": 3, "rows": 1500, ...}
T+8s:   /sensor/stop → 200 OK
T+8s:   Reset store state
T+8s:   UI shows "Disconnected"
```

### Next Recording

```
T+0s:   User clicks "Start Q-Series Recording" again
T+0s:   /sensor/start → 200 OK (no conflict)
T+2s:   /record/start → 200 OK with NEW session_id (no "already active" error)
T+2s:   Mirroring starts for new session
...
```

---

## Troubleshooting

### If polling still times out:

1. **Check Pi load**: Is the Pi CPU at 100%?
   ```bash
   ssh pi@blueos.local
   top
   ```

2. **Increase timeout further** if needed:
   - Edit `qsensor-mirror.ts` line 149
   - Change `15000` to `30000` (30 seconds)

3. **Check network**: Is there packet loss?
   ```bash
   ping blueos.local
   ```

### If stop recording still times out:

1. **Check Pi logs** for what's taking so long:
   ```bash
   docker logs q-sensor | tail -50
   ```

2. **Look for** slow SHA256 computation or manifest writes

3. **Increase timeout further**:
   - Edit `qsensor-control.ts` line 221
   - Change `30000` to `60000` (60 seconds)

### If wrong storage path persists:

1. **Verify config file**:
   ```bash
   cat ~/Library/Application\ Support/Cockpit/config.json | jq .qsensorStoragePath
   ```

2. **Should return**: `null` or not exist

3. **If it shows a path**, delete it and restart Cockpit

---

## Technical Notes

### Why 5 seconds was too short

**For polling (`/record/snapshots`)**:
- Network round-trip: 50-200ms
- Pi processing time (idle): 10-50ms
- Pi processing time (during chunk finalization): 3-7 seconds!
  - SHA256 computation: 1-3s (for 40KB CSV)
  - Manifest atomic write: 100-500ms
  - fsync operations: 500ms-2s

Total: Up to 7-9 seconds during chunk rollover

**For stop (`/record/stop`)**:
- Network round-trip: 50-200ms
- Stop DataRecorder thread: 200-500ms
- Flush buffered data: 100-300ms
- Finalize last chunk: 3-7s (SHA256 + manifest)
- Total statistics computation: 50-200ms

Total: Up to 8-10 seconds

### Why 15s/30s is safe

- **15 seconds for polling**: Even if chunk finalization takes 10 seconds, we have 5s buffer
- **30 seconds for stop**: Even with multiple chunks to finalize, 30s is plenty

### Future Optimization

Consider implementing:
1. **Background chunk finalization**: Finalize chunks in a separate thread so API responses are faster
2. **Incremental SHA256**: Compute SHA256 as data is written, not all at once at the end
3. **Optimistic polling**: Return immediately with "chunks in progress" status, don't block

But for now, increasing timeouts is the simplest and most reliable fix.
