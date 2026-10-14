import { contextBridge, ipcRenderer } from 'electron'
import type { Channel, KernelApi, PushEvent } from '@shared/ipc'
import type { AppSettings } from '@shared/types'

/** Main hands Settings, Appearance over as a flag, so the page has it before its first frame (KERNEL-708). Kept in step with APPEARANCE_ARG. */
const flag = process.argv.find((a) => a.startsWith('--kernel-appearance='))
let appearance: AppSettings['appearance'] | undefined
try { appearance = flag ? JSON.parse(flag.slice('--kernel-appearance='.length)) : undefined } catch { appearance = undefined }

const api = {
  invoke<C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']> {
    return ipcRenderer.invoke(channel, req)
  },
  on(listener: (event: PushEvent) => void): () => void {
    const wrapped = (_: unknown, event: PushEvent) => listener(event)
    ipcRenderer.on('kernel:event', wrapped)
    return () => ipcRenderer.removeListener('kernel:event', wrapped)
  },
  appearance
}

contextBridge.exposeInMainWorld('kernel', api)
export type KernelBridge = typeof api
