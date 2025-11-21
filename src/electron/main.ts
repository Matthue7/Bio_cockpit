import { app, BrowserWindow, dialog, ipcMain, protocol, screen } from 'electron'
import { join } from 'path'

import { setupAutoUpdater } from './services/auto-update'
import store from './services/config-store'
import { setupElectronLogService } from './services/electron-log'
import { setupJoystickMonitoring } from './services/joystick'
import { linkService } from './services/link'
import { setupNetworkService } from './services/network'
import { setupResourceMonitoringService } from './services/resource-monitoring'
import { setupFilesystemStorage } from './services/storage'
import { setupSystemInfoService } from './services/system-info'
import { setupUserAgentService } from './services/user-agent'
import { setupVideoRecordingService } from './services/video-recording'
import { setupWorkspaceService } from './services/workspace'
import { setupQSensorMirrorService } from './services/qsensor-mirror'
import { setupQSensorControlService } from './services/qsensor-control'
import { setupQSensorSerialRecordingService } from './services/qsensor-serial-recording'
import { setupQSensorTimeSyncService } from './services/qsensor-time-sync'
import { setupSyncMetadataIPC } from './services/qsensor-session-utils'
import { setupQSensorFusionService } from './services/qsensor-fusion'
// NOTE: SerialPort is imported in qsensor-serial-recording.ts, not here
// Importing it here causes native module build issues

// Setup the logger service as soon as possible to avoid different behaviors across runtime
setupElectronLogService()

export const ROOT_PATH = {
  dist: join(__dirname, '..'),
}

let mainWindow: BrowserWindow | null

/**
 * Create electron window
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    icon: join(ROOT_PATH.dist, 'pwa-512x512.png'),
    webPreferences: {
      preload: join(ROOT_PATH.dist, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    width: store.get('windowBounds')?.width ?? screen.getPrimaryDisplay().workAreaSize.width,
    height: store.get('windowBounds')?.height ?? screen.getPrimaryDisplay().workAreaSize.height,
    x: store.get('windowBounds')?.x ?? screen.getPrimaryDisplay().bounds.x,
    y: store.get('windowBounds')?.y ?? screen.getPrimaryDisplay().bounds.y,
  })

  linkService.setMainWindow(mainWindow)

  mainWindow.on('move', () => {
    const windowBounds = mainWindow!.getBounds()
    const { x, y, width, height } = windowBounds
    store.set('windowBounds', { x, y, width, height })
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(join(ROOT_PATH.dist, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  console.log('Closing application.')
  mainWindow = null
  app.quit()
})

app.on('ready', () => {
  protocol.registerFileProtocol('file', (i, o) => {
    o({ path: i.url.substring('file://'.length) })
  })
})

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'file',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      allowServiceWorkers: true,
    },
  },
])

console.log('[Main] Beginning IPC service registration at:', new Date().toISOString())

// Initialize link service first - it was deferred from module load to avoid electron init issues
linkService.initialize()
console.log('[Main] linkService.initialize() completed')

setupFilesystemStorage()
console.log('[Main] setupFilesystemStorage() completed')

setupNetworkService()
console.log('[Main] setupNetworkService() completed')

setupResourceMonitoringService()
console.log('[Main] setupResourceMonitoringService() completed')

setupSystemInfoService()
console.log('[Main] setupSystemInfoService() completed')

setupUserAgentService()
console.log('[Main] setupUserAgentService() completed')

setupWorkspaceService()
console.log('[Main] setupWorkspaceService() completed')

setupJoystickMonitoring()
console.log('[Main] setupJoystickMonitoring() completed')

setupVideoRecordingService()
console.log('[Main] setupVideoRecordingService() completed')

setupQSensorMirrorService()
console.log('[Main] setupQSensorMirrorService() completed')

setupQSensorControlService()
console.log('[Main] setupQSensorControlService() completed')

console.log('[Main] Starting serial IPC service…')
try {
  setupQSensorSerialRecordingService()
  console.log('[Main] Serial IPC service initialized.')
} catch (error: any) {
  console.error('[Main] FATAL: Serial IPC service failed to initialize:', error)
  console.error('[Main] Error message:', error?.message)
  console.error('[Main] Error stack:', error?.stack)
}

setupQSensorTimeSyncService()
console.log('[Main] setupQSensorTimeSyncService() completed')

setupSyncMetadataIPC()
console.log('[Main] setupSyncMetadataIPC() completed')

setupQSensorFusionService()
console.log('[Main] setupQSensorFusionService() completed')

console.log('[Main] All IPC service registration completed')
console.log('[DEBUG] IPC Handlers Registered:', ipcMain.eventNames())

// Q-Sensor storage path IPC handlers
ipcMain.handle('select-qsensor-storage-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Q-Sensor Storage Folder',
  })
  return result.filePaths[0] || null
})

ipcMain.handle('get-qsensor-storage-path', () => {
  return store.get('qsensorStoragePath') || join(app.getPath('userData'), 'qsensor')
})

ipcMain.handle('set-qsensor-storage-path', (_event, storagePath: string) => {
  store.set('qsensorStoragePath', storagePath)
})

// NOTE: Generic serial port handlers (serial-list-ports, serial-open, etc.) are NOT implemented here.
// All Q-Sensor serial functionality is handled through qsensor-serial-recording.ts which has:
// - qsensor-serial:list-ports
// - qsensor-serial:connect
// - qsensor-serial:disconnect
// etc.
// The preload.ts exposes these as qsensorSerialListPorts(), qsensorSerialConnect(), etc.

app.whenReady().then(async () => {
  console.log('Electron app is ready.')
  console.log(`Cockpit version: ${app.getVersion()}`)

  console.log('Creating window...')
  createWindow()

  setTimeout(() => {
    setupAutoUpdater(mainWindow as BrowserWindow)
  }, 5000)
})

app.on('before-quit', () => {
  // @ts-ignore: import.meta.env does not exist in the types
  if (import.meta.env.DEV) {
    app.exit()
  }
})
