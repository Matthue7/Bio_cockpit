# Q-Sensor Dual-Sensor Sync Markers and Drift-Corrected Fusion Plan

## Context

We have a dual-sensor setup:

**In-water sensor**
- Connected to a Raspberry Pi running Q_Sensor_API under BlueOS
- Data is recorded on Pi and mirrored to topside via HTTP/"mirror" logic

**Surface sensor**
- Connected directly to topside PC via serial
- Data is recorded locally in Cockpit

Both sensors run in freerun mode at roughly the same sampling rate. We then fuse their CSV outputs on topside into a unified CSV.

### Current fusion behavior

Fusion already supports:
- Drift models (constant / linear)
- Sync marker structures in metadata
- Timestamp correction via `correctTimestamp()`

**Surface sensor:**
- Injects actual SYNC_START / SYNC_STOP markers via `createSyncMarkerReading()`

**In-water sensor:**
- Has no real sync markers injected from Pi
- Fusion currently relies on a single time-sync offset → effectively a constant offset model

This leads to periodic timing gaps in fused wide-format CSV, because two independent freerun clocks drift relative to each other and fusion is constrained by a single offset plus a fixed matching tolerance.

We want a design that:
- Reduces or eliminates these periodic gaps
- Preserves scientific integrity (no "made up" data)
- Stays performant (O(N)-style fusion, no expensive resampling unless explicitly enabled)

## API Endpoint Analysis

After inspecting the Q_Sensor_API codebase at `/Users/matthuewalsh/qseries-noise/Q_Sensor_API`, I found:

### Existing Recording Endpoints

1. **`/record/start`** ([`main.py:920`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py:920))
   - Creates a new recording session with `RecordStartRequest`
   - Supports `mission`, `rate_hz`, `schema_version`, `roll_interval_s`
   - Returns `RecordStartResponse` with `session_id`

2. **`/record/stop`** ([`main.py:1002`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py:1002))
   - Stops a recording session with `RecordStopRequest`
   - Takes `session_id` parameter
   - Returns `RecordStopResponse` with final statistics

3. **`/record/status`** ([`main.py:1063`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py:1063))
   - Gets current recording session status
   - Takes `session_id` parameter
   - Returns `RecordStatusResponse`

4. **`/record/snapshots`** ([`main.py:1110`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py:1110))
   - Lists finalized chunks with metadata
   - Takes `session_id` parameter

### Time Sync Endpoint

5. **`/api/sync/time`** ([`main.py:1313`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py:1313))
   - Returns Pi current time for clock offset measurement
   - Used by topside Cockpit to measure clock offset via HTTP round-trip
   - Returns `TimeSyncResponse` with `pi_iso`, `pi_unix_ms`

### Data Recording Flow

The recording flow works as follows:
1. `SessionManager.create_session()` ([`session_manager.py:67`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/data_store/session_manager.py:67))
   - Creates `RecordingSession` instance
   - Generates UUID for `session_id`
   - Starts acquisition if not already running

2. `RecordingSession.start()` ([`session.py:126`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/data_store/session.py:126))
   - Creates `ChunkedDataStore` and `DataRecorder`
   - Starts background recording thread

3. `DataRecorder._recorder_loop()` ([`store.py:407`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/data_store/store.py:407))
   - Polls controller buffer every 200ms
   - Appends new readings to `ChunkedDataStore`

4. `ChunkedDataStore._append_row()` ([`store.py:534`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/data_store/store.py:534))
   - Writes CSV rows to chunk files
   - Handles chunk rolling based on time/size limits

### Assessment of Existing Endpoints for Sync Markers

**Why existing endpoints are NOT suitable for sync marker injection:**

1. **`/record/start` and `/record/stop`** are session lifecycle endpoints, not data injection points
   - They operate at session level, not individual reading level
   - No mechanism to inject specific readings into the data stream
   - Session start/stop happen once per session, not per reading

2. **`/api/sync/time`** is only for clock offset measurement
   - Returns current Pi time but doesn't inject anything into recording stream
   - Used once per session for time sync, not for continuous marker injection

3. **Data recording pipeline** ([`store.py:407-443`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/data_store/store.py:407-443))
   - `DataRecorder` only reads from controller buffer
   - No mechanism to inject external readings into the stream
   - `ChunkedDataStore` only writes what `DataRecorder` provides

