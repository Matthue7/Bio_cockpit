# Q-Sensor Dual-Sensor Fusion Phase 2.5 Plan

## Executive Summary

This document outlines Phase 2.5 improvements to eliminate periodic surface-only gaps in the dual-sensor fusion output. While Phase 1 and Phase 2 successfully implemented sync markers and drift correction, an asymmetric pattern remains where in-water values appear duplicated across consecutive rows while surface values appear only on every other row.

## Current Situation

### What's Already Implemented (Phase 1-2 Complete)

✅ **Sync Marker Infrastructure**
- Pi-side `/record/sync-marker` endpoint implemented
- START/STOP markers injected into both sensor streams
- Matching syncIds for marker pairing

✅ **Drift Model & Correction**
- Linear and constant drift model computation from markers
- Timestamp correction for in-water sensor
- Adaptive tolerance based on drift uncertainty

✅ **Wide-Format Fusion**
- One row per timestamp with side-by-side sensor columns
- Basic alignment using nearest-neighbor matching
- O(N) performance maintained

### Remaining Problem

The unified wide-format CSV shows periodic surface-only gaps with duplicated in-water values:

```
2025-11-21T22:35:49.051Z  serial ###### freerun 1.519271 23.53 7.494   serial ###### freerun 0.000009 7.536
2025-11-21T22:35:49.101Z  serial ###### freerun 1.519271 23.53 7.494
2025-11-21T22:35:49.163Z  serial ###### freerun 2.318043 23.53 7.494   serial ###### freerun 0.000007 7.536
2025-11-21T22:35:49.213Z  serial ###### freerun 2.318043 23.53 7.494
```

**Why this matters for scientific use:**
- Creates artificial timing patterns that don't reflect real sensor behavior
- Makes time-series analysis difficult due to regular missing data
- Reduces confidence in fusion quality
- May lead to incorrect scientific conclusions

## Current Fusion Algorithm Analysis

### Timestamp Axis Construction

**Current Implementation** (`buildTimestampAxisWithDrift()`):
```typescript
function buildTimestampAxisWithDrift(
  inWaterRows: CsvRow[],
  surfaceRows: CsvRow[],
  driftModel: ComputedDriftModel | null
): number[] {
  const timestampSet = new Set<number>()

  // Add surface timestamps as reference (no correction)
  for (const row of surfaceRows) {
    timestampSet.add(row._parsedTime)
  }

  // Add in-water timestamps with drift correction
  for (const row of inWaterRows) {
    const correctedTime = correctTimestamp(row._parsedTime, driftModel)
    timestampSet.add(correctedTime)
  }

  return Array.from(timestampSet).sort((a, b) => a - b)
}
```

**Result**: Creates a union of ALL unique timestamps from both sensors, potentially with very dense spacing.

### Tolerance Application

**Current Implementation** (in `fuseSessionData()`):
```typescript
const wideRows = createWideFormatRows(
  timestampAxis,
  inWaterMap,
  surfaceMap,
  ALIGNMENT_TOLERANCE_MS,           // Surface: 50ms tolerance
  computeAdaptiveTolerance(driftModel, timestampAxis, ALIGNMENT_TOLERANCE_MS)  // In-water: up to 150ms
)
```

**Problem**: Asymmetric tolerance allows in-water readings to match multiple axis points while surface only matches closest points.

### Reading Matching Logic

**Current Implementation** (`findNearestReading()`):
```typescript
function findNearestReading(
  targetTime: number,
  rowsMap: Map<number, CsvRow>,
  toleranceMs: number
): CsvRow | null {
  // Can return same reading for multiple timestamps if within tolerance
  // No tracking of whether reading was already used
}
```

**Problem**: Same reading can be reused across multiple timestamps, creating duplication.

### Row Creation Policy

**Current Implementation** (`createWideFormatRows()`):
```typescript
for (const timestamp of timestampAxis) {
  const inWaterRow = findNearestReading(timestamp, inWaterMap, inWaterToleranceMs)
  const surfaceRow = findNearestReading(timestamp, surfaceMap, surfaceToleranceMs)
  
  // Create row if at least one sensor has data
  if (!inWaterRow && !surfaceRow) continue
  
  wideRows.push({ /* row data */ })
}
```

**Problem**: Creates rows even when only one sensor has data, leading to many single-sensor rows.

## Root Cause Analysis

