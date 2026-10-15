import type { Channel, KernelApi, PushEvent } from '@shared/ipc'
import { GITHUB_ERROR_PREFIX } from '@shared/githubError'

/** Typed bridge to the main process. Every call maps to one handler in src/main/kernel.ts. */
export function call<C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']> {
  return window.kernel.invoke(channel, req)
}

export function onPush(listener: (e: PushEvent) => void) { return window.kernel.on(listener) }

/**
 * The text of a failed call for the user. Electron wraps a main-process error as "Error invoking remote method 'x': Error: msg";
 * this drops the wrapper, and the kind a GitHub failure carries in its name (`githubErrorKind` reads that, KERNEL-861).
 */
export function cleanError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(GITHUB_ERROR_PREFIX, '') || 'Something went wrong'
}