### Conclusion: We Must Add a New Endpoint

**We must add a new endpoint `/record/sync-marker` because there is no suitable existing endpoint for Pi-side marker injection.**

**Justification:**
- No existing endpoint allows injecting individual readings into the recording stream
- The data recording pipeline is unidirectional: controller → DataRecorder → ChunkedDataStore
- We need a way to inject sync markers directly into the ChunkedDataStore
- This requires a new endpoint that bypasses the normal controller buffer path

## Multi-Phase Plan for Sync Markers and Drift-Corrected Fusion

### Phase 1: Minimal Viable Sync Marker Pipeline

**Goal:** Get real, paired sync markers into both sensors' CSV streams at recording start and stop, with minimal changes.

#### 1.1 Pi-Side Sync Marker Injection

**New Endpoint: `/record/sync-marker`**

```python
# Add to main.py
class SyncMarkerRequest(BaseModel):
    """Request for POST /record/sync-marker."""
    session_id: str
    sync_id: str
    marker_type: Literal["START", "STOP", "PERIODIC"]

class SyncMarkerResponse(BaseModel):
    """Response for POST /record/sync-marker."""
    status: str
    timestamp: str

@app.post("/record/sync-marker", response_model=SyncMarkerResponse)
async def inject_sync_marker(req: SyncMarkerRequest):
    """Inject sync marker into recording stream.
    
    Args:
        req: SyncMarkerRequest with session_id, sync_id, marker_type
        
    Returns:
        SyncMarkerResponse with status and timestamp
        
    Raises:
        404: If session not found
        400: If session not recording
    """
    global _session_manager, _lock
    
    if not _session_manager:
        raise HTTPException(status_code=500, detail="SessionManager not initialized")
    
    with _lock:
        session = _session_manager.get_session(req.session_id)
        if not session:
            raise HTTPException(status_code=404, detail=f"Session not found: {req.session_id}")
        
        if not session.is_recording:
            raise HTTPException(status_code=400, detail="Session is not recording")
        
        # Create sync marker reading
        marker_reading = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "sensor_id": session._controller.sensor_id if session._controller else "unknown",
            "mode": f"SYNC_{req.marker_type}",
            "value": int(req.sync_id[:8], 16) if req.sync_id else 0,
            "TempC": 0,
            "Vin": 0
        }
        
        # Convert to Reading object
        from data_store.schemas import reading_to_row
        from q_sensor_lib.models import Reading
        
        # Create a Reading-like object for the marker
        marker_timestamp = datetime.now(timezone.utc)
        marker_reading_obj = Reading(
            ts=marker_timestamp,
            sensor_id=session._controller.sensor_id if session._controller else "unknown",
            mode=f"SYNC_{req.marker_type}",
            value=int(req.sync_id[:8], 16) if req.sync_id else 0,
            temp_c=0.0,
            vin=0.0
        )
        
        # Inject directly into the session's ChunkedDataStore
        if session._store:
            session._store.append_readings([marker_reading_obj])
            logger.info(f"Injected SYNC_{req.marker_type} marker (syncId: {req.sync_id[:8]}...)")
            
            return SyncMarkerResponse(
                status="injected",
                timestamp=marker_timestamp.isoformat()
            )
        else:
            raise HTTPException(status_code=500, detail="Store not initialized")
```

#### 1.2 Topside Sync Marker Coordination

**Modify `qsensor-mirror.ts`:**

