import type { Channel, KernelApi, PushEvent } from '@shared/ipc'

/** Typed bridge to the main process. Every call maps to one handler in src/main/kernel.ts. */
export function call<C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']> {
  return window.kernel.invoke(channel, req)
}

export function onPush(listener: (e: PushEvent) => void) { return window.kernel.on(listener) }
