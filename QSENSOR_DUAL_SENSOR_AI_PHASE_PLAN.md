# Q-Sensor Dual-Sensor AI Execution Plan

## Phase 1 – Baseline Hardening & Multi-Sensor Scaffolding
1. **Phase Name & Goal**  
   Establish type definitions, shared utilities, and guardrails so the existing in-water Pi pipeline can coexist with a future topside serial stack without regressions.
2. **Scope & Boundaries**  
   - Included: extracting shared Q-Sensor types, preparing Pinia store hooks for multiple sensor instances, isolating existing HTTP client usage, and creating placeholders for two backends:
      - Pi-based in-water sensor (HTTP via Q_Sensor_API)
      - Topside surface sensor (direct serial controlled by Electron)
   - Excluded: any serial parsing, changes to Q_Sensor_API, or UI redesign; the Pi HTTP flow must remain byte-for-byte compatible per “In-Water Sensor Architecture (PROVEN)” in the architecture doc.
3. **Key Files / Modules to Touch**  
   - `src/stores/qsensor.ts`, `src/stores/qsensor-common.ts` (new shared helpers)  
   - `src/types/qsensor.ts` for strongly typed sensor/session structs  
   - `src/libs/qsensor-client.ts` for non-breaking refactors  
   - Supporting docs: `QSENSOR_DUAL_SENSOR_ARCHITECTURE_PLAN_v2.md` → sections “Current State Analysis” and “Phase 0: Preparation & Safety”.
4. **Inputs Needed by the AI Agent**  
   - Open the architecture doc sections above plus `README.md` for repo scripts.  
   - Inspect current Pinia store (`src/stores/qsensor.ts`) and HTTP client to understand existing API expectations.  
   - No hardware logs needed yet.
5. **Expected Outputs / Deliverables**  
   - New shared type definitions and helper utilities with unit tests if applicable.  
   - Refactored store scaffolding that can register multiple sensor entries (placeholders for `in-water` and `surface`).  
   - Documentation comment summarizing how sensor IDs map to backend types.
6. **Acceptance Criteria / Verification Tests**  
   - `yarn lint src/stores/qsensor.ts src/types/qsensor.ts` passes.  
   - `yarn test --runInBand` (or targeted Pinia/unit suites) succeeds with no new failures.  
   - Manual check: launch Cockpit dev app (`yarn electron:dev`) and confirm single Pi sensor UI works exactly as before (no new console errors).
7. **Suggested Prompt Skeleton for AI Agents**  
   "You are extending the Q-Sensor store to support multiple sensor contexts without changing runtime behavior. Review `src/stores/qsensor.ts` and the 'Phase 0' section of QSENSOR_DUAL_SENSOR_ARCHITECTURE_PLAN_v2.md. Extract shared types into `src/types/qsensor.ts`, add multi-sensor scaffolding, and ensure existing HTTP flows keep working. After edits, run `yarn lint` and targeted tests to verify no regressions."

## Phase 2 – Surface Sensor Direct Control (Topside Serial Stack)

1. **Phase Name & Goal**  
   Implement the *topside-only* direct control layer for the surface reference sensor.  
   This runs entirely inside Cockpit/Electron, speaks to the sensor over USB/serial, and mirrors the behavior of the Python library in `q_sensor_lib` so the surface sensor can connect/start/stop/acquire without ever touching the Pi or BlueOS.

2. **Scope & Boundaries**  
   - Included:
     - TypeScript port of the core Q-Series protocol behavior used for **direct serial control** of the surface sensor:
       - Frame tokenization and parsing
       - CRC/validation
       - Menu / state-machine logic (where applicable)
       - Acquisition control (connect, configure, start, stop, health)
     - A serial controller that:
       - Opens/closes the serial port on the **topside computer**
       - Manages freerun acquisition
       - Emits structured readings to higher layers with timestamps
     - Verbose logging hooks for later debugging.
   - Excluded:
     - Any Pi / HTTP behavior (that remains handled by Q_Sensor_API).
     - Local chunk writing (handled in Phase 3).
     - UI wiring or dual-sensor store work (handled in Phases 4–5).

3. **Key Files / Modules to Touch**  
   - `src/electron/services/qsensor-protocol.ts` (new)  
   - `src/electron/services/qsensor-serial-controller.ts` (new)  
   - `tests/qsensor-protocol.test.ts`, `tests/qsensor-serial-controller.test.ts`  
   - Reference existing serial infra in `src/electron/services/link/serial.ts`.  
   - **Reference library:** `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/q_sensor_lib` (Python) as the behavioral spec for:
     - Command formats
     - Response parsing
     - Error handling and retries

