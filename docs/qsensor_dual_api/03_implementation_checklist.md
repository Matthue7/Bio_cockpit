# Q-Sensor Dual-API Implementation Checklist

## Phase 1 – Core Dual-API Wiring

### Type Definitions
- Add surface API URL methods to `src/types/electron.d.ts`
- Update `src/types/qsensor.ts` comments to reflect both sensors can use HTTP

### Config Store
- Add `qsensorSurfaceApiUrl` to schema in `src/electron/services/config-store.ts`
- Add `qsensorSurfaceApiUrl` to `ElectronStoreSchema` interface
- Add IPC handlers for surface API URL get/set operations

### Store Updates
- Initialize surface sensor with `apiBaseUrl` field in `src/stores/qsensor.ts`
- Add `setSurfaceApiUrl()` action with URL validation in `src/stores/qsensor.ts`
- Export `setSurfaceApiUrl` in store return object
- Update `loadHostDiscoveryState()` to load surface API URL from config

### UI Components
- Update connection mode label in `src/components/qsensor/QSensorConnectionModeSelector.vue`
- Add conditional API URL fields in `src/components/qsensor/QSensorConnectionControl.vue`
- Add `handleSaveSurfaceUrl()` method in `src/components/qsensor/QSensorConnectionControl.vue`

### Phase 1 Testing
- Verify in-water sensor still connects to BlueOS API as before
- Configure surface sensor in API mode with manual URL `http://surfaceref.local:9150`
- Test surface sensor connects to separate API host
- Verify both sensors can be connected simultaneously
- Test app restart - surface API URL should persist
- Verify in-water sensor behavior is unchanged

## Phase 2 – Electron + Mirroring Correctness

### Mirror Service Updates
- Update `MirrorSession` interface to use `apiBaseUrl` instead of `vehicleAddress`
- Update `injectPiSyncMarker()` to use full API URL
- Update `downloadChunk()` to accept and use full API URL
- Update `pollAndMirror()` to use full API URL
- Update `startMirrorSession()` signature to accept full API URL
- Update session creation to store full API URL

### IPC Signature Updates
- Update `startQSensorMirror` signature in `src/types/electron.d.ts`
- Update IPC handler signature in `src/electron/services/qsensor-mirror.ts`

### Store Integration
- Update mirror start call in `src/stores/qsensor.ts` to pass `sensor.apiBaseUrl`

### Phase 2 Testing
- Start dual-sensor recording with both sensors in API mode
- Verify data mirroring works from both APIs
- Test time sync measurements for both sensors
- Verify session fusion combines data from both sensors correctly
- Test with different ports (if configured) to ensure port flexibility
- Verify chunk downloads work from both API hosts

## Phase 3 – Polish & Optional Enhancements

### Connectivity Testing
- Add URL validation to `setSurfaceApiUrl()` in `src/stores/qsensor.ts`
- Add connectivity test before saving surface API URL
- Add error handling for unreachable hosts

### UX Improvements
- Improve error messages for surface sensor connection failures
- Add tooltips/help text explaining dual-API setup
- Add loading states during connectivity tests

### Optional Auto-Discovery
- Implement surface sensor discovery service
- Add discovery UI component for surface sensor
- Test auto-discovery functionality

### Phase 3 Testing
- Test URL validation with invalid formats
- Test connectivity check with unreachable hosts
- Verify improved error messages are helpful
- If implemented, test auto-discovery for surface sensor

## Final Integration Testing

### End-to-End Scenarios
- Test complete workflow: configure both sensors → connect → start recording → stop recording → verify data
- Test error recovery: disconnect one sensor → reconnect → continue recording
- Test app restart with both sensors configured
- Test with only one sensor connected (in-water only, surface only)
- Verify backward compatibility with existing single-sensor workflows

### Performance & Reliability
- Test recording stability over extended periods
- Verify memory usage with both sensors active
- Test network interruption recovery
- Verify data integrity after unexpected shutdowns