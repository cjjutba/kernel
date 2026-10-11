import type { Channel, KernelApi, PushEvent } from '@shared/ipc'

/** Typed bridge to the main process. Every call maps to one handler in src/main/kernel.ts. */
export function call<C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']> {
  return window.kernel.invoke(channel, req)
}

export function onPush(listener: (e: PushEvent) => void) { return window.kernel.on(listener) }

/** The text of a failed call for the user. Electron wraps a main-process error as "Error invoking remote method 'x': Error: msg"; this drops the wrapper. */
export function cleanError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'Something went wrong'
}
