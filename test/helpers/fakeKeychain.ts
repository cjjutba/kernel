import type { Keychain } from '../../src/main/services/providers/claudeHome'

/**
 * The Mac's Keychain in memory, as Claude Code's items hold a login and its MCP sign-ins (KERNEL-616): each item's secret
 * by its name. `between` runs once after an item's first read and before the next, so a test can change the item between
 * Kernel's two reads, as a CLI refreshing a token would. Every write is kept, in order.
 */
export function fakeKeychain(items: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(items).map(([name, v]) => [name, typeof v === 'string' ? v : JSON.stringify(v)]))
  const writes: string[] = []
  const reads = new Map<string, number>()
  const between = new Map<string, () => void>()
  const keychain: Keychain = {
    read: (item) => {
      const n = (reads.get(item) ?? 0) + 1
      reads.set(item, n)
      if (n === 2) between.get(item)?.()
      return store.get(item)
    },
    write: (item, secret) => { writes.push(item); store.set(item, secret); return true }
  }
  return {
    keychain, writes, between,
    /** An item's secret as JSON. */
    json: (item: string) => JSON.parse(store.get(item) ?? 'null'),
    set: (item: string, v: unknown) => store.set(item, typeof v === 'string' ? v : JSON.stringify(v)),
    /** Starts counting reads again, so `between` fires on the next pair. */
    reset: () => reads.clear()
  }
}