```typescript
// Add to MirrorSession interface
interface MirrorSession {
  sessionId: string
  vehicleAddress: string
  missionName: string
  cadenceSec: number
  fullBandwidth: boolean
  rootPath: string
  sessionRoot?: string
  lastChunkIndex: number
  bytesMirrored: number
  lastSync: string | null
  intervalId: NodeJS.Timeout | null
  running: boolean
  syncId: string | null  // NEW: UUID for marker pairing
}

// Modify startMirrorSession()
export async function startMirrorSession(
  sessionId: string,
  vehicleAddress: string,
  missionName: string,
  cadenceSec: number,
  fullBandwidth: boolean,
  unifiedSessionTimestamp?: string,
  syncId?: string  // NEW: Accept syncId from surface sensor
): Promise<{ success: boolean; error?: string; syncId?: string }> {
  try {
    // Generate or use provided syncId
    const sessionSyncId = syncId || uuidv4()
    
    // ... existing code ...
    
    // Store syncId in session
    session.syncId = sessionSyncId
    
    // Inject START sync marker into Pi recording
    console.log(`[QSensor Mirror] Injecting START sync marker (syncId: ${sessionSyncId.slice(0, 8)}...)`)
    const syncUrl = `http://${vehicleAddress}:9150/record/sync-marker`
    const markerResponse = await fetch(syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        sync_id: sessionSyncId,
        marker_type: 'START'
      }),
      signal: AbortSignal.timeout(5000)
    })
    
    if (!markerResponse.ok) {
      console.warn(`[QSensor Mirror] Failed to inject START marker: ${markerResponse.statusText}`)
      // Continue anyway - this is not fatal
    } else {
      const result = await markerResponse.json()
      console.log(`[QSensor Mirror] START marker injected at ${result.timestamp}`)
    }
    
    // ... rest of existing startMirrorSession code ...
    
    return { 
      success: true, 
      syncId: sessionSyncId  // Return syncId for coordination
    }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Start failed:`, error)
    return { success: false, error: error.message || 'Unknown error' }
  }
}

// Modify stopMirrorSession()
export async function stopMirrorSession(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  const session = activeSessions.get(sessionId)
  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  try {
    // ... existing stop code until finalization ...
    
    // Inject STOP sync marker before final chunk finalization
    if (session.syncId) {
      console.log(`[QSensor Mirror] Injecting STOP sync marker (syncId: ${session.syncId.slice(0, 8)}...)`)
      const syncUrl = `http://${session.vehicleAddress}:9150/record/sync-marker`
      const markerResponse = await fetch(syncUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          sync_id: session.syncId,
          marker_type: 'STOP'
        }),
        signal: AbortSignal.timeout(5000)
      })
      
      if (!markerResponse.ok) {
        console.warn(`[QSensor Mirror] Failed to inject STOP marker: ${markerResponse.statusText}`)
        // Continue anyway - this is not fatal
      } else {
        const result = await markerResponse.json()
        console.log(`[QSensor Mirror] STOP marker injected at ${result.timestamp}`)
      }
    }
    
    // ... rest of existing stopMirrorSession code ...
    
    return { success: true }
  } catch (error: any) {
    console.error(`[QSensor Mirror] Stop failed:`, error)
    return { success: false, error: error.message || 'Unknown error' }
  }
}
```

#### 1.3 Surface Recording Coordination

**Modify `qsensor-serial-recording.ts`:**

```typescript
// Modify startRecording()
async function startRecording(params: {
  mission: string
  rollIntervalS?: number
  rateHz?: number
  storagePath?: string
  unifiedSessionTimestamp?: string
}): Promise<{ success: boolean; data?: any; error?: string }> {
  // Generate syncId for this session
  const syncId = uuidv4()
  
  // ... existing connection and setup code ...
  
  // Start surface recording with syncId
  const sessionInfo = await localRecorder.startSession({
    sensorId,
    mission: params.mission,
    rollIntervalS,
    storagePath,
    unifiedSessionTimestamp: params.unifiedSessionTimestamp,
  })
  
  // If in-water sensor is active, share syncId
  if (activeInWaterSession) {
    const mirrorResult = await startMirrorSession(
      activeInWaterSession.sessionId,
      activeInWaterSession.vehicleAddress,
      params.mission,
      60, // cadence
      false, // fullBandwidth
      params.unifiedSessionTimestamp,
      syncId  // Share syncId
    )
    
    if (!mirrorResult.success) {
      console.warn('Failed to share syncId with in-water sensor:', mirrorResult.error)
    }
  }
  
  return {
    success: true,
    data: {
      session_id: sessionInfo.session_id,
      syncId: syncId,  // Return syncId for coordination
      // ... other fields
    }
  }
}
```

#### 1.4 Data Structure Updates

**No changes needed to existing data structures:**
- `SyncMarker` interface already supports the required fields
- `SyncMetadata` already has `markers` and `driftModel` fields
- `DriftModel` already supports constant and linear models

#### 1.5 Fusion Enhancements

**Modify `qsensor-fusion.ts`:**

```typescript
// Enhance computeDriftModel() to properly handle real markers from both sensors
function computeDriftModel(
  inWaterMarkers: ParsedSensorData['markers'],
  surfaceMarkers: ParsedSensorData['markers'],
  syncMetadata: SyncMetadata
): ComputedDriftModel | null {
  // Case 1: Both sensors have START + STOP markers (ideal case)
  if (surfaceMarkers.start && surfaceMarkers.stop && 
      inWaterMarkers.start && inWaterMarkers.stop) {
    // Use actual measured markers from both sensors
    const surfaceStart = surfaceMarkers.start.timestamp
    const surfaceStop = surfaceMarkers.stop.timestamp
    const inWaterStart = inWaterMarkers.start.timestamp
    const inWaterStop = inWaterMarkers.stop.timestamp
    
    // Compute linear drift model
    const startOffset = inWaterStart - surfaceStart
    const stopOffset = inWaterStop - surfaceStop
    const sessionDuration = surfaceStop - surfaceStart
    
    if (sessionDuration === 0) {
      return { type: 'constant', startOffsetMs: startOffset }
    }
    
    const driftRatePerMs = (stopOffset - startOffset) / sessionDuration
    
    // Only use linear model if drift is significant
    if (Math.abs(driftRatePerMs) * sessionDuration > DRIFT_THRESHOLD_MS) {
      return {
        type: 'linear',
        startOffsetMs: startOffset,
        driftRatePerMs,
        endOffsetMs: stopOffset,
        inWaterStartTime: inWaterStart,
      }
    } else {
      return { type: 'constant', startOffsetMs: (startOffset + stopOffset) / 2 }
    }
  }
  
  // ... existing fallback cases for partial/missing markers
}
```

### Phase 2: Drift Model + Gap Reduction

**Goal:** Use those start/stop markers to build a more accurate drift model and reduce periodic gaps we're seeing today.

#### 2.1 Enhanced Drift Model Computation

**Improve drift model selection logic:**

```typescript
// Add to qsensor-fusion.ts
interface EnhancedDriftModel extends DriftModel {
  uncertaintyMs: number          // Estimated model uncertainty
  confidenceLevel: number       // Statistical confidence (0-1)
  markerQuality: 'high' | 'medium' | 'low'
}

