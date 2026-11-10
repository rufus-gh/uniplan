import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ChatEvent, LemmaApi, LibraryState } from '../shared/types'

function on<T>(channel: string, cb: (v: T) => void) {
  const fn = (_: unknown, v: T) => cb(v)
  ipcRenderer.on(channel, fn)
  return () => {
    ipcRenderer.off(channel, fn)
  }
}

const api: LemmaApi = {
  listThreads: () => ipcRenderer.invoke('threads:list'),
  getThread: (id) => ipcRenderer.invoke('threads:get', id),
  createThread: (init) => ipcRenderer.invoke('threads:create', init),
  updateThread: (id, patch) => ipcRenderer.invoke('threads:update', id, patch),
  deleteThread: (id) => ipcRenderer.invoke('threads:delete', id),
  send: (req) => ipcRenderer.invoke('chat:send', req),
  stop: (threadId) => ipcRenderer.invoke('chat:stop', threadId),

  listModels: () => ipcRenderer.invoke('models:list'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  openLogin: (p, cmd) => ipcRenderer.invoke('auth:login', p, cmd),
  claudeUsage: (force) => ipcRenderer.invoke('claude:usage', force),

  practiceList: (courseId) => ipcRenderer.invoke('practice:list', courseId),
  practiceGenerate: (req) => ipcRenderer.invoke('practice:generate', req),
  practiceMark: (req) => ipcRenderer.invoke('practice:mark', req),
  practiceReveal: (id) => ipcRenderer.invoke('practice:reveal', id),
  practiceDelete: (id) => ipcRenderer.invoke('practice:delete', id),

  library: () => ipcRenderer.invoke('library:get'),
  createCourse: (name) => ipcRenderer.invoke('library:createCourse', name),
  renameCourse: (id, name) => ipcRenderer.invoke('library:renameCourse', id, name),
  deleteCourse: (id) => ipcRenderer.invoke('library:deleteCourse', id),
  pickFiles: (courseId) => ipcRenderer.invoke('library:pickFiles', courseId),
  addPaths: (courseId, paths) => ipcRenderer.invoke('library:addPaths', courseId, paths),
  removeFile: (id) => ipcRenderer.invoke('library:removeFile', id),
  openFile: (id) => ipcRenderer.invoke('library:openFile', id),
  search: (q, courseId) => ipcRenderer.invoke('library:search', q, courseId),
  pathForFile: (file) => webUtils.getPathForFile(file),

  onChatEvent: (cb) => on<ChatEvent>('chat:event', cb),
  onLibrary: (cb) => on<LibraryState>('library:changed', cb),
  onMenu: (cb) => on<string>('menu', cb),
  platform: process.platform
}

contextBridge.exposeInMainWorld('lemma', api)
