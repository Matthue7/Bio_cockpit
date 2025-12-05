// * TIME ALIGNMENT: currently uses raw UTC timestamps; future offset correction reads sync_metadata.timeSync.offsetMs.

import * as fs from 'fs/promises'
import * as path from 'path'
import { ipcMain } from 'electron'
import { SyncMetadata, SyncMarker, DriftModel, readSyncMetadata, updateSyncMetadata } from './qsensor-session-utils'

// ============================================================================
// Type Definitions
// ============================================================================

export interface FusionResult {
  success: boolean
  unifiedCsvPath?: string
  totalRows?: number
  inWaterRows?: number
  surfaceRows?: number
  error?: string
}

export interface FusionStatus {
  status: 'pending' | 'complete' | 'skipped' | 'failed'
  unifiedCsv: string | null
  rowCount: number | null
  inWaterRows: number | null
  surfaceRows: number | null
  completedAt: string | null
  error: string | null
}

interface CsvRow {
  timestamp: string
  sensor_id: string
  mode: string
  value: string
  TempC: string
  Vin: string
  source: string
  // Parsed timestamp for sorting
  _parsedTime: number
}

// Extracted sync marker from CSV
interface ExtractedMarker {
  type: 'START' | 'STOP'
  timestamp: number  // Epoch ms
  syncId: string
}

// Parsed sensor data with markers separated from data rows
interface ParsedSensorData {
  rows: CsvRow[]
  markers: {
    start?: ExtractedMarker
    stop?: ExtractedMarker
  }
}

// Internal drift model for computation
interface ComputedDriftModel {
  type: 'constant' | 'linear'
  startOffsetMs: number
  driftRatePerMs?: number  // For linear: ms drift per ms elapsed
  endOffsetMs?: number
  inWaterStartTime?: number  // Reference point for linear interpolation
}

// Wide-format row for unified output
interface WideFormatRow {
  timestamp: string
  _parsedTime: number
  inwater_sensor_id: string | null
  inwater_mode: string | null
  inwater_value: string | null
  inwater_TempC: string | null
  inwater_Vin: string | null
  surface_sensor_id: string | null
  surface_mode: string | null
  surface_value: string | null
  surface_TempC: string | null
  surface_Vin: string | null
}

// ============================================================================
// Constants
// ============================================================================

const WIDE_FORMAT_HEADER = 'timestamp,inwater_sensor_id,inwater_mode,inwater_value,inwater_TempC,inwater_Vin,surface_sensor_id,surface_mode,surface_value,surface_TempC,surface_Vin'
const UNIFIED_CSV_FILENAME = 'unified_session.csv'
const ALIGNMENT_TOLERANCE_MS = 50
const DRIFT_THRESHOLD_MS = 2  // Don't model drift if delta < 2ms (just noise)

// ============================================================================
// Main Fusion Function
// ============================================================================