function computeEnhancedDriftModel(
  inWaterMarkers: ParsedSensorData['markers'],
  surfaceMarkers: ParsedSensorData['markers'],
  syncMetadata: SyncMetadata
): EnhancedDriftModel | null {
  // Case 1: Both sensors have START + STOP markers (high confidence)
  if (surfaceMarkers.start && surfaceMarkers.stop && 
      inWaterMarkers.start && inWaterMarkers.stop) {
    // Verify syncIds match
    if (surfaceMarkers.start.syncId === inWaterMarkers.start.syncId &&
        surfaceMarkers.stop.syncId === inWaterMarkers.stop.syncId) {
      // High confidence: matching syncIds from both sensors
      const model = computeLinearDriftModel(surfaceMarkers, inWaterMarkers)
      return {
        ...model,
        uncertaintyMs: 5,  // Low uncertainty with matched markers
        confidenceLevel: 0.9,
        markerQuality: 'high'
      }
    } else {
      // Medium confidence: markers present but syncIds don't match
      const model = computeLinearDriftModel(surfaceMarkers, inWaterMarkers)
      return {
        ...model,
        uncertaintyMs: 15,  // Higher uncertainty with mismatched markers
        confidenceLevel: 0.6,
        markerQuality: 'medium'
      }
    }
  }
  
  // Case 2: Only surface markers, synthetic in-water (medium confidence)
  if (surfaceMarkers.start && surfaceMarkers.stop && 
      !inWaterMarkers.start && !inWaterMarkers.stop) {
    const timeSyncOffset = syncMetadata.timeSync.offsetMs
    if (timeSyncOffset !== null) {
      // Use time sync offset to create synthetic in-water markers
      const syntheticInWaterStart = surfaceMarkers.start.timestamp + timeSyncOffset
      const syntheticInWaterStop = surfaceMarkers.stop.timestamp + timeSyncOffset
      
      const model = computeLinearDriftModel(
        { start: surfaceMarkers.start, stop: surfaceMarkers.stop },
        { start: { timestamp: syntheticInWaterStart, syncId: 'synthetic' }, 
          stop: { timestamp: syntheticInWaterStop, syncId: 'synthetic' } }
      )
      
      return {
        ...model,
        uncertaintyMs: 25,  // Higher uncertainty with synthetic markers
        confidenceLevel: 0.4,
        markerQuality: 'medium'
      }
    }
  }
  
  // ... existing fallback cases
}
```

#### 2.2 Adaptive Tolerance Matching

**Implement tolerance that adapts to drift uncertainty:**

```typescript
// Modify createWideFormatRows() in qsensor-fusion.ts
function createWideFormatRows(
  timestampAxis: number[],
  inWaterMap: Map<number, CsvRow>,
  surfaceMap: Map<number, CsvRow>,
  toleranceMs: number,
  driftModel: ComputedDriftModel | null
): WideFormatRow[] {
  const wideRows: WideFormatRow[] = []
  
  // Calculate adaptive tolerance based on drift model
  let adaptiveToleranceMs = toleranceMs
  if (driftModel?.type === 'linear' && timestampAxis.length > 0) {
    // Increase tolerance for later timestamps where drift uncertainty is higher
    const sessionDuration = timestampAxis[timestampAxis.length - 1] - timestampAxis[0]
    const maxDriftError = Math.abs(driftModel.driftRatePerMs || 0) * sessionDuration
    adaptiveToleranceMs = toleranceMs + Math.min(maxDriftError, 100) // Cap at 100ms additional
  }
  
  for (const timestamp of timestampAxis) {
    const inWaterRow = findNearestReading(timestamp, inWaterMap, adaptiveToleranceMs)
    const surfaceRow = findNearestReading(timestamp, surfaceMap, toleranceMs)
    
    // Skip if neither sensor has data at this timestamp
    if (!inWaterRow && !surfaceRow) {
      continue
    }
    
    // Format timestamp as ISO string
    const timestampStr = new Date(timestamp).toISOString()
    
    wideRows.push({
      timestamp: timestampStr,
      _parsedTime: timestamp,
      inwater_sensor_id: inWaterRow?.sensor_id ?? null,
      inwater_mode: inWaterRow?.mode ?? null,
      inwater_value: inWaterRow?.value ?? null,
      inwater_TempC: inWaterRow?.TempC ?? null,
      inwater_Vin: inWaterRow?.Vin ?? null,
      surface_sensor_id: surfaceRow?.sensor_id ?? null,
      surface_mode: surfaceRow?.mode ?? null,
      surface_value: surfaceRow?.value ?? null,
      surface_TempC: surfaceRow?.TempC ?? null,
      surface_Vin: surfaceRow?.Vin ?? null,
    })
  }
  
  return wideRows
}
```

#### 2.3 Gap Reduction Metrics

**Expected improvement with Phase 2:**
- **Current situation:** Constant offset model → periodic gaps every ~5-10 seconds
- **Phase 2 improvement:** Linear drift model → gaps reduced to < 1% of readings
- **Target max alignment error:** < 25ms for 95% of readings
- **Expected gap pattern:** Near-continuous alignment with occasional gaps at drift extremes

### Phase 3: Optional Periodic Sync Markers (For Long Sessions)

**Goal:** For long missions, add the option to inject periodic sync markers (e.g., every 1-2 minutes) to model drift more accurately over time.

#### 3.1 Periodic Marker Infrastructure

**Extend Pi endpoint to support PERIODIC markers:**

```python
# Enhance SyncMarkerRequest to support periodic markers
class SyncMarkerRequest(BaseModel):
    """Request for POST /record/sync-marker."""
    session_id: str
    sync_id: str
    marker_type: Literal["START", "STOP", "PERIODIC"]
    periodic_sequence?: Optional[int] = None  # Sequence number for periodic markers

