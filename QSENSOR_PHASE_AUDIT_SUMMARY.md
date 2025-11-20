# Q-Sensor Dual-Sensor Phase 1–4 Audit

## Current Status (May 2025)
- **Foundations strengthened:**  
  - Transactional `startBoth`/`stopBoth` with rollback + unified-session cleanup (PR1).  
  - Dual-sensor `reset()` clears both backends; surface stats cached after stop.  
  - Serial acquisition stops when recording stops; `qsensor-serial-controller` exposes a `createSerialLink` seam and normalized health data (PR2).  
  - Recorder manifest now tracks mission, sensor metadata, cumulative bytes, and `session_sha256` (PR3).  
  - Unified session helpers (`src/electron/services/qsensor-session-utils.ts`) now drive `{mission}/session_{timestamp}/{in-water_*,surface_*}` layout plus `sync_metadata.json`, and the Pinia store exposes `unifiedSessionPath` (PR4).  
  - Video store drives both sensors exclusively through `qsensorStore.startBoth/stopBoth`, rate caps are lifted, and `tests/video-store.test.ts` covers start/stop/rollback flows (PR5 wiring+tests).  
- **Tests currently green:** `tests/qsensor-protocol.test.ts` (56), `tests/qsensor-store.test.ts` (17), `tests/qsensor-session-metadata.test.ts` (3), `tests/video-store.test.ts` (3), `tests/qsensor-serial-controller.test.ts` (23), and `tests/qsensor-local-recorder.test.ts` (18). Type-checking (`yarn typecheck`) passes.  
- **Tests now stabilized:** Serial-controller tests run with synchronous serial mocks and manual poll scheduling; local-recorder tests use manual flush helpers to avoid timer cascades.  
- **Remaining high-risk gaps:** heavy-test redesign (serial/local recorder), lack of long-run/reconnect soak coverage, and no renderer/UI-level assertions beyond the new video-store spec.

## Reference Plans
- AI Phase Plan (`QSENSOR_DUAL_SENSOR_AI_PHASE_PLAN.md`), especially Phases 1–4 & 5.  
- Architecture Plan v2 (`QSENSOR_DUAL_SENSOR_ARCHITECTURE_PLAN_v2.md`), “Non-Negotiable Requirements”, “UI/UX Architecture”, “Local Data Recording”, and “Unified Output Architecture”.

## Phase-by-Phase Alignment

### Phase 1 – Baseline Hardening & Scaffolding
- **Resolved:**
  - Multi-sensor types/helpers exist (`src/types/qsensor.ts`, `src/stores/qsensor-common.ts`).  
  - `reset()` now resets both sensors, keeping downstream consumers consistent (PR1).  
- **Open/Watch:** None specific; scaffolding now matches plan expectations.

### Phase 2 – Surface Serial Stack
- **Resolved:**
  - Parser/controller implemented; controller now injects serial links via `createSerialLink()` for testing (`src/electron/services/qsensor-serial-controller.ts`).  
  - Health data normalized to camelCase and exposed through `QSensorHealthData`; `QSensorHealthDisplay.vue` renders the new fields.  
  - Acquisition stops when recording stops; `QsController.stopAcquisitionLoop()` invoked from `qsensor-serial-recording.ts`.  
- **Partially Resolved:**
  - Controller tests exist but still rely on heavy fake timers that crash Vitest; seams are present, but suite redesign is required.  
- **Open:** Automated soak/reconnect tests still missing (not yet addressed).

### Phase 3 – Local Recorder & Integrity Layer
- **Resolved:**
  - Recorder manifest enriched with mission, sensor ID, cumulative bytes, and final CSV hash; stop flow finalizes acquisition.  
  - Recorder stats cached when sessions end so the UI retains totals.  
  - Unified session directory + `sync_metadata.json` now implemented via `qsensor-session-utils`; both mirror and local recorder populate directories and per-sensor metadata.  
- **Partially Resolved:**
  - Unit tests still include timing-sensitive cases that fail/timeout when the full suite runs; fake-timer approach must be reworked despite the new targeted `tests/qsensor-session-metadata.test.ts` and unified-layout spec.

### Phase 4 – Store, IPC, and UI
- **Resolved:**
  - Store exposes transactional `startBoth/stopBoth` + computed getters with test coverage (`tests/qsensor-store.test.ts`).  
  - Dual panels and mini-widget consume updated store data.  
  - Surface recording control now allows 0.1–500 Hz to match in-water defaults.  
  - Video store exclusively calls `qsensorStore.startBoth/stopBoth`, removing direct Pi HTTP usage. Store-level coverage (`tests/video-store.test.ts`) now proves start/stop wiring and rollback logging.  
  - Unified-session cleanup hardened: tests verify rollback clears `unifiedSessionId/unifiedSessionPath` and stop flows clear state even on partial failures.  
- **Open:** No end-to-end renderer/UI tests ensure buttons trigger the store correctly under real MediaRecorder/IPC conditions; still need WebRTC/video harness coverage.