// * Fuse in-water and surface session data into a unified CSV file.
// * Steps: read both session.csv files, tag rows by source, sort by timestamp, write unified_session.csv, update sync_metadata.
export async function fuseSessionData(
  sessionRoot: string,
  syncMetadata: SyncMetadata
): Promise<FusionResult> {
  console.log(`[QSensor Fusion] Starting fusion for ${sessionRoot}`)

  try {
    // Validate inputs
    const inWaterInfo = syncMetadata.sensors.inWater
    const surfaceInfo = syncMetadata.sensors.surface

    if (!inWaterInfo?.sessionCsv && !surfaceInfo?.sessionCsv) {
      console.log(`[QSensor Fusion] No session CSVs found, skipping fusion`)
      return {
        success: false,
        error: 'No session CSVs found in sync_metadata',
      }
    }

    // Build full paths
    const inWaterCsvPath = inWaterInfo?.sessionCsv
      ? path.join(sessionRoot, inWaterInfo.sessionCsv)
      : null
    const surfaceCsvPath = surfaceInfo?.sessionCsv
      ? path.join(sessionRoot, surfaceInfo.sessionCsv)
      : null

    console.log(`[QSensor Fusion] In-water CSV: ${inWaterCsvPath ?? 'none'}`)
    console.log(`[QSensor Fusion] Surface CSV: ${surfaceCsvPath ?? 'none'}`)

    // Check if only one sensor is present
    if (!inWaterCsvPath || !surfaceCsvPath) {
      const activeSource = inWaterCsvPath ? 'in-water' : 'surface'
      console.log(`[QSensor Fusion] Only ${activeSource} sensor active, skipping unified fusion`)
      return {
        success: true,
        totalRows: 0,
        inWaterRows: inWaterCsvPath ? -1 : 0,
        surfaceRows: surfaceCsvPath ? -1 : 0,
        error: `Only ${activeSource} sensor active, skipping unified fusion`,
      }
    }

    // Verify both files exist
    const inWaterExists = await fileExists(inWaterCsvPath)
    const surfaceExists = await fileExists(surfaceCsvPath)

    if (!inWaterExists) {
      console.error(`[QSensor Fusion] In-water session.csv not found: ${inWaterCsvPath}`)
      return {
        success: false,
        error: `In-water session.csv not found: ${inWaterCsvPath}`,
      }
    }

    if (!surfaceExists) {
      console.error(`[QSensor Fusion] Surface session.csv not found: ${surfaceCsvPath}`)
      return {
        success: false,
        error: `Surface session.csv not found: ${surfaceCsvPath}`,
      }
    }

    // Parse both CSV files (extracts sync markers)
    console.log(`[QSensor Fusion] Parsing in-water CSV...`)
    const inWaterData = await parseCsvFile(inWaterCsvPath, 'in-water')
    console.log(`[QSensor Fusion] In-water: ${inWaterData.rows.length} data rows`)

    console.log(`[QSensor Fusion] Parsing surface CSV...`)
    const surfaceData = await parseCsvFile(surfaceCsvPath, 'surface')
    console.log(`[QSensor Fusion] Surface: ${surfaceData.rows.length} data rows`)

    // Log detected sync markers
    logDetectedMarkers(inWaterData.markers, surfaceData.markers)

    // Compute drift model from markers and/or time sync
    const driftModel = computeDriftModel(
      inWaterData.markers,
      surfaceData.markers,
      syncMetadata
    )

    // Log drift model decision
    logDriftModel(driftModel, syncMetadata)

    // Build timestamp axis from both sensors using drift model
    const timestampAxis = buildConsolidatedTimestampAxis(
      inWaterData.rows,
      surfaceData.rows,
      driftModel
    )
    console.log(`[QSensor Fusion] Timestamp axis: ${timestampAxis.length} consolidated timestamps`)

    // Build row maps for fast lookup with drift correction
    const inWaterMap = buildRowMapWithDrift(inWaterData.rows, driftModel)
    const surfaceMap = buildRowMap(surfaceData.rows, 0)

    // Update sync_metadata with markers and drift model
    await updateSyncMetadataWithDriftInfo(sessionRoot, inWaterData.markers, surfaceData.markers, driftModel)

    // Create wide-format aligned rows
    const wideRows = createWideFormatRows(
      timestampAxis,
      inWaterMap,
      surfaceMap,
      ALIGNMENT_TOLERANCE_MS
    )
    console.log(`[QSensor Fusion] Wide-format rows: ${wideRows.length} total`)

    // Count rows with data from each sensor and alignment statistics
    let rowsWithInWater = 0
    let rowsWithSurface = 0
    let rowsWithBoth = 0
    for (const row of wideRows) {
      const hasInWater = row.inwater_value !== null
      const hasSurface = row.surface_value !== null
      if (hasInWater) rowsWithInWater++
      if (hasSurface) rowsWithSurface++
      if (hasInWater && hasSurface) rowsWithBoth++
    }
    const unmatched = wideRows.length - rowsWithBoth

    // Write unified CSV in wide format
    const unifiedCsvPath = path.join(sessionRoot, UNIFIED_CSV_FILENAME)
    await writeWideFormatCsv(unifiedCsvPath, wideRows)

    console.log(`[QSensor Fusion] ✓ Created ${unifiedCsvPath}`)
    console.log(`[QSensor Fusion] ✓ Alignment: ${rowsWithBoth} matched both sensors, ${unmatched} unmatched`)
    console.log(`[QSensor Fusion] ✓ Summary: in-water=${rowsWithInWater}, surface=${rowsWithSurface}, total=${wideRows.length}`)

    return {
      success: true,
      unifiedCsvPath,
      totalRows: wideRows.length,
      inWaterRows: rowsWithInWater,
      surfaceRows: rowsWithSurface,
    }
  } catch (error: any) {
    console.error(`[QSensor Fusion] Fusion failed:`, error)
    return {
      success: false,
      error: error.message || 'Unknown fusion error',
    }
  }
}