# Update inject_sync_marker() to handle periodic markers
@app.post("/record/sync-marker", response_model=SyncMarkerResponse)
async def inject_sync_marker(req: SyncMarkerRequest):
    """Inject sync marker into recording stream.
    
    Supports START, STOP, and PERIODIC markers.
    PERIODIC markers include sequence number for ordering.
    """
    # ... existing validation code ...
    
    # Create sync marker reading with sequence for periodic markers
    marker_value = int(req.sync_id[:8], 16) if req.sync_id else 0
    if req.marker_type == "PERIODIC" and req.periodic_sequence is not None:
        # Include sequence number in value for periodic markers
        marker_value = (marker_value & 0xFFFFFF00) | (req.periodic_sequence & 0xFF)
    
    # ... rest of existing injection code ...
```

#### 3.2 Topside Periodic Marker Coordination

**Add periodic marker timer to surface recording:**

```typescript
// Add to LocalRecordingSession interface in qsensor-local-recorder.ts
interface LocalRecordingSession {
  // ... existing fields ...
  periodicMarkerInterval: NodeJS.Timeout | null
  lastPeriodicMarkerTime: number
  periodicMarkerSequence: number
  enablePeriodicMarkers: boolean
}

// Add to startSession()
async function startSession(params: StartRecordingParams): Promise<{ session_id: string; started_at: string }> {
  // ... existing code ...
  
  // Start periodic marker injection if enabled
  if (params.enablePeriodicMarkers !== false) {
    session.periodicMarkerInterval = this.scheduleInterval(() => {
      this.injectPeriodicMarker(sessionId)
    }, 120000) // 2 minutes
    session.lastPeriodicMarkerTime = Date.now()
    session.periodicMarkerSequence = 0
    session.enablePeriodicMarkers = true
  }
  
  // ... rest of existing code ...
}

