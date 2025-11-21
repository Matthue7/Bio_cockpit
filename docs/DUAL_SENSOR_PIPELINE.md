# Dual-Sensor Data Pipeline

## Purpose

This document describes the data flow for the dual-sensor Q-Sensor system, from raw sensor readings to the final unified CSV output.

---

## Overview

The dual-sensor pipeline records data from two Q-Sensors simultaneously:

1. **In-water sensor**: Attached to BlueROV2, communicates via BlueOS API
2. **Surface sensor**: Connected to topside computer via USB serial

Both produce identically-formatted CSV data that is merged into a unified output for scientific analysis.

---

## In-Water Sensor Path

### Data Flow

```
Q-Sensor (ROV) → Serial → BlueOS Q_Sensor_API → HTTP → Electron Main → Local Storage
```

### Step-by-Step

1. **Sensor → BlueOS**: Q-Sensor streams readings over serial to the Raspberry Pi running BlueOS
2. **BlueOS Recording**: Q_Sensor_API extension writes data to chunked CSV files on the Pi
3. **Mirroring**: Electron's `qsensor-mirror.ts` polls the API for new chunks
4. **Download**: Each chunk is downloaded atomically (temp file → rename)
5. **Integrity**: SHA256 checksums verify each chunk
6. **Finalization**: On stop, chunks are combined into `session.csv`

### API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/recording/start` | POST | Begin recording on Pi |
| `/recording/stop` | POST | Stop recording on Pi |
| `/chunks` | GET | List available chunks |
| `/chunks/{index}` | GET | Download specific chunk |
| `/status` | GET | Get sensor/recording status |

### Mirror Configuration

- **Polling interval**: Configurable (default 5 seconds)
- **Full bandwidth mode**: Downloads all available chunks each cycle
- **Normal mode**: Downloads one chunk per cycle

---

## Surface Sensor Path

### Data Flow

```
Q-Sensor (Surface) → USB Serial → Electron Main → Local Storage
```

### Step-by-Step

1. **Serial Connection**: `qsensor-serial-controller.ts` opens serial port
2. **Protocol Parsing**: `qsensor-protocol.ts` parses Q-Sensor ASCII frames
3. **Buffering**: `qsensor-local-recorder.ts` buffers readings
4. **Chunk Writing**: Buffer flushed every 200ms; chunks rolled at interval
5. **Integrity**: SHA256 calculated for each chunk
6. **Finalization**: On stop, chunks combined into `session.csv`

### Serial Configuration

- **Baud rate**: 19200 (default for Q-Sensor)
- **Data format**: ASCII lines with comma-separated values

### Chunk Rolling

Chunks are automatically rolled based on the configured interval (default 60 seconds). This prevents any single chunk from becoming too large and limits data loss on failure.

---

## CSV Schema

Both sensors produce identical CSV format:

```csv
timestamp,sensor_id,mode,value,TempC,Vin
2025-11-18T12:00:01.123456+00:00,SN12345,freerun,123.456789,21.34,12.345
```

| Column | Description |
|--------|-------------|
| `timestamp` | ISO 8601 with microseconds and timezone |
| `sensor_id` | Sensor serial number |
| `mode` | Operating mode (freerun, integrate, etc.) |
| `value` | Primary measurement value |
| `TempC` | Temperature in Celsius |
| `Vin` | Input voltage |

---

## Session Directory Structure

```
YYYY-MM-DD_HH-MM-SS/                    # Unified session root
  in-water_<sessionId>/                 # In-water sensor data
    chunk_000.csv                       # First chunk
    chunk_001.csv                       # Second chunk
    ...
    manifest.json                       # Chunk metadata and checksums
    session.csv                         # Combined final output
  surface_<sessionId>/                  # Surface sensor data
    chunk_000.csv
    chunk_001.csv
    ...
    manifest.json
    session.csv
  sync_metadata.json                    # Session sync and fusion status
  unified_session.csv                   # Fused wide-format output
```

### Manifest Structure

Each sensor directory contains a `manifest.json`:

```json
{
  "session_id": "abc123",
  "sensor_id": "SN12345",
  "mission": "Test Mission",
  "started_at": "2025-11-18T12:00:00.000Z",
  "stopped_at": "2025-11-18T12:30:00.000Z",
  "next_chunk_index": 30,
  "total_rows": 18000,
  "total_bytes": 1234567,
  "schema_version": 1,
  "chunks": [
    {
      "index": 0,
      "name": "chunk_000.csv",
      "rows": 600,
      "sha256": "...",
      "size_bytes": 45000,
      "timestamp": "2025-11-18T12:00:00.000Z"
    }
  ],
  "session_sha256": "..."
}
```

---

## Recording Lifecycle

### Start

1. UI triggers start via IPC
2. Main process generates unified session timestamp
3. Both sensors start recording with shared timestamp
4. Session directories created
5. `sync_metadata.json` initialized

### During Recording

- In-water: Mirror service polls and downloads chunks
- Surface: Local recorder writes buffered chunks
- UI displays live statistics (rows, bytes, status)

### Stop

1. UI triggers stop via IPC
2. Both sensors finalize:
   - Flush remaining buffers
   - Write final chunk
   - Combine all chunks into `session.csv`
   - Calculate session checksum
   - Update manifest
3. Update `sync_metadata.json` with completion status
4. Trigger fusion (if both sensors complete)

---

## Chunk Combination

When recording stops, chunks are combined into a single `session.csv`:

1. Read all chunks in index order
2. Skip header rows for chunks after the first
3. Concatenate data rows
4. Calculate SHA256 of complete file
5. Write to `session.csv`
6. Update manifest with `session_sha256`

---

## Fusion Process

After both sensors complete, the fusion service creates `unified_session.csv`:

1. Read both `session.csv` files
2. Parse timestamps and tag rows by source
3. Apply time corrections if sync markers present
4. Sort all rows by timestamp
5. Merge into wide format (in-water + surface columns)
6. Write `unified_session.csv`
7. Update `sync_metadata.json` with fusion status

See [Time Sync and Fusion](TIME_SYNC_AND_FUSION.md) for algorithm details.

---

## Error Handling

### In-Water Mirror Failures

- **Network timeout**: Retry on next poll cycle
- **404 on chunk**: Log warning, may indicate recording stopped
- **Checksum mismatch**: Re-download chunk

### Surface Recording Failures

- **Serial disconnect**: Emit error event, attempt reconnect
- **Write failure**: Log error, continue buffering
- **Chunk corruption**: Detected on combine via checksum

### Fusion Failures

- **Missing session.csv**: Mark fusion as failed
- **Parse errors**: Log and skip malformed rows
- **Single sensor only**: Mark fusion as skipped

---

## Related Documentation

- [Architecture](ARCHITECTURE.md) - System overview and service descriptions
- [Time Sync and Fusion](TIME_SYNC_AND_FUSION.md) - Time alignment algorithm
