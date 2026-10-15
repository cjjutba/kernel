import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  appearance,
  /** A dropped or picked file's absolute path on the Mac, for an attached file's `src`. Empty for one made in the page (KERNEL-907). */
  pathOf(file: File): string {
    return webUtils.getPathForFile(file)
  }
}

contextBridge.exposeInMainWorld('kernel', api)
export type KernelBridge = typeof api
