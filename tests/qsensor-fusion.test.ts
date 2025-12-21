/**
 * Unit tests for Q-Sensor Fusion Core Algorithms
 *
 * These tests verify the correctness of timestamp consolidation,
 * reading alignment, and row creation decision logic.
 *
 * Focus areas:
 * - buildConsolidatedTimestampAxis: clustering and consolidation
 * - findNearestReading: tolerance window and deduplication
 * - evaluateRowCreation: gap detection and row suppression
 */

import { describe, expect, it } from 'vitest'

// ============================================================================
// Test Fixtures and Helpers
// ============================================================================

/**
 *
 */
interface CsvRow {
  /**
   *
   */
  timestamp: string
  /**
   *
   */
  sensor_id: string
  /**
   *
   */
  mode: string
  /**
   *
   */
  value: string
  /**
   *
   */
  TempC: string
  /**
   *
   */
  Vin: string
  /**
   *
   */
  source: string
  /**
   *
   */
  _parsedTime: number
}

/**
 *
 */
interface ComputedDriftModel {
  /**
   *
   */
  type: 'constant' | 'linear'
  /**
   *
   */
  startOffsetMs: number
  /**
   *
   */
  driftRatePerMs?: number
  /**
   *
   */
  endOffsetMs?: number
  /**
   *
   */
  inWaterStartTime?: number
}

/**
 * Helper to create synthetic CSV rows for testing
 * @param timestamp
 * @param source
 * @param sensorId
 */
function makeRow(timestamp: number, source: string, sensorId = 'TEST001'): CsvRow {
  return {
    timestamp: new Date(timestamp).toISOString(),
    sensor_id: sensorId,
    mode: 'OXYGEN',
    value: '100.0',
    TempC: '25.0',
    Vin: '3.3',
    source,
    _parsedTime: timestamp,
  }
}

// ============================================================================
// Inline copies of functions under test
// (These would normally be exported from qsensor-fusion.ts for testing)
// ============================================================================

/**
 *
 * @param inWaterTime
 * @param driftModel
 */
function correctTimestamp(inWaterTime: number, driftModel: ComputedDriftModel | null): number {
  if (!driftModel) {
    return inWaterTime
  }

  if (driftModel.type === 'constant') {
    return inWaterTime - driftModel.startOffsetMs
  }

  // Linear drift: offset(t) = startOffset + driftRate * (t - t_start)
  if (!driftModel.inWaterStartTime || !driftModel.driftRatePerMs) {
    return inWaterTime - driftModel.startOffsetMs
  }

  const elapsed = inWaterTime - driftModel.inWaterStartTime
  const currentOffset = driftModel.startOffsetMs + driftModel.driftRatePerMs * elapsed
  return inWaterTime - currentOffset
}

/**
 *
 * @param inWaterRows
 * @param surfaceRows
 * @param driftModel
 * @param consolidationThresholdMs
 */
function buildConsolidatedTimestampAxis(
  inWaterRows: CsvRow[],
  surfaceRows: CsvRow[],
  driftModel: ComputedDriftModel | null,
  consolidationThresholdMs = 25
): number[] {
  type TimestampEntry = {
    /**
     *
     */
    time: number
    /**
     *
     */
    source: string
  }

  const allTimestamps: TimestampEntry[] = []

  for (const row of surfaceRows) {
    allTimestamps.push({ time: row._parsedTime, source: 'surface' })
  }

  for (const row of inWaterRows) {
    const correctedTime = correctTimestamp(row._parsedTime, driftModel)
    allTimestamps.push({ time: correctedTime, source: 'in-water' })
  }

  if (allTimestamps.length === 0) return []

  allTimestamps.sort((a, b) => a.time - b.time)

  const consolidated: number[] = []
  let currentCluster: TimestampEntry[] = [allTimestamps[0]]

  for (let i = 1; i < allTimestamps.length; i++) {
    const current = allTimestamps[i]
    const clusterStart = currentCluster[0].time

    if (current.time - clusterStart <= consolidationThresholdMs) {
      currentCluster.push(current)
    } else {
      consolidated.push(computeRepresentativeTimestamp(currentCluster))
      currentCluster = [current]
    }
  }

  if (currentCluster.length > 0) {
    consolidated.push(computeRepresentativeTimestamp(currentCluster))
  }

  return consolidated
}

