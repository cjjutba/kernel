import type { Channel, KernelApi, PushEvent } from '../shared/ipc'
import type { AppSettings } from '../shared/types'

declare global {
  interface Window {
    kernel: {
      invoke<C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']>
      on(listener: (event: PushEvent) => void): () => void
      /** Settings, Appearance as main read it when it made the window, so the first frame matches it (KERNEL-708). */
      appearance?: AppSettings['appearance']
    }
  }
}
export {}
