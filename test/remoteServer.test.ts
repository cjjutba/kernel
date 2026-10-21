import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { createServer, type Server } from 'node:net'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Kernel } from '../src/main/kernel'
import { PAIR_CODE_MS, RemoteAuth } from '../src/main/services/remoteAuth'
import { REFUSED_CHANNELS } from '../src/main/services/remoteChannels'
import { MAX_MESSAGE_BYTES } from '../src/main/services/remoteServer'
import { freePort, tempRepo } from './helpers'

// remote-access-server: another device pairs with Kernel and drives it over a WebSocket, through the same handlers the window uses.

const stops: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop() })

async function boot(remote: { enabled?: boolean; host?: 'local' | 'network'; port?: number } = { enabled: true }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  const port = remote.port ?? await freePort()
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), remote: { port, ...remote } }))
  const k = new Kernel({ dataDir, home })
  stops.push(() => k.stop({ budgetMs: 0 }))
  await k.start()
  await k.remote.settled
  const h = k.handlers()
  const base = () => `http://127.0.0.1:${k.remote.status().port}`
  return { k, h, port, dataDir, base }
}
type Booted = Awaited<ReturnType<typeof boot>>

/** The code in a pairing URL, as the browser client reads it from the hash. */
const codeOf = (url: string) => new URL(url).hash.slice('#pair='.length)

const postPair = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

/** Pairs a device the way the browser does and returns its token. */
async function pairDevice({ h, base }: Booted, name = 'Phone') {
  const { url } = await h['remote.pair']()
  const r = await postPair(base(), { code: codeOf(url), name })
  expect(r.status).toBe(200)
  return (await r.json()) as { token: string; deviceId: string; name: string; expiresAt: number }
}

/** A socket that is open, or an error naming the HTTP status the upgrade got. */
const open = (url: string, opts: ConstructorParameters<typeof WebSocket>[2] = {}) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url, opts)
  stops.push(() => ws.terminate())
  ws.once('open', () => resolve(ws))
  ws.once('unexpected-response', (_q, res) => reject(new Error(String(res.statusCode))))
  ws.once('error', reject)
})

/** A client over an open socket: `call` waits for its own answer, `events` fills as pushes arrive. */
function client(ws: WebSocket) {
  const events: unknown[] = []
  const waiting = new Map<string, (m: Record<string, unknown>) => void>()
  let n = 0
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString()) as Record<string, unknown>
    if ('event' in m) events.push(m.event)
    else waiting.get(String(m.id))?.(m)
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  const call = (channel: unknown, req?: unknown, id: string = `c${++n}`) => new Promise<Record<string, unknown>>((resolve) => {
    waiting.set(id, resolve)
    ws.send(JSON.stringify({ id, channel, req }))
  })
  return { call, events, closed }
}

const connect = async (b: Booted, token: string) => client(await open(`${b.base().replace('http', 'ws')}/ws`, { headers: { authorization: `Bearer ${token}` } }))

