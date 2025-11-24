import * as fs from 'fs/promises'
import * as path from 'path'
import { ipcMain } from 'electron'

export type SensorKey = 'inWater' | 'surface'

const SENSOR_DIRECTORY_PREFIX: Record<SensorKey, string> = {
  inWater: 'in-water',
  surface: 'surface',
}

const SYNC_METADATA_FILENAME = 'sync_metadata.json'

export interface SyncMetadataSensorInfo {
  sessionId?: string
  directory?: string
  startedAt?: string
  stoppedAt?: string
  sessionCsv?: string
  bytesMirrored?: number
  bytesRecorded?: number
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

export interface SyncMarker {
  syncId: string                    // UUID for marker pairing
  type: 'START' | 'STOP'
  inWaterTimestamp: string | null   // ISO timestamp from in-water sensor
  surfaceTimestamp: string | null   // ISO timestamp from surface sensor
  offsetMs: number | null           // Computed offset at this marker
  quality: 'measured' | 'synthetic' // Source quality indicator
}

export interface DriftModel {
  type: 'constant' | 'linear'       // Model used for correction
  startOffsetMs: number             // Offset at session start
  driftRateMsPerMin?: number        // ms drift per minute (for linear)
  endOffsetMs?: number              // Offset at session end (for linear)
}

export interface SyncMetadata {
  schemaVersion: number
  mission: string
  unifiedSessionTimestamp: string
  createdAt: string
  updatedAt: string
  sensors: {
    inWater: SyncMetadataSensorInfo | null
    surface: SyncMetadataSensorInfo | null
  }
  timeSync: {
    method: string | null
    offsetMs: number | null
    uncertaintyMs: number | null
    measuredAt: string | null
    error: string | null
    markers: SyncMarker[]           // Detected sync markers
    driftModel: DriftModel | null   // Computed drift correction model
  }
  fusion?: FusionStatus
}

export function buildUnifiedSessionRoot(basePath: string, mission: string, unifiedTimestamp: string): string {
  return path.join(basePath, mission, `session_${unifiedTimestamp}`)
}

export function buildSensorDirectoryName(sensor: SensorKey, sessionId: string): string {
  const prefix = SENSOR_DIRECTORY_PREFIX[sensor]
  return `${prefix}_${sessionId}`
}

export function resolveUnifiedSensorPath(
  basePath: string,
  mission: string,
  unifiedTimestamp: string,
  sensor: SensorKey,
  sessionId: string
): { sessionRoot: string; sensorPath: string; sensorDirectoryName: string } {
  const sessionRoot = buildUnifiedSessionRoot(basePath, mission, unifiedTimestamp)
  const sensorDirectoryName = buildSensorDirectoryName(sensor, sessionId)
  const sensorPath = path.join(sessionRoot, sensorDirectoryName)
  return { sessionRoot, sensorPath, sensorDirectoryName }
}

async function writeSyncMetadataFile(sessionRoot: string, metadata: SyncMetadata): Promise<void> {
  const metadataPath = path.join(sessionRoot, SYNC_METADATA_FILENAME)
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8')
}

export async function ensureSyncMetadata(
  sessionRoot: string,
  mission: string,
  unifiedTimestamp: string
): Promise<SyncMetadata> {
  await fs.mkdir(sessionRoot, { recursive: true })
  const metadataPath = path.join(sessionRoot, SYNC_METADATA_FILENAME)
  try {
    const existing = await fs.readFile(metadataPath, 'utf-8')
    return JSON.parse(existing) as SyncMetadata
  } catch {
    const createdAt = new Date().toISOString()
    const metadata: SyncMetadata = {
      schemaVersion: 1,
      mission,
      unifiedSessionTimestamp: unifiedTimestamp,
      createdAt,
      updatedAt: createdAt,
      sensors: {
        inWater: null,
        surface: null,
      },
      timeSync: {
        method: null,
        offsetMs: null,
        uncertaintyMs: null,
        measuredAt: null,
        error: null,
        markers: [],
        driftModel: null,
      },
    }
    await writeSyncMetadataFile(sessionRoot, metadata)
    return metadata
  }
}

export async function readSyncMetadata(sessionRoot: string): Promise<SyncMetadata | null> {
  const metadataPath = path.join(sessionRoot, SYNC_METADATA_FILENAME)
  try {
    const data = await fs.readFile(metadataPath, 'utf-8')
    return JSON.parse(data) as SyncMetadata
  } catch {
    return null
  }
}

export async function updateSyncMetadata(
  sessionRoot: string,
  updateFn: (metadata: SyncMetadata) => void
): Promise<void> {
  const metadata = await readSyncMetadata(sessionRoot)
  if (!metadata) {
    throw new Error(`sync_metadata.json not initialized for ${sessionRoot}`)
  }
  updateFn(metadata)
  metadata.updatedAt = new Date().toISOString()
  await writeSyncMetadataFile(sessionRoot, metadata)
}

export async function updateSensorMetadata(
  sessionRoot: string,
  sensor: SensorKey,
  updates: SyncMetadataSensorInfo
): Promise<void> {
  await updateSyncMetadata(sessionRoot, (metadata) => {
    const current = metadata.sensors[sensor] || {}
    metadata.sensors[sensor] = {
      ...current,
      ...updates,
    }
  })
}

export function getSyncMetadataPath(sessionRoot: string): string {
  return path.join(sessionRoot, SYNC_METADATA_FILENAME)
}

export async function updateFusionStatus(
  sessionRoot: string,
  fusionStatus: FusionStatus
): Promise<void> {
  await updateSyncMetadata(sessionRoot, (metadata) => {
    metadata.fusion = fusionStatus
  })
}

// * Setup IPC handler for updating sync metadata timeSync field.
// NOTE: Renderer uses this to push measured time sync values after capture.
export function setupSyncMetadataIPC(): void {
  ipcMain.handle(
    'qsensor:update-sync-metadata',
    async (
      _event,
      sessionRoot: string,
      timeSync: {
        method: string
        offsetMs: number | null
        uncertaintyMs: number | null
        measuredAt: string | null
        error?: string | null
      }
    ) => {
      try {
        await updateSyncMetadata(sessionRoot, (metadata) => {
          metadata.timeSync = {
            ...metadata.timeSync,
            method: timeSync.method,
            offsetMs: timeSync.offsetMs,
            uncertaintyMs: timeSync.uncertaintyMs,
            measuredAt: timeSync.measuredAt,
            error: timeSync.error ?? null,
            markers: metadata.timeSync.markers || [],
            driftModel: metadata.timeSync.driftModel ?? null,
          }
        })
        return { success: true }
      } catch (error: any) {
        console.error('[QSensor Session Utils] Failed to update sync metadata:', error.message)
        return { success: false, error: error.message }
      }
    }
  )

  console.log('[QSensor Session Utils] Sync metadata IPC registered')
}
