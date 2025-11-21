# Q-Sensor Integration Architecture

## Purpose

This document describes the high-level architecture of the Biospherical Instruments (BSI) Q-Sensor integration, which extends the Blue Robotics Cockpit application with dual-sensor scientific data acquisition capabilities.

---

## System Overview

The integration adds a dual-sensor recording system to Cockpit:

- **In-water sensor**: Q-Sensor attached to BlueROV2, accessed via BlueOS `Q_Sensor_API`
- **Surface sensor**: Reference Q-Sensor connected directly to the topside computer via serial

Both sensors record simultaneously, with data fused into a unified CSV for scientific analysis.

---

## Process Architecture

### Electron Main Process

The Electron main process hosts all Q-Sensor services. This design:

- Bypasses CORS restrictions for BlueOS API calls
- Enables direct serial port access for surface sensor
- Provides atomic file operations for data integrity

Key services in `src/electron/services/`:

| Service | File | Responsibility |
|---------|------|----------------|
| Control | `qsensor-control.ts` | Proxy API calls to Q_Sensor_API (CORS bypass) |
| Mirror | `qsensor-mirror.ts` | Live-mirror in-water data from BlueOS to topside |
| Local Recorder | `qsensor-local-recorder.ts` | Record surface sensor data locally |
| Fusion | `qsensor-fusion.ts` | Merge dual-sensor data into unified CSV |
| Time Sync | `qsensor-time-sync.ts` | Manage time synchronization between sensors |
| Session Utils | `qsensor-session-utils.ts` | Shared session management utilities |
| Serial Controller | `qsensor-serial-controller.ts` | Serial port communication for surface sensor |
| Protocol | `qsensor-protocol.ts` | Q-Sensor data parsing and protocol handling |

### Vue Renderer Process

The Vue renderer provides UI components for:

- Sensor status display
- Recording controls (start/stop)
- Session management
- Data visualization

Key files:

- `src/stores/qsensor.ts` - Pinia store for Q-Sensor state
- `src/stores/qsensor-common.ts` - Shared state utilities
- `src/libs/qsensor-client.ts` - IPC client for renderer-to-main communication
- `src/types/qsensor.ts` - TypeScript type definitions

---

## Data Flow

### Recording Start

1. User initiates recording from UI
2. Renderer sends IPC message to main process
3. Main process starts both recording paths in parallel:
   - **In-water**: Starts mirroring from BlueOS Q_Sensor_API
   - **Surface**: Starts local serial recording
4. Both paths write to unified session directory

### During Recording

**In-water path:**
```
BlueOS Q_Sensor_API → HTTP polling → qsensor-mirror.ts → chunk files
```

**Surface path:**
```
Serial port → qsensor-serial-controller.ts → qsensor-local-recorder.ts → chunk files
```

### Recording Stop

1. User stops recording from UI
2. Both recording paths finalize:
   - Flush remaining data
   - Combine chunks into `session.csv`
   - Calculate checksums
3. Fusion service merges both `session.csv` files
4. Output: `unified_session.csv` with wide-format columns

---

## Integration with BlueOS

### Q_Sensor_API

The in-water Q-Sensor runs as a BlueOS extension, exposing a REST API:

- `/sensor/connect` - Connect to sensor serial port
- `/sensor/disconnect` - Disconnect from sensor
- `/status` - Get sensor status
- `/recording/start` - Start recording
- `/recording/stop` - Stop recording
- `/chunks` - List available data chunks
- `/chunks/{index}` - Download specific chunk

### CORS Bypass

BlueOS serves the Q_Sensor_API over HTTP from the ROV's IP. Browser security restrictions (CORS) prevent direct access from the renderer. The Electron main process acts as a proxy, making requests from Node.js where CORS doesn't apply.

---

## Session Directory Structure

All session data is stored under the configured storage path:

```
qsensor-data/
  YYYY-MM-DD_HH-MM-SS/           # Unified session root
    in-water_<sessionId>/
      chunk_000.csv
      chunk_001.csv
      ...
      manifest.json
      session.csv                 # Combined final output
    surface_<sessionId>/
      chunk_000.csv
      chunk_001.csv
      ...
      manifest.json
      session.csv                 # Combined final output
    sync_metadata.json            # Session metadata and fusion status
    unified_session.csv           # Fused wide-format output
```

---

## Key Design Decisions

### Chunked Recording

Both sensors write data in time-limited chunks (default 60 seconds). Benefits:

- Minimizes data loss on crash
- Enables incremental transfer from ROV
- Allows integrity verification per chunk

### Atomic File Operations

All writes use the `.tmp` → rename pattern to prevent partial files:

1. Write to `filename.tmp`
2. Atomically rename to `filename`

### SHA256 Integrity

Each chunk includes a SHA256 checksum in the manifest. The final `session.csv` also records its checksum for end-to-end verification.

---

## Related Documentation

- [Dual Sensor Pipeline](DUAL_SENSOR_PIPELINE.md) - Detailed data flow and processing
- [Time Sync and Fusion](TIME_SYNC_AND_FUSION.md) - Time alignment and fusion algorithm