// ============================================================================
// CSV Parsing
// ============================================================================

// * Parse a session.csv file and tag rows with source.
// * Expected input schema: timestamp,sensor_id,mode,value,TempC,Vin; rows with bad timestamps are skipped.
// * Extracts sync markers (SYNC_START, SYNC_STOP) and separates them from data rows.
async function parseCsvFile(csvPath: string, source: string): Promise<ParsedSensorData> {
  const content = await fs.readFile(csvPath, 'utf-8')
  const lines = content.split('\n')
  const rows: CsvRow[] = []
  const markers: ParsedSensorData['markers'] = {}

  let headerSkipped = false
  let parseErrors = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') continue

    // NOTE: Skip header line
    if (!headerSkipped) {
      if (line.includes('timestamp') || line.includes('sensor_id')) {
        headerSkipped = true
        continue
      }
    }

    // Parse CSV row
    const parts = line.split(',')
    if (parts.length < 4) {
      parseErrors++
      continue
    }

    const timestamp = parts[0]
    const sensor_id = parts[1]
    const mode = parts[2]
    const value = parts[3]
    const TempC = parts[4] ?? ''
    const Vin = parts[5] ?? ''

    // NOTE: Parse timestamp for sorting
    const parsedTime = new Date(timestamp).getTime()
    if (isNaN(parsedTime)) {
      parseErrors++
      if (parseErrors <= 5) {
        console.warn(`[QSensor Fusion] Unparseable timestamp in ${source}: "${timestamp}" (line ${i + 1})`)
      }
      continue
    }

    // Check for sync markers - extract and don't include in data rows
    if (mode === 'SYNC_START') {
      markers.start = {
        type: 'START',
        timestamp: parsedTime,
        syncId: value,  // syncId stored in value field
      }
      continue  // Don't add marker to data rows
    }

    if (mode === 'SYNC_STOP') {
      markers.stop = {
        type: 'STOP',
        timestamp: parsedTime,
        syncId: value,
      }
      continue  // Don't add marker to data rows
    }

    rows.push({
      timestamp,
      sensor_id,
      mode,
      value,
      TempC,
      Vin,
      source,
      _parsedTime: parsedTime,
    })
  }

  if (parseErrors > 0) {
    console.warn(`[QSensor Fusion] ${source}: ${parseErrors} rows skipped due to parse errors`)
  }

  return { rows, markers }
}

// ============================================================================
// Drift Model Computation
// ============================================================================

// * Log detected sync markers from both sensors
function logDetectedMarkers(
  inWaterMarkers: ParsedSensorData['markers'],
  surfaceMarkers: ParsedSensorData['markers']
): void {
  const inWaterStatus = []
  const surfaceStatus = []

  if (inWaterMarkers.start) inWaterStatus.push('START')
  if (inWaterMarkers.stop) inWaterStatus.push('STOP')
  if (surfaceMarkers.start) surfaceStatus.push('START')
  if (surfaceMarkers.stop) surfaceStatus.push('STOP')

  console.log(`[QSensor Fusion] Surface markers: ${surfaceStatus.length > 0 ? surfaceStatus.join('+') + '=measured' : 'none'}`)

  if (inWaterStatus.length > 0) {
    console.log(`[QSensor Fusion] In-water markers: ${inWaterStatus.join('+')}=measured`)
  } else {
    console.log(`[QSensor Fusion] In-water markers: synthetic (derived from time sync)`)
    console.log(`[QSensor Fusion] Warning: Synthetic markers assume stable Pi clock during recording`)
  }

  if (surfaceMarkers.start && inWaterMarkers.start) {
    const match = surfaceMarkers.start.syncId === inWaterMarkers.start.syncId ? 'MATCH' : 'MISMATCH'
    console.log(`[QSensor Fusion] START syncId ${match}: surface=${surfaceMarkers.start.syncId}, in-water=${inWaterMarkers.start.syncId}`)
  }

  if (surfaceMarkers.stop && inWaterMarkers.stop) {
    const match = surfaceMarkers.stop.syncId === inWaterMarkers.stop.syncId ? 'MATCH' : 'MISMATCH'
    console.log(`[QSensor Fusion] STOP syncId ${match}: surface=${surfaceMarkers.stop.syncId}, in-water=${inWaterMarkers.stop.syncId}`)
  }
}

