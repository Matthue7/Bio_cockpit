# Q-Sensor Time Synchronization Architecture Specification

## Executive Summary

This document specifies the complete time synchronization architecture for the dual-sensor Q-Sensor system, enabling reliable clock offset measurement between the Raspberry Pi (in-water sensor) and topside computer (surface sensor + video timestamps).

The design uses a two-layer approach:
1. **Baseline NTP sync** (OS-level, already available)
2. **Session-level HTTP handshake** (new implementation for per-recording metadata)

---

## 1. Current State Analysis

### 1.1 Existing Architecture
- **Pi-side**: FastAPI service in `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py`
- **Topside**: Electron/Vue application in `/Users/matthuewalsh/Bio_cockpit/`
- **Metadata**: `sync_metadata.json` already implemented with placeholder `timeSync` fields
- **Integration**: Unified recording via `startBoth()` in `qsensor.ts` store

### 1.2 Missing Components
- No Pi-side endpoint for returning current time
- No time sync handshake implementation in topside
- Empty `timeSync` fields in `sync_metadata.json`
- No clock offset measurement utilities

---

## 2. High-Level Time Sync Model

### 2.1 Two-Layer Architecture

```
┌─────────────────┐    NTP (OS-level)    ┌─────────────────┐
│   Pi Clock     │◄──────────────────────►│ Topside Clock   │
│  (Linux/UTC)   │                      │  (macOS/UTC)    │
└─────────────────┘                      └─────────────────┘
         │                                       │
         │ HTTP Handshake (per session)             │
         └───────────────────────┬───────────────────┘
                                 │
                         ┌─────────────┐
                         │ Offset Calc │
                         │ ±2-3ms acc │
                         └─────────────┘
```

### 2.2 Handshake Algorithm
```
T1: Topside records local timestamp
T2: Topside requests /api/sync/time from Pi
T3: Pi returns PiT (current Pi time)
T4: Topside records local timestamp

RTT = T4 - T1
Estimated Offset = PiT - (T1 + RTT/2)
Uncertainty = RTT/2
```

---

## 3. Pi-Side Changes (Q_Sensor_API)

### 3.1 New Endpoint Specification

**File**: `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py`

**Location**: Add after existing health endpoints (around line 1193)

```python
# New Response Model (add around line 208)
class TimeSyncResponse(BaseModel):
    """Response for GET /api/sync/time."""
    pi_iso: str
    pi_unix_ms: int
    container_version: str
    schema_version: int

# New Endpoint (add around line 1193)
@app.get("/api/sync/time", response_model=TimeSyncResponse)
async def get_sync_time():
    """Get Pi current time for clock offset measurement.
    
    Returns Pi time in ISO 8601 and Unix milliseconds format.
    Used by topside Cockpit to measure clock offset via HTTP round-trip.
    
    Returns:
        TimeSyncResponse with pi_iso, pi_unix_ms, container_version, schema_version
    """
    from datetime import datetime, timezone
    
    # Get current UTC time
    now = datetime.now(timezone.utc)
    pi_iso = now.isoformat()
    pi_unix_ms = int(now.timestamp() * 1000)
    
    return TimeSyncResponse(
        pi_iso=pi_iso,
        pi_unix_ms=pi_unix_ms,
        container_version=API_VERSION,
        schema_version=1
    )
```

### 3.2 Integration Points
- **Import Section**: Add `datetime` and `timezone` imports (line 15-22)
- **Response Models**: Add `TimeSyncResponse` class (around line 208)
- **Endpoint Registration**: Add GET endpoint (around line 1193)
- **CORS**: Automatically handled by existing CORS middleware

### 3.3 Minimal Risk Design
- Single read-only endpoint
- No state modification
- No impact on existing recording functionality
- Uses existing FastAPI patterns and error handling

---

## 4. Topside Changes (Bio_Cockpit)

### 4.1 New Time Sync Service

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/services/qsensor-time-sync.ts`

```typescript
/**
 * Q-Sensor time synchronization service for Electron main process.
 * 
 * Implements HTTP round-trip time measurement between Pi and topside.
 * Provides clock offset and uncertainty for sync_metadata.json population.
 */