The asymmetric pattern arises from three compounding issues:

1. **Union Timestamp Axis**: Creates dense axis with points from both sensors
2. **Asymmetric Tolerance**: In-water gets larger tolerance than surface
3. **Reading Reuse**: Same in-water reading can match multiple nearby axis points

This creates the exact pattern observed:
- Axis point 1: Both sensors have exact matches → full row
- Axis point 2: Only in-water within tolerance → duplicated in-water, no surface
- Axis point 3: Both sensors have new matches → full row
- Axis point 4: Only in-water within tolerance → duplicated in-water, no surface

## Phase 2.5 Overview

### High-Level Goals

1. **Eliminate asymmetric patterns** in fused output
2. **Preserve scientific integrity** - no fabricated data
3. **Maintain O(N) performance** - no expensive algorithms
4. **Reduce single-sensor rows** that are just alignment artifacts
5. **Keep real gaps** when sensors actually drop data

### Constraints

- Must not interpolate or fabricate readings
- Must maintain O(N) or O(N log N) complexity
- Must preserve existing sync marker and drift model functionality
- Must be backward compatible with existing data format

## Phase 2.5 - Step 1: Symmetric Tolerance & Reading Reuse Rules

### What Changes

**File**: `src/electron/services/qsensor-fusion.ts`

**Function**: `fuseSessionData()` (lines 200-206)

**Current Code**:
```typescript
const wideRows = createWideFormatRows(
  timestampAxis,
  inWaterMap,
  surfaceMap,
  ALIGNMENT_TOLERANCE_MS,           // Surface: 50ms tolerance
  computeAdaptiveTolerance(driftModel, timestampAxis, ALIGNMENT_TOLERANCE_MS)  // In-water: up to 150ms
)
```

**New Code**:
```typescript
const wideRows = createWideFormatRows(
  timestampAxis,
  inWaterMap,
  surfaceMap,
  ALIGNMENT_TOLERANCE_MS,           // Surface: 50ms tolerance
  ALIGNMENT_TOLERANCE_MS            // In-water: 50ms tolerance (symmetric)
)
```

**Function**: `findNearestReading()` (lines 642-667)

**Add reading reuse tracking**:
```typescript
function findNearestReading(
  targetTime: number,
  rowsMap: Map<number, CsvRow>,
  toleranceMs: number,
  usedReadings: Set<string> | null = null
): CsvRow | null {
  // First check for exact match
  if (rowsMap.has(targetTime)) {
    const row = rowsMap.get(targetTime)!
    const readingId = `${row.timestamp}_${row.sensor_id}`
    if (!usedReadings || !usedReadings.has(readingId)) {
      if (usedReadings) usedReadings.add(readingId)
      return row
    }
  }

  // Search for nearest within tolerance (excluding used readings)
  let nearestRow: CsvRow | null = null
  let nearestDiff = toleranceMs + 1

  for (const [time, row] of rowsMap) {
    const readingId = `${row.timestamp}_${row.sensor_id}`
    if (usedReadings && usedReadings.has(readingId)) continue
    
    const diff = Math.abs(time - targetTime)
    if (diff <= toleranceMs && diff < nearestDiff) {
      nearestDiff = diff
      nearestRow = row
    }
  }

  if (nearestRow && usedReadings) {
    const readingId = `${nearestRow.timestamp}_${nearestRow.sensor_id}`
    usedReadings.add(readingId)
  }

  return nearestRow
}
```

**Function**: `createWideFormatRows()` (lines 684-723)

**Add reading tracking**:
```typescript
function createWideFormatRows(
  timestampAxis: number[],
  inWaterMap: Map<number, CsvRow>,
  surfaceMap: Map<number, CsvRow>,
  toleranceMs: number
): WideFormatRow[] {
  const wideRows: WideFormatRow[] = []
  const usedInWaterReadings = new Set<string>()
  const usedSurfaceReadings = new Set<string>()

  for (const timestamp of timestampAxis) {
    const inWaterRow = findNearestReading(timestamp, inWaterMap, toleranceMs, usedInWaterReadings)
    const surfaceRow = findNearestReading(timestamp, surfaceMap, toleranceMs, usedSurfaceReadings)
    
    // Skip if neither sensor has data at this timestamp
    if (!inWaterRow && !surfaceRow) continue
    
    // ... rest of row creation logic
  }
  
  return wideRows
}
```

### Expected Impact

