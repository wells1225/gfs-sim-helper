import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, screen, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_TITLE } from '../shared/app.ts'
import { createAppHost, desktopDir } from './app-host.ts'
import { appIconPath } from './app-icon.ts'
import { appPaths } from './app-paths.ts'
import { registerIpc } from './ipc.ts'
import { createContext, createRecoveryQuitGuard, updaterKeepOutOf, type RecoveryQuitGuard } from './services.ts'
import { createUpdater } from './update/updater.ts'

const LIGHT_BG = '#FAF9F6'
const DARK_BG = '#171B1A'

const RENDERER_HTML_PATH = join(__dirname, '../renderer/index.html')
const RENDERER_FILE_URL = pathToFileURL(RENDERER_HTML_PATH)

let mainWindow: BrowserWindow | null = null

/** The dev server URL. Ignored in the installed app, so an environment variable cannot point it at another page. */
function devRendererUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
}

function themeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG
}

function isAppPageUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }

  const devUrl = devRendererUrl()
  if (devUrl) {
    try {
      const expected = new URL(devUrl)
      return parsed.origin === expected.origin
    } catch {
      return false
    }
  }

  if (parsed.protocol !== 'file:') return false
  if (process.platform === 'win32') {
    return parsed.pathname.toLowerCase() === RENDERER_FILE_URL.pathname.toLowerCase()
  }
  return parsed.pathname === RENDERER_FILE_URL.pathname
}

function isAppWindowEvent(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (event.sender !== mainWindow.webContents) return false
  if (!event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) return false
  return isAppPageUrl(event.senderFrame.url)
}

function createWindow(): BrowserWindow {
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize
  const width = Math.max(500, Math.min(960, workWidth))
  const height = Math.max(520, Math.min(700, workHeight))

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 500,
    minHeight: 520,
    show: false,
    backgroundColor: themeBackgroundColor(),
    icon: appIconPath(__dirname),
    title: APP_TITLE,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppPageUrl(url)) {
      event.preventDefault()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  const rendererUrl = devRendererUrl()
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(RENDERER_HTML_PATH)
  }

  return win
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  let quitGuard: RecoveryQuitGuard | null = null

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)

    const paths = appPaths({
      localAppData: process.env['LOCALAPPDATA']?.trim() || app.getPath('appData'),
      appData: process.env['APPDATA']?.trim() || null,
      desktopDir: desktopDir(),
      env: process.env
    })

    const host = createAppHost()
    // Real Documents always, plus the test override when one is set: an environment variable can only add a folder.
    const keepOutOf = updaterKeepOutOf([app.getPath('documents'), host.documentsDir], paths)
    const updaterInput = {
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      installDir: dirname(process.execPath),
      argv: process.argv,
      env: process.env,
      keepOutOf,
      platform: process.platform
    }

    const ctx = createContext({
      host,
      paths,
      // createContext calls this once with its own busy(), so install refuses while a fix, backup or 50/50 step runs.
      updater: (seams) => createUpdater(updaterInput, seams),
      safeStorage: {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (text) => safeStorage.encryptString(text),
        decryptString: (data) => safeStorage.decryptString(Buffer.from(data))
      },
      emit: (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('progress', progress)
        }
      },
      reveal: (file) => {
        shell.showItemInFolder(file)
      },
      pickFolder: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return null
        const picked = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
        return picked.canceled ? null : (picked.filePaths[0] ?? null)
      },
      // services.ts hands this only the url safeWebLink gave back.
      openExternal: (url) => shell.openExternal(url)
    })

    registerIpc(ipcMain, ctx, isAppWindowEvent)

    // Start recovery once before the window opens without blocking first paint; IPC handlers and Shell wait on journal:recovery.
    const recoveryDone = ctx.startupRecovery()
    quitGuard = createRecoveryQuitGuard(recoveryDone, {
      platform: process.platform,
      quit: () => app.quit(),
      openWindowCount: () => BrowserWindow.getAllWindows().length
    })

    nativeTheme.on('updated', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(themeBackgroundColor())
      }
    })

    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('before-quit', (event) => {
    quitGuard?.onBeforeQuit(event)
  })

  app.on('window-all-closed', () => {
    if (quitGuard) {
      quitGuard.onWindowAllClosed()
    } else if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