4. **Inputs Needed by the AI Agent**  
   - Architecture doc sections:
     - “Surface Sensor Architecture (NEW)”
     - “Phase 1: TypeScript Protocol Parser”
   - **Python reference implementation**:
     - Entire `q_sensor_lib` directory in the Q_Sensor_API repo:
       - Identify the modules responsible for serial I/O, command building, and response parsing.
       - Mirror their behavior in TypeScript (don’t copy literally, treat it as a spec).
   - Existing Cockpit serial stack:
     - `src/electron/services/link/serial.ts` for how other devices are handled.
   - Any available serial logs from the real Q-Series surface sensor (if present in `scripts/` or `binaries/`).

5. **Expected Outputs / Deliverables**  
   - A deterministic TypeScript parser that:
     - Accepts raw bytes from the topside serial port.
     - Reconstructs Q-Series messages/frames (e.g. `$LITE...`).
     - Emits structured readings with:
       - `timestamp_utc` (from Cockpit clock)
       - `timestamp_monotonic` (if feasible, or a monotonic tick estimate).
   - A serial controller that:
     - Exposes `connect()`, `disconnect()`, `startAcquisition()`, `stopAcquisition()`.
     - Emits events or callbacks for new readings.
     - Integrates a configurable acquisition mode consistent with Q_Sensor_API’s expectations (freerun first).
   - Unit tests that:
     - Feed in recorded frames from `q_sensor_lib` fixtures and assert identical parsed values.
     - Exercise error cases (bad CRC, truncated frame, garbage data).

6. **Acceptance Criteria / Verification Tests**  
   - `yarn test --runInBand tests/qsensor-protocol.test.ts tests/qsensor-serial-controller.test.ts` passes.  
   - For a curated set of sample frames:
     - Python `q_sensor_lib` and TypeScript `qsensor-protocol.ts` produce equivalent parsed objects (numerical data, flags, timestamps aligned modulo representation).  
   - Manual smoke (simulated if necessary):
     - `yarn electron:dev --simulate-surface-qsensor`
     - Logs show stable freerun acquisition at 500 Hz from **topside serial**, with no unbounded buffer growth or crashes.

7. **Suggested Prompt Skeleton for AI Agents**  
   > "You are implementing the *topside* direct control layer for the Q-Series **surface reference sensor**.  
   > Read `/Users/matthuewalsh/qseries-noise/Q_Sensor_API/q_sensor_lib` to understand the Python implementation of the Q-Series protocol and serial behavior.  
   > Then, implement `src/electron/services/qsensor-protocol.ts` and `qsensor-serial-controller.ts` so Cockpit can control the surface sensor over USB/serial (no Pi, no BlueOS).  
   > Your parser must reconstruct frames (e.g. `$LITE...`), validate them, and emit structured readings with UTC timestamps.  
   > Your controller must expose connect/start/stop and integrate with the existing Electron serial infrastructure in `src/electron/services/link/serial.ts`.  
   > Provide Jest/Vitest tests comparing the TypeScript parser output to fixtures derived from the Python `q_sensor_lib`.  
   > Do not modify any Pi/Q_Sensor_API HTTP behavior in this phase."

## Phase 3 – Surface Sensor Local Recorder & Integrity Layer
1. **Phase Name & Goal**  
   Deliver chunked CSV writing, manifest maintenance, and session finalization for the surface sensor so its output mirrors the proven Pi recorder, per “Phase 2: Local Data Recording”.
2. **Scope & Boundaries**  
   - Included: buffered chunk writer, manifest generation, checksum calculation, and session.csv stitcher for the topside surface sensor, consuming readings from the Phase 2 serial controller and mirroring the proven Pi recorder behavior. 
   - Excluded: UI wiring, time-sync metadata, or altering the Pi recorder.
3. **Key Files / Modules to Touch**  
   - `src/electron/services/qsensor-local-recorder.ts` (new)  
   - IPC glue inside `src/electron/main.ts`, `src/electron/preload.ts`, `src/types/electron.d.ts`  
   - Unit tests: `tests/qsensor-local-recorder.test.ts`.  
   - Reference manifest expectations from `QSENSOR_DUAL_SENSOR_ARCHITECTURE_PLAN_v2.md` → sections “Local Data Recording” and “Unified Output Architecture”.
4. **Inputs Needed by the AI Agent**  
   - Architecture doc chunk writer pseudocode and directory layouts.  
   - Existing Pi CSV/manifest examples (`binaries` or prior sessions) for golden-file comparison.  
   - Disk paths from Cockpit settings (config stored in `src/stores/settings.ts`).