interface TimeSyncResult {
  method: string
  offsetMs: number | null
  uncertaintyMs: number | null
  topsideRequestStart: string
  piResponseTime: string | null
  topsideResponseEnd: string
  error?: string
}

interface TimeSyncResponse {
  pi_iso: string
  pi_unix_ms: number
  container_version: string
  schema_version: number
}

/**
 * Perform HTTP round-trip time measurement with Pi.
 */
async function measureClockOffset(baseUrl: string): Promise<TimeSyncResult> {
  const topsideRequestStart = new Date().toISOString()
  const startTime = Date.now()
  
  try {
    const url = `${baseUrl}/api/sync/time`
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000), // 5s timeout
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const piData: TimeSyncResponse = await response.json()
    const endTime = Date.now()
    const topsideResponseEnd = new Date().toISOString()
    
    // Calculate offset and uncertainty
    const rtt = endTime - startTime
    const offsetMs = piData.pi_unix_ms - (startTime + rtt / 2)
    const uncertaintyMs = rtt / 2
    
    // Validate RTT is reasonable
    if (rtt > 200) {
      return {
        method: 'ntp_handshake_v1',
        offsetMs: null,
        uncertaintyMs: null,
        topsideRequestStart,
        piResponseTime: piData.pi_iso,
        topsideResponseEnd,
        error: 'high_rtt'
      }
    }
    
    return {
      method: 'ntp_handshake_v1',
      offsetMs: Math.round(offsetMs),
      uncertaintyMs: Math.round(uncertaintyMs),
      topsideRequestStart,
      piResponseTime: piData.pi_iso,
      topsideResponseEnd
    }
    
  } catch (error: any) {
    const topsideResponseEnd = new Date().toISOString()
    return {
      method: 'unsynced',
      offsetMs: null,
      uncertaintyMs: null,
      topsideRequestStart,
      piResponseTime: null,
      topsideResponseEnd,
      error: error.message.includes('timeout') ? 'timeout' : 'network_error'
    }
  }
}

/**
 * Setup IPC handlers for time synchronization.
 */
export function setupQSensorTimeSyncService(): void {
  ipcMain.handle('qsensor:measure-clock-offset', async (_event, baseUrl: string) => {
    return await measureClockOffset(baseUrl)
  })
  
  console.log('[QSensor Time Sync] Service registered')
}
```

### 4.2 Store Integration

**File**: `/Users/matthuewalsh/Bio_cockpit/src/stores/qsensor.ts`

**Location**: Modify `startBoth()` function (around line 713)

```typescript
// Add after line 743 (after unifiedSessionTimestamp generation)
const timeSyncResult = await window.electronAPI.measureClockOffset(
  inWaterSensor.value.apiBaseUrl || 'http://blueos.local:9150'
)

// Add after successful sensor start (around line 774)
if (success && unifiedSessionPath.value) {
  // Update sync_metadata.json with time sync data
  await window.electronAPI.updateSyncMetadata(unifiedSessionPath.value, (metadata) => {
    metadata.timeSync = {
      method: timeSyncResult.method,
      offsetMs: timeSyncResult.offsetMs,
      uncertaintyMs: timeSyncResult.uncertaintyMs,
      measuredAt: timeSyncResult.topsideResponseEnd
    }
  })
}
```

### 4.3 IPC Handler Addition

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/preload.ts`

**Location**: Add to electronAPI object (around existing qsensor methods)

```typescript
measureClockOffset: (baseUrl: string) => 
  ipcRenderer.invoke('qsensor:measure-clock-offset', baseUrl),

updateSyncMetadata: (sessionRoot: string, updateFn: any) => 
  ipcRenderer.invoke('qsensor:update-sync-metadata', sessionRoot, updateFn),
```

### 4.4 Main Process Integration

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/main.ts` or equivalent

**Location**: Add service registration (around other service setups)

```typescript
import { setupQSensorTimeSyncService } from './services/qsensor-time-sync'