// Add periodic marker injection function
private injectPeriodicMarker(sessionId: string): void {
  const session = this.sessions.get(sessionId)
  if (!session || !session.enablePeriodicMarkers) return
  
  const now = Date.now()
  const timeSinceLastMarker = now - session.lastPeriodicMarkerTime
  
  if (timeSinceLastMarker >= 120000) { // 2 minutes
    const periodicMarker = createSyncMarkerReading(
      session.sensorId,
      session.syncId,
      'PERIODIC' as any
    )
    
    // Include sequence number in value
    periodicMarker.value = (periodicMarker.value & 0xFFFFFF00) | (session.periodicMarkerSequence & 0xFF)
    session.readingBuffer.push(periodicMarker)
    session.lastPeriodicMarkerTime = now
    session.periodicMarkerSequence = (session.periodicMarkerSequence + 1) % 256
    
    console.log(`[QSeriesLocalRecorder] Injected PERIODIC sync marker #${session.periodicMarkerSequence}`)
  }
}
```

#### 3.3 Multi-Marker Drift Model

**Enhance drift model to use multiple markers:**

```typescript
// Enhance computeDriftModel() to handle multiple markers
function computeMultiMarkerDriftModel(
  inWaterMarkers: ExtractedMarker[],
  surfaceMarkers: ExtractedMarker[],
  syncMetadata: SyncMetadata
): EnhancedDriftModel | null {
  // Collect all markers with timestamps and syncIds
  const allInWaterMarkers = [...(inWaterMarkers.start ? [inWaterMarkers.start] : []),
                              ...(inWaterMarkers.stop ? [inWaterMarkers.stop] : []),
                              ...(inWaterMarkers.periodic || [])]
  
  const allSurfaceMarkers = [...(surfaceMarkers.start ? [surfaceMarkers.start] : []),
                              ...(surfaceMarkers.stop ? [surfaceMarkers.stop] : []),
                              ...(surfaceMarkers.periodic || [])]
  
  // Group markers by syncId to find matching pairs
  const markerPairs = groupMarkersBySyncId(allInWaterMarkers, allSurfaceMarkers)
  
  if (markerPairs.length >= 2) {
    // Use linear regression over all marker pairs
    return computeLinearRegressionDriftModel(markerPairs)
  } else if (markerPairs.length === 1) {
    // Use single offset from the one pair
    return computeConstantDriftModel(markerPairs[0])
  } else {
    // Fall back to time sync offset
    return computeTimeSyncDriftModel(syncMetadata)
  }
}

