import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron'
import { join } from 'node:path'
import * as store from './store'
import * as library from './rag/library'
import * as chat from './chat'
import * as practice from './practice'
import { listModels, login, normalizeModel, providerStatus } from './providers'
import { claudeUsage } from './providers/claude'
import type { ChatEvent, Provider, SendRequest, ThreadPatch } from '../shared/types'

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Lemma',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0a0a0b',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

const emit = (e: ChatEvent) => win?.webContents.send('chat:event', e)

function registerIpc() {
  // Threads
  ipcMain.handle('threads:list', () => store.listThreads())
  ipcMain.handle('threads:get', (_e, id: string) => store.getThread(id))
  ipcMain.handle('threads:create', (_e, init) => store.createThread(init))
  ipcMain.handle('threads:update', (_e, id: string, patch: ThreadPatch) => {
    const t = store.getThread(id)
    if (!t) return null
    if (patch.title !== undefined) t.title = patch.title.trim() || t.title
    if (patch.model) t.model = normalizeModel(patch.model)
    if (patch.mode) t.mode = patch.mode
    if (patch.courseId !== undefined) t.courseId = patch.courseId
    if (patch.effort) t.effort = patch.effort
    store.saveThread(t)
    return t
  })
  ipcMain.handle('threads:delete', (_e, id: string) => {
    chat.stopThread(id)
    store.deleteThread(id)
  })

  // Chat
  ipcMain.handle('chat:send', (_e, req: SendRequest) => chat.send(req, emit))
  ipcMain.handle('chat:stop', (_e, threadId: string) => chat.stopThread(threadId))

  // Providers
  ipcMain.handle('models:list', () => listModels())
  ipcMain.handle('auth:status', () => providerStatus())
  ipcMain.handle('auth:login', (_e, p: Provider) => login(p))
  ipcMain.handle('claude:usage', (_e, force?: boolean) => claudeUsage(force))

  // Practice
  ipcMain.handle('practice:list', (_e, courseId: string) => practice.list(courseId))
  ipcMain.handle('practice:generate', (_e, req) => practice.generate(req))
  ipcMain.handle('practice:mark', (_e, req) => practice.mark(req))
  ipcMain.handle('practice:reveal', (_e, id: string) => practice.reveal(id))
  ipcMain.handle('practice:delete', (_e, id: string) => practice.remove(id))

  // Library
  ipcMain.handle('library:get', async () => {
    await library.load()
    return library.state()
  })
  ipcMain.handle('library:createCourse', (_e, name: string) => library.createCourse(name))
  ipcMain.handle('library:renameCourse', (_e, id: string, name: string) => library.renameCourse(id, name))
  ipcMain.handle('library:deleteCourse', (_e, id: string) => library.deleteCourse(id))
  ipcMain.handle('library:pickFiles', async (_e, courseId: string) => {
    if (!win) return
    const r = await dialog.showOpenDialog(win, {
      title: 'Add lecture notes and transcripts',
      buttonLabel: 'Add',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Notes & transcripts', extensions: ['pdf', 'txt', 'md', 'markdown', 'tex', 'vtt', 'srt', 'docx'] }]
    })
    if (!r.canceled && r.filePaths.length) await library.addPaths(courseId, r.filePaths)
  })
  ipcMain.handle('library:addPaths', (_e, courseId: string, paths: string[]) => library.addPaths(courseId, paths))
  ipcMain.handle('library:removeFile', (_e, id: string) => library.removeFile(id))
  ipcMain.handle('library:openFile', async (_e, id: string) => {
    const p = library.storedPath(id)
    if (p) await shell.openPath(p)
  })
  ipcMain.handle('library:search', (_e, q: string, courseId: string) => library.search(q, courseId, 8))
  library.onLibraryChange((s) => win?.webContents.send('library:changed', s))
}

function buildMenu() {
  const send = (channel: string) => () => win?.webContents.send('menu', channel)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' as const },
      {
        label: 'File',
        submenu: [
          { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: send('new') },
          { label: 'Library', accelerator: 'CmdOrCtrl+L', click: send('library') },
          { label: 'Practice', accelerator: 'CmdOrCtrl+P', click: send('practice') },
          { type: 'separator' as const },
          { role: 'close' as const }
        ]
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Command Menu', accelerator: 'CmdOrCtrl+K', click: send('palette') },
          { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: send('sidebar') },
          { type: 'separator' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { role: 'windowMenu' }
    ])
  )
}

app.whenReady().then(() => {
  app.setName('Lemma')
  if (!app.isPackaged) {
    // Packaged builds get the icon from the .icns; in dev, set the Dock icon by hand.
    if (process.platform === 'darwin') app.dock?.setIcon(join(import.meta.dirname, '../../resources/icon.png'))
    // Expose the page to accessibility clients (UI automation, VoiceOver testing).
    app.setAccessibilitySupportEnabled(true)
  }
  registerIpc()
  buildMenu()
  createWindow()
  void library.load()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => chat.stopAll())
