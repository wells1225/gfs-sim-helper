import { app, BrowserWindow, ipcMain, Menu, nativeTheme, safeStorage, screen, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_TITLE } from '../shared/app.ts'
import { createAppHost, desktopDir } from './app-host.ts'
import { appPaths } from './app-paths.ts'
import { registerIpc } from './ipc.ts'
import { createContext } from './services.ts'

const LIGHT_BG = '#FAF9F6'
const DARK_BG = '#171B1A'

const RENDERER_HTML_PATH = join(__dirname, '../renderer/index.html')
const RENDERER_FILE_URL = pathToFileURL(RENDERER_HTML_PATH)

let mainWindow: BrowserWindow | null = null

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

  const devUrl = process.env['ELECTRON_RENDERER_URL']
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

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
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

    const ctx = createContext({
      host: createAppHost(),
      paths,
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
      }
    })

    registerIpc(ipcMain, ctx, isAppWindowEvent)

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

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
