# Bio_Cockpit Electron Desktop Audit

**Generated**: 2025-11-11
**Purpose**: Document exact integration points for Q-Series live mirroring

## 1. Electron Main Process

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/main.ts`

### App Initialization
- **Lines 92-102**: App ready handler, window creation
- **Lines 83-90**: Service setup calls (ADD Q-SENSOR HERE)

```typescript
// Line 83-90: Service setup pattern
setupFilesystemStorage()
setupNetworkService()
setupResourceMonitoringService()
setupSystemInfoService()
setupUserAgentService()
setupWorkspaceService()
setupJoystickMonitoring()
setupVideoRecordingService()
// ← ADD: setupQSensorMirrorService()
```

## 2. Electron Preload & IPC

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/preload.ts`

### IPC Channel Pattern
- **Lines 6-88**: contextBridge.exposeInMainWorld
- **Lines 48-62**: Video recording IPC channels

**ADD Q-SENSOR IPC**:
```typescript
// After line 62, add:
startQSensorMirror: (sessionId: string, vehicleAddress: string, missionName: string) =>
  ipcRenderer.invoke('qsensor:start-mirror', sessionId, vehicleAddress, missionName),
stopQSensorMirror: (sessionId: string) =>
  ipcRenderer.invoke('qsensor:stop-mirror', sessionId),
getQSensorStats: (sessionId: string) =>
  ipcRenderer.invoke('qsensor:get-stats', sessionId),
onQSensorUpdate: (callback: (data: any) => void) =>
  ipcRenderer.on('qsensor:update', (_, data) => callback(data)),
```

## 3. Video Recording Logic

**File**: `/Users/matthuewalsh/Bio_cockpit/src/stores/video.ts`

### Start Recording Hook Point
- **Lines 323-588**: `startRecording()` method
- **Line 416**: MediaRecorder.start() - INSERT Q-SENSOR START AFTER THIS

### Stop Recording Hook Point
- **Lines 294-311**: `stopRecording()` method
- **Line 308**: MediaRecorder.stop() - INSERT Q-SENSOR STOP BEFORE THIS

### Integration Pattern

```typescript
// After line 416 in startRecording():
if (window.electronAPI?.startQSensorMirror) {
  try {
    const vehicleAddress = mainVehicleStore.globalAddress || 'blueos.local'
    const missionName = missionStore.missionName || 'Unknown'

    const response = await fetch(`http://${vehicleAddress}:9150/record/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chunk_interval_s: qsensorStore.chunkIntervalS,
        metadata: { mission: missionName }
      })
    })

    const data = await response.json()
    qsensorStore.setActiveSession(data.session_id, recordingHash)

    await window.electronAPI.startQSensorMirror(
      data.session_id,
      vehicleAddress,
      missionName
    )

    console.log(`Q-Sensor mirroring started: ${data.session_id}`)
  } catch (error) {
    console.error('Failed to start Q-Sensor mirroring:', error)
  }
}

