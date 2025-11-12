# Q-Series Desktop Integration - Complete Implementation Plan

**Generated**: 2025-11-12
**Status**: ✅ Ready for Implementation
**Target**: Transparent single-button Q-Sensor recording in Cockpit desktop app

---

## Executive Summary

This document summarizes the complete plan for integrating Q-Series sensor data recording into the Bio_Cockpit Electron desktop application with **live mirroring** to the topside computer.

### User Experience Goal

**Single Record Button** → Video + Q-Sensor data record simultaneously → Files already local when finished

- No extra buttons or manual export steps
- Automatic and transparent background mirroring
- Whale-proof fail-safe: topside has almost all data even if tether/power dies mid-mission
- User is unaware of Q-Sensor API details

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ TOPSIDE (macOS/Windows)                                         │
│                                                                 │
│  User clicks "Record" in Cockpit Desktop                        │
│         ↓                                                       │
│  ┌──────────────────────────────────────────────────┐          │
│  │ Video Store (video.ts)                            │          │
│  │  - startRecording() → hooks Q-Sensor start       │          │
│  │  - stopRecording() → hooks Q-Sensor stop         │          │
│  └──────────────────┬───────────────────────────────┘          │
│                     ↓                                           │
│  ┌──────────────────────────────────────────────────┐          │
│  │ Q-Sensor Mirror Service (Electron main process)  │          │
│  │  - Polls http://blueos.local:9150 every 15s      │          │
│  │  - Downloads new chunks atomically               │          │
│  │  - Verifies SHA256 integrity                     │          │
│  │  - Writes to ~/Cockpit/qsensor/<mission>/        │          │
│  └──────────────────┬───────────────────────────────┘          │
│                     ↓                                           │
│  Storage: ~/Cockpit/qsensor/MissionName/session_id/            │
│           chunk_00000.jsonl, chunk_00001.jsonl, ...            │
└─────────────────────┼───────────────────────────────────────────┘
                      │
                  Ethernet/WiFi (tether)
                      │
┌─────────────────────┼───────────────────────────────────────────┐
│ ROV (Raspberry Pi)  ↓                                           │
│                                                                 │
│  ┌──────────────────────────────────────────────────┐          │
│  │ Q_Sensor_API (BlueOS Extension)                  │          │
│  │  - FastAPI on port 9150                          │          │
│  │  - ChunkedDataStore writes every 60s             │          │
│  │  - Serves chunks via /files/{session}/{chunk}    │          │
│  └──────────────────┬───────────────────────────────┘          │
│                     ↓                                           │
│  Storage: /data/qsensor_recordings/session_id/                 │
│           chunk_00000.jsonl, chunk_00001.jsonl, ...            │
│                     ↑                                           │
│  ┌──────────────────┴───────────────────────────────┐          │
│  │ Q-Sensor Hardware (RS232)                        │          │
│  │  - /dev/ttyUSB0 @ 9600 baud                      │          │
│  │  - Free-run mode ~15 Hz sample rate              │          │
│  └──────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Files

This plan consists of **4 comprehensive documentation files**:

### 1. [05-cockpit-audit.md](./05-cockpit-audit.md)

**Purpose**: Exact integration points in Bio_Cockpit codebase

**Contents**:
- Electron main process structure
- IPC channel pattern (preload.ts)
- Video recording hooks (video.ts:416, video.ts:308)
- Widget system registration
- Action/event bus
- Storage path resolution
- **11 specific hook points with line numbers**