/**
 *
 * @param cluster
 */
function computeRepresentativeTimestamp(
  cluster: Array<{
    /**
fffffffffffffffffffffffffffffffffffffffffffffffffffffffff *
fffffffffffffffffffffffffffffffffffffffffffffffffffffffff
     */
    time: number
    /**
tttttttttttttt *
tttttttttttttt
     */
    source: string
  }>
): number {
  const surfaceCandidate = cluster.find((item) => item.source === 'surface')
  if (surfaceCandidate) {
    return surfaceCandidate.time
  }

  const times = cluster.map((item) => item.time).sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  return times.length % 2 === 0 ? (times[mid - 1] + times[mid]) / 2 : times[mid]
}

/**
 *
 * @param targetTime
 * @param rowsMap
 * @param toleranceMs
 * @param usedReadings
 */
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

  // Search for nearest within tolerance
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

/**
 *
 * @param timestamp
 * @param inWaterRow
 * @param surfaceRow
 * @param lastInWaterTime
 * @param lastSurfaceTime
 * @param lastRowHadBothSensors
 * @param toleranceMs
 */
function evaluateRowCreation(
  timestamp: number,
  inWaterRow: CsvRow | null,
  surfaceRow: CsvRow | null,
  lastInWaterTime: number | null,
  lastSurfaceTime: number | null,
  lastRowHadBothSensors: boolean,
  toleranceMs: number
): boolean {
  if (inWaterRow && surfaceRow) return true

  const significantGapThreshold = 2 * toleranceMs
  const timeSinceLastInWater = lastInWaterTime !== null ? timestamp - lastInWaterTime : Number.POSITIVE_INFINITY
  const timeSinceLastSurface = lastSurfaceTime !== null ? timestamp - lastSurfaceTime : Number.POSITIVE_INFINITY

  if (inWaterRow && !surfaceRow) {
    return timeSinceLastSurface > significantGapThreshold || !lastRowHadBothSensors
  }

  if (surfaceRow && !inWaterRow) {
    return timeSinceLastInWater > significantGapThreshold || !lastRowHadBothSensors
  }

  return false
}

// ============================================================================
// Test Suite 1: buildConsolidatedTimestampAxis
// ============================================================================

