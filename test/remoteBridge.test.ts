import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PushEvent } from '../src/shared/ipc'
import { Bridge, type LinkState, type SocketLike } from '../src/renderer/src/remote/bridge'
import { deviceName, pairCode } from '../src/renderer/src/remote/pairing'

// remote-web-client: the browser's window.kernel over the WebSocket, with a fake socket standing in for the browser's.

class FakeSocket implements SocketLike {
  readyState = 0
  sent: { id: string; channel: string; req: unknown }[] = []
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  constructor(readonly url: string, readonly protocols: string[]) {}
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close(code = 1000) { this.drop(code) }
  open() { this.readyState = 1; this.onopen?.({}) }
  say(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }) }
}

let sockets: FakeSocket[]
let bridges: Bridge[]
const make = (o: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) => {
  const b = new Bridge({ url: 'ws://mac/ws', token: 'tok', open: (u, p) => { const s = new FakeSocket(u, p); sockets.push(s); return s }, random: () => 1, ...o })
  bridges.push(b)
  return b
}
const last = () => sockets[sockets.length - 1]

beforeEach(() => { vi.useFakeTimers(); sockets = []; bridges = [] })
afterEach(() => { for (const b of bridges) b.close(); vi.useRealTimers() })

describe('browser bridge', () => {
  it('offers the token as a subprotocol, never in the URL', () => {
    make()
    expect(last().protocols).toEqual(['kernel.v1', 'kernel.token.tok'])
    expect(last().url).toBe('ws://mac/ws')
  })

  it('sends a call once the socket is open and resolves with its answer, whatever the order', async () => {
    const b = make()
    const a = b.invoke('projects.list', undefined)
    const c = b.invoke('usage.get', undefined)
    expect(last().sent).toEqual([])
    last().open()
    expect(last().sent.map((m) => m.channel)).toEqual(['projects.list', 'usage.get'])
    const [first, second] = last().sent
    last().say({ id: second.id, ok: true, res: ['usage'] })
    last().say({ id: first.id, ok: true, res: ['projects'] })
    expect(await a).toEqual(['projects'])
    expect(await c).toEqual(['usage'])
  })

  it('rejects with the error the Mac sent', async () => {
    const b = make()
    last().open()
    const p = b.invoke('settings.set' as 'settings.get', undefined)
    last().say({ id: last().sent[0].id, ok: false, error: 'settings.set is not available from another device' })
    await expect(p).rejects.toThrow('not available from another device')
  })

  it('fails a call the Mac never answers, and says so plainly', async () => {
    const b = make({ timeoutMs: 1000 })
    last().open()
    const p = b.invoke('projects.list', undefined)
    const caught = p.catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await caught).toMatch(/did not answer/)
  })

  it('treats a socket that said nothing for the whole wait as half open and opens a new one', async () => {
    const b = make({ timeoutMs: 1000, baseMs: 100 })
    last().open()
    const caught = b.invoke('projects.list', undefined).catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(1001)
    await caught
    expect(b.link).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(200)
    expect(sockets).toHaveLength(2)
  })

  it('refuses a message too big for the server without sending it', async () => {
    const b = make()
    last().open()
    await expect(b.invoke('chats.send', { chatId: 'c', parts: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] } as never)).rejects.toThrow(/too large/)
    expect(last().sent).toEqual([])
  })

  it('hands pushes to every listener until it is removed', () => {
    const b = make()
    last().open()
    const seen: PushEvent[] = []
    const off = b.on((e) => seen.push(e))
    const event = { type: 'toast', toast: { title: 'Hi' } } as PushEvent
    last().say({ event })
    off()
    last().say({ event })
    expect(seen).toEqual([event])
  })

  it('answers what only the Mac can do without asking it', async () => {
    const b = make()
    expect(await b.invoke('system.fixture', undefined)).toBeNull()
    expect(sockets[0].sent).toEqual([])
    expect(b.pathOf(new File([''], 'a.txt'))).toBe('')
  })

  describe('losing the connection', () => {
    it('reconnects with a growing, capped wait, shows Reconnecting, and calls onReconnect once it is back', async () => {
      const onReconnect = vi.fn()
      const states: LinkState[] = []
      const b = make({ baseMs: 100, maxMs: 400, onReconnect })
      b.watch(() => states.push(b.link))
      last().open()
      expect(onReconnect).not.toHaveBeenCalled()
      last().drop(1006)
      expect(b.link).toBe('reconnecting')
      // random() is 1, so the wait is the full step: 100, 200, 400, then capped at 400.
      await vi.advanceTimersByTimeAsync(99)
      expect(sockets).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(2)
      last().drop(1006)
      await vi.advanceTimersByTimeAsync(199)
      expect(sockets).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(3)
      last().drop(1006)
      await vi.advanceTimersByTimeAsync(400)
      expect(sockets).toHaveLength(4)
      last().drop(1006)
      await vi.advanceTimersByTimeAsync(399)
      expect(sockets).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(5)
      last().open()
      expect(b.link).toBe('open')
      expect(onReconnect).toHaveBeenCalledTimes(1)
      expect(states).toEqual(['open', 'reconnecting', 'open'])
    })

    it('jitters the wait down by up to half', async () => {
      const b = make({ baseMs: 1000, random: () => 0 })
      last().open()
      last().drop(1006)
      await vi.advanceTimersByTimeAsync(499)
      expect(sockets).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(2)
      expect(b.link).toBe('reconnecting')
    })

    it('fails a call that was sent, keeps one that was not, and sends that one on the new socket', async () => {
      const b = make({ baseMs: 100 })
      last().open()
      const sent = b.invoke('projects.list', undefined).catch((e: Error) => e.message)
      last().drop(1006)
      expect(await sent).toMatch(/connection to your Mac was lost/)
      const waiting = b.invoke('usage.get', undefined)
      await vi.advanceTimersByTimeAsync(100)
      last().open()
      expect(last().sent.map((m) => m.channel)).toEqual(['usage.get'])
      last().say({ id: last().sent[0].id, ok: true, res: 'u' })
      expect(await waiting).toBe('u')
    })

    it('retries at once when nudged, as when the phone comes back to the front', async () => {
      const b = make({ baseMs: 60_000 })
      last().open()
      last().drop(1006)
      b.nudge()
      expect(sockets).toHaveLength(2)
    })
  })

  describe('a token the Mac no longer accepts', () => {
    it('stops at close code 4401, fails what was sent and refuses new calls', async () => {
      const b = make()
      last().open()
      const waiting = b.invoke('projects.list', undefined).catch((e: Error) => e.message)
      last().drop(4401)
      expect(b.link).toBe('unauthorized')
      expect(await waiting).toMatch(/lost|not paired/)
      await expect(b.invoke('usage.get', undefined)).rejects.toThrow(/not paired/)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets).toHaveLength(1)
    })

    it('asks the server why when the socket fails before it opens, and stops when the answer is 401', async () => {
      const probe = vi.fn().mockResolvedValue('unauthorized')
      const b = make({ probe })
      last().drop(1006)
      await vi.advanceTimersByTimeAsync(0)
      expect(probe).toHaveBeenCalledTimes(1)
      expect(b.link).toBe('unauthorized')
    })

    it('keeps trying when the server is only out of reach', async () => {
      const probe = vi.fn().mockResolvedValue('down')
      const b = make({ probe, baseMs: 100 })
      last().drop(1006)
      await vi.advanceTimersByTimeAsync(0)
      expect(b.link).toBe('reconnecting')
      await vi.advanceTimersByTimeAsync(100)
      expect(sockets).toHaveLength(2)
    })
  })
})

describe('pairing helpers', () => {
  it('reads the code from the hash and nothing else', () => {
    expect(pairCode('#pair=abc_DEF-123')).toBe('abc_DEF-123')
    expect(pairCode('#pair=')).toBeUndefined()
    expect(pairCode('#/dev/ui')).toBeUndefined()
    expect(pairCode('#pair=a&x=1')).toBeUndefined()
  })

  it('names a device from its browser', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iPhone Safari')
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36')).toBe('Mac Chrome')
  })
})