- **Eliminates duplicated in-water values** across consecutive rows
- **Reduces surface-only gaps** by using symmetric tolerance
- **Maintains scientific integrity** by not fabricating data
- **Preserves O(N) performance** with simple Set operations

### Validation

**Metrics to measure**:
- Number of single-sensor rows before/after
- Maximum consecutive single-sensor rows
- In-water reading duplication count
- Surface gap frequency

**Test cases**:
1. Normal dual-sensor recording with slight clock drift
2. Recording with one sensor temporarily dropping data
3. Recording with significant drift (linear model)
4. Edge case: identical timestamps from both sensors

## Phase 2.5 - Step 2: Timestamp Axis Consolidation

### What Changes

**File**: `src/electron/services/qsensor-fusion.ts`

**New Function**: `buildConsolidatedTimestampAxis()`

**Current Algorithm**:
```typescript
// Current: Union of all timestamps
function buildTimestampAxisWithDrift(inWaterRows, surfaceRows, driftModel) {
  const timestampSet = new Set<number>()
  // Add all surface timestamps
  // Add all corrected in-water timestamps
  return Array.from(timestampSet).sort()
}
```

**New Algorithm**:
```typescript
function buildConsolidatedTimestampAxis(
  inWaterRows: CsvRow[],
  surfaceRows: CsvRow[],
  driftModel: ComputedDriftModel | null,
  consolidationThresholdMs: number = 25
): number[] {
  // Collect all timestamps with source info
  const allTimestamps: Array<{time: number, source: string, originalRow: CsvRow}> = []
  
  // Add surface timestamps
  for (const row of surfaceRows) {
    allTimestamps.push({time: row._parsedTime, source: 'surface', originalRow: row})
  }
  
  // Add drift-corrected in-water timestamps
  for (const row of inWaterRows) {
    const correctedTime = correctTimestamp(row._parsedTime, driftModel)
    allTimestamps.push({time: correctedTime, source: 'in-water', originalRow: row})
  }
  
  // Sort by time
  allTimestamps.sort((a, b) => a.time - b.time)
  
  // Consolidate close timestamps into clusters
  const consolidatedTimestamps: number[] = []
  let currentCluster: typeof allTimestamps = [allTimestamps[0]]
  
  for (let i = 1; i < allTimestamps.length; i++) {
    const current = allTimestamps[i]
    const clusterStart = currentCluster[0].time
    
    if (current.time - clusterStart <= consolidationThresholdMs) {
      // Add to current cluster
      currentCluster.push(current)
    } else {
      // Finalize current cluster
      const representativeTime = computeRepresentativeTimestamp(currentCluster)
      consolidatedTimestamps.push(representativeTime)
      
      // Start new cluster
      currentCluster = [current]
    }
  }
  
  // Finalize last cluster
  if (currentCluster.length > 0) {
    const representativeTime = computeRepresentativeTimestamp(currentCluster)
    consolidatedTimestamps.push(representativeTime)
  }
  
  return consolidatedTimestamps
}

function computeRepresentativeTimestamp(cluster: typeof allTimestamps): number {
  // Strategy 1: Use surface timestamp if available (more stable reference)
  const surfaceTimestamps = cluster.filter(item => item.source === 'surface')
  if (surfaceTimestamps.length > 0) {
    return surfaceTimestamps[0].time  // Use first surface timestamp
  }
  
  // Strategy 2: Use median timestamp
  const times = cluster.map(item => item.time).sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  return times.length % 2 === 0 
    ? (times[mid - 1] + times[mid]) / 2  // Average of middle two
    : times[mid]  // Middle value
}
```

### Tradeoffs and Performance

**Benefits**:
- Reduces redundant axis points that cause single-sensor rows
- More intuitive fusion events aligned with actual data clusters
- Still O(N log N) due to sorting (acceptable)

**Tradeoffs**:
- Slight complexity increase in axis building
- Need to choose consolidation threshold carefully (25ms default)
- May slightly shift timestamps from original values

**Performance Considerations**:
- Sorting dominates: O(N log N) where N = total readings from both sensors
- Clustering is O(N) single pass
- Memory: O(N) for timestamp array
- Still well within acceptable limits for typical session sizes

### Integration

**Update `fuseSessionData()`**:
```typescript
// Replace:
const timestampAxis = buildTimestampAxisWithDrift(inWaterData.rows, surfaceData.rows, driftModel)

// With:
const timestampAxis = buildConsolidatedTimestampAxis(inWaterData.rows, surfaceData.rows, driftModel)
```