// Before line 308 in stopRecording():
if (qsensorStore.activeSessionId && window.electronAPI?.stopQSensorMirror) {
  try {
    await window.electronAPI.stopQSensorMirror(qsensorStore.activeSessionId)

    const vehicleAddress = mainVehicleStore.globalAddress || 'blueos.local'
    await fetch(`http://${vehicleAddress}:9150/record/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: qsensorStore.activeSessionId })
    })

    qsensorStore.clearActiveSession()
    console.log('Q-Sensor mirroring stopped')
  } catch (error) {
    console.error('Failed to stop Q-Sensor mirroring:', error)
  }
}
```

## 4. Widget System

**File**: `/Users/matthuewalsh/Bio_cockpit/src/types/widgets.ts`

### Mini-Widget Registration
- **Lines 71-92**: `MiniWidgetType` enum
- **Line 86**: `MiniVideoRecorder` example

**ADD Q-SENSOR WIDGET**:
```typescript
// After line 86:
QSensorRecorder = 'QSensorRecorder',
```

### Widget Pattern Reference
**File**: `/Users/matthuewalsh/Bio_cockpit/src/components/mini-widgets/MiniVideoRecorder.vue`

- **Lines 105-111**: Props definition
- **Lines 263-277**: Toggle recording pattern
- **Lines 279-293**: Start recording validation
- **Lines 295-298**: Recording state computed property

## 5. Action/Event Bus

**File**: `/Users/matthuewalsh/Bio_cockpit/src/libs/joystick/protocols/cockpit-actions.ts`

### Action Registration System
- **Lines 123-125**: `registerActionCallback()`
- **Lines 74-109**: `CockpitActionsManager` class

### Video Store Action Registration
- **Lines 859-870**: Recording action callbacks

**Pattern for Q-Sensor**:
```typescript
// In qsensor store setup:
import { registerActionCallback } from '@/libs/joystick/protocols/cockpit-actions'

registerActionCallback(
  {
    id: 'qsensor_start_mirror',
    name: 'Start Q-Sensor Mirroring',
    protocol: 'qsensor_start'
  },
  () => qsensorStore.startMirroring()
)

registerActionCallback(
  {
    id: 'qsensor_stop_mirror',
    name: 'Stop Q-Sensor Mirroring',
    protocol: 'qsensor_stop'
  },
  () => qsensorStore.stopMirroring()
)
```

## 6. Storage Paths

**File**: `/Users/matthuewalsh/Bio_cockpit/src/electron/services/storage.ts`

### Cockpit Folder Path
- **Line 9**: `cockpitFolderPath = join(app.getPath('home'), 'Cockpit')`

### Path Resolution Pattern
- **Lines 74-79** (video-recording.ts): Video path construction

**Q-Sensor Paths**:
```typescript
// In qsensor-mirror.ts:
const qsensorBasePath = join(cockpitFolderPath, 'qsensor')
const sessionPath = join(qsensorBasePath, missionName, sessionId)

// macOS: ~/Cockpit/qsensor/MissionName/550e8400.../
```

## 7. Live Processing Reference

**File**: `/Users/matthuewalsh/Bio_cockpit/src/libs/live-video-processor.ts`

### Chunk Processing Pattern
- **Lines 85-128**: `addChunk()` and queue processing
- **Lines 135-152**: `processChunk()` implementation
- **Lines 166-192**: FFmpeg integration

**Q-Sensor Mirror Service should follow similar pattern**:
- Background thread/timer
- Queue-based chunk processing
- Integrity verification (SHA256)
- Atomic writes (temp + rename)

## 8. Service Setup Pattern

**Files**:
- `/Users/matthuewalsh/Bio_cockpit/src/electron/services/video-recording.ts:696-801`
- `/Users/matthuewalsh/Bio_cockpit/src/electron/services/storage.ts:55-137`

### IPC Handler Registration
```typescript
export const setupQSensorMirrorService = (): void => {
  ipcMain.handle('qsensor:start-mirror', async (
    _,
    sessionId: string,
    vehicleAddress: string,
    missionName: string
  ) => {
    // Implementation
  })

  ipcMain.handle('qsensor:stop-mirror', async (_, sessionId: string) => {
    // Implementation
  })

  ipcMain.handle('qsensor:get-stats', async (_, sessionId: string) => {
    // Implementation
  })
}
```

## Summary: Integration Hook Points

| Component | File | Lines | Action |
|-----------|------|-------|--------|
| Electron main | `main.ts` | 83-90 | Add `setupQSensorMirrorService()` |
| Preload IPC | `preload.ts` | 48-62 | Add Q-Sensor IPC channels |
| Video start | `stores/video.ts` | 416+ | Hook Q-Sensor mirror start |
| Video stop | `stores/video.ts` | 308- | Hook Q-Sensor mirror stop |
| Widget enum | `types/widgets.ts` | 86+ | Add `QSensorRecorder` |
| Actions | `cockpit-actions.ts` | 859+ | Register Q-Sensor actions |
| Storage | `services/storage.ts` | 9 | Use `cockpitFolderPath` base |
| Service | NEW: `services/qsensor-mirror.ts` | - | Create mirror service |
| Store | NEW: `stores/qsensor.ts` | - | Create Q-Sensor state store |
| Client | NEW: `libs/qsensor-client.ts` | - | Create REST/SSE client |
| Widget | NEW: `mini-widgets/MiniQSensorRecorder.vue` | - | Create UI widget |

## Next Steps

1. Review Q_Sensor_API endpoints (confirm/add missing)
2. Design integration dataflow
3. Write minimal code diffs for each file