describe('buildConsolidatedTimestampAxis', () => {
  it('should consolidate timestamps within 25ms threshold', () => {
    const baseTime = 1000
    const inWaterRows = [makeRow(baseTime, 'in-water'), makeRow(baseTime + 20, 'in-water')]
    const surfaceRows = [makeRow(baseTime + 10, 'surface')]

    const axis = buildConsolidatedTimestampAxis(inWaterRows, surfaceRows, null, 25)

    // All three timestamps within 25ms should collapse to one
    expect(axis).toHaveLength(1)
    expect(axis[0]).toBe(baseTime + 10) // Should prefer surface timestamp
  })

  it('should not consolidate timestamps beyond threshold', () => {
    const baseTime = 1000
    const inWaterRows = [makeRow(baseTime, 'in-water')]
    const surfaceRows = [makeRow(baseTime + 50, 'surface')]

    const axis = buildConsolidatedTimestampAxis(inWaterRows, surfaceRows, null, 25)

    // 50ms apart exceeds 25ms threshold → should produce 2 timestamps
    expect(axis).toHaveLength(2)
    expect(axis[0]).toBe(baseTime)
    expect(axis[1]).toBe(baseTime + 50)
  })

  it('should prefer surface timestamp as representative', () => {
    const baseTime = 1000
    const inWaterRows = [
      makeRow(baseTime, 'in-water'),
      makeRow(baseTime + 5, 'in-water'),
      makeRow(baseTime + 20, 'in-water'),
    ]
    const surfaceRows = [makeRow(baseTime + 15, 'surface')]

    const axis = buildConsolidatedTimestampAxis(inWaterRows, surfaceRows, null, 25)

    expect(axis).toHaveLength(1)
    expect(axis[0]).toBe(baseTime + 15) // Surface timestamp preferred
  })

  it('should use median when no surface timestamp in cluster', () => {
    const baseTime = 1000
    const inWaterRows = [
      makeRow(baseTime, 'in-water'),
      makeRow(baseTime + 10, 'in-water'),
      makeRow(baseTime + 20, 'in-water'),
    ]
    const surfaceRows: CsvRow[] = []

    const axis = buildConsolidatedTimestampAxis(inWaterRows, surfaceRows, null, 25)

    expect(axis).toHaveLength(1)
    expect(axis[0]).toBe(baseTime + 10) // Median of [1000, 1010, 1020]
  })

  it('should maintain monotonicity of output', () => {
    const baseTime = 1000
    const inWaterRows = [
      makeRow(baseTime, 'in-water'),
      makeRow(baseTime + 100, 'in-water'),
      makeRow(baseTime + 200, 'in-water'),
    ]
    const surfaceRows = [makeRow(baseTime + 50, 'surface'), makeRow(baseTime + 150, 'surface')]

    const axis = buildConsolidatedTimestampAxis(inWaterRows, surfaceRows, null, 25)

    // Verify axis is sorted
    for (let i = 1; i < axis.length; i++) {
      expect(axis[i]).toBeGreaterThan(axis[i - 1])
    }
  })

  it('should apply drift correction to in-water timestamps', () => {
    const baseTime = 1000
    const driftModel: ComputedDriftModel = {
      type: 'constant',
      startOffsetMs: 100, // in-water is 100ms ahead
    }

    const inWaterRows = [makeRow(baseTime + 100, 'in-water')] // Raw in-water time
    const surfaceRows = [makeRow(baseTime, 'surface')] // Surface time

    const axis = buildConsolidatedTimestampAxis(inWaterRows, surfaceRows, driftModel, 25)

    // After correction: in-water 1100 - 100 = 1000, matches surface 1000
    expect(axis).toHaveLength(1)
    expect(axis[0]).toBe(baseTime) // Should consolidate to surface time
  })

  it('should return empty array for no input rows', () => {
    const axis = buildConsolidatedTimestampAxis([], [], null, 25)
    expect(axis).toHaveLength(0)
  })
})

// ============================================================================
// Test Suite 2: findNearestReading
// ============================================================================

