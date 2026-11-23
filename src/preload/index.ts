import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, SherpaAPI } from '../shared/types'

const api: SherpaAPI = {
  getState: () => ipcRenderer.invoke('sherpa:state'),
  addCommand: (settings) => ipcRenderer.invoke('sherpa:command-add', settings),
  updateCommand: (id, settings) => ipcRenderer.invoke('sherpa:command-update', id, settings),
  deleteCommand: (id) => ipcRenderer.invoke('sherpa:command-delete', id),
  reloadConfig: () => ipcRenderer.invoke('sherpa:config-reload'),
  createSession: (input) => ipcRenderer.invoke('sherpa:create', input),
  closeSession: (id) => ipcRenderer.invoke('sherpa:close', id),
  sendMessage: (id, text) => ipcRenderer.invoke('sherpa:send', id, text),
  interrupt: (id) => ipcRenderer.invoke('sherpa:interrupt', id),
  respond: (id, requestId, reply) => ipcRenderer.invoke('sherpa:respond', id, requestId, reply),
  openExternal: (url) => ipcRenderer.invoke('sherpa:open', url),
  onState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state)
    ipcRenderer.on('sherpa:state-changed', listener)
    return () => ipcRenderer.removeListener('sherpa:state-changed', listener)
  },
}
contextBridge.exposeInMainWorld('sherpa', api)
