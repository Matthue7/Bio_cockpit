# Q-Sensor Mirroring Debug Guide

**Date**: 2025-11-14
**Issue**: Mirroring service creates `mirror.json` but doesn't download chunks

## Quick Diagnostic Checklist

### 1. Check Storage Path Configuration

The mirroring service needs a proper base path. Run this test:

```bash
# Check what storage path is configured
# Look in Cockpit UI: Q-Series Tool → Storage folder

# Expected: ~/Library/Application Support/Cockpit/qsensor
# Problem: /Users/.../Documents/Data Visualization (wrong!)
```

**Fix**: In Cockpit UI, click "Browse..." and select a proper base directory, OR leave it at default.

### 2. Verify Path Structure

After starting a recording, check if the path structure is correct:

```bash
# CORRECT structure:
~/Library/Application Support/Cockpit/qsensor/
  └── Cockpit/                    ← mission name
      └── {session-id}/           ← UUID
          ├── mirror.json
          ├── chunk_00000.csv
          └── chunk_00001.csv

# WRONG structure (indicates config problem):
/Users/.../Documents/Data Visualization/
  └── Cockpit/                    ← mission name (MISSING qsensor dir)
      └── {session-id}/           ← UUID (wrong parent)
          └── mirror.json         ← exists but no chunks
```

### 3. Check Electron Logs

Open DevTools in Cockpit (View → Developer → Toggle Developer Tools), then check Console for these log lines:

#### Expected Log Sequence

```
[QSensor Mirror] Service registered
[QSensor Mirror] IPC start request: session=<uuid>, vehicle=blueos.local, cadence=60s, fullBandwidth=false
[QSensor Mirror] startMirrorSession() called: session=<uuid>, vehicle=blueos.local, mission=Cockpit
[QSensor Mirror] Storage path resolved: customPath=none, basePath=.../Cockpit/qsensor, rootPath=.../Cockpit/qsensor/Cockpit/<uuid>
[QSensor Mirror] Created directory: .../Cockpit/qsensor/Cockpit/<uuid>
[QSensor Mirror] Loaded metadata: lastChunk=-1, bytes=0
[QSensor Mirror] Session <uuid> added to active sessions map
[QSensor Mirror] Will poll: http://blueos.local:9150/record/snapshots?session_id=<uuid> every 60s
[QSensor Mirror] Running initial poll...
[QSensor Mirror] Polling interval 1 started (cadence=60s)
[QSensor Mirror] Started session <uuid>: cadence=60s, path=...
[QSensor Mirror] Polling http://blueos.local:9150/record/snapshots?session_id=<uuid>...
[QSensor Mirror] Received 1 total chunks, lastChunkIndex=-1
[QSensor Mirror] Found 1 new chunks for session <uuid>
[QSensor Mirror] Attempting to download chunk 0: chunk_00000.csv (43649 bytes, sha256=ba4488f1...)
[QSensor Mirror] Downloading http://blueos.local:9150/files/<uuid>/chunk_00000.csv -> .../chunk_00000.csv.tmp
[QSensor Mirror] Received 43649 bytes, writing to .../chunk_00000.csv.tmp
[QSensor Mirror] SHA256 verified: ba4488f1...
[QSensor Mirror] Renamed .../chunk_00000.csv.tmp -> .../chunk_00000.csv
[QSensor Mirror] ✓ Downloaded chunk chunk_00000.csv: 43649 bytes (total mirrored: 43649)
[QSensor Mirror] Writing mirror.json: lastChunk=0, bytes=43649
[QSensor Mirror] Poll complete for session <uuid>
```

#### Problem Indicators

**If you see NO logs at all after "Service registered"**:
- The IPC call `startQSensorMirror()` is not being invoked
- Check if `qsensorStore.start()` is being called in Vue component
- Check browser console for errors in renderer process

**If you see logs up to "Created directory" but nothing after**:
- Check if there's an error loading metadata
- Look for uncaught exceptions in DevTools console

**If you see "Polling..." but "Received 0 total chunks"**:
- Pi API is not returning chunks from `/record/snapshots`
- Check Pi logs for errors in ChunkedDataStore
- Verify chunks are actually being written to Pi storage

**If download fails with HTTP errors**:
- Check vehicle address (should be `blueos.local` or Pi IP)
- Verify port 9150 is accessible
- Test manually: `curl http://blueos.local:9150/files/{session-id}/chunk_00000.csv`

**If SHA256 mismatch**:
- Network corruption during transfer
- Pi and topside clocks out of sync (unlikely but possible)
- Retry should succeed on next poll

## Common Problems and Solutions

### Problem 1: Wrong Storage Path

