# Topside Storage Implementation (Electron Service)

## Overview

This document specifies the Electron background service that continuously pulls chunks from the Pi and writes them to local storage on the topside computer.

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/services/qsensor-storage.ts` (NEW)

**Referenced Pattern**: `/Users/matthuewalsh/Bio_cockpit/src/electron/services/video-recording.ts:63-162`

## Service Architecture

### Initialization

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/main.ts:83-90`

Add to service setup:
```typescript
setupQSensorStorageService()
```

### Service Lifecycle

```typescript
// main.ts
import { setupQSensorStorageService } from './services/qsensor-storage'

app.whenReady().then(() => {
  setupFilesystemStorage()
  setupNetworkService()
  setupResourceMonitoringService()
  setupSystemInfoService()
  setupUserAgentService()
  setupWorkspaceService()
  setupJoystickMonitoring()
  setupVideoRecordingService()
  setupQSensorStorageService()  // ← NEW
})
```

## File: qsensor-storage.ts

**Location**: `/Users/matthuewalsh/Bio_cockpit/src/electron/services/qsensor-storage.ts` (NEW)

**Size**: ~350 lines

**Pattern Reference**: Video recording service uses similar background polling

### Implementation

```typescript
import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import ky from 'ky'
import { cockpitFolderPath } from './storage'

// Types
interface QSensorSession {
  sessionId: string
  vehicleAddress: string
  missionName: string
  pollIntervalMs: number
  bandwidthCapBytesPerSec: number | null
  active: boolean
}

interface ChunkMetadata {
  index: number
  name: string
  size: number
  sha256: string
  row_start: number
  row_end: number
  row_count: number
  timestamp: string
}

interface SyncStats {
  bytesMirrored: number
  lastSyncTimestamp: number
  backlogCount: number
  chunksDownloaded: number
  errorCount: number
}

// Active sessions
const activeSessions = new Map<string, QSensorSession>()
const sessionStats = new Map<string, SyncStats>()
const pollTimers = new Map<string, NodeJS.Timeout>()

// Bandwidth throttler
class BandwidthThrottler {
  private bytesThisSecond = 0
  private lastReset = Date.now()

  constructor(private maxBytesPerSecond: number | null) {}

  async waitForCapacity(bytes: number): Promise<void> {
    if (this.maxBytesPerSecond === null) return // Unlimited

    const now = Date.now()

    // Reset counter every second
    if (now - this.lastReset >= 1000) {
      this.bytesThisSecond = 0
      this.lastReset = now
    }

    // Check if adding this chunk would exceed cap
    if (this.bytesThisSecond + bytes > this.maxBytesPerSecond) {
      const waitMs = 1000 - (now - this.lastReset)
      await new Promise(resolve => setTimeout(resolve, waitMs))
      this.bytesThisSecond = 0
      this.lastReset = Date.now()
    }

    this.bytesThisSecond += bytes
  }
}

// Get storage path for session
function getSessionStoragePath(missionName: string, sessionId: string): string {
  const qsensorRoot = path.join(cockpitFolderPath, 'qsensor')
  return path.join(qsensorRoot, missionName || 'unknown', sessionId)
}

// Start session sync
async function startSessionSync(
  sessionId: string,
  vehicleAddress: string,
  missionName: string,
  pollIntervalMs: number = 15000,
  bandwidthCapBytesPerSec: number | null = 500 * 1024 // 500 KB/s default
): Promise<void> {
  console.log(`Starting Q-Sensor sync for session ${sessionId}`)

  // Create session object
  const session: QSensorSession = {
    sessionId,
    vehicleAddress,
    missionName,
    pollIntervalMs,
    bandwidthCapBytesPerSec,
    active: true
  }

  activeSessions.set(sessionId, session)

  // Initialize stats
  sessionStats.set(sessionId, {
    bytesMirrored: 0,
    lastSyncTimestamp: 0,
    backlogCount: 0,
    chunksDownloaded: 0,
    errorCount: 0
  })

  // Create storage directory
  const sessionPath = getSessionStoragePath(missionName, sessionId)
  await fs.mkdir(sessionPath, { recursive: true })

  // Start polling
  const timer = setInterval(async () => {
    try {
      await pollAndDownloadChunks(sessionId)
    } catch (error) {
      console.error(`Error polling session ${sessionId}:`, error)
      const stats = sessionStats.get(sessionId)
      if (stats) {
        stats.errorCount++
      }
    }
  }, pollIntervalMs)

  pollTimers.set(sessionId, timer)

  // Do initial poll immediately
  await pollAndDownloadChunks(sessionId)
}

// Stop session sync
async function stopSessionSync(sessionId: string): Promise<void> {
  console.log(`Stopping Q-Sensor sync for session ${sessionId}`)

  const session = activeSessions.get(sessionId)
  if (!session) return

  session.active = false

  // Clear poll timer
  const timer = pollTimers.get(sessionId)
  if (timer) {
    clearInterval(timer)
    pollTimers.delete(sessionId)
  }

  // Do final poll to catch any remaining chunks
  try {
    await pollAndDownloadChunks(sessionId)
  } catch (error) {
    console.error(`Error in final poll for ${sessionId}:`, error)
  }

  activeSessions.delete(sessionId)
}

// Poll and download chunks
async function pollAndDownloadChunks(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId)
  if (!session) return

  const stats = sessionStats.get(sessionId)!
  const throttler = new BandwidthThrottler(session.bandwidthCapBytesPerSec)

  // Fetch remote manifest
  const baseUrl = `http://${session.vehicleAddress}:9150`
  const snapshotsUrl = `${baseUrl}/record/snapshots?session_id=${sessionId}`

  let remoteChunks: ChunkMetadata[]
  try {
    const response = await ky.get(snapshotsUrl, { timeout: 10000 }).json<any>()
    remoteChunks = response.chunks || []
  } catch (error) {
    console.error(`Failed to fetch snapshots for ${sessionId}:`, error)
    stats.errorCount++
    return
  }

  // Get local chunks
  const sessionPath = getSessionStoragePath(session.missionName, sessionId)
  let localChunks: string[]
  try {
    localChunks = await fs.readdir(sessionPath)
    localChunks = localChunks.filter(f => f.endsWith('.csv'))
  } catch (error) {
    console.error(`Failed to read local directory for ${sessionId}:`, error)
    localChunks = []
  }

  // Find missing chunks
  const missingChunks = remoteChunks.filter(
    chunk => !localChunks.includes(chunk.name)
  )

  stats.backlogCount = missingChunks.length

  // Download each missing chunk
  for (const chunk of missingChunks) {
    try {
      // Wait for bandwidth capacity
      await throttler.waitForCapacity(chunk.size)

      // Download chunk
      await downloadAndVerifyChunk(session, chunk, sessionPath)

      // Update stats
      stats.bytesMirrored += chunk.size
      stats.chunksDownloaded++
      stats.lastSyncTimestamp = Date.now()
      stats.backlogCount--

      // Notify renderer
      notifyRenderer(sessionId, stats)
    } catch (error) {
      console.error(`Failed to download chunk ${chunk.name}:`, error)
      stats.errorCount++
    }
  }
}

