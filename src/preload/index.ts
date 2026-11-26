import { contextBridge, ipcRenderer } from 'electron'
import type { AppState, SherpaAPI } from '../shared/types'

const api: SherpaAPI = {
  getState: () => ipcRenderer.invoke('sherpa:state'),
  addProfile: (settings) => ipcRenderer.invoke('sherpa:profile-add', settings),
  cloneProfile: (id) => ipcRenderer.invoke('sherpa:profile-clone', id),
  updateProfile: (id, settings) => ipcRenderer.invoke('sherpa:profile-update', id, settings),
  deleteProfile: (id) => ipcRenderer.invoke('sherpa:profile-delete', id),
  reloadConfig: () => ipcRenderer.invoke('sherpa:config-reload'),
  createSession: (input) => ipcRenderer.invoke('sherpa:create', input),
  configureSession: (id, profileId) =>
    ipcRenderer.invoke('sherpa:configure-session', id, profileId),
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