## Phase 2.5 - Step 3: Smarter Row Creation Policy

### What Changes

**File**: `src/electron/services/qsensor-fusion.ts`

**Function**: `createWideFormatRows()` (lines 684-723)

**Current Policy**: Create row if at least one sensor has data

**New Policy**: Create row based on intelligent gap detection

```typescript
function createWideFormatRows(
  timestampAxis: number[],
  inWaterMap: Map<number, CsvRow>,
  surfaceMap: Map<number, CsvRow>,
  toleranceMs: number
): WideFormatRow[] {
  const wideRows: WideFormatRow[] = []
  const usedInWaterReadings = new Set<string>()
  const usedSurfaceReadings = new Set<string>()
  
  let lastInWaterTime: number | null = null
  let lastSurfaceTime: number | null = null
  let lastRowHadBothSensors = false

  for (const timestamp of timestampAxis) {
    const inWaterRow = findNearestReading(timestamp, inWaterMap, toleranceMs, usedInWaterReadings)
    const surfaceRow = findNearestReading(timestamp, surfaceMap, toleranceMs, usedSurfaceReadings)
    
    // Skip if neither sensor has data at this timestamp
    if (!inWaterRow && !surfaceRow) continue
    
    // Smart row creation policy
    const shouldCreateRow = evaluateRowCreation(
      timestamp, inWaterRow, surfaceRow, 
      lastInWaterTime, lastSurfaceTime, lastRowHadBothSensors,
      toleranceMs
    )
    
    if (!shouldCreateRow) continue
    
    // Update tracking variables
    if (inWaterRow) lastInWaterTime = timestamp
    if (surfaceRow) lastSurfaceTime = timestamp
    lastRowHadBothSensors = !!(inWaterRow && surfaceRow)
    
    // Create row
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

function evaluateRowCreation(
  timestamp: number,
  inWaterRow: CsvRow | null,
  surfaceRow: CsvRow | null,
  lastInWaterTime: number | null,
  lastSurfaceTime: number | null,
  lastRowHadBothSensors: boolean,
  toleranceMs: number
): boolean {
  // Always create row if both sensors have data
  if (inWaterRow && surfaceRow) return true
  
  // If only one sensor has data, check if this represents a real gap
  const timeSinceLastInWater = lastInWaterTime ? timestamp - lastInWaterTime : Infinity
  const timeSinceLastSurface = lastSurfaceTime ? timestamp - lastSurfaceTime : Infinity
  
  // Create row if gap is significant (> 2 * tolerance)
  const significantGapThreshold = 2 * toleranceMs
  
  if (inWaterRow && !surfaceRow) {
    // In-water only: create if surface gap is significant OR previous row was single-sensor
    return timeSinceLastSurface > significantGapThreshold || !lastRowHadBothSensors
  }
  
  if (surfaceRow && !inWaterRow) {
    // Surface only: create if in-water gap is significant OR previous row was single-sensor
    return timeSinceLastInWater > significantGapThreshold || !lastRowHadBothSensors
  }
  
  return false
}
```

### Decision Logic Explained

**Always create row when**:
- Both sensors have data within tolerance (ideal fusion event)

**Create single-sensor row when**:
- Other sensor hasn't had data for > 2× tolerance (real gap)
- Previous row was also single-sensor (avoid consecutive single-sensor rows)

**Skip single-sensor row when**:
- Other sensor had data recently (< 2× tolerance)
- Previous row had both sensors (likely alignment artifact)

### Edge Case Handling

**True sensor dropout**: When a sensor actually stops reporting data, the gap will exceed 2× tolerance and single-sensor rows will be created.

**Brief clock skew**: Small timing differences (< 2× tolerance) will not create single-sensor rows, reducing artificial gaps.

**Recovery from dropout**: When sensor resumes reporting, first dual-sensor row will be created immediately.

## Validation Plan

### Metrics to Measure

**Before/After Comparison**:
1. **Single-sensor row percentage**: `(single-sensor rows / total rows) × 100`
2. **Maximum consecutive single-sensor rows**: Longest run of rows with only one sensor
3. **In-water reading duplication count**: How many times same reading appears in multiple rows
4. **Surface gap frequency**: Percentage of surface-only rows vs total
5. **Temporal coverage**: Percentage of session duration with at least one sensor reporting

