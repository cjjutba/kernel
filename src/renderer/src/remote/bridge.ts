import type { Channel, KernelApi, PushEvent } from '@shared/ipc'
import type { AppSettings } from '@shared/types'

/*
 * The browser's `window.kernel` (remote-web-client). The app's own preload carries `invoke` and `on` over Electron's IPC; this
 * carries them over the one WebSocket Remote access serves (docs/decisions/remote-access-server.md): a call is
 * { id, channel, req } and is answered by { id, ok, res | error }, and a push is { event }. The renderer can't tell the two apart.
 *
 * What a bridge adds that IPC never needed: a call waits for the socket to open and fails with a plain sentence when the Mac
 * does not answer; a lost socket is opened again after a growing, jittered wait; and once it is back `onReconnect` runs, so the
 * app can load again what it missed while it was away (the store's `resync`).
 */

/** Where the link to the Mac stands. `unauthorized`: the token was revoked or ended, so the page has to pair again. */
export type LinkState = 'connecting' | 'open' | 'reconnecting' | 'unauthorized'

/** The part of a WebSocket the bridge uses, so a test can stand in for one. */
export interface SocketLike {
  readyState: number
  send(data: string): void
  close(code?: number): void
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number }) => void) | null
  onerror: ((e: unknown) => void) | null
}

export interface BridgeOptions {
  /** `ws://host:port/ws`. */
  url: string
  token: string
  /** Makes a socket. The browser's WebSocket by default. */
  open?: (url: string, protocols: string[]) => SocketLike
  /** Asks whether the token still works, once a socket failed before it opened. A browser can't read the status of a refused upgrade. */
  probe?: () => Promise<'ok' | 'unauthorized' | 'down'>
  /** How long a call may wait for its answer. */
  timeoutMs?: number
  /** The wait before the first retry, and the longest wait. Each is jittered down by up to half. */
  baseMs?: number
  maxMs?: number
  random?: () => number
  /** The socket is back after a loss, not on its first open. */
  onReconnect?: () => void
}

const OPEN = 1
export const TOKEN_KEY = 'kernel.remote.token'
const SUBPROTOCOL = 'kernel.v1'
/** The server closes a socket for a message over 1 MB. A call this big fails here, with a sentence, and keeps the socket. */
const MAX_MESSAGE_BYTES = 1024 * 1024 - 1024

/**
 * Channels the Mac refuses a device that the app still calls while it starts or runs. They answer here, so the page does not meet an
 * error for something that only makes sense in the Mac's window.
 */
const OK = { ok: true } as const
const LOCAL: Partial<{ [C in Channel]: (req: KernelApi[C]['req']) => KernelApi[C]['res'] }> = {
  'system.fixture': () => null,
  'system.zoomChanged': () => OK,
  'telemetry.track': () => OK,
  'notifications.playSound': () => OK,
  // A link opens in a tab of this browser, as long as it is a web page.
  'system.openExternal': ({ url }) => {
    if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
    return OK
  }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; message: string; sent: boolean }

export class Bridge {
  readonly remote = true as const
  appearance: AppSettings['appearance'] = browserAppearance()
  link: LinkState = 'connecting'
  private socket?: SocketLike
  private seq = 0
  private attempt = 0
  private everOpened = false
  private stopped = false
  private lastHeard = Date.now()
  private retry?: ReturnType<typeof setTimeout>
  private pending = new Map<string, Pending>()
  private listeners = new Set<(e: PushEvent) => void>()
  private watchers = new Set<() => void>()

  constructor(private readonly o: BridgeOptions) {
    this.connect()
  }