5. **Expected Outputs / Deliverables**  
   - Recorder service able to spin up per session, flush atomic chunk files, generate manifests, and emit completion events.  
   - IPC handlers for connect/start/stop/mirror operations for the surface sensor.  
   - Tests proving chunk rotation, manifest updates, and session.csv consolidation.
6. **Acceptance Criteria / Verification Tests**  
   - `yarn test --runInBand tests/qsensor-local-recorder.test.ts` passes with large-buffer scenarios.  
   - Manual run: `LOG_LEVEL=debug yarn electron:dev --qsensor-sim` followed by verifying `{storage}/mission/session_surface*/` contains manifest + session.csv with correct row counts.  
   - Checksums recorded in manifest match `shasum -a 256 chunk_00000.csv`.  
   - Recorder gracefully handles flush intervals even when no readings arrive (no empty chunks).
7. **Suggested Prompt Skeleton for AI Agents**  
   "Follow ‘Phase 2: Local Data Recording’ to build `qsensor-local-recorder.ts`. Wire it to the serial controller via IPC so readings stream into chunked CSV files under the unified storage root. Add manifest generation, checksum validation, and tests that emulate rapid chunk flushes."

## Phase 4 – Dual-Sensor Store, IPC, and UI Integration
1. **Phase Name & Goal**  
   Expose both sensors end-to-end through Pinia stores and Vue components so operators can manage Pi HTTP + topside serial devices side-by-side, referencing “Phase 3: Dual-Sensor Store & UI” and “UI/UX Architecture”.
2. **Scope & Boundaries**  
   - Included: multi-sensor Pinia store APIs, IPC calls for serial actions, new Vue components (`QSensorPanel`, `QSensorSessionControls`, etc.), and refreshed view layout ensuring both sensors share mission context.  
   - Excluded: video auto-start wiring, sync metadata persistence, or advanced drift monitors (handled later).
3. **Key Files / Modules to Touch**  
   - `src/stores/qsensor.ts`, `src/stores/video.ts` (only for wiring store events, not yet video triggers)  
   - New components under `src/components/qsensor/` (panel, session controls, time-sync indicator, connection config, health/recording subcomponents)  
   - `src/views/ToolsQSeriesView.vue`, `src/components/mini-widgets/MiniQSensorRecorder.vue`.
4. **Inputs Needed by the AI Agent**  
   - Architecture doc “UI/UX Architecture” mockups and component breakdown.  
   - Existing Vuetify setup within `src/plugins/vuetify.ts`.  
   - Current video store integration points to understand future hooks.
5. **Expected Outputs / Deliverables**  
   - Store exposing `startBoth`, `stopBoth`, `measureClockOffset`, and per-sensor state selectors.  
   - Responsive dual-panel UI plus unified session controls with placeholders for sync status.  
   - Mini widget updated to surface both sensor statuses.
6. **Acceptance Criteria / Verification Tests**  
   - `yarn lint src/stores/qsensor.ts src/views/ToolsQSeriesView.vue src/components/qsensor` passes.  
   - `yarn test --runInBand` (component/unit suites) green.  
   - Manual UX check: run `yarn electron:dev`, confirm dual panels render, HTTP sensor can still connect via Pi while surface panel shows serial config state machine (even if simulator).  
   - Store actions emit proper IPC payloads (verify via devtools logs or `console.info`).
7. **Suggested Prompt Skeleton for AI Agents**  
   "Using the ‘UI/UX Architecture’ section, refactor the Q-Sensor Pinia store for multi-sensor control and implement the described Vue components in `src/components/qsensor/`. Ensure both sensors share mission/storage settings, and expose `startBoth/stopBoth` for later video automation. Validate with lint/tests and a manual dev run."

## Phase 5 – Unified Session Management, Time Sync, and Video Automation
1. **Phase Name & Goal**  
   Implement time-offset measurement, unified session directories, sync metadata, and automatic start/stop tied to video recording so both sensors and video share aligned lifecycle triggers.
2. **Scope & Boundaries**  
   - Included: `qsensor-timesync.ts`, `qsensor-session-manager.ts`, sync metadata writing, HTTP round-trip offset averaging, mission directory orchestration, and updates to `src/stores/video.ts` so both sensors start exactly with video capture per global requirements.  
   - Excluded: MAVLink TIMESYNC or monotonic timestamp enhancements (deferred future work unless dependencies demand it).
3. **Key Files / Modules to Touch**  
   - `src/electron/services/qsensor-timesync.ts`, `.../qsensor-session-manager.ts` (new)  
   - IPC: `src/electron/main.ts`, `src/electron/preload.ts`, `src/types/electron.d.ts` for session/time-sync commands  
   - Store: `src/stores/qsensor.ts` (wire measurement + metadata), `src/stores/video.ts` (auto start/stop)  
   - Metadata helpers possibly under `src/libs/` for JSON schemas.
