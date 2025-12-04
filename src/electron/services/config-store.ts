import { app } from 'electron'
import Store from 'electron-store'

const electronStoreSchema = {
  windowBounds: {
    type: 'object',
    properties: {
      width: {
        type: 'number',
      },
      height: {
        type: 'number',
      },
      x: {
        type: 'number',
      },
      y: {
        type: 'number',
      },
    },
  },
  qsensorStoragePath: {
    type: 'string',
  },
  qsensorSurfaceApiUrl: {
    type: 'string',
  },
}

/**
 * Electron store schema
 * Stores configuration data
 */
export interface ElectronStoreSchema {
  /**
   * Window bounds
   */
  windowBounds:
    | undefined
    | {
        /**
         * Last known window width
         */
        width: number
        /**
         * Last known window height
         */
        height: number
        /**
         * Last known window x position
         */
        x: number
        /**
         * Last known window y position
         */
        y: number
      }
  /**
   * Q-Sensor storage base path (for mirrored chunks)
   */
  qsensorStoragePath?: string
  /**
   * Surface Q-Sensor API base URL (for API mode).
   * Persisted across app restarts. Defaults to empty (user must set).
   */
  qsensorSurfaceApiUrl?: string
}

let storeInstance: Store<ElectronStoreSchema> | null = null

/**
 * Get the config store instance (lazy initialization after app ready).
 */
function getStore(): Store<ElectronStoreSchema> {
  if (!storeInstance) {
    storeInstance = new Store<ElectronStoreSchema>({
      projectName: app.getName() || 'Cockpit',
      cwd: app.getPath('userData'),
      name: 'config',
      schema: electronStoreSchema,
    })
  }
  return storeInstance
}

// Export a proxy that intercepts ALL property accesses
const store = new Proxy({} as Store<ElectronStoreSchema>, {
  get(_target, prop, receiver) {
    const store = getStore()
    const value = (store as any)[prop]
    // Bind methods to the store instance
    if (typeof value === 'function') {
      return value.bind(store)
    }
    return value
  },
  set(_target, prop, value) {
    const store = getStore()
    ;(store as any)[prop] = value
    return true
  },
})

export default store