describe('remote access server (remote-access-server)', () => {
  it('is off until it is turned on, and Kernel listens for nothing', async () => {
    const b = await boot({ enabled: false })
    expect(b.h['remote.status']).toBeTypeOf('function')
    expect(await b.h['remote.status']()).toEqual({ enabled: false, running: false })
    await expect(b.h['remote.pair']()).rejects.toThrow('Turn on Remote access first')
    await expect(fetch(`http://127.0.0.1:${b.port}/`)).rejects.toThrow()
  })

  it('listens on this Mac only by default and serves the placeholder page', async () => {
    const b = await boot()
    const s = await b.h['remote.status']()
    expect(s).toMatchObject({ enabled: true, running: true, host: '127.0.0.1', port: b.port, url: `http://127.0.0.1:${b.port}` })
    const page = await fetch(`${s.url}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('web client is coming')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect((await fetch(`${s.url}/nope`)).status).toBe(404)
  })

  describe('pairing', () => {
    it('exchanges a code for a token once, and refuses it a second time', async () => {
      const b = await boot()
      const { url, qr, expiresAt } = await b.h['remote.pair']()
      expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${b.port}/#pair=[A-Za-z0-9_-]{27}$`))
      expect(qr).toContain('<svg')
      expect(expiresAt - Date.now()).toBeGreaterThan(PAIR_CODE_MS - 5000)
      const first = await postPair(b.base(), { code: codeOf(url), name: 'Sam’s iPhone' })
      expect(first.status).toBe(200)
      const got = (await first.json()) as { token: string; name: string }
      expect(got.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(got.name).toBe('Sam’s iPhone')
      const again = await postPair(b.base(), { code: codeOf(url) })
      expect(again.status).toBe(401)
      expect(JSON.stringify(await again.json())).not.toContain(got.token)
    })

    it('keeps only a hash of the token', async () => {
      const b = await boot()
      const { token, deviceId } = await pairDevice(b)
      const row = b.k.store.db.prepare('select * from remote_devices where id = ?').get(deviceId) as Record<string, unknown>
      expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'))
      expect(Object.values(row)).not.toContain(token)
      const [listed] = await b.h['remote.devices']()
      expect(listed).toMatchObject({ id: deviceId, name: 'Phone', connected: false })
      expect(listed).not.toHaveProperty('tokenHash')
      expect(listed.expiresAt - listed.createdAt).toBe(30 * 24 * 3600_000)
    })

    it('expires a code after 5 minutes and a session after 30 days', async () => {
      const store = new Store(':memory:')
      let now = 1_000_000
      const auth = new RemoteAuth(store, () => now)
      const { code } = auth.newCode()
      now += PAIR_CODE_MS
      expect(auth.pair(code, 'Late', 'a')).toMatchObject({ ok: false, status: 401 })
      const fresh = auth.newCode()
      const paired = auth.pair(fresh.code, 'Phone', 'a')
      expect(paired.ok).toBe(true)
      if (!paired.ok) return
      expect(auth.verify(paired.token)?.name).toBe('Phone')
      now += 30 * 24 * 3600_000
      expect(auth.verify(paired.token)).toBeUndefined()
      expect(auth.devices()).toEqual([])
    })

    it('makes each code different and drops the oldest past five open', () => {
      const store = new Store(':memory:')
      const auth = new RemoteAuth(store)
      const codes = Array.from({ length: 6 }, () => auth.newCode().code)
      expect(new Set(codes).size).toBe(6)
      expect(auth.pair(codes[0], 'x', 'a')).toMatchObject({ ok: false, status: 401 })
      expect(auth.pair(codes[5], 'x', 'a').ok).toBe(true)
    })

    it('limits failed attempts from one address, then says when to try again', async () => {
      const b = await boot()
      const { url } = await b.h['remote.pair']()
      for (let i = 0; i < 5; i++) expect((await postPair(b.base(), { code: `wrong-${i}` })).status).toBe(401)
      const blocked = await postPair(b.base(), { code: codeOf(url) })
      expect(blocked.status).toBe(429)
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
      // The blocked try pairs nothing.
      expect(b.k.store.remoteDevices()).toEqual([])
    })

    it('takes only a small JSON object', async () => {
      const b = await boot()
      expect((await postPair(b.base(), { code: 'x' }, { 'content-type': 'text/plain' })).status).toBe(415)
      expect((await postPair(b.base(), 'not json')).status).toBe(400)
      expect((await postPair(b.base(), '[1]')).status).toBe(400)
      expect((await postPair(b.base(), { code: 'x'.repeat(10_000) })).status).toBe(413)
      expect((await fetch(`${b.base()}/pair`)).status).toBe(405)
    })

    it('names a device with printable text of at most 60 characters', async () => {
      const b = await boot()
      const { url } = await b.h['remote.pair']()
      const r = await postPair(b.base(), { code: codeOf(url), name: `  Pixel\n\u0007 ${'x'.repeat(100)}` })
      const { name } = (await r.json()) as { name: string }
      expect(name).toHaveLength(60)
      expect(name.startsWith('Pixel x')).toBe(true)
    })
  })

  describe('the socket', () => {
    it('refuses a connection with no token, a wrong token and a revoked one', async () => {
      const b = await boot()
      const ws = `${b.base().replace('http', 'ws')}/ws`
      await expect(open(ws)).rejects.toThrow('401')
      await expect(open(ws, { headers: { authorization: 'Bearer nope' } })).rejects.toThrow('401')
      await expect(open(`${ws}?token=nope`)).rejects.toThrow('401')
      const { token, deviceId } = await pairDevice(b)
      await b.h['remote.revoke']({ id: deviceId })
      await expect(open(ws, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow('401')
      await expect(open(`${b.base().replace('http', 'ws')}/elsewhere`, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow('404')
    })

    it('takes the token from a header or from the query a browser sends', async () => {
      const b = await boot()
      const { token } = await pairDevice(b)
      const viaHeader = await connect(b, token)
      expect((await viaHeader.call('settings.get')).ok).toBe(true)
      const viaQuery = client(await open(`${b.base().replace('http', 'ws')}/ws?token=${token}`))
      expect((await viaQuery.call('settings.get')).ok).toBe(true)
    })

    it('answers a channel as the window would, with the same result', async () => {
      const b = await boot()
      const project = await b.k.projects.addProject(await tempRepo())
      const { token } = await pairDevice(b)
      const c = await connect(b, token)
      const viaSocket = await c.call('projects.list', undefined, 'list-1')
      expect(viaSocket).toEqual({ id: 'list-1', ok: true, res: JSON.parse(JSON.stringify(await b.h['projects.list']())) })
      expect((viaSocket.res as { id: string }[]).map((p) => p.id)).toEqual([project.id])
      // A call with arguments, and a handler that throws: the error text comes back as the reason.
      expect((await c.call('projects.inspectFolder', { path: project.path })).ok).toBe(true)
      expect(await c.call('workspaces.gitStatus', { workspaceId: 'missing' })).toMatchObject({ ok: false, error: expect.any(String) })
    })

    it('pushes every event to a connected device', async () => {
      const b = await boot()
      const c = await connect(b, (await pairDevice(b)).token)
      const [listed] = await b.h['remote.devices']()
      expect(listed.connected).toBe(true)
      bus.push({ type: 'toast', toast: { title: 'Hello from the Mac' } })
      await expect.poll(() => c.events).toEqual([{ type: 'toast', toast: { title: 'Hello from the Mac' } }])
    })

    it('refuses system channels, channels that open things on the Mac, and its own', async () => {
      const b = await boot()
      const c = await connect(b, (await pairDevice(b)).token)
      for (const channel of ['system.pickFolder', 'system.openExternal', 'app.openTerminal', 'app.openIn', 'shared.reveal', 'env.reveal', 'terminal.write', 'hooks.install', 'remote.pair', 'remote.devices', 'remote.revoke', 'remote.status']) {
        expect(await c.call(channel, {}), channel).toMatchObject({ ok: false, error: expect.stringMatching(/not available from another device|belongs to the app/) })
      }
      expect(await b.h['remote.devices']()).toHaveLength(1)
    })

    it('refuses a settings change that moves the server or the hook port', async () => {
      const b = await boot()
      const c = await connect(b, (await pairDevice(b)).token)
      expect(await c.call('settings.set', { patch: { remote: { host: 'network' } } })).toMatchObject({ ok: false, error: expect.stringContaining('only be changed in the app') })
      expect(await c.call('settings.set', { patch: { hookPort: 9 } })).toMatchObject({ ok: false })
      expect((await c.call('settings.set', { patch: { general: { sendWith: 'cmdEnter' } } })).ok).toBe(true)
      expect(b.k.settings.remote.host).toBe('local')
      expect(b.k.settings.general.sendWith).toBe('cmdEnter')
    })

    it('names only channels that exist in its refusal list', async () => {
      const b = await boot()
      const known = new Set(Object.keys(b.h))
      expect(REFUSED_CHANNELS.filter((c) => !known.has(c))).toEqual([])
    })

    it('refuses an unknown channel, a missing id, a binary frame and text that is not JSON', async () => {
      const b = await boot()
      const ws = await open(`${b.base().replace('http', 'ws')}/ws`, { headers: { authorization: `Bearer ${(await pairDevice(b)).token}` } })
      const c = client(ws)
      for (const name of ['constructor', '__proto__', 'toString', 'no.such']) {
        expect(await c.call(name), name).toMatchObject({ ok: false, error: expect.stringContaining('Unknown channel') })
      }
      for (const name of [7, null]) expect(await c.call(name), String(name)).toMatchObject({ ok: false, error: expect.stringContaining('needs a channel') })
      const answers: Record<string, unknown>[] = []
      ws.on('message', (d) => answers.push(JSON.parse(d.toString())))
      ws.send(JSON.stringify({ channel: 'settings.get' }))
      ws.send('not json')
      ws.send(JSON.stringify([1]))
      ws.send(Buffer.from([1, 2, 3]))
      await expect.poll(() => answers.length).toBe(4)
      expect(answers.every((a) => a.ok === false && a.id === null)).toBe(true)
    })

    it('closes a socket that sends more than 1 MB', async () => {
      const b = await boot()
      const other = await connect(b, (await pairDevice(b)).token)
      const ws = await open(`${b.base().replace('http', 'ws')}/ws`, { headers: { authorization: `Bearer ${(await pairDevice(b, 'Tablet')).token}` } })
      const closed = client(ws).closed
      ws.send(JSON.stringify({ id: 'big', channel: 'settings.get', req: 'x'.repeat(MAX_MESSAGE_BYTES) }))
      // 1009 is what the server sends. A client still writing the rest of the message can see the reset first, as 1006.
      expect([1009, 1006]).toContain((await closed).code)
      expect((await other.call('settings.get')).ok).toBe(true)
    })

    it('closes a socket whose 30 days ended while it sat idle, at the next push', async () => {
      const b = await boot()
      const c = await connect(b, (await pairDevice(b)).token)
      vi.useFakeTimers({ toFake: ['Date'] })
      stops.push(() => vi.useRealTimers())
      vi.setSystemTime(Date.now() + 31 * 24 * 3600_000)
      bus.push({ type: 'toast', toast: { title: 'Too late' } })
      expect(await c.closed).toMatchObject({ code: 4401 })
      expect(c.events).toEqual([])
    })

    it('closes the socket of a revoked device at once', async () => {
      const b = await boot()
      const { token, deviceId } = await pairDevice(b)
      const c = await connect(b, token)
      await b.h['remote.revoke']({ id: deviceId })
      expect(await c.closed).toMatchObject({ code: 4401 })
      expect(await b.h['remote.devices']()).toEqual([])
      await expect(b.h['remote.revoke']({ id: deviceId })).rejects.toThrow('not paired')
    })
  })

  describe('where it accepts calls from', () => {
    it('refuses a page from another origin and a Host that is not this server', async () => {
      const b = await boot()
      const { token } = await pairDevice(b)
      const url = `${b.base().replace('http', 'ws')}/ws`
      await expect(open(url, { headers: { authorization: `Bearer ${token}` }, origin: 'http://evil.example' })).rejects.toThrow('403')
      await expect(open(url, { headers: { authorization: `Bearer ${token}` }, origin: `http://127.0.0.1:${b.port}` })).resolves.toBeDefined()
      expect((await postPair(b.base(), { code: 'x' }, { origin: 'http://evil.example' })).status).toBe(403)
      // A DNS rebinding page keeps its own name in Host, which a local-only server doesn't answer to.
      const status = await new Promise<number>((resolve, reject) => {
        request({ host: '127.0.0.1', port: b.port, path: '/', headers: { host: `rebind.example:${b.port}` } }, (res) => { res.resume(); resolve(res.statusCode!) }).on('error', reject).end()
      })
      expect(status).toBe(403)
    })

    it('answers any Host when it listens for the network, and says the Mac\'s address in the pairing URL', async () => {
      const b = await boot({ enabled: true, host: 'network' })
      b.k.remote.lanAddress = () => '192.168.1.20'
      expect(await b.h['remote.status']()).toMatchObject({ running: true, host: '0.0.0.0', url: `http://192.168.1.20:${b.port}` })
      expect((await b.h['remote.pair']()).url).toContain(`http://192.168.1.20:${b.port}/#pair=`)
      const status = await new Promise<number>((resolve, reject) => {
        request({ host: '127.0.0.1', port: b.port, path: '/', headers: { host: `mac.local:${b.port}` } }, (res) => { res.resume(); resolve(res.statusCode!) }).on('error', reject).end()
      })
      expect(status).toBe(200)
    })
  })

  describe('start and stop', () => {
    it('follows the setting, and every pairing code ends with the server', async () => {
      const b = await boot({ enabled: false })
      expect((await b.h['remote.status']()).running).toBe(false)
      await b.h['settings.set']({ patch: { remote: { enabled: true } } })
      const { url } = await b.h['remote.pair']()
      // No kept-alive connection, which the restart below would reset.
      expect((await fetch(`http://127.0.0.1:${b.port}/`, { headers: { connection: 'close' } })).status).toBe(200)
      await b.h['settings.set']({ patch: { remote: { host: 'network' } } })
      expect((await postPair(`http://127.0.0.1:${b.port}`, { code: codeOf(url) })).status).toBe(401)
      await b.h['settings.set']({ patch: { remote: { enabled: false } } })
      expect(await b.h['remote.status']()).toEqual({ enabled: false, running: false })
      await expect(fetch(`http://127.0.0.1:${b.port}/`)).rejects.toThrow()
    })

    it('keeps a valid port and falls back on a bad value', async () => {
      const b = await boot({ enabled: false })
      await b.h['settings.set']({ patch: { remote: { port: 80, host: 'everywhere' as never, enabled: 'yes' as never } } })
      expect(b.k.settings.remote).toEqual({ enabled: false, host: 'local', port: b.port })
    })

    it('takes the next port when its own is busy, and reports the one it got', async () => {
      const port = await freePort()
      const busy: Server = createServer()
      await new Promise<void>((r) => busy.listen(port, '127.0.0.1', r))
      stops.push(() => new Promise((r) => busy.close(r)))
      const b = await boot({ enabled: true, port })
      const s = await b.h['remote.status']()
      expect(s.running).toBe(true)
      expect(s.port).toBeGreaterThan(port)
      expect((await fetch(`${s.url}/`)).status).toBe(200)
    })

    it('says why it could not start, and Kernel carries on', async () => {
      const b = await boot({ enabled: false })
      // Every port it tries is taken, so it reports instead of throwing at the setting that asked.
      const busy: Server[] = []
      for (let p = b.port; p < b.port + 20; p++) {
        const s = createServer()
        try { await new Promise<void>((r, j) => { s.once('error', j); s.listen(p, '127.0.0.1', r) }) } catch { continue }
        busy.push(s)
      }
      stops.push(() => Promise.all(busy.map((s) => new Promise((r) => s.close(r)))))
      await b.h['settings.set']({ patch: { remote: { enabled: true } } })
      const s = await b.h['remote.status']()
      expect(s).toMatchObject({ enabled: true, running: false, error: expect.stringContaining('No free port') })
    })

    it('stops with the Kernel and closes the open sockets', async () => {
      const b = await boot()
      const c = await connect(b, (await pairDevice(b)).token)
      const url = b.base()
      await b.k.stop({ budgetMs: 0 })
      expect((await c.closed).code).toBe(1001)
      await expect(fetch(`${url}/`)).rejects.toThrow()
    })
  })
})