describe('findNearestReading', () => {
  it('should find exact timestamp match', () => {
    const row1 = makeRow(1000, 'surface')
    const row2 = makeRow(1050, 'surface')
    const rowsMap = new Map([
      [1000, row1],
      [1050, row2],
    ])

    const result = findNearestReading(1000, rowsMap, 50)

    expect(result).toBe(row1)
  })

  it('should find nearest reading within tolerance', () => {
    const row1 = makeRow(1000, 'surface')
    const row2 = makeRow(1030, 'surface')
    const rowsMap = new Map([
      [1000, row1],
      [1030, row2],
    ])

    const result = findNearestReading(1025, rowsMap, 50)

    expect(result).toBe(row2) // 1030 is closer to 1025 (5ms vs 25ms)
  })

  it('should return null if no reading within tolerance', () => {
    const row1 = makeRow(1000, 'surface')
    const rowsMap = new Map([[1000, row1]])

    const result = findNearestReading(1100, rowsMap, 50)

    expect(result).toBeNull() // 100ms exceeds 50ms tolerance
  })

  it('should prevent reading reuse via usedReadings set', () => {
    const row1 = makeRow(1000, 'surface')
    const rowsMap = new Map([[1000, row1]])
    const usedReadings = new Set<string>()

    // First call should succeed
    const result1 = findNearestReading(1000, rowsMap, 50, usedReadings)
    expect(result1).toBe(row1)
    expect(usedReadings.size).toBe(1)

    // Second call should return null (reading already used)
    const result2 = findNearestReading(1000, rowsMap, 50, usedReadings)
    expect(result2).toBeNull()
  })

  it('should prioritize exact match over nearest match', () => {
    const row1 = makeRow(1000, 'surface', 'SENSOR_A')
    const row2 = makeRow(1010, 'surface', 'SENSOR_B')
    const rowsMap = new Map([
      [1000, row1],
      [1010, row2],
    ])

    const result = findNearestReading(1000, rowsMap, 50)

    expect(result).toBe(row1) // Exact match preferred
  })

  it('should skip already-used readings when finding nearest', () => {
    const row1 = makeRow(1000, 'surface', 'SENSOR_A')
    const row2 = makeRow(1020, 'surface', 'SENSOR_B')
    const rowsMap = new Map([
      [1000, row1],
      [1020, row2],
    ])
    const usedReadings = new Set<string>()

    // Mark row1 as used
    usedReadings.add(`${row1.timestamp}_${row1.sensor_id}`)

    // Search for nearest to 1000 should return row2 (row1 is used)
    const result = findNearestReading(1005, rowsMap, 50, usedReadings)

    expect(result).toBe(row2)
  })

  it('should work without usedReadings tracking (null parameter)', () => {
    const row1 = makeRow(1000, 'surface')
    const rowsMap = new Map([[1000, row1]])

    const result1 = findNearestReading(1000, rowsMap, 50, null)
    const result2 = findNearestReading(1000, rowsMap, 50, null)

    // Both calls should succeed (no deduplication)
    expect(result1).toBe(row1)
    expect(result2).toBe(row1)
  })
})

// ============================================================================
// Test Suite 3: evaluateRowCreation
// ============================================================================

describe('evaluateRowCreation', () => {
  const TOLERANCE = 50 // ms
  const GAP_THRESHOLD = 2 * TOLERANCE // 100ms

  it('should always create row when both sensors have data', () => {
    const inWaterRow = makeRow(1000, 'in-water')
    const surfaceRow = makeRow(1000, 'surface')

    const shouldCreate = evaluateRowCreation(1000, inWaterRow, surfaceRow, null, null, false, TOLERANCE)

    expect(shouldCreate).toBe(true)
  })

  it('should create single-sensor row after significant gap', () => {
    const inWaterRow = makeRow(1200, 'in-water')
    const lastSurfaceTime = 1000

    // Gap = 200ms > 100ms threshold
    const shouldCreate = evaluateRowCreation(
      1200,
      inWaterRow,
      null,
      null,
      lastSurfaceTime,
      true, // Last row had both sensors
      TOLERANCE
    )

    expect(shouldCreate).toBe(true)
  })

  it('should suppress single-sensor row during brief misalignment', () => {
    const inWaterRow = makeRow(1080, 'in-water')
    const lastSurfaceTime = 1000

    // Gap = 80ms < 100ms threshold
    const shouldCreate = evaluateRowCreation(
      1080,
      inWaterRow,
      null,
      null,
      lastSurfaceTime,
      true, // Last row had both sensors
      TOLERANCE
    )

    expect(shouldCreate).toBe(false) // Suppressed
  })

  it('should create single-sensor row if last row was single-sensor', () => {
    const surfaceRow = makeRow(1080, 'surface')
    const lastInWaterTime = 1000

    // Gap = 80ms < threshold, BUT lastRowHadBothSensors = false
    const shouldCreate = evaluateRowCreation(
      1080,
      null,
      surfaceRow,
      lastInWaterTime,
      null,
      false, // Last row was single-sensor
      TOLERANCE
    )

    expect(shouldCreate).toBe(true) // Create to continue single-sensor period
  })

  it('should handle first row correctly (no previous times)', () => {
    const inWaterRow = makeRow(1000, 'in-water')

    // No lastSurfaceTime → timeSinceLastSurface = Infinity > threshold
    const shouldCreate = evaluateRowCreation(1000, inWaterRow, null, null, null, false, TOLERANCE)

    expect(shouldCreate).toBe(true)
  })

  it('should reject row with no data from either sensor', () => {
    const shouldCreate = evaluateRowCreation(1000, null, null, null, null, false, TOLERANCE)

    expect(shouldCreate).toBe(false)
  })

  it('should apply symmetric logic for surface-only rows', () => {
    const surfaceRow = makeRow(1200, 'surface')
    const lastInWaterTime = 1000

    // Gap = 200ms > 100ms threshold
    const shouldCreate = evaluateRowCreation(1200, null, surfaceRow, lastInWaterTime, null, true, TOLERANCE)

    expect(shouldCreate).toBe(true)
  })

  it('should use 2× tolerance as gap threshold', () => {
    const customTolerance = 30 // 2× = 60ms
    const inWaterRow = makeRow(1055, 'in-water')
    const lastSurfaceTime = 1000

    // Gap = 55ms < 60ms threshold → suppress
    const shouldCreate = evaluateRowCreation(1055, inWaterRow, null, null, lastSurfaceTime, true, customTolerance)

    expect(shouldCreate).toBe(false)
  })
})