**Symptoms**:
- `mirror.json` appears in unexpected location
- Path missing `/qsensor/{mission}/` structure
- Log shows `customPath=/Users/.../Documents/...` instead of `customPath=none`

**Root Cause**:
The `qsensorStoragePath` config key is set to a wrong value (possibly an old setting or user selected wrong directory).

**Solution**:
1. Open Cockpit Q-Series Tool
2. Note the current "Storage folder" value
3. Click "Browse..."
4. Select a proper base directory (e.g., `~/Documents/QSensorData`)
5. **OR** manually clear the config:
   ```bash
   # Find config file
   ~/Library/Application Support/Cockpit/config.json

   # Edit and remove "qsensorStoragePath" key, OR set to null
   ```
6. Restart Cockpit
7. Verify it now shows default: `~/Library/Application Support/Cockpit/qsensor`

### Problem 2: Polling Never Starts

**Symptoms**:
- Log shows "Started session..." but never "Polling..."
- No errors, just silence
- `mirror.json` exists but stays at `last_chunk_index: -1`

**Root Cause**:
The `setInterval()` call succeeded but the poll function is never executing, OR it's executing but failing silently.

**Debug**:
1. Check if `session.running` is true
2. Look for uncaught promise rejections
3. Verify `fetch()` is available in Electron main process

**Solution**:
- If this happens, it's likely a timing bug or the session was stopped immediately after starting
- Check if `stopMirrorSession()` is being called right after `startMirrorSession()`

### Problem 3: Network Errors

**Symptoms**:
- Log shows "Download failed: HTTP 404" or "HTTP 500"
- Pi logs show the chunks exist on disk
- `/record/snapshots` returns chunk metadata correctly

**Root Cause**:
- Vehicle address is wrong (using hostname when should use IP, or vice versa)
- Port is blocked
- Chunks are being deleted before download completes

**Solution**:
1. Verify vehicle address in logs matches Pi network address
2. Test URL manually:
   ```bash
   curl http://blueos.local:9150/record/snapshots?session_id=<uuid>
   # Should return JSON array with chunk metadata

   curl http://blueos.local:9150/files/<uuid>/chunk_00000.csv
   # Should download CSV file
   ```
3. If manual curl works but Electron fetch fails, check Electron network permissions

## Testing the Fix

After applying the logging changes and fixing any config issues:

### Step 1: Clean Start

```bash
# Delete old test data
rm -rf ~/Library/Application\ Support/Cockpit/qsensor/*

# Restart Cockpit
```

### Step 2: Start Recording

1. Connect to sensor (blueos.local:9150)
2. Start Q-Series Recording
3. Immediately open DevTools Console (Cmd+Option+I)
4. Watch for log lines

### Step 3: Verify After 70 Seconds

After the first chunk rolls over (60s + 10s buffer):

```bash
# Check mirror directory
ls -lh ~/Library/Application\ Support/Cockpit/qsensor/Cockpit/<session-id>/

# Should see:
# chunk_00000.csv  (43-45 KB)
# mirror.json

# Check mirror.json
cat ~/Library/Application\ Support/Cockpit/qsensor/Cockpit/<session-id>/mirror.json | jq .

# Should show:
# {
#   "session_id": "<uuid>",
#   "mission": "Cockpit",
#   "last_chunk_index": 0,      ← NOT -1 !
#   "bytes_mirrored": 43649,
#   "last_sync": "2025-11-14T21:14:30.123Z"
# }
```

## Success Criteria

✅ **Logs show**:
- "startMirrorSession() called"
- "Polling http://..."
- "Received N total chunks"
- "Found N new chunks"
- "✓ Downloaded chunk"
- "Poll complete"

✅ **Filesystem shows**:
- Correct path structure: `{base}/qsensor/{mission}/{session}/`
- CSV files: `chunk_00000.csv`, `chunk_00001.csv`, etc.
- `mirror.json` with `last_chunk_index >= 0`

✅ **Cockpit UI shows**:
- "Mirroring Status" panel shows non-zero "Bytes Mirrored"
- "Last Sync" updates every 60 seconds
- "Last Chunk" increments over time

## Still Not Working?

If you've followed all steps and it's still failing:

1. **Capture full logs**: Copy entire DevTools Console output
2. **Check Pi logs**: `docker logs q-sensor | grep QSensor`
3. **Verify network**: Can you `ping blueos.local` and `curl http://blueos.local:9150/health`?
4. **Check disk space**: Both Pi and laptop have free space?
5. **Test manual download**: Does `curl http://blueos.local:9150/files/{session}/{chunk}.csv` work?

Share the answers to these questions along with the full log output for further debugging.