**Target Improvements**:
- Single-sensor row percentage: < 10% (from current ~50%)
- Maximum consecutive single-sensor rows: ≤ 2 (from current ~5+)
- In-water reading duplication: 0 (from current many)
- Surface gap frequency: < 5% (from current ~50%)

### Test Cases

**Test Case 1: Normal Operation**
- Both sensors reporting regularly with slight clock drift
- Expect: Mostly dual-sensor rows, occasional single-sensor rows

**Test Case 2: Sensor Dropout**
- One sensor stops reporting for 1+ seconds
- Expect: Single-sensor rows during dropout, dual-sensor rows after recovery

**Test Case 3: High Drift**
- Significant linear drift between sensors
- Expect: Consistent dual-sensor rows with proper drift correction

**Test Case 4: Edge Cases**
- Identical timestamps, missing markers, etc.
- Expect: Graceful handling with appropriate fallbacks

### Validation Data

**Before Example**:
```
22:35:49.051Z  in-water + surface
22:35:49.101Z  same in-water, no surface  ← Artifact
22:35:49.163Z  in-water + surface
22:35:49.213Z  same in-water, no surface  ← Artifact
```

**After Example**:
```
22:35:49.051Z  in-water + surface
22:35:49.163Z  in-water + surface
```

## Risks / Trade-offs / Future Work

### Risks

1. **Over-aggressive consolidation**: Might merge distinct events if threshold too high
2. **Hiding real gaps**: Smart row policy might miss brief but real sensor dropouts
3. **Timestamp shifting**: Consolidation changes original timestamps slightly

### Mitigations

1. **Configurable thresholds**: Allow tuning of consolidation and gap parameters
2. **Extensive testing**: Validate against known-good reference recordings
3. **Fallback modes**: Option to disable consolidation if needed

### Trade-offs

1. **Complexity vs. quality**: More complex algorithm for cleaner output
2. **Performance vs. accuracy**: Slightly slower processing for better alignment
3. **Flexibility vs. simplicity**: More parameters to tune but more control

### Future Work

1. **Periodic sync markers**: Phase 3 will further reduce drift accumulation
2. **Adaptive thresholds**: Machine learning to optimize parameters per session
3. **Quality metrics**: Automatic detection of fusion quality issues
4. **Visualization tools**: UI to inspect fusion quality and tune parameters

## Implementation Checklist

### Step 1: Symmetric Tolerance & Reading Reuse
- [ ] Modify `fuseSessionData()` to use symmetric tolerance
- [ ] Update `findNearestReading()` with reading reuse tracking
- [ ] Update `createWideFormatRows()` with used reading Sets
- [ ] Remove `computeAdaptiveTolerance()` function
- [ ] Unit tests for reading reuse logic

### Step 2: Timestamp Axis Consolidation
- [ ] Implement `buildConsolidatedTimestampAxis()`
- [ ] Implement `computeRepresentativeTimestamp()`
- [ ] Update `fuseSessionData()` to use new axis builder
- [ ] Add configurable consolidation threshold
- [ ] Unit tests for consolidation logic

### Step 3: Smarter Row Creation Policy
- [ ] Implement `evaluateRowCreation()` function
- [ ] Update `createWideFormatRows()` with smart policy
- [ ] Add tracking variables for last readings
- [ ] Unit tests for row creation logic

### Validation & Testing
- [ ] Create test datasets for all scenarios
- [ ] Implement before/after comparison metrics
- [ ] Performance benchmarking
- [ ] Integration tests with real session data

### Documentation
- [ ] Update function documentation
- [ ] Add configuration parameter documentation
- [ ] Create troubleshooting guide for fusion issues
- [ ] Update API documentation for new parameters

## Conclusion

Phase 2.5 addresses the remaining asymmetric pattern in dual-sensor fusion through three coordinated improvements:

1. **Symmetric tolerance** ensures both sensors are treated equally in matching
2. **Reading reuse prevention** eliminates duplicated values across rows  
3. **Timestamp consolidation** reduces redundant axis points
4. **Smart row creation** minimizes artificial single-sensor rows

These changes will eliminate the periodic surface-only gaps while preserving scientific integrity and maintaining O(N) performance. The result will be cleaner, more intuitive fused data that accurately reflects the true sensor behavior without artificial timing patterns.