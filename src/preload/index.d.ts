import type { Channel, KernelApi, PushEvent } from '../shared/ipc'
import type { AppSettings } from '../shared/types'

declare global {
  interface Window {
    kernel: {
      invoke<C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']>
      on(listener: (event: PushEvent) => void): () => void
      /** Settings, Appearance as main read it when it made the window, so the first frame matches it (KERNEL-708). */
      appearance?: AppSettings['appearance']
      /** A dropped or picked file's absolute path on the Mac, for an attached file's `src`. Empty for one made in the page (KERNEL-907). */
      pathOf(file: File): string
      /** Set by the browser bridge, which carries these calls over Remote access to a Mac. The app's own preload leaves it out (remote-web-client). */
      remote?: true
    }
  }
}
export {}
