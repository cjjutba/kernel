import type { Keychain, KeychainAccess } from '../../src/main/services/providers/claudeHome'

/**
 * The Mac's Keychain in memory, as Claude Code's items hold a login and its MCP sign-ins (KERNEL-616): each item's secret
 * by its name. `between` runs once after an item's first read and before the next, so a test can change the item between
 * Kernel's two reads, as a CLI refreshing a token would. Every write is kept, in order. `prompt` makes an item's reads wait
 * on a macOS prompt until the test allows or denies it, or the read's timeout passes (KERNEL-618). `accesses` counts them.
 */
export function fakeKeychain(items: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(items).map(([name, v]) => [name, typeof v === 'string' ? v : JSON.stringify(v)]))
  const writes: string[] = []
  const reads = new Map<string, number>()
  const between = new Map<string, () => void>()
  const prompts = new Map<string, Set<(r: KeychainAccess) => void>>()
  const accesses: string[] = []
  const keychain: Required<Keychain> = {
    read: (item) => {
      const n = (reads.get(item) ?? 0) + 1
      reads.set(item, n)
      if (n === 2) between.get(item)?.()
      return store.get(item)
    },
    write: (item, secret) => { writes.push(item); store.set(item, secret); return true },
    access: (item, timeoutMs) => {
      accesses.push(item)
      const waiting = prompts.get(item)
      if (!waiting) return Promise.resolve(store.has(item) ? 'ok' : 'absent')
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiting.delete(answer); resolve('denied') }, timeoutMs)
        const answer = (r: KeychainAccess) => { clearTimeout(timer); resolve(r) }
        waiting.add(answer)
      })
    }
  }
  /** Answers every read waiting on an item's prompt, and lets later reads through. */
  const answer = (item: string, r: KeychainAccess) => {
    for (const resolve of prompts.get(item) ?? []) resolve(r)
    prompts.delete(item)
  }
  return {
    keychain, writes, between, accesses,
    /** An item's secret as JSON. */
    json: (item: string) => JSON.parse(store.get(item) ?? 'null'),
    set: (item: string, v: unknown) => store.set(item, typeof v === 'string' ? v : JSON.stringify(v)),
    /** Starts counting reads again, so `between` fires on the next pair. */
    reset: () => reads.clear(),
    /** From now on, reads of `item` wait on a macOS prompt. */
    prompt: (item: string) => { prompts.set(item, prompts.get(item) ?? new Set()) },
    /** Someone clicked Always Allow, or Deny. */
    allow: (item: string) => answer(item, 'ok'),
    deny: (item: string) => answer(item, 'denied')
  }
}