// ============================================================================
// In-Water-Driven Fusion Functions (for testing)
// ============================================================================

/**
 *
 */
interface WideFormatRow {
  /**
   *
   */
  timestamp: string
  /**
   *
   */
  _parsedTime: number
  /**
   *
   */
  inwater_value: string | null
  /**
   *
   */
  surface_value: string | null
  /**
   *
   */
  surface_timestamp_used: string | null
  /**
   *
   */
  surface_age_ms: number | null
  /**
   *
   */
  surface_status: 'fresh' | 'stale' | 'missing' | null
}

const MAX_SURFACE_STALENESS_MS = 30000
const SURFACE_STALENESS_WARNING_MS = 10000

/**
 *
 * @param inWaterTime
 * @param surfaceTimestamps
 * @param surfaceMap
 * @param stalenessThresholdMs
 */
function findSurfaceValueForInWater(
  inWaterTime: number,
  surfaceTimestamps: number[],
  surfaceMap: Map<number, CsvRow>,
  stalenessThresholdMs: number
): {
  /**
   *
   */
  row: CsvRow | null
  /**
   *
   */
  timestamp_used: number | null
  /**
   *
   */
  age_ms: number | null
  /**
   *
   */
  status: 'fresh' | 'stale' | 'missing'
} {
  // Binary search for largest surface timestamp <= inWaterTime
  let left = 0
  let right = surfaceTimestamps.length - 1
  let bestIdx = -1

  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    if (surfaceTimestamps[mid] <= inWaterTime) {
      bestIdx = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  // No surface reading before this in-water time
  if (bestIdx === -1) {
    return {
      row: null,
      timestamp_used: null,
      age_ms: null,
      status: 'missing',
    }
  }

  const surfaceTime = surfaceTimestamps[bestIdx]
  const age = inWaterTime - surfaceTime

  // Check staleness
  if (age > stalenessThresholdMs) {
    return {
      row: null,
      timestamp_used: surfaceTime,
      age_ms: age,
      status: 'stale',
    }
  }

  // Determine status: fresh (< 10s) or approaching stale
  const status: 'fresh' | 'stale' = age < SURFACE_STALENESS_WARNING_MS ? 'fresh' : 'stale'

  return {
    row: surfaceMap.get(surfaceTime) ?? null,
    timestamp_used: surfaceTime,
    age_ms: age,
    status,
  }
}

/**
 *
 * @param inWaterMap
 * @param surfaceMap
 * @param stalenessThresholdMs
 */
function createInWaterDrivenRows(
  inWaterMap: Map<number, CsvRow>,
  surfaceMap: Map<number, CsvRow>,
  stalenessThresholdMs: number = MAX_SURFACE_STALENESS_MS
): WideFormatRow[] {
  const rows: WideFormatRow[] = []

  // Sort in-water timestamps (canonical timeline)
  const inWaterTimestamps = Array.from(inWaterMap.keys()).sort((a, b) => a - b)

  // Sort surface timestamps for binary search
  const surfaceTimestamps = Array.from(surfaceMap.keys()).sort((a, b) => a - b)

  // For each in-water sample, attach surface value via hold-last
  for (const inWaterTime of inWaterTimestamps) {
    const inWaterRow = inWaterMap.get(inWaterTime)!

    // Find best surface value for this in-water time
    const surfaceInfo = findSurfaceValueForInWater(
      inWaterTime,
      surfaceTimestamps,
      surfaceMap,
      stalenessThresholdMs
    )

    // Build simplified wide-format row for testing
    const row: WideFormatRow = {
      timestamp: new Date(inWaterTime).toISOString(),
      _parsedTime: inWaterTime,
      inwater_value: inWaterRow.value ?? null,
      surface_value: surfaceInfo.row?.value ?? null,
      surface_timestamp_used:
        surfaceInfo.timestamp_used !== null ? new Date(surfaceInfo.timestamp_used).toISOString() : null,
      surface_age_ms: surfaceInfo.age_ms,
      surface_status: surfaceInfo.status,
    }

    rows.push(row)
  }

  return rows
}

// ============================================================================
// Test Suite 4: In-Water-Driven Fusion
// ============================================================================

describe('createInWaterDrivenRows', () => {
  it('should create exactly one row per in-water sample', () => {
    const baseTime = 1000
    const inWaterMap = new Map([
      [baseTime, makeRow(baseTime, 'in-water')],
      [baseTime + 100, makeRow(baseTime + 100, 'in-water')],
      [baseTime + 200, makeRow(baseTime + 200, 'in-water')],
    ])
    const surfaceMap = new Map([[baseTime + 50, makeRow(baseTime + 50, 'surface')]])

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap)

    expect(rows).toHaveLength(3) // Exactly 3 rows for 3 in-water samples
    expect(rows.every((r) => r.inwater_value !== null)).toBe(true) // All rows have in-water data
  })

  it('should attach surface value via hold-last strategy', () => {
    const baseTime = 1000
    const inWaterMap = new Map([
      [baseTime + 50, makeRow(baseTime + 50, 'in-water')],
      [baseTime + 150, makeRow(baseTime + 150, 'in-water')],
      [baseTime + 250, makeRow(baseTime + 250, 'in-water')],
    ])
    const surfaceMap = new Map([
      [baseTime, makeRow(baseTime, 'surface', 'SURF_A')],
      [baseTime + 100, makeRow(baseTime + 100, 'surface', 'SURF_B')],
      [baseTime + 200, makeRow(baseTime + 200, 'surface', 'SURF_C')],
    ])

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap)

    // First in-water (t=1050) should use surface SURF_A (t=1000)
    expect(rows[0]._parsedTime).toBe(baseTime + 50)
    expect(rows[0].surface_age_ms).toBe(50)

    // Second in-water (t=1150) should use surface SURF_B (t=1100)
    expect(rows[1]._parsedTime).toBe(baseTime + 150)
    expect(rows[1].surface_age_ms).toBe(50)

    // Third in-water (t=1250) should use surface SURF_C (t=1200)
    expect(rows[2]._parsedTime).toBe(baseTime + 250)
    expect(rows[2].surface_age_ms).toBe(50)
  })

  it('should mark surface as missing when no prior surface reading exists', () => {
    const baseTime = 1000
    const inWaterMap = new Map([
      [baseTime, makeRow(baseTime, 'in-water')],
      [baseTime + 100, makeRow(baseTime + 100, 'in-water')],
    ])
    const surfaceMap = new Map([[baseTime + 150, makeRow(baseTime + 150, 'surface')]])

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap)

    // First in-water sample (t=1000) has no prior surface → missing
    expect(rows[0].surface_status).toBe('missing')
    expect(rows[0].surface_value).toBeNull()
    expect(rows[0].surface_age_ms).toBeNull()

    // Second in-water sample (t=1100) also before first surface → missing
    expect(rows[1].surface_status).toBe('missing')
    expect(rows[1].surface_value).toBeNull()
  })

  it('should mark surface as stale when age exceeds threshold', () => {
    const baseTime = 1000
    const stalenessThreshold = 10000 // 10 seconds
    const inWaterMap = new Map([
      [baseTime + 5000, makeRow(baseTime + 5000, 'in-water')], // 5s after surface
      [baseTime + 15000, makeRow(baseTime + 15000, 'in-water')], // 15s after surface
    ])
    const surfaceMap = new Map([[baseTime, makeRow(baseTime, 'surface')]])

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap, stalenessThreshold)

    // First in-water (age=5s < 10s) → fresh
    expect(rows[0].surface_status).toBe('fresh')
    expect(rows[0].surface_value).not.toBeNull()
    expect(rows[0].surface_age_ms).toBe(5000)

    // Second in-water (age=15s > 10s) → stale
    expect(rows[1].surface_status).toBe('stale')
    expect(rows[1].surface_value).toBeNull() // Null when stale
    expect(rows[1].surface_age_ms).toBe(15000)
  })

  it('should distinguish fresh vs stale within valid threshold', () => {
    const baseTime = 1000
    const inWaterMap = new Map([
      [baseTime + 5000, makeRow(baseTime + 5000, 'in-water')], // 5s
      [baseTime + 12000, makeRow(baseTime + 12000, 'in-water')], // 12s
    ])
    const surfaceMap = new Map([[baseTime, makeRow(baseTime, 'surface')]])

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap, 30000) // 30s threshold

    // Age 5s < 10s warning threshold → fresh
    expect(rows[0].surface_status).toBe('fresh')
    expect(rows[0].surface_value).not.toBeNull()

    // Age 12s > 10s warning but < 30s staleness → stale (but still valid)
    expect(rows[1].surface_status).toBe('stale')
    expect(rows[1].surface_value).not.toBeNull() // Still has value
  })

  it('should never create surface-only rows', () => {
    const baseTime = 1000
    const inWaterMap = new Map([[baseTime, makeRow(baseTime, 'in-water')]])
    const surfaceMap = new Map([
      [baseTime - 100, makeRow(baseTime - 100, 'surface')],
      [baseTime + 100, makeRow(baseTime + 100, 'surface')],
      [baseTime + 200, makeRow(baseTime + 200, 'surface')],
    ])

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap)

    // Only 1 row (matching 1 in-water sample), despite 3 surface samples
    expect(rows).toHaveLength(1)
    expect(rows[0].inwater_value).not.toBeNull()
  })

  it('should handle empty surface map gracefully', () => {
    const baseTime = 1000
    const inWaterMap = new Map([
      [baseTime, makeRow(baseTime, 'in-water')],
      [baseTime + 100, makeRow(baseTime + 100, 'in-water')],
    ])
    const surfaceMap = new Map()

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap)

    expect(rows).toHaveLength(2)
    expect(rows[0].surface_status).toBe('missing')
    expect(rows[1].surface_status).toBe('missing')
    expect(rows[0].surface_value).toBeNull()
    expect(rows[1].surface_value).toBeNull()
  })

  it('should handle empty in-water map gracefully', () => {
    const baseTime = 1000
    const inWaterMap = new Map()
    const surfaceMap = new Map([[baseTime, makeRow(baseTime, 'surface')]])

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap)

    expect(rows).toHaveLength(0) // No rows if no in-water samples
  })

  it('should maintain monotonic timestamps', () => {
    const baseTime = 1000
    const inWaterMap = new Map([
      [baseTime + 200, makeRow(baseTime + 200, 'in-water')], // Out of order insertion
      [baseTime, makeRow(baseTime, 'in-water')],
      [baseTime + 100, makeRow(baseTime + 100, 'in-water')],
    ])
    const surfaceMap = new Map([[baseTime + 50, makeRow(baseTime + 50, 'surface')]])

    const rows = createInWaterDrivenRows(inWaterMap, surfaceMap)

    // Verify sorted output despite unsorted input
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]._parsedTime).toBeGreaterThan(rows[i - 1]._parsedTime)
    }
  })
})