  invoke = <C extends Channel>(channel: C, req: KernelApi[C]['req']): Promise<KernelApi[C]['res']> => {
    const local = LOCAL[channel] as ((req: KernelApi[C]['req']) => KernelApi[C]['res']) | undefined
    if (local) return Promise.resolve(local(req))
    if (this.link === 'unauthorized' || this.stopped) return Promise.reject(new Error('This device is not paired any more.'))
    const id = String(++this.seq)
    const message = JSON.stringify({ id, channel, req })
    if (new TextEncoder().encode(message).length > MAX_MESSAGE_BYTES) return Promise.reject(new Error('That is too large to send from a browser. Try something smaller.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Kernel did not answer. Check that your Mac is awake and online.'))
        // A socket that has said nothing for the whole wait is half open, as after the phone slept. Closing it starts the retry.
        if (Date.now() - this.lastHeard >= (this.o.timeoutMs ?? 60_000)) this.socket?.close()
      }, this.o.timeoutMs ?? 60_000)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, message, sent: false })
      this.flush()
    })
  }

  on = (listener: (event: PushEvent) => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Called whenever `link` changes. Returns the way to stop. */
  watch(fn: () => void): () => void {
    this.watchers.add(fn)
    return () => { this.watchers.delete(fn) }
  }

  /** What a file's path on this device is: none, since a browser doesn't know it. */
  pathOf = (_file: File): string => ''

  /** Opens the socket now when it is closed, for a page that comes back to the front or a network that returns. */
  nudge() {
    if (this.stopped || this.link === 'unauthorized' || this.socket || !this.retry) return
    clearTimeout(this.retry)
    this.retry = undefined
    this.connect()
  }

  close() {
    this.stopped = true
    clearTimeout(this.retry)
    this.socket?.close(1000)
    this.socket = undefined
    this.failAll('The connection was closed.')
  }

  private set(link: LinkState) {
    if (this.link === link) return
    this.link = link
    for (const w of [...this.watchers]) w()
  }

  private connect() {
    this.retry = undefined
    if (this.stopped) return
    const open = this.o.open ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike)
    const ws = open(this.o.url, [SUBPROTOCOL, `kernel.token.${this.o.token}`])
    this.socket = ws
    let opened = false
    ws.onopen = () => {
      if (this.socket !== ws) return
      opened = true
      this.attempt = 0
      this.lastHeard = Date.now()
      const back = this.everOpened
      this.everOpened = true
      this.set('open')
      this.flush()
      if (back) this.o.onReconnect?.()
    }
    ws.onmessage = (e) => { if (this.socket === ws) this.receive(String(e.data)) }
    ws.onerror = () => undefined
    ws.onclose = (e) => {
      if (this.socket !== ws) return
      this.socket = undefined
      this.failSent('The connection to your Mac was lost. Try again.')
      if (this.stopped) return
      if (e.code === 4401) return this.unauthorized()
      // A refused upgrade and a Mac that is away look alike to a browser. Ask the server which it is.
      if (!opened && this.o.probe) void this.o.probe().then((r) => (r === 'unauthorized' ? this.unauthorized() : this.later()))
      else this.later()
    }
  }

  private later() {
    if (this.stopped || this.link === 'unauthorized') return
    this.set('reconnecting')
    const cap = Math.min(this.o.maxMs ?? 15_000, (this.o.baseMs ?? 500) * 2 ** this.attempt)
    this.attempt++
    this.retry = setTimeout(() => this.connect(), cap * (0.5 + 0.5 * (this.o.random ?? Math.random)()))
  }

  private unauthorized() {
    this.stopped = true
    this.set('unauthorized')
    this.failAll('This device is not paired any more.')
  }

  private receive(text: string) {
    this.lastHeard = Date.now()
    let msg: { id?: unknown; ok?: boolean; res?: unknown; error?: unknown; event?: PushEvent }
    try { msg = JSON.parse(text) } catch { return }
    if (msg.event) {
      for (const l of [...this.listeners]) l(msg.event)
      return
    }
    if (typeof msg.id !== 'string') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.res)
    else p.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Something went wrong'))
  }

  /** Sends what is waiting for an open socket. A call made while the socket was down goes out when it is back. */
  private flush() {
    if (this.socket?.readyState !== OPEN) return
    for (const p of this.pending.values()) {
      if (p.sent) continue
      p.sent = true
      this.socket.send(p.message)
    }
  }

  /** A call already sent may have run on the Mac, so it fails rather than going out twice. Calls not yet sent stay for the next socket. */
  private failSent(why: string) {
    for (const [id, p] of this.pending) {
      if (!p.sent) continue
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.reject(new Error(why))
    }
  }

  private failAll(why: string) {
    for (const [id, p] of this.pending) { this.pending.delete(id); clearTimeout(p.timer); p.reject(new Error(why)) }
  }
}

/** Settings, Appearance until the Mac's own settings arrive: what this browser asks for. */
export function browserAppearance(): AppSettings['appearance'] {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  return { theme: 'system', fontSize: 'default', density: 'comfortable', pointerCursors: false, reduceMotion: reduce }
}

/** Asks `/session` with the token, for `BridgeOptions.probe`. */
export const sessionProbe = (origin: string, token: string) => async (): Promise<'ok' | 'unauthorized' | 'down'> => {
  try {
    const r = await fetch(`${origin}/session`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
    return r.status === 401 ? 'unauthorized' : r.ok ? 'ok' : 'down'
  } catch {
    return 'down'
  }
}