// Download and verify chunk
async function downloadAndVerifyChunk(
  session: QSensorSession,
  chunk: ChunkMetadata,
  sessionPath: string
): Promise<void> {
  const baseUrl = `http://${session.vehicleAddress}:9150`
  const chunkUrl = `${baseUrl}/files/${session.sessionId}/${chunk.name}`

  // Download chunk
  const response = await ky.get(chunkUrl, {
    timeout: 30000,
    retry: 2
  })

  const data = Buffer.from(await response.arrayBuffer())

  // Verify SHA256
  const hash = crypto.createHash('sha256').update(data).digest('hex')
  if (hash !== chunk.sha256) {
    throw new Error(
      `Chunk integrity check failed: expected ${chunk.sha256}, got ${hash}`
    )
  }

  // Atomic write
  const chunkPath = path.join(sessionPath, chunk.name)
  const tempPath = path.join(sessionPath, `.${chunk.name}.tmp`)

  await fs.writeFile(tempPath, data)

  // fsync
  const fd = await fs.open(tempPath, 'r+')
  await fd.sync()
  await fd.close()

  // Atomic rename
  await fs.rename(tempPath, chunkPath)

  console.log(
    `Downloaded chunk ${chunk.name}: ${chunk.size} bytes, SHA256 verified`
  )
}