// * Compute drift model from sync markers and/or time sync metadata
function computeDriftModel(
  inWaterMarkers: ParsedSensorData['markers'],
  surfaceMarkers: ParsedSensorData['markers'],
  syncMetadata: SyncMetadata
): ComputedDriftModel | null {
  const timeSyncOffset = syncMetadata.timeSync?.inWater?.offsetMs ?? null
  const hasSurfaceStart = !!surfaceMarkers.start
  const hasSurfaceStop = !!surfaceMarkers.stop
  const hasInWaterStart = !!inWaterMarkers.start
  const hasInWaterStop = !!inWaterMarkers.stop

  // Case A: both sensors have START and STOP → prefer linear drift
  if (hasSurfaceStart && hasSurfaceStop && hasInWaterStart && hasInWaterStop) {
    const surfaceStart = surfaceMarkers.start!.timestamp
    const surfaceStop = surfaceMarkers.stop!.timestamp
    const inWaterStart = inWaterMarkers.start!.timestamp
    const inWaterStop = inWaterMarkers.stop!.timestamp
    const sessionDuration = surfaceStop - surfaceStart

    const startOffset = inWaterStart - surfaceStart
    const endOffset = inWaterStop - surfaceStop
    const driftDelta = Math.abs(endOffset - startOffset)

    if (sessionDuration === 0 || driftDelta < DRIFT_THRESHOLD_MS) {
      return { type: 'constant', startOffsetMs: (startOffset + endOffset) / 2 }
    }

    return {
      type: 'linear',
      startOffsetMs: startOffset,
      endOffsetMs: endOffset,
      driftRatePerMs: (endOffset - startOffset) / sessionDuration,
      inWaterStartTime: inWaterStart,
    }
  }

  // Case B: surface has START/STOP; in-water only START
  if (hasSurfaceStart && hasSurfaceStop && hasInWaterStart) {
    const surfaceStart = surfaceMarkers.start!.timestamp
    const surfaceStop = surfaceMarkers.stop!.timestamp
    const inWaterStart = inWaterMarkers.start!.timestamp
    const sessionDuration = surfaceStop - surfaceStart

    const startOffset = inWaterStart - surfaceStart
    if (timeSyncOffset === null) {
      // Best effort constant offset with only start marker
      console.warn('[QSensor Fusion] Missing in-water STOP marker; using single START marker only')
      return { type: 'constant', startOffsetMs: startOffset }
    }

    // Estimate in-water stop using time sync offset
    console.log('[QSensor Fusion] Estimating in-water STOP marker from timeSync offset')
    const estimatedInWaterStop = surfaceStop + timeSyncOffset
    const endOffset = estimatedInWaterStop - surfaceStop
    const driftDelta = Math.abs(endOffset - startOffset)

    if (sessionDuration === 0 || driftDelta < DRIFT_THRESHOLD_MS) {
      return { type: 'constant', startOffsetMs: (startOffset + endOffset) / 2 }
    }

    return {
      type: 'linear',
      startOffsetMs: startOffset,
      endOffsetMs: endOffset,
      driftRatePerMs: (endOffset - startOffset) / sessionDuration,
      inWaterStartTime: inWaterStart,
    }
  }

  // Case C: START only available (surface must exist)
  if (hasSurfaceStart) {
    const surfaceStart = surfaceMarkers.start!.timestamp
    let inWaterStart = inWaterMarkers.start?.timestamp

    if (!inWaterStart && timeSyncOffset !== null) {
      inWaterStart = surfaceStart + timeSyncOffset
    }

    if (inWaterStart !== undefined) {
      const startOffset = inWaterStart - surfaceStart
      return { type: 'constant', startOffsetMs: startOffset }
    }
  }

  // Case D: No markers, fall back to time sync offset if present
  if (timeSyncOffset !== null) {
    console.warn('[QSensor Fusion] No sync markers detected; using timeSync offset only')
    return { type: 'constant', startOffsetMs: timeSyncOffset }
  }

  console.warn('[QSensor Fusion] No sync markers or timeSync offset available; no drift correction applied')
  return null
}

