import { contextBridge, ipcRenderer } from 'electron'

import type { ElectronSDLJoystickControllerStateEventData } from '@/types/joystick'
import type { FileDialogOptions, FileStats } from '@/types/storage'

contextBridge.exposeInMainWorld('electronAPI', {
  getInfoOnSubnets: () => ipcRenderer.invoke('get-info-on-subnets'),
  getResourceUsage: () => ipcRenderer.invoke('get-resource-usage'),
  onUpdateAvailable: (callback: (info: any) => void) =>
    ipcRenderer.on('update-available', (_event, info) => callback(info)),
  onUpdateDownloaded: (callback: (info: any) => void) =>
    ipcRenderer.on('update-downloaded', (_event, info) => callback(info)),
  onCheckingForUpdate: (callback: () => void) => ipcRenderer.on('checking-for-update', () => callback()),
  onUpdateNotAvailable: (callback: (info: any) => void) =>
    ipcRenderer.on('update-not-available', (_event, info) => callback(info)),
  onDownloadProgress: (callback: (info: any) => void) =>
    ipcRenderer.on('download-progress', (_event, info) => callback(info)),
  onElectronSDLControllerJoystickStateChange: (callback: (data: ElectronSDLJoystickControllerStateEventData) => void) =>
    ipcRenderer.on('sdl-controller-joystick-state', (_event, data) => callback(data)),
  checkSDLStatus: () => ipcRenderer.invoke('check-sdl-status'),
  downloadUpdate: () => ipcRenderer.send('download-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
  cancelUpdate: () => ipcRenderer.send('cancel-update'),
  setItem: async (key: string, value: Blob, subFolders?: string[]) => {
    const arrayBuffer = await value.arrayBuffer()
    await ipcRenderer.invoke('setItem', { key, value: new Uint8Array(arrayBuffer), subFolders })
  },
  getItem: async (key: string, subFolders?: string[]) => {
    const arrayBuffer = await ipcRenderer.invoke('getItem', { key, subFolders })
    return arrayBuffer ? new Blob([arrayBuffer]) : null
  },
  removeItem: async (key: string, subFolders?: string[]) => {
    await ipcRenderer.invoke('removeItem', { key, subFolders })
  },
  clear: async (subFolders?: string[]) => {
    await ipcRenderer.invoke('clear', { subFolders })
  },
  keys: async (subFolders?: string[]) => {
    return await ipcRenderer.invoke('keys', { subFolders })
  },
  openCockpitFolder: () => ipcRenderer.invoke('open-cockpit-folder'),
  openVideoFolder: () => ipcRenderer.invoke('open-video-folder'),
  openVideoFile: (fileName: string) => ipcRenderer.invoke('open-video-file', fileName),
  openVideoChunksFolder: () => ipcRenderer.invoke('open-temp-video-chunks-folder'),
  getFileStats: (pathOrKey: string, subFolders?: string[]): Promise<FileStats> =>
    ipcRenderer.invoke('get-file-stats', pathOrKey, subFolders),
  getPathOfSelectedFile: (options?: FileDialogOptions) => ipcRenderer.invoke('get-path-of-selected-file', options),
  startVideoRecording: async (firstChunk: Blob, recordingHash: string, fileName: string, keepChunkBackup?: boolean) => {
    const chunkData = new Uint8Array(await firstChunk.arrayBuffer())
    return ipcRenderer.invoke('start-video-recording', chunkData, recordingHash, fileName, keepChunkBackup)
  },
  appendChunkToVideoRecording: async (processId: string, chunk: Blob, chunkNumber: number) => {
    const chunkData = new Uint8Array(await chunk.arrayBuffer())
    return ipcRenderer.invoke('append-chunk-to-video-recording', processId, chunkData, chunkNumber)
  },
  finalizeVideoRecording: (processId: string) => ipcRenderer.invoke('finalize-video-recording', processId),
  extractVideoChunksZip: (zipFilePath: string) => ipcRenderer.invoke('extract-video-chunks-zip', zipFilePath),
  readChunkFile: (chunkPath: string) => ipcRenderer.invoke('read-chunk-file', chunkPath),
  copyTelemetryFile: (assFilePath: string, outputVideoPath: string) =>
    ipcRenderer.invoke('copy-telemetry-file', assFilePath, outputVideoPath),
  createVideoChunksZip: (hash: string) => ipcRenderer.invoke('create-video-chunks-zip', hash),
  cleanupTempDir: (tempDir: string) => ipcRenderer.invoke('cleanup-temp-dir', tempDir),
  captureWorkspace: (rect?: Electron.Rectangle) => ipcRenderer.invoke('capture-workspace', rect),
  serialListPorts: () => ipcRenderer.invoke('serial-list-ports'),
  serialOpen: (path: string, baudRate?: number) => ipcRenderer.invoke('serial-open', { path, baudRate }),
  serialWrite: (path: string, data: Uint8Array) => ipcRenderer.invoke('serial-write', { path, data }),
  serialClose: (path: string) => ipcRenderer.invoke('serial-close', { path }),
  serialIsOpen: (path: string) => ipcRenderer.invoke('serial-is-open', { path }),
  /* eslint-disable jsdoc/require-jsdoc */
  onSerialData: (callback: (data: { path: string; data: number[] }) => void) => {
    ipcRenderer.on('serial-data', (_event, data) => callback(data))
  },
  linkOpen: (path: string) => ipcRenderer.invoke('link-open', { path }),
  linkWrite: (path: string, data: Uint8Array) => ipcRenderer.invoke('link-write', { path, data }),
  linkClose: (path: string) => ipcRenderer.invoke('link-close', { path }),
  onLinkData: (callback: (data: { path: string; data: number[] }) => void) => {
    ipcRenderer.on('link-data', (_event, data) => callback(data))
  },
  systemLog: (level: string, message: string) => ipcRenderer.send('system-log', { level, message }),
  getElectronLogs: () => ipcRenderer.invoke('get-electron-logs'),
  // Q-Sensor control (bypasses CORS)
  qsensorConnect: (baseUrl: string, port: string, baud: number) =>
    ipcRenderer.invoke('qsensor:connect', baseUrl, port, baud),
  qsensorDisconnect: (baseUrl: string) => ipcRenderer.invoke('qsensor:disconnect', baseUrl),
  qsensorGetHealth: (baseUrl: string) => ipcRenderer.invoke('qsensor:get-health', baseUrl),
  qsensorStartAcquisition: (baseUrl: string, pollHz?: number) =>
    ipcRenderer.invoke('qsensor:start-acquisition', baseUrl, pollHz),
  qsensorStopAcquisition: (baseUrl: string) => ipcRenderer.invoke('qsensor:stop-acquisition', baseUrl),
  qsensorStartRecording: (baseUrl: string, options: any) =>
    ipcRenderer.invoke('qsensor:start-recording', baseUrl, options),
  qsensorStopRecording: (baseUrl: string, sessionId: string) =>
    ipcRenderer.invoke('qsensor:stop-recording', baseUrl, sessionId),
  // Q-Sensor mirroring
  startQSensorMirror: (
    sessionId: string,
    vehicleAddress: string,
    missionName: string,
    cadenceSec: number,
    fullBandwidth: boolean,
    unifiedSessionTimestamp?: string,
    syncId?: string
  ) =>
    ipcRenderer.invoke('qsensor:start-mirror', sessionId, vehicleAddress, missionName, cadenceSec, fullBandwidth, unifiedSessionTimestamp, syncId),
  stopQSensorMirror: (sessionId: string) => ipcRenderer.invoke('qsensor:stop-mirror', sessionId),
  getQSensorStats: (sessionId: string) => ipcRenderer.invoke('qsensor:get-stats', sessionId),
  // Q-Sensor storage path
  selectQSensorStorageDirectory: () => ipcRenderer.invoke('select-qsensor-storage-directory'),
  getQSensorStoragePath: () => ipcRenderer.invoke('get-qsensor-storage-path'),
  setQSensorStoragePath: (storagePath: string) => ipcRenderer.invoke('set-qsensor-storage-path', storagePath),
  // Q-Sensor serial recording (topside/surface sensor)
  qsensorSerialConnect: (port: string, baudRate: number) => {
    console.log(`[Preload] qsensorSerialConnect called - port: ${port}, baudRate: ${baudRate}`)
    return ipcRenderer.invoke('qsensor-serial:connect', port, baudRate)
      .then((result: any) => {
        console.log('[Preload] qsensorSerialConnect result:', JSON.stringify(result))
        return result
      })
      .catch((error: any) => {
        console.error('[Preload] qsensorSerialConnect error:', error)
        console.error('[Preload] Error message:', error?.message)
        console.error('[Preload] Error stack:', error?.stack)
        throw error
      })
  },
  qsensorSerialDisconnect: () => {
    console.log('[Preload] qsensorSerialDisconnect called')
    return ipcRenderer.invoke('qsensor-serial:disconnect')
  },
  qsensorSerialGetHealth: () => {
    console.log('[Preload] qsensorSerialGetHealth called')
    return ipcRenderer.invoke('qsensor-serial:get-health')
  },
  qsensorSerialStartAcquisition: (pollHz: number) => {
    console.log(`[Preload] qsensorSerialStartAcquisition called - pollHz: ${pollHz}`)
    return ipcRenderer.invoke('qsensor-serial:start-acquisition', pollHz)
  },
  qsensorSerialStopAcquisition: () => {
    console.log('[Preload] qsensorSerialStopAcquisition called')
    return ipcRenderer.invoke('qsensor-serial:stop-acquisition')
  },
  qsensorSerialStartRecording: (params: {
    mission: string
    rollIntervalS?: number
    rateHz?: number
    storagePath?: string
    unifiedSessionTimestamp?: string
    syncId?: string
  }) => ipcRenderer.invoke('qsensor-serial:start-recording', params),
  qsensorSerialStopRecording: () => ipcRenderer.invoke('qsensor-serial:stop-recording'),
  qsensorSerialGetStats: () => ipcRenderer.invoke('qsensor-serial:get-stats'),
  qsensorSerialListPorts: () => {
    console.log('[Preload] qsensorSerialListPorts called')
    return ipcRenderer.invoke('qsensor-serial:list-ports')
  },
  // Q-Sensor time sync
  measureClockOffset: (baseUrl: string) =>
    ipcRenderer.invoke('qsensor:measure-clock-offset', baseUrl),
  updateSyncMetadata: (
    sessionRoot: string,
    timeSync: {
      method: string
      offsetMs: number | null
      uncertaintyMs: number | null
      measuredAt: string | null
      error?: string | null
    }
  ) => ipcRenderer.invoke('qsensor:update-sync-metadata', sessionRoot, timeSync),
  // Q-Sensor fusion
  qsensorGetFusionStatus: (sessionRoot: string) =>
    ipcRenderer.invoke('qsensor:get-fusion-status', sessionRoot),
  qsensorTriggerManualFusion: (sessionRoot: string) =>
    ipcRenderer.invoke('qsensor:trigger-manual-fusion', sessionRoot),
  getElectronLogContent: (logName: string) => ipcRenderer.invoke('get-electron-log-content', logName),
  deleteElectronLog: (logName: string) => ipcRenderer.invoke('delete-electron-log', logName),
  deleteOldElectronLogs: () => ipcRenderer.invoke('delete-old-electron-logs'),
  setUserAgent: (userAgent: string) => ipcRenderer.invoke('set-user-agent', userAgent),
  restoreUserAgent: () => ipcRenderer.invoke('restore-user-agent'),
  getCurrentUserAgent: () => ipcRenderer.invoke('get-current-user-agent'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
})