**Key Findings**:
- Hook after [video.ts:416](../../src/stores/video.ts#L416) - `MediaRecorder.start()`
- Hook before [video.ts:308](../../src/stores/video.ts#L308) - `MediaRecorder.stop()`
- Service setup in [main.ts:83-90](../../src/electron/main.ts#L83-L90)
- IPC channels in [preload.ts:48-62](../../src/electron/preload.ts#L48-L62)

---

### 2. [06-integration-plan.md](./06-integration-plan.md)

**Purpose**: Transparent UX design and fail-safe architecture

**Contents**:
- User experience flow diagram
- Transparent background mirroring architecture
- ASCII dataflow diagrams
- Settings (hidden from user with sane defaults)
- **4 fail-safe scenarios** with exact timing:
  - Tether disconnect: Max lag = outage + 15s, auto-resume
  - Cockpit crash: No auto-resume (future improvement)
  - ROV power off: Chunks on topside preserved
  - Q-Sensor API unavailable: Video continues, Q-Sensor silently disabled
- Performance calculations:
  - 1 Hz: 105 bytes/s (negligible)
  - 10 Hz: 1.05 KB/s
  - 100 Hz: 10.5 KB/s (~1.6% of video bandwidth at 640 KB/s)
- Security: input validation, rate limiting, log redaction
- Recovery strategy: idempotent resume with manifest reconciliation
- Implementation checklist

**Key Settings**:
- Poll interval: 15s (configurable)
- Chunk cadence: 60s (configurable 15-300s)
- Bandwidth cap: 500 KB/s
- Storage: `~/Cockpit/qsensor/<mission>/<session_id>/`

---

### 3. [07-file-plan-and-diffs.md](./07-file-plan-and-diffs.md)

**Purpose**: Concrete code changes for all files

**Contents**:
- **4 new files** with complete TypeScript/Vue implementations:
  - `src/electron/services/qsensor-mirror.ts` (270 lines) - Background chunk polling service
  - `src/libs/qsensor-client.ts` (120 lines) - REST API client wrapper
  - `src/stores/qsensor.ts` (100 lines) - Pinia state store
  - `src/components/mini-widgets/MiniQSensorRecorder.vue` (70 lines) - Optional status widget
- **4 file modifications** with minimal unified diffs:
  - [main.ts](../../src/electron/main.ts) - Add service setup call (1 line)
  - [preload.ts](../../src/electron/preload.ts) - Add IPC channels (7 lines)
  - [video.ts](../../src/stores/video.ts) - Hook start/stop recording (60 lines)
  - [widgets.ts](../../src/types/widgets.ts) - Add widget enum (1 line)
- Implementation checklist (14 tasks)

**Total Code**: ~560 lines of new TypeScript/Vue code + 70 lines of modifications

---

### 4. [08-qsensor-api-minimal.md](./08-qsensor-api-minimal.md)

**Purpose**: Required Q_Sensor_API endpoint changes

**Contents**:
- Current API analysis (existing endpoints ✅)
- **6 new endpoints required**:
  - POST `/record/start` - Start chunked recording session
  - POST `/record/stop` - Stop and finalize
  - GET `/record/status` - Current recording state
  - GET `/record/snapshots` - Manifest with SHA256 hashes
  - GET `/files/{session_id}/{filename}` - Download chunk
  - GET `/instrument/health` - Connection health check
- Complete Python implementation diffs
- `ChunkedDataStore` class (~60 lines)
- Environment variable configuration
- Port change: 8000 → 9150
- Testing checklist (10 tests)

**Total Code**: ~310 lines of new Python code + configuration updates

---

## File Structure Summary

```
Bio_Cockpit/
├── docs/qseries-desktop/
│   ├── 00-SUMMARY.md (this file)
│   ├── 05-cockpit-audit.md
│   ├── 06-integration-plan.md
│   ├── 07-file-plan-and-diffs.md
│   └── 08-qsensor-api-minimal.md
│
├── src/
│   ├── electron/
│   │   ├── main.ts (MODIFY: +1 line)
│   │   ├── preload.ts (MODIFY: +7 lines)
│   │   └── services/
│   │       └── qsensor-mirror.ts (NEW: 270 lines)
│   ├── stores/
│   │   ├── video.ts (MODIFY: +60 lines)
│   │   └── qsensor.ts (NEW: 100 lines)
│   ├── libs/
│   │   └── qsensor-client.ts (NEW: 120 lines)
│   ├── components/mini-widgets/
│   │   └── MiniQSensorRecorder.vue (NEW: 70 lines)
│   └── types/
│       └── widgets.ts (MODIFY: +1 line)
```

```
Q_Sensor_API/
├── api/
│   └── main.py (MODIFY: +250 lines)
└── data_store/
    └── store.py (MODIFY: +60 lines)
```

---

## Implementation Steps

### Phase 1: Q_Sensor_API Changes

1. **Update `api/main.py`**:
   - Add chunk recording state variables
   - Add 6 new endpoint handlers
   - Add request/response models
   - **Estimated time**: 2-3 hours

2. **Update `data_store/store.py`**:
   - Add `ChunkedDataStore` class
   - Implement auto-flush logic
   - **Estimated time**: 1 hour

3. **Update deployment**:
   - Change port 8000 → 9150
   - Add environment variables
   - Create `/data/qsensor_recordings` volume
   - **Estimated time**: 30 minutes

4. **Test API endpoints**:
   - Use `curl` or Postman to verify all endpoints
   - Test chunking with 15s interval
   - Verify SHA256 computation
   - **Estimated time**: 1-2 hours

**Phase 1 Total**: ~5-7 hours

---

### Phase 2: Cockpit Desktop Changes

5. **Create new service files**:
   - `src/electron/services/qsensor-mirror.ts`
   - `src/libs/qsensor-client.ts`
   - `src/stores/qsensor.ts`
   - `src/components/mini-widgets/MiniQSensorRecorder.vue`
   - **Estimated time**: 3-4 hours

6. **Modify existing files**:
   - [main.ts](../../src/electron/main.ts) - Import and setup call
   - [preload.ts](../../src/electron/preload.ts) - IPC channels
   - [video.ts](../../src/stores/video.ts) - Start/stop hooks
   - [widgets.ts](../../src/types/widgets.ts) - Enum entry
   - **Estimated time**: 2 hours

7. **Test Electron integration**:
   - Verify IPC communication
   - Test recording start/stop flow
   - Verify chunk polling and downloads
   - Check atomic writes and SHA256 verification
   - **Estimated time**: 2-3 hours

8. **Test fail-safe scenarios**:
   - Disconnect tether during recording → verify auto-resume
   - Kill Cockpit during recording → verify chunks preserved
   - Power off ROV → verify topside chunks intact
   - Disable Q-Sensor API → verify video continues
   - **Estimated time**: 2 hours

**Phase 2 Total**: ~9-12 hours

---

### Phase 3: End-to-End Integration

9. **Deploy Q_Sensor_API on ROV**:
   - Build Docker image
   - Deploy as BlueOS extension
   - Verify accessible at `http://blueos.local:9150`
   - **Estimated time**: 1-2 hours

10. **Full system test**:
    - Start recording from Cockpit desktop
    - Verify video recording starts
    - Verify Q-Sensor mirroring starts
    - Wait for 3-5 chunks to flush
    - Stop recording
    - Verify both video and Q-Sensor files on topside
    - **Estimated time**: 1 hour

11. **Optional: Widget integration**:
    - Register `MiniQSensorRecorder` widget
    - Add to default layout
    - Test UI interactions
    - **Estimated time**: 1 hour (optional)

**Phase 3 Total**: ~2-4 hours

---

**Grand Total**: ~16-23 hours of development + testing

---

## Success Criteria

### Must-Have

- ✅ Single Record button triggers both video and Q-Sensor recording
- ✅ Q-Sensor data mirrored live to topside (15s poll interval)
- ✅ Chunks written atomically with SHA256 integrity verification
- ✅ Video continues if Q-Sensor unavailable (graceful degradation)
- ✅ Tether disconnect auto-resumes mirroring on reconnect
- ✅ Topside preserves chunks even if ROV loses power
- ✅ No user-visible changes beyond existing Record button

### Should-Have

- ✅ Optional mini-widget showing Q-Sensor status
- ✅ Configurable chunk interval (15-300s)
- ✅ Bandwidth cap (500 KB/s default)
- ✅ Session metadata (mission name, linked video recording)

### Could-Have (Future)

- ⏸️ Cockpit crash auto-resume (requires persistent state)
- ⏸️ Chunk compression (gzip for reduced bandwidth)
- ⏸️ Real-time data preview in Cockpit UI
- ⏸️ Historical session browser

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Q-Sensor hardware failure | HIGH | Graceful degradation: video continues, Q-Sensor silently disabled |
| Network bandwidth overload | MEDIUM | 500 KB/s cap, 15s poll interval, configurable chunk cadence |
| Disk space exhaustion (Pi) | MEDIUM | Monitor with /instrument/health, alert if < 1GB free |
| Disk space exhaustion (topside) | LOW | User's responsibility (same as video recordings) |
| Chunk corruption during transfer | LOW | SHA256 verification, idempotent re-download |
| IPC communication failure | LOW | Timeout handling, error logging, retry logic |
| Concurrent recording attempts | LOW | 400 error prevents second recording session |

---

## Performance Characteristics

### Bandwidth Usage

| Sample Rate | Bytes/Sample | Bandwidth | % of Video (640 KB/s) |
|-------------|--------------|-----------|----------------------|
| 1 Hz        | 105 bytes    | 105 B/s   | 0.016%              |
| 10 Hz       | 105 bytes    | 1.05 KB/s | 0.16%               |
| 100 Hz      | 105 bytes    | 10.5 KB/s | 1.6%                |

**Conclusion**: Q-Sensor mirroring adds negligible network load.

### Storage Usage

- **Pi**: ~38 KB/minute @ 10 Hz → ~2.3 MB/hour
- **Topside**: Same as Pi (full mirror)
- **1-hour mission**: ~2.3 MB Q-Sensor data vs ~2-3 GB video

**Conclusion**: Q-Sensor data storage is negligible compared to video.

### Latency

- Poll interval: 15s (configurable)
- Chunk flush: 60s (configurable)
- **Max lag**: 75s (worst case: chunk just flushed + poll interval)
- **Typical lag**: ~37s (average)

---

## Security Considerations

1. **Input Validation**:
   - Session IDs validated as UUIDs
   - Filenames checked for path traversal (`..`, `/`)
   - Chunk intervals clamped (15-300s)

2. **Rate Limiting**:
   - Poll interval minimum 5s (configurable)
   - Bandwidth cap enforced (500 KB/s default)

3. **Log Redaction**:
   - No sensitive data (passwords, tokens) in Q-Sensor logs
   - Session IDs truncated in UI (first 8 chars)

4. **CORS**:
   - Q_Sensor_API allows `blueos.local` and `localhost` origins
   - No wildcard CORS

---

## Deployment Checklist

### Q_Sensor_API (ROV)

- [ ] Update `api/main.py` with new endpoints
- [ ] Update `data_store/store.py` with `ChunkedDataStore`
- [ ] Change port 8000 → 9150 in Dockerfile
- [ ] Add `CHUNK_RECORDING_PATH=/data/qsensor_recordings` to env
- [ ] Create Docker volume for `/data/qsensor_recordings`
- [ ] Build and deploy as BlueOS extension
- [ ] Verify accessible at `http://blueos.local:9150/health`
- [ ] Test all 6 new endpoints with curl

### Cockpit Desktop (Topside)

- [ ] Create `src/electron/services/qsensor-mirror.ts`
- [ ] Create `src/libs/qsensor-client.ts`
- [ ] Create `src/stores/qsensor.ts`
- [ ] Create `src/components/mini-widgets/MiniQSensorRecorder.vue`
- [ ] Modify [main.ts](../../src/electron/main.ts) - add setup call
- [ ] Modify [preload.ts](../../src/electron/preload.ts) - add IPC channels
- [ ] Modify [video.ts](../../src/stores/video.ts) - add hooks
- [ ] Modify [widgets.ts](../../src/types/widgets.ts) - add enum
- [ ] Test recording flow end-to-end
- [ ] Test fail-safe scenarios (tether disconnect, crashes)
- [ ] Verify chunks written to `~/Cockpit/qsensor/`
- [ ] Verify SHA256 integrity verification
- [ ] Verify atomic writes (no `.tmp` files remain)
- [ ] Verify graceful degradation (Q-Sensor unavailable)

---

## Next Steps

1. **Review this plan** with stakeholders
2. **Implement Phase 1** (Q_Sensor_API changes)
3. **Test API endpoints** with real Q-Sensor hardware
4. **Implement Phase 2** (Cockpit desktop changes)
5. **End-to-end integration test** with ROV + topside
6. **User acceptance testing** with full mission scenario
7. **Deploy to production**

---

## Additional Resources

- **Bio_Cockpit Repository**: `/Users/matthuewalsh/Bio_cockpit`
- **Q_Sensor_API Repository**: `/Users/matthuewalsh/qseries-noise/Q_Sensor_API`
- **BlueOS Bootstrap Reference**: `/Users/matthuewalsh/BlueOS/bootstrap`
- **Cockpit Video Recording Service**: [video-recording.ts](../../src/electron/services/video-recording.ts)
- **Cockpit Storage Service**: [storage.ts](../../src/electron/services/storage.ts)
- **Live Video Processor Pattern**: [live-video-processor.ts](../../src/libs/live-video-processor.ts)

---

## Contact

For questions or clarifications during implementation, refer to the detailed documentation files:

1. **Integration points**: [05-cockpit-audit.md](./05-cockpit-audit.md)
2. **Architecture & fail-safes**: [06-integration-plan.md](./06-integration-plan.md)
3. **Code implementation**: [07-file-plan-and-diffs.md](./07-file-plan-and-diffs.md)
4. **API changes**: [08-qsensor-api-minimal.md](./08-qsensor-api-minimal.md)

---

**Document Version**: 1.0
**Last Updated**: 2025-11-12
**Ready for Implementation**: ✅ Yes
