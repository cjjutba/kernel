import type { Channel, KernelApi, PushEvent } from '../shared/ipc'

declare global {
  interface Window {
    kernel: {
      invoke<C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']>
      on(listener: (event: PushEvent) => void): () => void
    }
  }
}
export {}
