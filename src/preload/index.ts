import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { INVOKE_CHANNELS, type IpcInvoke, type SimsHelperApi } from '../shared/ipc.ts'
import type { Progress } from '../shared/model.ts'

const ALLOWED_CHANNELS = new Set<string>(INVOKE_CHANNELS)

const api: SimsHelperApi = {
  invoke<K extends keyof IpcInvoke>(
    channel: K,
    ...req: IpcInvoke[K]['req'] extends void ? [] : [IpcInvoke[K]['req']]
  ): Promise<IpcInvoke[K]['res']> {
    if (!ALLOWED_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel, ...req) as Promise<IpcInvoke[K]['res']>
  },

  onProgress(listener: (progress: Progress) => void): () => void {
    const handler = (_event: IpcRendererEvent, progress: Progress) => {
      listener(progress)
    }
    ipcRenderer.on('progress', handler)
    return () => {
      ipcRenderer.removeListener('progress', handler)
    }
  }
}

contextBridge.exposeInMainWorld('simsHelper', api)