// Add to main process initialization
setupQSensorTimeSyncService()
```

### 4.5 Metadata Update Service

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/services/qsensor-session-utils.ts`

**Location**: Add IPC handler (around end of file)

```typescript
// Add to exports
export async function updateSyncMetadata(
  sessionRoot: string, 
  updateFn: (metadata: SyncMetadata) => void
): Promise<void> {
  await updateSyncMetadata(sessionRoot, updateFn)
}

// Add IPC handler in service setup function
ipcMain.handle('qsensor:update-sync-metadata', async (_event, sessionRoot: string, updateFn: any) => {
  try {
    await updateSyncMetadata(sessionRoot, updateFn)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})
```

---

## 5. Sync Metadata Schema Updates

### 5.1 Enhanced timeSync Object

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/services/qsensor-session-utils.ts`

**Location**: Modify `SyncMetadata` interface (around line 33)

```typescript
timeSync: {
  method: string | null  // "ntp_handshake_v1" | "unsynced" | null
  offsetMs: number | null  // Clock offset in milliseconds
  uncertaintyMs: number | null  // Measurement uncertainty in milliseconds
  measuredAt: string | null  // ISO timestamp of measurement
  topsideRequestStart?: string  // Detailed handshake timestamps
  piResponseTime?: string | null
  topsideResponseEnd?: string
  error?: string  // "timeout" | "high_rtt" | "network_error" | null
}
```

### 5.2 Default Initialization

**Location**: Modify `ensureSyncMetadata()` function (around line 90)

```typescript
timeSync: {
  method: null,
  offsetMs: null,
  uncertaintyMs: null,
  measuredAt: null,
}
```

---

## 6. Error Handling Strategy

### 6.1 Failure Scenarios

#### 6.1.1 Network Timeout
- **Detection**: fetch timeout > 5s
- **Response**: `{ method: "unsynced", error: "timeout" }`
- **Action**: Continue recording, log warning, allow manual sync later

#### 6.1.2 High RTT
- **Threshold**: RTT > 200ms
- **Response**: `{ method: "ntp_handshake_v1", error: "high_rtt", offsetMs: null }`
- **Action**: Continue recording, flag data as potentially misaligned

#### 6.1.3 Invalid Pi Response
- **Detection**: Missing/invalid pi_iso or pi_unix_ms
- **Response**: `{ method: "unsynced", error: "invalid_pi_time" }`
- **Action**: Continue recording, log detailed error

#### 6.1.4 General Network Error
- **Detection**: DNS, connection, HTTP errors
- **Response**: `{ method: "unsynced", error: "network_error" }`
- **Action**: Continue recording, suggest network diagnostics

### 6.2 Recording Continuation Policy
- **Never block recording start** due to sync failure
- **Always populate sync_metadata.json** with error state
- **Provide clear error messages** for troubleshooting
- **Allow retry** via manual sync button (future enhancement)

---

## 7. Implementation Order

### 7.1 Phase 1: Pi-Side Endpoint (Low Risk)
1. Add `TimeSyncResponse` model to [`main.py`](/Users/matthuewalsh/qseries-noise/Q_Sensor_API/api/main.py:208)
2. Implement `GET /api/sync/time` endpoint
3. Test endpoint independently (curl/Postman)
4. Verify no impact on existing functionality

### 7.2 Phase 2: Topside Infrastructure (Medium Risk)
1. Create [`qsensor-time-sync.ts`](/Users/matthuewalsh/Bio_cockpit/src/electron/services/qsensor-time-sync.ts) service
2. Add IPC handlers to main process
3. Update [`preload.ts`](/Users/matthuewalsh/Bio_cockpit/src/electron/preload.ts) with new APIs
4. Test time sync measurement independently

### 7.3 Phase 3: Integration (Medium Risk)
1. Update [`qsensor.ts`](/Users/matthuewalsh/Bio_cockpit/src/stores/qsensor.ts:713) `startBoth()` function
2. Enhance [`qsensor-session-utils.ts`](/Users/matthuewalsh/Bio_cockpit/src/electron/services/qsensor-session-utils.ts:33) metadata schema
3. Add metadata update IPC handler
4. Test end-to-end with mock Pi endpoint

### 7.4 Phase 4: End-to-End Testing (Low Risk)
1. Deploy Pi endpoint to test environment
2. Test complete unified recording workflow
3. Verify `sync_metadata.json` population
4. Validate offset calculation accuracy
5. Test error scenarios (network issues, high RTT)

---

## 8. Testing Strategy

### 8.1 Unit Testing
- **Pi endpoint**: Verify response format and UTC accuracy
- **Offset calculation**: Test with simulated RTT values
- **Error handling**: Validate timeout and failure scenarios

### 8.2 Integration Testing
- **Handshake flow**: End-to-end time sync measurement
- **Metadata updates**: Verify `sync_metadata.json` population
- **Recording workflow**: Ensure no impact on existing functionality

### 8.3 Performance Testing
- **RTT measurement**: Validate accuracy across network conditions
- **Concurrent access**: Multiple simultaneous requests
- **Resource usage**: Minimal CPU/memory impact

### 8.4 Acceptance Criteria
- **Accuracy**: ±3ms typical offset measurement
- **Reliability**: >95% successful sync attempts on good network
- **Fallback**: Graceful degradation when sync fails
- **Compatibility**: No breaking changes to existing API

---

## 9. Security Considerations

### 9.1 Minimal Attack Surface
- Read-only endpoint with no state modification
- No sensitive data exposure (only current time)
- Uses existing FastAPI security patterns

### 9.2 Network Security
- Inherits existing CORS configuration
- No authentication required (matches existing endpoints)
- Timeout protection prevents resource exhaustion

---

## 10. Monitoring and Diagnostics

### 10.1 Logging
- **Pi-side**: Request logging with response times
- **Topside**: Detailed handshake timing and errors
- **Metadata**: Complete audit trail in `sync_metadata.json`

### 10.2 Health Checks
- **Endpoint availability**: Include in existing health monitoring
- **RTT trends**: Track network performance over time
- **Sync success rate**: Monitor reliability metrics

---

## 11. Future Enhancements

### 11.1 Retry Mechanism
- Automatic retry on transient failures
- Exponential backoff with jitter
- User-configurable retry limits

### 11.2 Manual Sync
- UI button for on-demand time sync
- Real-time offset display
- Sync quality indicators

### 11.3 Advanced Algorithms
- Multiple round-trip measurements with statistical filtering
- NTP-style dispersion calculations
- Adaptive timeout based on network conditions

---

## 12. Assumptions and Dependencies

### 12.1 Assumptions
- Both systems have NTP/chrony running at OS level
- Network connectivity between Pi and topside is stable
- System clocks are set to UTC
- Existing `sync_metadata.json` infrastructure is functional

### 12.2 Dependencies
- FastAPI application structure remains unchanged
- Electron IPC patterns remain consistent
- No changes to existing recording workflows
- No additional system-level dependencies required

---

## 13. Risk Assessment

### 13.1 Technical Risks
- **Low**: Pi endpoint implementation (isolated, read-only)
- **Medium**: Topside integration (touches recording workflow)
- **Low**: Metadata schema changes (backward compatible)

### 13.2 Operational Risks
- **Low**: Network connectivity issues (handled with fallbacks)
- **Low**: Clock accuracy (improved over current state)
- **Medium**: Integration complexity (mitigated with phased approach)

### 13.3 Mitigation Strategies
- **Phased implementation** with testing at each stage
- **Backward compatibility** maintained throughout
- **Comprehensive error handling** with graceful degradation
- **Extensive testing** before production deployment

---

## 14. Conclusion

This architecture provides a robust, minimal-risk solution for time synchronization between the Pi and topside systems. The design:

- **Maintains existing functionality** while adding sync capability
- **Provides graceful fallbacks** for network issues
- **Uses proven HTTP round-trip measurement** techniques
- **Integrates cleanly** with existing metadata infrastructure
- **Enables future enhancements** without breaking changes

The implementation can be completed in 4 phases with minimal risk to the production system, ultimately providing the clock offset measurements needed for accurate sensor data correlation and video timestamp alignment.