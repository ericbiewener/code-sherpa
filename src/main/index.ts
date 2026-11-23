import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import {
  commandSettingsSchema,
  idSchema,
  newSessionSchema,
  promptSchema,
  replySchema,
} from '../shared/validation'
import { errorMessage } from './agents/transport'
import { ConfigStore, configFilePath, defaultConfig } from './config'
import { shellEnvironment } from './discovery'
import { SessionManager } from './session-manager'
import { SessionStore } from './store'

const directory = fileURLToPath(new URL('.', import.meta.url))
// Useful for isolated development/testing, without touching normal conversation data.
if (process.env.SHERPA_DATA_DIR) app.setPath('userData', process.env.SHERPA_DATA_DIR)
app.setName('Code Sherpa')
let window: BrowserWindow | null = null
let manager: SessionManager | undefined
let quitting = false

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    window?.show()
    window?.focus()
  })
  void app
    .whenReady()
    .then(async () => {
      const env = await shellEnvironment()
      const configStore = new ConfigStore(configFilePath(env))
      let config = defaultConfig()
      let configError: string | undefined
      try {
        config = await configStore.load()
      } catch (error) {
        configError = errorMessage(error)
      }
      manager = new SessionManager(
        new SessionStore(join(app.getPath('userData'), 'sessions.json')),
        config,
        env,
        app.isPackaged ? homedir() : process.cwd(),
        (state) => {
          if (window && !window.isDestroyed())
            window.webContents.send('sherpa:state-changed', state)
        },
        undefined,
        configStore.path,
      )
      if (configError) manager.setConfigError(configError)
      await manager.load()

      const handle = (channel: string, callback: (...args: unknown[]) => unknown) => {
        ipcMain.handle(channel, (event, ...args: unknown[]) => {
          if (
            !window ||
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame
          )
            throw new Error('Untrusted IPC sender')
          return callback(...args)
        })
      }
      handle('sherpa:state', () => manager?.snapshot())
      handle('sherpa:command-add', async (input) => {
        manager?.setConfig(await configStore.addCommand(commandSettingsSchema.parse(input), env))
      })
      handle('sherpa:command-update', async (id, input) => {
        manager?.setConfig(
          await configStore.updateCommand(
            idSchema.parse(id),
            commandSettingsSchema.parse(input),
            env,
          ),
        )
      })
      handle('sherpa:command-delete', async (id) => {
        manager?.setConfig(await configStore.deleteCommand(idSchema.parse(id)))
      })
      handle('sherpa:config-reload', async () => {
        try {
          manager?.setConfig(await configStore.load())
        } catch (error) {
          manager?.setConfigError(errorMessage(error))
          throw error
        }
      })
      handle('sherpa:create', async (input) => {
        const parsed = newSessionSchema.parse(input)
        if (parsed.harness)
          manager?.setConfig(await configStore.setHarness(parsed.profileId, parsed.harness))
        return manager?.create(parsed)
      })
      handle('sherpa:close', (id) => manager?.close(idSchema.parse(id)))
      handle('sherpa:send', (id, text) =>
        manager?.send(idSchema.parse(id), promptSchema.parse(text)),
      )
      handle('sherpa:interrupt', (id) => manager?.interrupt(idSchema.parse(id)))
      handle('sherpa:respond', (id, request, reply) =>
        manager?.respond(idSchema.parse(id), idSchema.parse(request), replySchema.parse(reply)),
      )
      handle('sherpa:open', async (value) => {
        if (typeof value !== 'string') throw new Error('Invalid URL')
        const url = new URL(value)
        if (!['https:', 'http:'].includes(url.protocol))
          throw new Error('Only web links can be opened')
        await shell.openExternal(url.toString())
      })
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      )
      createWindow()
      app.on('activate', () => {
        if (!window) createWindow()
        else window.show()
      })
    })
    .catch((error) => {
      dialog.showErrorBox('Code Sherpa could not start', String(error))
      app.quit()
    })
}

function createWindow() {
  window = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 640,
    minHeight: 600,
    title: 'Code Sherpa',
    backgroundColor: '#151915',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.on('closed', () => {
    window = null
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(directory, '../renderer/index.html'))
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', (event) => {
  if (quitting || !manager) return
  event.preventDefault()
  quitting = true
  void manager.dispose().finally(() => app.quit())
})
