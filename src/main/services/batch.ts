/** How long output waits to go to the window with what comes after it: about 20 pushes a second for a chatty script or terminal (KERNEL-216). */
export const BATCH_MS = 50

/**
 * Collects items by key and hands each key's items over in order, together, once `BATCH_MS` has passed since the first
 * one waiting. `flush` hands a key's items over at once, for an exit that must come after the last of its output.
 */
export class Batcher<T> {
  private pending = new Map<string, T[]>()
  private timer?: NodeJS.Timeout

  constructor(private send: (key: string, items: T[]) => void, private ms = BATCH_MS) {}

  add(key: string, item: T) {
    const items = this.pending.get(key)
    if (items) items.push(item)
    else this.pending.set(key, [item])
    if (!this.timer) { this.timer = setTimeout(() => this.flushAll(), this.ms); this.timer.unref() }
  }

  flush(key: string) {
    const items = this.pending.get(key)
    if (!items) return
    this.pending.delete(key)
    this.send(key, items)
  }

  /** Forgets a key's items, as when what they would add to is replaced. */
  drop(key: string) { this.pending.delete(key) }

  flushAll() {
    clearTimeout(this.timer)
    this.timer = undefined
    for (const key of [...this.pending.keys()]) this.flush(key)
  }
}
