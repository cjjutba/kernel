import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { QUEUE_CAP } from '../src/main/features/telemetry'
import { batchBody, errorEvent } from '../src/main/services/telemetrySend'
import { diagnostics } from '../src/main/services/log'
import { freePort } from './helpers'

// KERNEL-397: usage data is opt-in. Kernel keeps a short list of events either way, and only a build with a key whose user
// said yes sends them, in batches, with nothing that names the user's work.
type Sent = { url: string; body: { api_key: string; batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[] } }

async function boot(o: { key?: boolean; privacy?: 'ask' | 'on' | 'off'; ok?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), privacy: { telemetry: o.privacy ?? 'ask' } }))
  const sent: Sent[] = []
  const state = { ok: o.ok ?? true }
  const fetch = (async (url: string, init: { body: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: state.ok } }) as unknown as typeof globalThis.fetch
  const k = new Kernel({ dataDir, home, version: '0.9.0', fetch, ...(o.key === false ? {} : { telemetry: { key: 'phc_test', host: 'https://us.i.posthog.com/', os: '15.4', arch: 'arm64' } }) })
  onTestFinished(() => k.stop())
  await k.start()
  const h = k.handlers()
  const settle = () => k.telemetry.send()
  return { k, h, dataDir, sent, state, settle }
}

describe('usage data (KERNEL-397)', () => {
  it('keeps events on the Mac and sends nothing until the user says yes', async () => {
    const { k, h, dataDir, sent, settle } = await boot({ privacy: 'ask' })
    bus.track({ name: 'pr.merged' })
    await settle()
    expect(sent).toEqual([])
    expect(existsSync(join(dataDir, 'telemetry-queue.json'))).toBe(false)
    expect((await h['telemetry.recent']()).map((r) => [r.event.name, r.sent])).toEqual([['pr.merged', false], ['app.started', false]])
    expect((await h['app.info']()).telemetry).toBe(true)
    expect(k.telemetry.on).toBe(false)
  })

  it('never sends from a build without a key, whatever the setting says', async () => {
    const { h, sent, settle } = await boot({ key: false, privacy: 'on' })
    bus.track({ name: 'pr.merged' })
    await settle()
    expect(sent).toEqual([])
    expect((await h['app.info']()).telemetry).toBe(false)
  })

  it('sends a batch once the user says yes, with the base and no person or location', async () => {
    const { h, dataDir, sent, settle } = await boot({ privacy: 'ask' })
    await h['settings.set']({ patch: { privacy: { telemetry: 'on' } } })
    bus.track({ name: 'handoff.refused', reason: 'helper' })
    await settle()
    expect(sent.at(-1)!.url).toBe('https://us.i.posthog.com/batch/')
    const batch = sent.flatMap((s) => s.body.batch)
    expect(batch.map((e) => e.event)).toEqual(['handoff.refused'])
    expect(batch[0].properties).toEqual({ reason: 'helper', app_version: '0.9.0', os_version: '15.4', arch: 'arm64', $process_person_profile: false, $geoip_disable: true })
    expect(sent[0].body.api_key).toBe('phc_test')
    const id = JSON.parse(await readFile(join(dataDir, 'telemetry.json'), 'utf8')).installId
    expect(batch[0].distinct_id).toBe(id)
    expect((await h['telemetry.recent']())[0]).toMatchObject({ event: { name: 'handoff.refused' }, sent: true })
  })

  it('keeps what failed to go out, up to a cap, and deletes it all when turned off', async () => {
    const { h, dataDir, sent, state, settle } = await boot({ privacy: 'on', ok: false })
    for (let i = 0; i < QUEUE_CAP + 5; i++) bus.track({ name: 'pr.merged' })
    await settle()
    expect(sent.length).toBeGreaterThan(0)
    const queued = JSON.parse(await readFile(join(dataDir, 'telemetry-queue.json'), 'utf8'))
    expect(queued).toHaveLength(QUEUE_CAP)
    state.ok = true
    await settle()
    expect(JSON.parse(await readFile(join(dataDir, 'telemetry-queue.json'), 'utf8'))).toEqual([])
    await h['settings.set']({ patch: { privacy: { telemetry: 'off' } } })
    expect(existsSync(join(dataDir, 'telemetry-queue.json'))).toBe(false)
    expect(existsSync(join(dataDir, 'telemetry.json'))).toBe(false)
  })

  it('refuses an event that breaks the rules', async () => {
    const { h } = await boot()
    await expect(h['telemetry.track']({ event: { name: 'setup.team_review', choice: 'kept' } })).resolves.toEqual({ ok: true })
    await expect(h['telemetry.track']({ event: { name: 'setup.team_review', choice: '/Users/cj/shop' } as never })).rejects.toThrow(/can't keep that event/)
  })

  it('names an error by its class and its line in the bundle, never its message or path', () => {
    const err = new TypeError('Cannot read /Users/cj/Projects/client/secret.ts')
    err.stack = `TypeError: Cannot read /Users/cj/Projects/client/secret.ts\n    at Team.resolve (/Applications/Kernel.app/Contents/Resources/app.asar/out/main/index.js:4021:17)\n    at /Users/cj/x.js:1:1`
    expect(errorEvent('exception', err)).toEqual({ name: 'app.error', kind: 'exception', errorClass: 'TypeError', frame: 'index.js:4021:17' })
    expect(errorEvent('rejection', 'just a string /Users/cj')).toEqual({ name: 'app.error', kind: 'rejection', errorClass: 'Error', frame: 'unknown' })
    expect(JSON.stringify(batchBody({ key: 'k', installId: 'i', base: { app: '1', os: '15', arch: 'arm64' }, events: [{ event: errorEvent('exception', err), at: 0 }] }))).not.toContain('/Users')
  })

  it('puts the latest events in Copy diagnostics', async () => {
    const text = await diagnostics({ app: '0.9.0', macos: '15.4', arch: 'arm64', electron: '38', run: async () => ({ code: 1, stdout: '', stderr: '' }), claude: null, events: ['2026-10-11T00:00:00.000Z kept {"name":"pr.merged"}'] })
    expect(text).toContain('Usage events, newest first. "sent" left this Mac, "kept" stayed:\n2026-10-11T00:00:00.000Z kept {"name":"pr.merged"}')
  })
})
