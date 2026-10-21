import { useCallback, useEffect, useRef, useState } from 'react'
import { call } from '../../../api'
import { actions, getState, useStore } from '../../../store'

/** What a chat's composer could not read from main: its queue (and why it waits) and the mode it runs in. */
export interface LoadFailure { queue: boolean; mode: boolean }

const NONE: LoadFailure = { queue: false, mode: false }

/**
 * Reads the chat's queue, the reason it waits and its run mode as the box opens. A read that fails is kept, not hidden: `failed` says which,
 * so the box can say so instead of drawing an empty tray or the default mode as the chat's own. `retry` reads again, and so does the
 * network coming back while one is failed. A pushed event fills the same store, so what it already filled is not read over.
 */
export function useComposerLoads(chatId: string): { failed: LoadFailure; retry: () => Promise<void> } {
  const online = useStore((s) => s.system.online)
  const [state, setState] = useState<{ chatId: string; failed: LoadFailure }>({ chatId, failed: NONE })
  const failed = state.chatId === chatId ? state.failed : NONE
  const latest = useRef(failed)
  latest.current = failed

  const load = useCallback(async () => {
    const [queue, why, mode] = await Promise.allSettled([
      call('chats.queue', { chatId }),
      call('chats.queueReason', { chatId }),
      getState().runModes[chatId] ? Promise.resolve(undefined) : call('chats.runMode', { chatId })
    ])
    if (queue.status === 'fulfilled' && Array.isArray(queue.value)) actions.chats.setQueue(chatId, queue.value)
    // No reason comes back for an empty queue, so a null answer says nothing and leaves a pushed one alone.
    if (why.status === 'fulfilled' && why.value) actions.chats.setQueueWhy(chatId, why.value)
    if (mode.status === 'fulfilled' && mode.value && !getState().runModes[chatId]) actions.chats.setRunMode(chatId, mode.value)
    const next = { queue: queue.status === 'rejected' || why.status === 'rejected', mode: mode.status === 'rejected' && !getState().runModes[chatId] }
    setState({ chatId, failed: next.queue || next.mode ? next : NONE })
  }, [chatId])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (online && (latest.current.queue || latest.current.mode)) void load() }, [online])

  return { failed, retry: load }
}

/** What the toast says failed to load. */
export function loadFailureLine(f: LoadFailure): string | undefined {
  if (f.queue && f.mode) return "Couldn't load this chat's queue and mode"
  if (f.queue) return "Couldn't load this chat's queued messages"
  if (f.mode) return "Couldn't load this chat's mode"
  return undefined
}

/** Why it matters: the box runs in the mode it already shows until the mode loads, and the tray fills in once the queue does. */
export function loadFailureSub(f: LoadFailure, mode: string): string | undefined {
  if (f.mode) return `The composer uses ${mode} until ${f.queue ? 'they load' : 'it loads'}.`
  return f.queue ? 'Queued messages show once they load.' : undefined
}
