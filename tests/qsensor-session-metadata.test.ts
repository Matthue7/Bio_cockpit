import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildSensorDirectoryName,
  buildUnifiedSessionRoot,
  ensureSyncMetadata,
  readSyncMetadata,
  resolveUnifiedSensorPath,
  updateSensorMetadata,
} from '../src/electron/services/qsensor-session-utils'

describe('Q-Sensor session utilities', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qsensor-session-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('buildSensorDirectoryName generates expected folders for both sensors', () => {
    expect(buildSensorDirectoryName('inWater', 'abc')).toBe('in-water_abc')
    expect(buildSensorDirectoryName('surface', 'def')).toBe('surface_def')
  })

  it('resolves unified session paths for both sensors', () => {
    const mission = 'mission-alpha'
    const timestamp = '2025-01-01T00-00-00Z'
    const inWater = resolveUnifiedSensorPath(tempDir, mission, timestamp, 'inWater', 'abc')
    const surface = resolveUnifiedSensorPath(tempDir, mission, timestamp, 'surface', 'def')

    expect(inWater.sessionRoot).toBe(surface.sessionRoot)
    expect(path.basename(inWater.sensorPath)).toBe('in-water_abc')
    expect(path.basename(surface.sensorPath)).toBe('surface_def')
  })

  it('creates and updates sync_metadata.json for both sensors', async () => {
    const mission = 'mission-beta'
    const timestamp = '2025-02-02T00-00-00Z'
    const sessionRoot = buildUnifiedSessionRoot(tempDir, mission, timestamp)

    await ensureSyncMetadata(sessionRoot, mission, timestamp)
    await updateSensorMetadata(sessionRoot, 'inWater', {
      sessionId: 'in-123',
      directory: 'in-water_in-123',
      startedAt: '2025-02-02T00:00:01Z',
      sessionCsv: 'in-water_in-123/session.csv',
      bytesMirrored: 1024,
    })
    await updateSensorMetadata(sessionRoot, 'surface', {
      sessionId: 'surf-456',
      directory: 'surface_surf-456',
      startedAt: '2025-02-02T00:00:05Z',
      stoppedAt: '2025-02-02T00:10:05Z',
      sessionCsv: 'surface_surf-456/session.csv',
      bytesRecorded: 2048,
    })

    const metadata = await readSyncMetadata(sessionRoot)
    expect(metadata).not.toBeNull()
    expect(metadata?.mission).toBe(mission)
    expect(metadata?.unifiedSessionTimestamp).toBe(timestamp)
    expect(metadata?.sensors.inWater?.sessionId).toBe('in-123')
    expect(metadata?.sensors.inWater?.sessionCsv).toBe('in-water_in-123/session.csv')
    expect(metadata?.sensors.inWater?.bytesMirrored).toBe(1024)
    expect(metadata?.sensors.surface?.stoppedAt).toBe('2025-02-02T00:10:05Z')
    expect(metadata?.sensors.surface?.sessionCsv).toBe('surface_surf-456/session.csv')
    expect(metadata?.sensors.surface?.bytesRecorded).toBe(2048)
  })
})