// * Log the drift model decision
function logDriftModel(driftModel: ComputedDriftModel | null, syncMetadata: SyncMetadata): void {
  if (!driftModel) {
    console.log(`[QSensor Fusion] Warning: No time sync data available, timestamps will not be corrected`)
    return
  }

  if (driftModel.type === 'constant') {
    console.log(`[QSensor Fusion] Using constant offset model: ${driftModel.startOffsetMs.toFixed(1)}ms`)
  } else {
    const driftRateMsPerMin = (driftModel.driftRatePerMs ?? 0) * 60000
    const endOffset = driftModel.endOffsetMs !== undefined
      ? driftModel.endOffsetMs.toFixed(1)
      : '?'
    console.log(
      `[QSensor Fusion] Using linear drift model: start=${driftModel.startOffsetMs.toFixed(1)}ms, ` +
      `end=${endOffset}ms, drift=${driftRateMsPerMin.toFixed(3)}ms/min`
    )
  }
}

// * Correct a timestamp using the drift model
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

// * Update sync_metadata.json with sync markers and drift model info
async function updateSyncMetadataWithDriftInfo(
  sessionRoot: string,
  inWaterMarkers: ParsedSensorData['markers'],
  surfaceMarkers: ParsedSensorData['markers'],
  driftModel: ComputedDriftModel | null
): Promise<void> {
  try {
    await updateSyncMetadata(sessionRoot, (metadata) => {
      // Build sync markers array
      const markers: SyncMarker[] = []

      if (surfaceMarkers.start || inWaterMarkers.start) {
        const surfaceStart = surfaceMarkers.start?.timestamp
        const inWaterStart = inWaterMarkers.start?.timestamp

        markers.push({
          syncId: surfaceMarkers.start?.syncId || inWaterMarkers.start?.syncId || 'unknown',
          type: 'START',
          inWaterTimestamp: inWaterStart ? new Date(inWaterStart).toISOString() : null,
          surfaceTimestamp: surfaceStart ? new Date(surfaceStart).toISOString() : null,
          offsetMs: surfaceStart && inWaterStart ? inWaterStart - surfaceStart : null,
          quality: inWaterMarkers.start ? 'measured' : 'synthetic',
        })
      }

      if (surfaceMarkers.stop || inWaterMarkers.stop) {
        const surfaceStop = surfaceMarkers.stop?.timestamp
        const inWaterStop = inWaterMarkers.stop?.timestamp

        markers.push({
          syncId: surfaceMarkers.stop?.syncId || inWaterMarkers.stop?.syncId || 'unknown',
          type: 'STOP',
          inWaterTimestamp: inWaterStop ? new Date(inWaterStop).toISOString() : null,
          surfaceTimestamp: surfaceStop ? new Date(surfaceStop).toISOString() : null,
          offsetMs: surfaceStop && inWaterStop ? inWaterStop - surfaceStop : null,
          quality: inWaterMarkers.stop ? 'measured' : 'synthetic',
        })
      }

      metadata.timeSync.markers = markers

      // Store drift model
      metadata.timeSync.driftModel = driftModel
        ? {
            type: driftModel.type,
            startOffsetMs: driftModel.startOffsetMs,
            driftRateMsPerMin: driftModel.driftRatePerMs ? driftModel.driftRatePerMs * 60000 : undefined,
            endOffsetMs: driftModel.endOffsetMs,
          }
        : null
    })
  } catch (error: any) {
    console.warn(`[QSensor Fusion] Failed to update sync metadata with drift info: ${error.message}`)
  }
}

// ============================================================================
// Wide-Format Alignment Functions
// ============================================================================

// * Build a consolidated timestamp axis by clustering nearby timestamps.
// * This reduces redundant axis points that previously drove single-sensor rows.
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

// * Pick a representative timestamp for a cluster: prefer surface reading, otherwise median.
function computeRepresentativeTimestamp(cluster: Array<{ time: number; source: string }>): number {
  const surfaceCandidate = cluster.find((item) => item.source === 'surface')
  if (surfaceCandidate) {
    return surfaceCandidate.time
  }

  const times = cluster.map((item) => item.time).sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  return times.length % 2 === 0 ? (times[mid - 1] + times[mid]) / 2 : times[mid]
}

// * Build a row map with drift correction applied to timestamps.
function buildRowMapWithDrift(
  rows: CsvRow[],
  driftModel: ComputedDriftModel | null
): Map<number, CsvRow> {
  const map = new Map<number, CsvRow>()
  for (const row of rows) {
    const correctedTime = correctTimestamp(row._parsedTime, driftModel)
    map.set(correctedTime, row)
  }
  return map
}

// * Build a Map from timestamp (ms) to CsvRow for fast lookup.
function buildRowMap(rows: CsvRow[], offsetMs: number = 0): Map<number, CsvRow> {
  const map = new Map<number, CsvRow>()
  for (const row of rows) {
    const adjustedTime = row._parsedTime - offsetMs
    map.set(adjustedTime, row)
  }
  return map
}

