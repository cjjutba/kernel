// Browser stand-in for node:events: the small part of EventEmitter the bus uses.
type Fn = (...args: unknown[]) => void
export class EventEmitter {
  private map = new Map<string | symbol, Set<Fn>>()
  on(e: string | symbol, f: Fn): this { (this.map.get(e) ?? this.map.set(e, new Set()).get(e)!).add(f); return this }
  addListener(e: string | symbol, f: Fn): this { return this.on(e, f) }
  once(e: string | symbol, f: Fn): this { const w: Fn = (...a) => { this.off(e, w); f(...a) }; return this.on(e, w) }
  off(e: string | symbol, f: Fn): this { this.map.get(e)?.delete(f); return this }
  removeListener(e: string | symbol, f: Fn): this { return this.off(e, f) }
  removeAllListeners(e?: string | symbol): this { if (e === undefined) this.map.clear(); else this.map.delete(e); return this }
  emit(e: string | symbol, ...args: unknown[]): boolean { const s = this.map.get(e); s?.forEach((f) => f(...args)); return !!s?.size }
  setMaxListeners(): this { return this }
  listenerCount(e: string | symbol): number { return this.map.get(e)?.size ?? 0 }
}
export default EventEmitter