// Notify renderer process
function notifyRenderer(sessionId: string, stats: SyncStats): void {
  const mainWindow = require('../main').getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('qsensor:sync-update', {
      sessionId,
      ...stats
    })
  }
}

// Resume sessions on startup
async function resumeActiveSessions(): Promise<void> {
  console.log('Checking for active Q-Sensor sessions to resume...')

  // This would query the Pi for active sessions
  // and resume syncing if found
  // Implementation depends on persistence strategy
}

// IPC Handlers
export function setupQSensorStorageService(): void {
  console.log('Setting up Q-Sensor storage service')

  // Start session sync
  ipcMain.handle(
    'qsensor:start-session-sync',
    async (
      _,
      sessionId: string,
      vehicleAddress: string,
      missionName: string,
      pollIntervalMs?: number,
      bandwidthCapBytesPerSec?: number | null
    ) => {
      await startSessionSync(
        sessionId,
        vehicleAddress,
        missionName,
        pollIntervalMs,
        bandwidthCapBytesPerSec
      )
      return { success: true }
    }
  )

  // Stop session sync
  ipcMain.handle('qsensor:stop-session-sync', async (_, sessionId: string) => {
    await stopSessionSync(sessionId)
    return { success: true }
  })

  // Get session stats
  ipcMain.handle('qsensor:get-session-stats', async (_, sessionId: string) => {
    const stats = sessionStats.get(sessionId)
    return stats || null
  })

  // List local chunks
  ipcMain.handle('qsensor:list-local-chunks', async (_, sessionId: string) => {
    const session = activeSessions.get(sessionId)
    if (!session) return []

    const sessionPath = getSessionStoragePath(session.missionName, sessionId)
    try {
      const files = await fs.readdir(sessionPath)
      return files.filter(f => f.endsWith('.csv'))
    } catch (error) {
      return []
    }
  })

  // Resume sessions on startup
  resumeActiveSessions()
}
```

## IPC Bridge (Preload)

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/preload.ts`

**Add to contextBridge**:

```typescript
// Existing pattern reference: Line 47-65
contextBridge.exposeInMainWorld('electronAPI', {
  // ... existing methods ...
  
  // Q-Sensor storage methods
  startQSensorSessionSync: (
    sessionId: string,
    vehicleAddress: string,
    missionName: string,
    pollIntervalMs?: number,
    bandwidthCapBytesPerSec?: number | null
  ) =>
    ipcRenderer.invoke(
      'qsensor:start-session-sync',
      sessionId,
      vehicleAddress,
      missionName,
      pollIntervalMs,
      bandwidthCapBytesPerSec
    ),
  
  stopQSensorSessionSync: (sessionId: string) =>
    ipcRenderer.invoke('qsensor:stop-session-sync', sessionId),
  
  getQSensorSessionStats: (sessionId: string) =>
    ipcRenderer.invoke('qsensor:get-session-stats', sessionId),
  
  listQSensorLocalChunks: (sessionId: string) =>
    ipcRenderer.invoke('qsensor:list-local-chunks', sessionId),
  
  onQSensorSyncUpdate: (callback: (data: any) => void) => {
    ipcRenderer.on('qsensor:sync-update', (_, data) => callback(data))
  }
})
```

## Storage Directory Layout

**Base Path** (macOS):
```
~/Library/Application Support/Cockpit/qsensor/
```