describe('findSurfaceValueForInWater', () => {
  it('should find most recent surface reading before in-water time', () => {
    const surfaceMap = new Map([
      [1000, makeRow(1000, 'surface', 'A')],
      [1100, makeRow(1100, 'surface', 'B')],
      [1200, makeRow(1200, 'surface', 'C')],
    ])
    const surfaceTimestamps = Array.from(surfaceMap.keys()).sort((a, b) => a - b)

    const result = findSurfaceValueForInWater(1150, surfaceTimestamps, surfaceMap, 30000)

    expect(result.row?.sensor_id).toBe('B') // 1100 is most recent before 1150
    expect(result.timestamp_used).toBe(1100)
    expect(result.age_ms).toBe(50)
    expect(result.status).toBe('fresh')
  })

  it('should return missing when no surface reading before in-water time', () => {
    const surfaceMap = new Map([[2000, makeRow(2000, 'surface')]])
    const surfaceTimestamps = [2000]

    const result = findSurfaceValueForInWater(1500, surfaceTimestamps, surfaceMap, 30000)

    expect(result.row).toBeNull()
    expect(result.status).toBe('missing')
    expect(result.timestamp_used).toBeNull()
  })

  it('should handle exact timestamp match', () => {
    const surfaceMap = new Map([[1000, makeRow(1000, 'surface')]])
    const surfaceTimestamps = [1000]

    const result = findSurfaceValueForInWater(1000, surfaceTimestamps, surfaceMap, 30000)

    expect(result.row).not.toBeNull()
    expect(result.timestamp_used).toBe(1000)
    expect(result.age_ms).toBe(0)
    expect(result.status).toBe('fresh')
  })

  it('should apply staleness threshold correctly', () => {
    const surfaceMap = new Map([[1000, makeRow(1000, 'surface')]])
    const surfaceTimestamps = [1000]

    const result = findSurfaceValueForInWater(32000, surfaceTimestamps, surfaceMap, 30000)

    // Age = 31000ms > 30000ms threshold
    expect(result.row).toBeNull()
    expect(result.status).toBe('stale')
    expect(result.age_ms).toBe(31000)
    expect(result.timestamp_used).toBe(1000) // Still recorded for debugging
  })

  it('should distinguish fresh (< 10s) from stale (10s-30s)', () => {
    const surfaceMap = new Map([[1000, makeRow(1000, 'surface')]])
    const surfaceTimestamps = [1000]

    // Fresh: age = 5s
    const freshResult = findSurfaceValueForInWater(6000, surfaceTimestamps, surfaceMap, 30000)
    expect(freshResult.status).toBe('fresh')
    expect(freshResult.row).not.toBeNull()

    // Stale but valid: age = 15s
    const staleResult = findSurfaceValueForInWater(16000, surfaceTimestamps, surfaceMap, 30000)
    expect(staleResult.status).toBe('stale')
    expect(staleResult.row).not.toBeNull() // Still valid

    // Beyond threshold: age = 35s
    const expiredResult = findSurfaceValueForInWater(36000, surfaceTimestamps, surfaceMap, 30000)
    expect(expiredResult.status).toBe('stale')
    expect(expiredResult.row).toBeNull() // Null when expired
  })
})
