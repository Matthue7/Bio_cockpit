# Time Synchronization and Data Fusion

## Purpose

This document describes the time synchronization strategy and fusion algorithm used to merge dual-sensor Q-Sensor data into a unified output with scientific timing accuracy.

---

## Overview

The dual-sensor system faces a timing challenge: two sensors record independently, potentially with clock drift between them. The fusion algorithm must:

1. Align data from both sensors on a common timeline
2. Account for any clock offset between sensors
3. Handle drift that accumulates over long recordings
4. Produce a unified output suitable for scientific analysis

---

## Time Synchronization Strategy

### Timestamp Format

All timestamps use ISO 8601 with microsecond precision and timezone:

```
2025-11-18T12:00:01.123456+00:00
```

Both sensors record in UTC to eliminate timezone ambiguity.

### Clock Offset

The primary timing challenge is the offset between:

- **In-water sensor**: Timestamps from BlueOS (ROV's Raspberry Pi clock)
- **Surface sensor**: Timestamps from topside computer clock

These clocks are not synchronized by default. The offset is stored in `sync_metadata.json`:

```json
{
  "timeSync": {
    "offsetMs": -150,
    "quality": "estimated"
  }
}
```

### Sync Markers

For high-accuracy synchronization, the system supports sync markers:

1. **START marker**: Written at recording start with matching `syncId`
2. **STOP marker**: Written at recording stop with matching `syncId`

These markers allow computing the actual offset between sensors:

```
Offset = InWaterMarkerTime - SurfaceMarkerTime
```

---

## Drift Model

### Constant Offset

For short recordings (< 10 minutes), a constant offset is sufficient:

```
CorrectedTime = RawTime + OffsetMs
```

### Linear Drift

For longer recordings, clocks may drift relative to each other. The linear drift model interpolates:

```
DriftRate = (EndOffset - StartOffset) / SessionDuration
CorrectedTime = RawTime + StartOffset + (ElapsedTime * DriftRate)
```

### Drift Threshold

Drift correction only applies if the delta exceeds 2ms (below that is noise).

---

## Fusion Algorithm

### Input

- `in-water_<sessionId>/session.csv` - In-water sensor data
- `surface_<sessionId>/session.csv` - Surface sensor data
- `sync_metadata.json` - Session metadata with time sync info

### Process

1. **Parse CSVs**: Read both session files, parse timestamps
2. **Tag Source**: Mark each row as `in-water` or `surface`
3. **Extract Markers**: Identify START/STOP sync markers if present
4. **Compute Offset**: Calculate time offset from markers or metadata
5. **Apply Correction**: Adjust in-water timestamps by offset
6. **Sort**: Order all rows by corrected timestamp
7. **Align**: Match rows within alignment tolerance
8. **Wide Format**: Convert to side-by-side columns

### Output Format

The unified CSV uses wide format with prefixed columns:

```csv
timestamp,inwater_sensor_id,inwater_mode,inwater_value,inwater_TempC,inwater_Vin,surface_sensor_id,surface_mode,surface_value,surface_TempC,surface_Vin
```

Each row represents a single timestamp with data from both sensors (if available).

---

## Alignment Rules

### Tolerance

Default alignment tolerance: **50ms**

Two readings are considered aligned if their timestamps differ by less than the tolerance.

### Matching Strategy

For each timestamp:

1. Find all readings within tolerance window
2. If multiple readings from same sensor, use closest
3. If no reading from a sensor, leave columns null

### Example

```
In-water: 12:00:01.000, 12:00:01.050, 12:00:01.100
Surface:  12:00:01.025, 12:00:01.080

Output rows:
12:00:01.000 - in-water only
12:00:01.025 - aligned (in-water: 01.050, surface: 01.025)
12:00:01.080 - aligned (in-water: 01.100, surface: 01.080)
```

---

## Sync Metadata Structure

The `sync_metadata.json` file tracks synchronization and fusion status:

```json
{
  "sessionId": "abc123",
  "startedAt": "2025-11-18T12:00:00.000Z",
  "sensors": {
    "inWater": {
      "sessionId": "iw-456",
      "sensorId": "SN12345",
      "status": "complete",
      "rowCount": 18000,
      "completedAt": "2025-11-18T12:30:00.000Z"
    },
    "surface": {
      "sessionId": "sf-789",
      "sensorId": "SN67890",
      "status": "complete",
      "rowCount": 18000,
      "completedAt": "2025-11-18T12:30:00.000Z"
    }
  },
  "timeSync": {
    "offsetMs": -150,
    "quality": "marker-based",
    "markers": {
      "start": {
        "inWater": "2025-11-18T12:00:00.000Z",
        "surface": "2025-11-18T12:00:00.150Z"
      },
      "stop": {
        "inWater": "2025-11-18T12:30:00.000Z",
        "surface": "2025-11-18T12:30:00.148Z"
      }
    },
    "driftMs": 2
  },
  "fusion": {
    "status": "complete",
    "unifiedCsv": "unified_session.csv",
    "rowCount": 36000,
    "inWaterRows": 18000,
    "surfaceRows": 18000,
    "completedAt": "2025-11-18T12:30:05.000Z",
    "error": null
  }
}
```

---

## Scientific Timing Guarantees

### Accuracy

- **With sync markers**: ±5ms alignment accuracy
- **Without markers**: Depends on clock synchronization between systems
- **With drift correction**: Maintains accuracy over multi-hour recordings

### Recommendations

For scientific use requiring high timing accuracy:

1. Ensure both computers are NTP-synchronized
2. Use sync markers for each recording session
3. Keep recordings under 1 hour to minimize drift
4. Verify alignment in output data before analysis

### Limitations

- Fusion assumes monotonic timestamps (no time jumps)
- Large offsets (> 1 second) may indicate configuration issues
- Network latency affects in-water timestamp accuracy

---

## Fusion Status Values

| Status | Meaning |
|--------|---------|
| `pending` | Waiting for both sensors to complete |
| `complete` | Fusion successful, `unified_session.csv` created |
| `skipped` | Single-sensor recording, no fusion needed |
| `failed` | Fusion failed (see error field) |

---

## Troubleshooting

### Large Time Offset

If offset exceeds expectations:

1. Check NTP sync on both computers
2. Verify timezone settings (should be UTC)
3. Review sync markers for accuracy

### Missing Fusion Output

If `unified_session.csv` not created:

1. Check both sensors have `status: complete`
2. Review `fusion.error` in sync metadata
3. Verify both `session.csv` files exist

### Alignment Gaps

If unified output has many null columns:

1. Verify sensors were recording simultaneously
2. Check alignment tolerance setting
3. Review timestamps for large gaps

---

## Related Documentation

- [Architecture](ARCHITECTURE.md) - System overview
- [Dual Sensor Pipeline](DUAL_SENSOR_PIPELINE.md) - Data flow details