**Structure**:
```
qsensor/
├── Monterey_Bay_Survey/
│   └── 550e8400-e29b-41d4-a716-446655440000/
│       ├── manifest.json (local copy)
│       ├── chunk-000000.csv
│       ├── chunk-000001.csv
│       ├── chunk-000002.csv
│       └── chunk-000003.csv
└── Antarctic_Dive/
    └── 660f9511-f39c-52e5-b827-557766551111/
        ├── manifest.json
        └── chunk-000000.csv
```

**Platform Paths**:
- **macOS**: `~/Library/Application Support/Cockpit/qsensor/`
- **Windows**: `%APPDATA%/Cockpit/qsensor/`
- **Linux**: `~/.config/Cockpit/qsensor/`

## Polling Strategy

### Default Configuration

```typescript
const DEFAULT_POLL_INTERVAL_MS = 15000        // 15 seconds
const DEFAULT_BANDWIDTH_CAP_BPSE = 500 * 1024 // 500 KB/s
```

### Adaptive Polling

**Future Enhancement**: Adjust poll rate based on chunk cadence

```typescript
function calculateOptimalPollInterval(chunkIntervalS: number): number {
  // Poll at 1/4 of chunk interval, min 15s, max 60s
  const optimal = (chunkIntervalS * 1000) / 4
  return Math.max(15000, Math.min(60000, optimal))
}
```

**Example**:
- Chunk interval 60s → Poll every 15s (4 polls per chunk)
- Chunk interval 300s → Poll every 60s (5 polls per chunk)

## Bandwidth Throttling

### Implementation

```typescript
class BandwidthThrottler {
  private bytesThisSecond = 0
  private lastReset = Date.now()

  constructor(private maxBytesPerSecond: number | null) {}

  async waitForCapacity(bytes: number): Promise<void> {
    if (this.maxBytesPerSecond === null) return // Unlimited

    const now = Date.now()

    // Reset counter every second
    if (now - this.lastReset >= 1000) {
      this.bytesThisSecond = 0
      this.lastReset = now
    }

    // Check if adding this chunk would exceed cap
    if (this.bytesThisSecond + bytes > this.maxBytesPerSecond) {
      const waitMs = 1000 - (now - this.lastReset)
      await new Promise(resolve => setTimeout(resolve, waitMs))
      this.bytesThisSecond = 0
      this.lastReset = Date.now()
    }

    this.bytesThisSecond += bytes
  }
}
```

### Configuration

**Settings UI** (future):
```typescript
interface QSensorSettings {
  pollIntervalMs: number             // 15000-60000
  bandwidthCapKBps: number | null    // null = unlimited
  fullPassthroughMode: boolean       // true = 1s chunks
}
```

## Recovery Logic

### Idempotent Resume

**On Cockpit Restart**:
1. Check for active sessions on Pi (GET /record/status)
2. For each active session:
   - Load local directory
   - Compare with remote manifest
   - Resume downloading missing chunks
3. Continue normal polling

**Implementation**:

```typescript
async function resumeActiveSessions(): Promise<void> {
  // Get vehicle address from settings
  const vehicleAddress = await getVehicleAddress()
  if (!vehicleAddress) return

  try {
    // Query Pi for active sessions
    const response = await ky.get(
      `http://${vehicleAddress}:9150/record/sessions/active`,
      { timeout: 5000 }
    ).json<any>()

    const activeSessions = response.sessions || []

    for (const session of activeSessions) {
      console.log(`Resuming Q-Sensor session ${session.session_id}`)
      
      // Start sync for this session
      await startSessionSync(
        session.session_id,
        vehicleAddress,
        session.mission_name || 'unknown',
        15000,
        500 * 1024
      )
    }
  } catch (error) {
    console.error('Failed to resume active sessions:', error)
  }
}
```

## Error Handling

### Network Errors

```typescript
try {
  await pollAndDownloadChunks(sessionId)
} catch (error) {
  if (error instanceof ky.TimeoutError) {
    console.warn('Network timeout, will retry on next poll')
  } else if (error instanceof ky.HTTPError) {
    console.error(`HTTP error ${error.response.status}`)
  } else {
    console.error('Unexpected error:', error)
  }
  
  stats.errorCount++
  
  // Continue polling (errors are transient)
}
```

### Integrity Failures

```typescript
try {
  await downloadAndVerifyChunk(session, chunk, sessionPath)
} catch (error) {
  if (error.message.includes('integrity check failed')) {
    console.error(`Chunk ${chunk.name} integrity failed, will retry`)
    
    // Delete partial download
    const chunkPath = path.join(sessionPath, chunk.name)
    try {
      await fs.unlink(chunkPath)
    } catch {}
    
    // Will retry on next poll
  }
}
```

### Disk Full

```typescript
try {
  await fs.writeFile(tempPath, data)
} catch (error) {
  if (error.code === 'ENOSPC') {
    console.error('Topside disk full, stopping sync')
    
    // Notify renderer
    mainWindow.webContents.send('qsensor:error', {
      sessionId,
      errorCode: 'DISK_FULL',
      message: 'Local disk full. Free space and resume.'
    })
    
    // Stop syncing this session
    await stopSessionSync(sessionId)
  }
}
```

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Poll latency | < 100 ms | HTTP GET to Pi |
| Chunk download (1 MB) | < 5 s | @ 200 KB/s |
| SHA256 verification | < 50 ms | 1 MB file |
| Atomic write | < 100 ms | fsync + rename |
| CPU usage | < 1% | Background service |
| Memory usage | < 20 MB | Per active session |

## Monitoring & Observability

### Console Logging

```typescript
// Startup
console.log('Setting up Q-Sensor storage service')

// Session start
console.log(`Starting Q-Sensor sync for session ${sessionId}`)

// Chunk download
console.log(`Downloaded chunk ${chunk.name}: ${chunk.size} bytes, SHA256 verified`)

// Error
console.error(`Failed to download chunk ${chunk.name}:`, error)

// Session stop
console.log(`Stopping Q-Sensor sync for session ${sessionId}`)
```

### Stats Tracking

```typescript
interface SyncStats {
  bytesMirrored: number        // Total bytes downloaded
  lastSyncTimestamp: number    // Last successful sync (ms since epoch)
  backlogCount: number         // Number of chunks pending
  chunksDownloaded: number     // Total chunks downloaded
  errorCount: number           // Total errors encountered
}
```

### UI Notification

```typescript
// Send stats to renderer every time chunk is downloaded
mainWindow.webContents.send('qsensor:sync-update', {
  sessionId,
  bytesMirrored: 1234567,
  lastSyncTimestamp: Date.now(),
  backlogCount: 0,
  chunksDownloaded: 5,
  errorCount: 0
})
```

## Testing

### Unit Tests

```typescript
describe('QSensorStorageService', () => {
  test('downloads missing chunks', async () => {
    // Mock: remote has chunks 0, 1, 2
    // Local has chunks 0, 1
    // Expect: download chunk 2
  })

  test('verifies SHA256', async () => {
    // Mock: chunk with incorrect hash
    // Expect: throw integrity error
  })

  test('throttles bandwidth', async () => {
    // Mock: 500 KB/s cap, 1 MB chunk
    // Expect: download takes ~2 seconds
  })

  test('atomic write', async () => {
    // Mock: crash during write
    // Expect: .tmp file exists, final file doesn't
  })
})
```

### Integration Test

```bash
# Start mock Pi server
node tests/mock-qsensor-api.js &

# Start Cockpit
npm run electron:dev

# Trigger recording
# Verify chunks appear in ~/Library/Application Support/Cockpit/qsensor/
```

## Summary

This Electron service provides:
- ✅ Background chunk pulling (15s poll interval)
- ✅ Bandwidth throttling (500 KB/s cap)
- ✅ SHA256 verification on every chunk
- ✅ Atomic writes (temp + fsync + rename)
- ✅ Idempotent recovery (resume on restart)
- ✅ Error handling (network, integrity, disk)
- ✅ Real-time UI updates (IPC notifications)
- ✅ Low overhead (< 1% CPU, < 20 MB RAM)

Next: Cockpit UI and state management changes.