// * Find the nearest reading within tolerance.
// * Returns the row if found within toleranceMs, otherwise null.
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

// * Create wide-format rows from timestamp axis and sensor maps.
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
    if (!inWaterRow && !surfaceRow) {
      continue
    }

    const shouldCreateRow = evaluateRowCreation(
      timestamp,
      inWaterRow,
      surfaceRow,
      lastInWaterTime,
      lastSurfaceTime,
      lastRowHadBothSensors,
      toleranceMs
    )

    if (!shouldCreateRow) {
      continue
    }

    if (inWaterRow) lastInWaterTime = timestamp
    if (surfaceRow) lastSurfaceTime = timestamp
    lastRowHadBothSensors = !!(inWaterRow && surfaceRow)

    // Format timestamp as ISO string
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

// * Write wide-format unified CSV file with atomic write pattern.
async function writeWideFormatCsv(outputPath: string, rows: WideFormatRow[]): Promise<void> {
  const tmpPath = outputPath + '.tmp'

  // Build CSV content
  let content = WIDE_FORMAT_HEADER + '\n'

  for (const row of rows) {
    const csvLine = [
      row.timestamp,
      row.inwater_sensor_id ?? '',
      row.inwater_mode ?? '',
      row.inwater_value ?? '',
      row.inwater_TempC ?? '',
      row.inwater_Vin ?? '',
      row.surface_sensor_id ?? '',
      row.surface_mode ?? '',
      row.surface_value ?? '',
      row.surface_TempC ?? '',
      row.surface_Vin ?? '',
    ].join(',')
    content += csvLine + '\n'
  }

  // Write atomically
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, outputPath)
}

// ============================================================================
// Utilities
// ============================================================================

// * Check if file exists.
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

// * Check if both sensors have completed recording and produced session.csv files.
export function areBothSensorsComplete(syncMetadata: SyncMetadata): boolean {
  return !!(
    syncMetadata.sensors.inWater?.sessionCsv &&
    syncMetadata.sensors.surface?.sessionCsv
  )
}

// * Check if fusion has already been performed for this session by looking for unified_session.csv.
export async function isFusionComplete(sessionRoot: string): Promise<boolean> {
  const unifiedPath = path.join(sessionRoot, UNIFIED_CSV_FILENAME)
  return fileExists(unifiedPath)
}

// ============================================================================
// IPC Service Setup
// ============================================================================

/**
 * Setup IPC handlers for Q-Sensor fusion service.
 * Enables renderer to query fusion status and trigger manual fusion.
 */
export function setupQSensorFusionService(): void {
  // Get fusion status from sync_metadata.json
  ipcMain.handle('qsensor:get-fusion-status', async (_event, sessionRoot: string) => {
    try {
      if (!sessionRoot) {
        return { success: false, error: 'No session root provided' }
      }

      const syncMetadata = await readSyncMetadata(sessionRoot)
      if (!syncMetadata) {
        return { success: false, error: 'sync_metadata.json not found' }
      }

      const unifiedCsvPath = path.join(sessionRoot, UNIFIED_CSV_FILENAME)
      const exists = await fileExists(unifiedCsvPath)

      return {
        success: true,
        data: {
          fusion: syncMetadata.fusion || null,
          unifiedCsvPath: exists ? unifiedCsvPath : null,
          exists,
        },
      }
    } catch (error: any) {
      console.error('[QSensor Fusion] Failed to get fusion status:', error)
      return { success: false, error: error.message }
    }
  })

  // Manually trigger fusion (for already-recorded sessions)
  ipcMain.handle('qsensor:trigger-manual-fusion', async (_event, sessionRoot: string) => {
    try {
      if (!sessionRoot) {
        return { success: false, error: 'No session root provided' }
      }

      const syncMetadata = await readSyncMetadata(sessionRoot)
      if (!syncMetadata) {
        return { success: false, error: 'sync_metadata.json not found' }
      }

      console.log(`[QSensor Fusion] Manual fusion triggered for ${sessionRoot}`)
      const result = await fuseSessionData(sessionRoot, syncMetadata)
      return result
    } catch (error: any) {
      console.error('[QSensor Fusion] Manual fusion failed:', error)
      return { success: false, error: error.message }
    }
  })

  console.log('[QSensor Fusion] Service registered')
}