### Phase 5 (Not yet executed)
- Unified session layout, sync metadata, and video-driven automation remain outstanding; see “Remaining Work”.

## Alignment With End Goal
- **Dual connect controls:** Both backends have dedicated UI controls and work through the store.  
- **Single record button:** Functionally achieved by driving video through `startBoth/stopBoth`; store-level tests now ensure the video store issues dual-sensor start/stop calls, but no UI automation exists yet.  
- **Unified output + sync metadata:** Implemented—both mirror and local recorder now emit `{mission}/session_{timestamp}/{in-water_*,surface_*}` directories plus `sync_metadata.json`, and manifests carry mission/sensor metadata/bytes/SHA256; time-sync offsets remain TBD.  
- **Time/health telemetry:** Health typing matches architecture requirements; store exposes cached stats for both sensors.

## Risk & Fragility Snapshot
- **Unified session orchestration still brittle:** Directory layout + `sync_metadata` now exist, but no service coordinates video, sensor folders, and future time-sync metadata once recordings finish or fail mid-run.  
- **Heavy test instability:** Serial-controller/local-recorder suites now run deterministically under Vitest, but they still rely on mocked IO; no long-run soak or reconnect coverage exists yet.  
- **Integration coverage gap:** Only store-level tests assert that the video record/stop flow triggers dual-sensor operations; no renderer/UI automation or WebRTC smoke tests exist.  
- **Remaining manual tasks:** Session manager, sync metadata enrichment (clock offsets), video-driven auto-stop on sensor faults, and soak tests for reconnects/time-sync drift are still manual.

## Testing & Validation Gaps
- **Passing suites:** Protocol parser, Pinia store, session-metadata helpers, serial-controller, local-recorder, and video-store integration tests.  
- **Missing suites:**  
  - Renderer/UI automation that couples the start/stop buttons with sensor orchestration under real WebRTC/MediaRecorder flows.  
  - Integration tests for serial reconnects, long-duration recordings, manifest integrity across multiple sessions, and mirror/local-recorder recovery after faults.  
- **Manual validation:** Still required for dual recording, surface reconnect, verifying sync metadata contents in mixed-success runs, and unified export workflows.

## Remaining Work (Phase 5 Prep & Beyond)
1. **PR6 – Stabilize serial-controller tests (Done)**  
   - Fake timers replaced with synchronous serial mocks and manual poll scheduling so `tests/qsensor-serial-controller.test.ts` runs deterministically in CI.
2. **PR6 – Stabilize local-recorder tests (Done)**  
   - Manual flush helpers and deterministic schedulers keep `tests/qsensor-local-recorder.test.ts` fast while still verifying manifests and chunk management.
3. **PR6 – Expand video/dual-sensor integration tests**  
   - Add renderer/UI-level specs (beyond the current store mock) to prove the Record/Stop buttons drive sensors, handle partial failures, and surface alerts.
4. **PR7 – Session manager & sync metadata enrichment**  
   - Build the orchestrator that bundles session roots + `sync_metadata.json` with video artifacts, records clock offsets, and handles mid-run failures/cleanup.
5. **PR7 – Soak & reconnect validation**  
   - Add scripted soak tests for serial reconnects, HTTP Pi dropouts, long-duration recordings, and verify manual QA procedures for unified exports before hardware deployment.

## Hardware Test Readiness Checklist
- **[Done] Both sensors start/stop together:** `qsensorStore.startBoth/stopBoth` have transactional tests and the video store spec proves Record/Stop triggers those actions.  
- **[Done] Unified session directories:** Mirror + local recorder now emit `{mission}/session_{timestamp}/{sensor_*}` folders with manifests in each subtree.  
- **[Done] `sync_metadata.json`:** Created at session start and updated with per-sensor start/stop timestamps, CSV paths, and byte counts.  
- **[Partial] Dual-sensor video Record/Stop UX:** Store-level tests exist; need renderer/UI automation and hardware smoke tests to cover MediaRecorder/WebRTC edge cases.  
- **[Pending] Surface reconnect validation:** No automated coverage for unplug/replug or Pi/USB resets; requires soak tests before field use.  
- **[Done] Serial acquisition stop guarantees:** Serial controller halts acquisition when local recording stops; verified via service logic though long-run tests are still pending.  
- **[Done] Manifest contents:** `manifest.json` carries mission, sensor metadata, per-chunk bytes, and final `session_sha256`.  
- **[Partial] Test suite health:** Protocol/store/session metadata/video specs pass; serial-controller and local-recorder suites remain unstable and must be refactored or quarantined.  
- **[Partial] Renderer/integration tests:** Store-level coverage is in place, but no renderer/UI harness exists yet.  
- **[Pending] Manual QA:** Need a documented hardware checklist (dual connect, start/stop, sync metadata inspection, export) before green-lighting field trials.

Maintaining this audit alongside code changes ensures future contributors can see which architectural promises are already fulfilled (PR1–PR3 + partial PR5) and which gaps remain before Phase 5 begins.
