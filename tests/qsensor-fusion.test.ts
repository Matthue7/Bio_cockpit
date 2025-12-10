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

import { describe, it, expect } from 'vitest'

// ============================================================================
// Test Fixtures and Helpers
// ============================================================================

interface CsvRow {
  timestamp: string
  sensor_id: string
  mode: string
  value: string
  TempC: string
  Vin: string
  source: string
  _parsedTime: number
}

interface ComputedDriftModel {
  type: 'constant' | 'linear'
  startOffsetMs: number
  driftRatePerMs?: number
  endOffsetMs?: number
  inWaterStartTime?: number
}

/**
 * Helper to create synthetic CSV rows for testing
 */
function makeRow(
  timestamp: number,
  source: string,
  sensorId: string = 'TEST001'
): CsvRow {
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

function correctTimestamp(
  inWaterTime: number,
  driftModel: ComputedDriftModel | null
): number {
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
  const currentOffset =
    driftModel.startOffsetMs + driftModel.driftRatePerMs * elapsed
  return inWaterTime - currentOffset
}

function buildConsolidatedTimestampAxis(
  inWaterRows: CsvRow[],
  surfaceRows: CsvRow[],
  driftModel: ComputedDriftModel | null,
  consolidationThresholdMs: number = 25
): number[] {
  type TimestampEntry = { time: number; source: string }

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

function computeRepresentativeTimestamp(
  cluster: Array<{ time: number; source: string }>
): number {
  const surfaceCandidate = cluster.find((item) => item.source === 'surface')
  if (surfaceCandidate) {
    return surfaceCandidate.time
  }

  const times = cluster.map((item) => item.time).sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  return times.length % 2 === 0 ? (times[mid - 1] + times[mid]) / 2 : times[mid]
}

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
  const timeSinceLastInWater =
    lastInWaterTime !== null
      ? timestamp - lastInWaterTime
      : Number.POSITIVE_INFINITY
  const timeSinceLastSurface =
    lastSurfaceTime !== null
      ? timestamp - lastSurfaceTime
      : Number.POSITIVE_INFINITY

  if (inWaterRow && !surfaceRow) {
    return (
      timeSinceLastSurface > significantGapThreshold || !lastRowHadBothSensors
    )
  }

  if (surfaceRow && !inWaterRow) {
    return (
      timeSinceLastInWater > significantGapThreshold || !lastRowHadBothSensors
    )
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

    const axis = buildConsolidatedTimestampAxis(
      inWaterRows,
      surfaceRows,
      null,
      25
    )

    // All three timestamps within 25ms should collapse to one
    expect(axis).toHaveLength(1)
    expect(axis[0]).toBe(baseTime + 10) // Should prefer surface timestamp
  })

  it('should not consolidate timestamps beyond threshold', () => {
    const baseTime = 1000
    const inWaterRows = [makeRow(baseTime, 'in-water')]
    const surfaceRows = [makeRow(baseTime + 50, 'surface')]

    const axis = buildConsolidatedTimestampAxis(
      inWaterRows,
      surfaceRows,
      null,
      25
    )

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

    const axis = buildConsolidatedTimestampAxis(
      inWaterRows,
      surfaceRows,
      null,
      25
    )

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

    const axis = buildConsolidatedTimestampAxis(
      inWaterRows,
      surfaceRows,
      null,
      25
    )

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
    const surfaceRows = [
      makeRow(baseTime + 50, 'surface'),
      makeRow(baseTime + 150, 'surface'),
    ]

    const axis = buildConsolidatedTimestampAxis(
      inWaterRows,
      surfaceRows,
      null,
      25
    )

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

    const axis = buildConsolidatedTimestampAxis(
      inWaterRows,
      surfaceRows,
      driftModel,
      25
    )

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

    const shouldCreate = evaluateRowCreation(
      1000,
      inWaterRow,
      surfaceRow,
      null,
      null,
      false,
      TOLERANCE
    )

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
    const shouldCreate = evaluateRowCreation(
      1000,
      inWaterRow,
      null,
      null,
      null,
      false,
      TOLERANCE
    )

    expect(shouldCreate).toBe(true)
  })

  it('should reject row with no data from either sensor', () => {
    const shouldCreate = evaluateRowCreation(
      1000,
      null,
      null,
      null,
      null,
      false,
      TOLERANCE
    )

    expect(shouldCreate).toBe(false)
  })

  it('should apply symmetric logic for surface-only rows', () => {
    const surfaceRow = makeRow(1200, 'surface')
    const lastInWaterTime = 1000

    // Gap = 200ms > 100ms threshold
    const shouldCreate = evaluateRowCreation(
      1200,
      null,
      surfaceRow,
      lastInWaterTime,
      null,
      true,
      TOLERANCE
    )

    expect(shouldCreate).toBe(true)
  })

  it('should use 2× tolerance as gap threshold', () => {
    const customTolerance = 30 // 2× = 60ms
    const inWaterRow = makeRow(1055, 'in-water')
    const lastSurfaceTime = 1000

    // Gap = 55ms < 60ms threshold → suppress
    const shouldCreate = evaluateRowCreation(
      1055,
      inWaterRow,
      null,
      null,
      lastSurfaceTime,
      true,
      customTolerance
    )

    expect(shouldCreate).toBe(false)
  })
})