4. **Inputs Needed by the AI Agent**  
   - Architecture doc sections “Time Synchronization Architecture”, “Unified Output Architecture”, and “Phase 4/5 descriptions”.  
   - Existing video start/stop hooks in `src/stores/video.ts`, plus `QSENSOR_TIMING_AUDIT_REPORT.md` for reference offsets if needed.  
   - Access to storage path settings (see `src/stores/settings.ts`).
5. **Expected Outputs / Deliverables**  
   - Time-sync service collecting averaged HTTP offsets with uncertainty metrics and optional drift polling hooks.  
   - Unified session directories with `sync_metadata.json` capturing mission, sensor, and video timing.  
   - Video initiation automatically invoking `startBoth` and finalization writing closing metadata, ensuring Pi sensor (HTTP) and surface sensor (serial) start/stop in lockstep with the media recorder.
6. **Acceptance Criteria / Verification Tests**  
   - `yarn lint` on all modified services/stores succeeds.  
   - Manual integration test: start video recording via Cockpit UI; verify both sensors begin simultaneously (logs show identical start timestamps) and storage path contains `sync_metadata.json` plus per-sensor directories.  
   - Command: `node scripts/inspect-sync.js <session_path>/sync_metadata.json` (write script if missing) prints offsets and passes schema validation.  
   - Run `yarn test --runInBand tests/qsensor-session-manager.test.ts` (new) validating metadata merges.  
   - Confirm stopping video stops both sensors and final metadata records stop time + duration.
7. **Suggested Prompt Skeleton for AI Agents**  
   "Per ‘Time Synchronization Architecture’ and ‘Unified Output Architecture’, add `qsensor-timesync.ts` and `qsensor-session-manager.ts` services plus IPC endpoints so starting video triggers both sensors, writes sync metadata (offsets, directories, video filename), and stopping video finalizes sessions. Update `src/stores/video.ts` and `src/stores/qsensor.ts` accordingly, then validate by running the dev app and inspecting the generated session folder."

## Phase 6 – System Validation & Field-Readiness
1. **Phase Name & Goal**  
   Execute the full hardware + simulator validation matrix to ensure dual-sensor capture, time-sync accuracy, and video coupling meet acceptance criteria from “Phase 6: Testing & Validation”.
2. **Scope & Boundaries**  
   - Included: automated Jest/Vitest suites, end-to-end Cockpit sessions, drift monitoring checks, fault-injection (serial disconnect, Pi API outage), and documentation updates summarizing procedures.  
   - Excluded: new feature development; only stabilization, bug fixes, and doc polish.
3. **Key Files / Modules to Touch**  
   - Test specs under `tests/` covering connection, acquisition, recording, time sync, video integration per architecture doc table.  
   - `QSENSOR_DEBUG_REPORT.md`, `QSENSOR_TIMING_AUDIT_REPORT.md` for logging templates.  
   - `README.md` / `docs/` for operator instructions.
4. **Inputs Needed by the AI Agent**  
   - Architecture doc section “Phase 6: Testing & Validation” plus “Success Criteria”.  
   - Access to hardware logs or simulator outputs (stored under `binaries/` or `scripts/`).  
   - Knowledge of mission storage paths to inspect generated data.
5. **Expected Outputs / Deliverables**  
   - Updated automated test suites, scripted manual test checklist, and bug fixes discovered during validation.  
   - Documentation addendum describing how to run alignment verification and interpret sync indicators.  
   - Archived sample datasets demonstrating aligned Pi/surface/video timestamps.
6. **Acceptance Criteria / Verification Tests**  
   - `yarn test --runInBand` (entire suite) passes repeatedly on CI and locally.  
   - Manual scenarios enumerated in architecture doc all signed off, with logs captured in `QSENSOR_DEBUG_REPORT.md`.  
   - Field trial: run dual recording for ≥30 min, confirm `sync_metadata.json` shows drift <50 ms and `session.csv` for both sensors align when run through the provided Python merge script (`python scripts/postprocess/align_qsensor.py <session_root>`).  
   - Any critical bugs raised during validation are resolved with regression tests.
7. **Suggested Prompt Skeleton for AI Agents**  
   "Act as the validation lead for the dual-sensor stack. Follow the ‘Phase 6: Testing & Validation’ matrix, expand automated tests under `tests/`, and document manual procedures in `QSENSOR_DEBUG_REPORT.md`. Record results, fix blocking issues, and verify long-duration runs keep offset <50 ms using the provided post-processing script."
