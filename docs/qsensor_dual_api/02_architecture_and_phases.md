# Q-Sensor Dual-API Architecture and Implementation Phases

## Phase 1 – Core Dual-API Wiring (Manual Surface URL)

### Goals
- Enable surface sensor to use HTTP backend with separate API URL configuration
- Add persistence for surface sensor API URL across app restarts
- Update UI to show different URL inputs for in-water vs. surface sensors
- Ensure in-water sensor behavior remains completely unchanged

### Non-Goals
- No auto-discovery for surface sensor (manual URL entry only)
- No changes to mirroring or time-sync behavior
- No changes to port configuration (still defaults to 9150)
- No modifications to connection flow beyond URL configuration

### Key Files
- `src/stores/qsensor.ts` - Add surface API URL support and persistence
- `src/electron/services/config-store.ts` - Add surface API URL storage
- `src/types/electron.d.ts` - Add IPC method signatures
- `src/components/qsensor/QSensorConnectionControl.vue` - Conditional URL inputs
- `src/components/qsensor/QSensorConnectionModeSelector.vue` - Label updates
- `src/types/qsensor.ts` - Update type comments

### Main Changes
- Initialize surface sensor with empty `apiBaseUrl` field
- Add `setSurfaceApiUrl()` action with validation and persistence
- Add config store keys and IPC handlers for surface API URL
- Update UI to show different URL inputs based on sensor ID
- Update connection mode labels to be generic for any API host

### Risks and Coupling
- **Low risk**: Type definition changes have no runtime impact
- **Medium risk**: Store changes could affect surface sensor initialization
- **Low coupling**: UI changes are isolated to connection components
- **No impact**: In-water sensor behavior remains unchanged

## Phase 2 – Electron + Mirroring Correctness

### Goals
- Fix hard-coded port 9150 in mirroring service to use full API base URL
- Ensure surface recordings and time-sync work correctly against surface Pi
- Update mirroring to use per-sensor API URLs instead of vehicleAddress
- Make time sync measurements work for both sensors independently

### Non-Goals
- No UI changes (Phase 1 UI should be sufficient)
- No auto-discovery implementation
- No changes to connection flow beyond mirroring
- No modifications to data fusion logic

### Key Files
- `src/electron/services/qsensor-mirror.ts` - Use full API URLs instead of host+port
- `src/stores/qsensor.ts` - Pass full API URL to mirroring service
- `src/types/electron.d.ts` - Update IPC method signatures
- `src/electron/services/qsensor-time-sync.ts` - Ensure per-sensor time sync

### Main Changes
- Update `MirrorSession` interface to store full `apiBaseUrl`
- Replace hard-coded URL construction with full URL usage
- Update IPC signatures to accept full API URLs
- Modify sync marker injection to use complete API base URL
- Ensure chunk downloads use per-sensor API endpoints

### Risks and Coupling
- **High risk**: Changes to core mirroring service could break data transfer
- **High coupling**: IPC signature changes affect both main and renderer processes
- **Medium risk**: Time sync changes could affect data alignment
- **Critical dependency**: Must maintain backward compatibility during transition

## Phase 3 – Polish & Optional Enhancements

### Goals
- Add connectivity tests before saving URLs
- Improve error messages for surface sensor connection failures
- Add tooltips and help text explaining dual-API setup
- Optional: Implement auto-discovery for surface reference sensor

### Non-Goals
- No major architectural changes
- No changes to core data flow or fusion logic
- No modifications to existing connection workflows
- No changes to mirroring service beyond Phase 2

### Key Files
- `src/stores/qsensor.ts` - Add URL validation and connectivity testing
- `src/components/qsensor/QSensorConnectionControl.vue` - Enhanced error messaging
- `src/components/qsensor/QSensorConnectionModeSelector.vue` - Help text
- `src/electron/services/qsensor-host-discovery.ts` - Optional surface discovery

### Main Changes
- Add URL format validation before saving
- Implement connectivity test API calls
- Enhance error messages with specific guidance
- Add user assistance tooltips and contextual help
- Optional: Implement mDNS discovery for surface sensor hosts

### Risks and Coupling
- **Low risk**: Validation and UX improvements are isolated
- **Medium risk**: Auto-discovery could affect network behavior
- **Low coupling**: Help text and tooltips are cosmetic
- **Optional dependency**: Auto-discovery can be implemented separately