// Helper function to group markers by syncId
function groupMarkersBySyncId(
  inWaterMarkers: ExtractedMarker[],
  surfaceMarkers: ExtractedMarker[]
): Array<{inWater: ExtractedMarker, surface: ExtractedMarker, offsetMs: number}> {
  const syncIdMap = new Map<string, {inWater?: ExtractedMarker, surface?: ExtractedMarker}>()
  
  // Group by syncId
  for (const marker of inWaterMarkers) {
    const existing = syncIdMap.get(marker.syncId) || {}
    existing.inWater = marker
    syncIdMap.set(marker.syncId, existing)
  }
  
  for (const marker of surfaceMarkers) {
    const existing = syncIdMap.get(marker.syncId) || {}
    existing.surface = marker
    syncIdMap.set(marker.syncId, existing)
  }
  
  // Create pairs with offsets
  const pairs: Array<{inWater: ExtractedMarker, surface: ExtractedMarker, offsetMs: number}> = []
  for (const [syncId, {inWater, surface}] of syncIdMap.entries()) {
    if (inWater && surface) {
      pairs.push({
        inWater,
        surface,
        offsetMs: inWater.timestamp - surface.timestamp
      })
    }
  }
  
  return pairs.sort((a, b) => a.inWater.timestamp - b.inWater.timestamp)
}
```

#### 3.4 Performance Considerations

**Maintaining O(N) fusion performance:**
- Pre-compute drift model once per session
- Apply drift correction with simple arithmetic during fusion
- Limit periodic markers to reasonable frequency (e.g., every 2 minutes)
- Use efficient data structures (Maps) for marker lookup

## Risks and Open Questions

### API Changes
- **New endpoint required:** `/record/sync-marker` must be added to Q_Sensor_API
- **Backward compatibility:** Ensure new endpoint is optional, existing workflows continue to work
- **Error handling:** Network failures during marker injection should not crash recording

### Pi Performance Impact
- **Minimal overhead:** Sync marker injection is O(1) operation
- **Storage impact:** One additional reading per marker (negligible)
- **Timing impact:** Marker injection should not disrupt normal data flow

### Edge Cases
- **Network hiccups:** Marker injection failures should be logged but not stop recording
- **Partial markers:** Handle cases where only some markers are received
- **Sync ID mismatches:** Fallback gracefully when syncIds don't match

### Impact on Existing Workflows
- **Single-sensor workflows:** Must continue to work unchanged
- **Prior dual-sensor recordings:** Should continue to work with improved fusion
- **Time sync failures:** System should degrade gracefully to constant offset model

## Implementation Checklist

### Phase 1: Minimal sync marker pipeline

#### Files to Touch

**Pi-side (Q_Sensor_API):**
- [`api/main.py`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py) - Add `/record/sync-marker` endpoint
- [`data_store/store.py`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/data_store/store.py) - Add marker injection method to `ChunkedDataStore`

**Topside (Cockpit):**
- [`src/electron/services/qsensor-mirror.ts`](src/electron/services/qsensor-mirror.ts) - Add syncId coordination and marker injection
- [`src/electron/services/qsensor-serial-recording.ts`](src/electron/services/qsensor-serial-recording.ts) - Add syncId sharing
- [`src/electron/services/qsensor-fusion.ts`](src/electron/services/qsensor-fusion.ts) - Enhance drift model computation

#### Types/Interfaces to Update

**New Types:**
```typescript
// Add to qsensor-session-utils.ts
interface SyncMarkerRequest {
  session_id: string
  sync_id: string
  marker_type: 'START' | 'STOP' | 'PERIODIC'
  periodic_sequence?: number
}

