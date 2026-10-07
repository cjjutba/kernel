import { contextBridge, ipcRenderer } from 'electron'
import type { Channel, KernelApi, PushEvent } from '@shared/ipc'

const api = {
  invoke<C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']> {
    return ipcRenderer.invoke(channel, req)
  },
  on(listener: (event: PushEvent) => void): () => void {
    const wrapped = (_: unknown, event: PushEvent) => listener(event)
    ipcRenderer.on('kernel:event', wrapped)
    return () => ipcRenderer.removeListener('kernel:event', wrapped)
  }
}

contextBridge.exposeInMainWorld('kernel', api)
export type KernelBridge = typeof api