interface SyncMarkerResponse {
  status: string
  timestamp: string
}
```

#### New Functions to Add

**Pi-side:**
- `inject_sync_marker()` - New endpoint handler
- `ChunkedDataStore.inject_marker()` - Method to inject markers into data stream

**Topside:**
- `coordinateSyncIds()` - Function to share syncId between sensors
- `injectPiSyncMarker()` - Function to call Pi endpoint for marker injection
- `computeLinearDriftModel()` - Enhanced drift model computation

#### Tests or Manual Validation Steps

1. **Unit Tests:**
   - Test new `/record/sync-marker` endpoint with valid/invalid session IDs
   - Test marker injection into active recording stream
   - Verify markers appear in final CSV with correct format

2. **Integration Tests:**
   - Test full dual-sensor recording with sync marker coordination
   - Verify fusion produces better alignment with drift correction
   - Test error cases (network failures, missing markers)

3. **Manual Validation:**
   - Record 5-minute dual-sensor session
   - Verify START/STOP markers appear in both CSV files
   - Check fused CSV shows reduced periodic gaps
   - Measure alignment improvement vs. baseline

### Phase 2: Drift model and gap reduction

#### Files to Touch

- [`src/electron/services/qsensor-fusion.ts`](src/electron/services/qsensor-fusion.ts) - Enhance drift model and adaptive tolerance
- [`src/electron/services/qsensor-session-utils.ts`](src/electron/services/qsensor-session-utils.ts) - Add enhanced drift model types

#### Types/Interfaces to Update

```typescript
// Enhance existing interfaces
interface EnhancedDriftModel extends DriftModel {
  uncertaintyMs: number
  confidenceLevel: number
  markerQuality: 'high' | 'medium' | 'low'
}
```

#### New Functions to Add

- `computeEnhancedDriftModel()` - Improved drift model with confidence metrics
- `computeLinearRegressionDriftModel()` - Multi-marker drift computation
- `createAdaptiveToleranceMatcher()` - Adaptive tolerance based on drift uncertainty

#### Tests or Manual Validation Steps

1. **Performance Tests:**
   - Measure fusion performance with enhanced drift model (must remain O(N))
   - Verify memory usage doesn't increase significantly

2. **Accuracy Tests:**
   - Record sessions with known clock drift
   - Verify enhanced drift model reduces alignment errors
   - Measure gap reduction percentage

3. **Edge Case Tests:**
   - Test with mismatched syncIds
   - Test with partial markers
   - Verify graceful degradation to constant offset model

### Phase 3: Optional periodic markers

#### Files to Touch

- [`api/main.py`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py) - Extend for periodic markers
- [`src/electron/services/qsensor-local-recorder.ts`](src/electron/services/qsensor-local-recorder.ts) - Add periodic marker timer
- [`src/electron/services/qsensor-fusion.ts`](src/electron/services/qsensor-fusion.ts) - Multi-marker drift model

#### Types/Interfaces to Update

```typescript
// Extend LocalRecordingSession
interface LocalRecordingSession {
  // ... existing fields ...
  periodicMarkerInterval: NodeJS.Timeout | null
  lastPeriodicMarkerTime: number
  periodicMarkerSequence: number
  enablePeriodicMarkers: boolean
}
```

#### New Functions to Add

- `injectPeriodicMarker()` - Periodic marker injection on surface
- `computeMultiMarkerDriftModel()` - Multi-marker drift computation
- `groupMarkersBySyncId()` - Marker grouping for drift analysis

#### Tests or Manual Validation Steps

1. **Long Session Tests:**
   - Record 30-minute session with periodic markers enabled
   - Verify markers appear every 2 minutes in both streams
   - Check drift model accuracy improves over time

2. **Performance Tests:**
   - Measure fusion performance with multiple markers
   - Verify O(N) complexity is maintained
   - Check memory usage scales linearly with marker count

3. **Configuration Tests:**
   - Test with periodic markers disabled (Phase 2 behavior)
   - Test with different periodic intervals (1min, 2min, 5min)
   - Verify graceful handling of marker injection failures

## Conclusion

This plan provides a clear, phased approach to implementing robust sync markers and drift-corrected fusion for the Q-Sensor dual-sensor system:

1. **Phase 1** establishes the minimal viable pipeline with START/STOP markers from both sensors
2. **Phase 2** enhances the drift model and reduces periodic gaps through adaptive tolerance
3. **Phase 3** adds optional periodic markers for long sessions to maintain accuracy over time

The design preserves scientific integrity by never fabricating data, only improving timestamp alignment through better drift modeling. Performance remains O(N) by pre-computing drift models and using efficient data structures.

The key architectural decision is adding a new `/record/sync-marker` endpoint to the Pi API, as no existing endpoint can inject individual readings into the recording stream.