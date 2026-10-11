import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppUpdate } from '../src/shared/types'
import { bus } from '../src/main/bus'
import { blockedReason, parseNotes, Updater, type UpdateEngine, type UpdateInfo } from '../src/main/updater'
import { packagedClaude } from '../src/main/services/sessions'

/** Stands in for electron-updater's autoUpdater. `next` is what the following check emits. */
class FakeEngine extends EventEmitter implements UpdateEngine {
  autoDownload = false
  autoInstallOnAppQuit = false
  installs = 0
  next: (e: FakeEngine) => void = (e) => e.emit('update-not-available')
  async checkForUpdates() { this.emit('checking-for-update'); this.next(this) }
  quitAndInstall() { this.installs++ }
}

const notes = '### Checkpoints\nEvery turn saves the worktree.\n\n### Pause room\nFreeze every agent in a room.'
const info: UpdateInfo = { version: '0.2.0', releaseNotes: notes }
const download = (e: FakeEngine) => { e.emit('update-available', info); e.emit('download-progress', { percent: 41.6 }); e.emit('update-downloaded', info) }
const dir = () => mkdtemp(join(tmpdir(), 'kernel-update-'))
/** Updater writes update.json without waiting, so wait for the file to say `what`. A busy machine takes a while (KERNEL-187). */
const saved = (dataDir: string, what: object) => vi.waitFor(async () => expect(JSON.parse(await readFile(join(dataDir, 'update.json'), 'utf8'))).toMatchObject(what), { timeout: 10_000 })

describe('parseNotes', () => {
  it('reads markdown headings as titles and the text under them as the body', () => {
    expect(parseNotes(notes)).toEqual([
      { title: 'Checkpoints', body: 'Every turn saves the worktree.' },
      { title: 'Pause room', body: 'Freeze every agent in a room.' }
    ])
  })

  it('reads the HTML the GitHub feed sends', () => {
    const html = '<p>Intro.</p><h3>Big terminal</h3><p>Open Claude Code with &#39;⌘⇧T&#39; &amp; more.</p><h3>Overlap warnings</h3><ul><li>Rowan flags it.</li><li>Twice.</li></ul>'
    expect(parseNotes(html)).toEqual([
      { title: 'Big terminal', body: "Open Claude Code with '⌘⇧T' & more." },
      { title: 'Overlap warnings', body: 'Rowan flags it.\nTwice.' }
    ])
  })

  it('puts each list item on its own line and drops PR references and emphasis', () => {
    const md = '### Fixed\n- Fixed a stale PR status. (#44)\n- Fixed **two** things. (#45, #46)\n\n### Board\nA paragraph\nthat wraps.'
    expect(parseNotes(md)).toEqual([
      { title: 'Fixed', body: 'Fixed a stale PR status.\nFixed two things.' },
      { title: 'Board', body: 'A paragraph that wraps.' }
    ])
  })

  it('handles empty and per-version notes', () => {
    expect(parseNotes(null)).toEqual([])
    expect(parseNotes('No headings here.')).toEqual([])
    expect(parseNotes([{ version: '0.2.0', note: '## One\nA' }, { version: '0.1.1', note: null }])).toEqual([{ title: 'One', body: 'A' }])
  })
})

describe('Updater', () => {
  it('downloads in the background and reports ready with the notes', async () => {
    const engine = new FakeEngine()
    engine.next = download
    const pushed: AppUpdate[] = []
    const listen = (e: { type: string; update?: AppUpdate }) => { if (e.type === 'update' && e.update) pushed.push(e.update) }
    bus.on('push', listen)
    const u = new Updater({ current: '0.1.0', dataDir: await dir(), engine })
    expect(engine.autoDownload).toBe(true)
    const after = await u.check()
    bus.off('push', listen)
    expect(pushed.map((p) => p.status)).toEqual(['checking', 'downloading', 'downloading', 'ready'])
    expect(pushed[2].progress).toBe(42)
    expect(after).toMatchObject({ status: 'ready', current: '0.1.0', version: '0.2.0', notes: parseNotes(notes) })
    u.install()
    expect(engine.installs).toBe(1)
  })

  it('stays quiet when a check fails, and keeps a ready update through later checks', async () => {
    const engine = new FakeEngine()
    engine.next = (e) => e.emit('error', new Error('HttpError: 404'))
    const u = new Updater({ current: '0.1.0', dataDir: await dir(), engine })
    expect(await u.check()).toMatchObject({ status: 'idle', error: 'HttpError: 404' })
    expect(() => u.install()).toThrow('No update is ready')
    engine.next = (e) => e.emit('update-not-available')
    expect((await u.check()).error).toBeUndefined()
    engine.next = download
    await u.check()
    engine.next = (e) => e.emit('error', new Error('offline'))
    expect((await u.check()).status).toBe('ready')
  })

  it('shows What\'s new once after the update installs', async () => {
    const dataDir = await dir()
    const engine = new FakeEngine()
    engine.next = download
    const before = new Updater({ current: '0.1.0', dataDir, engine })
    await before.check()
    expect(before.get().installed).toBeUndefined()
    await saved(dataDir, { version: '0.2.0', shown: false })

    // Kernel restarts on 0.2.0.
    const after = new Updater({ current: '0.2.0', dataDir, engine: new FakeEngine() })
    expect(after.get()).toMatchObject({ installed: true, version: '0.2.0', notes: parseNotes(notes) })
    expect(after.get().installed).toBeUndefined()
    await saved(dataDir, { shown: true })
    expect(new Updater({ current: '0.2.0', dataDir, engine: new FakeEngine() }).get().installed).toBeUndefined()
  })

  it('carries the running version\'s notes from the build through every check (KERNEL-154)', async () => {
    const dataDir = await dir()
    const notesFile = join(dataDir, '0.1.1.md')
    await writeFile(notesFile, '### Fixed\n- Fixed a stale PR status.\n- Fixed the footer.')
    const current = [{ title: 'Fixed', body: 'Fixed a stale PR status.\nFixed the footer.' }]
    const engine = new FakeEngine()
    const u = new Updater({ current: '0.1.1', dataDir, engine, notesFile })
    expect(u.get()).toMatchObject({ status: 'idle', currentNotes: current })
    expect((await u.check()).currentNotes).toEqual(current)
    engine.next = (e) => e.emit('error', new Error('offline'))
    expect((await u.check()).currentNotes).toEqual(current)
    // A downloaded update brings its own notes and leaves the running version's alone.
    engine.next = download
    expect(await u.check()).toMatchObject({ status: 'ready', notes: parseNotes(notes), currentNotes: current })
  })

  it('falls back to the notes an update installed with, and only for that version', async () => {
    const dataDir = await dir()
    const engine = new FakeEngine()
    engine.next = download
    await new Updater({ current: '0.1.0', dataDir, engine }).check()
    await saved(dataDir, { version: '0.2.0' })
    const missing = join(dataDir, 'nope.md')
    expect(new Updater({ current: '0.2.0', dataDir, engine: new FakeEngine(), notesFile: missing }).get().currentNotes).toEqual(parseNotes(notes))
    expect(new Updater({ current: '0.1.0', dataDir, engine: new FakeEngine(), notesFile: missing }).get().currentNotes).toBeUndefined()
    expect(new Updater({ current: '0.1.0', dataDir: await dir(), engine: new FakeEngine() }).get().currentNotes).toBeUndefined()
  })

  it('does not show What\'s new when the downloaded update never installed', async () => {
    const dataDir = await dir()
    const engine = new FakeEngine()
    engine.next = download
    await new Updater({ current: '0.1.0', dataDir, engine }).check()
    await saved(dataDir, { version: '0.2.0' })
    expect(new Updater({ current: '0.1.0', dataDir, engine: new FakeEngine() }).get().installed).toBeUndefined()
  })
})

// KERNEL-443: a copy outside Applications can't replace itself, so it never checks and says why.
describe('Updater outside Applications', () => {
  it('says where it runs and how to fix it, and never asks GitHub', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const engine = new FakeEngine()
    const checks = vi.spyOn(engine, 'checkForUpdates')
    engine.next = download
    const u = new Updater({ current: '0.1.0', dataDir: await dir(), engine, outside: 'Downloads' })
    const blocked = 'Kernel is running from Downloads. Move it to Applications and open it from there.'
    expect(blockedReason('Downloads')).toBe(blocked)
    expect(u.get()).toMatchObject({ status: 'idle', blocked })
    u.start()
    expect(warn).toHaveBeenCalledWith(`[kernel] updates are off: ${blocked}`)
    expect(await u.check()).toMatchObject({ status: 'idle', blocked })
    expect(await u.readyWithin(5000)).toBeUndefined()
    expect(checks).not.toHaveBeenCalled()
    u.stop()
    warn.mockRestore()
  })

  it('checks as before in Applications', async () => {
    const engine = new FakeEngine()
    engine.next = download
    const u = new Updater({ current: '0.1.0', dataDir: await dir(), engine })
    expect(u.get().blocked).toBeUndefined()
    expect(await u.check()).toMatchObject({ status: 'ready', version: '0.2.0' })
  })
})

// KERNEL-408: a Kernel that could not start checks once and offers an update it finds.
describe('Updater.readyWithin after a failed start', () => {
  it('gives the version once the update downloads, and install runs', async () => {
    const engine = new FakeEngine()
    // The check answers first, and the download finishes later.
    engine.next = (e) => { e.emit('update-available', info); setTimeout(() => e.emit('update-downloaded', info), 20) }
    const u = new Updater({ current: '0.1.0', dataDir: await dir(), engine })
    expect(await u.readyWithin(5000)).toBe('0.2.0')
    u.install()
    expect(engine.installs).toBe(1)
  })

  it('gives nothing when there is no update', async () => {
    const u = new Updater({ current: '0.1.0', dataDir: await dir(), engine: new FakeEngine() })
    expect(await u.readyWithin(5000)).toBeUndefined()
  })

  it('gives nothing when the check fails or the download does', async () => {
    const offline = new FakeEngine()
    offline.next = (e) => e.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(await new Updater({ current: '0.1.0', dataDir: await dir(), engine: offline }).readyWithin(5000)).toBeUndefined()
    const rejects = new FakeEngine()
    rejects.checkForUpdates = async () => { throw new Error('HttpError: 404') }
    expect(await new Updater({ current: '0.1.0', dataDir: await dir(), engine: rejects }).readyWithin(5000)).toBeUndefined()
    const broken = new FakeEngine()
    broken.next = (e) => { e.emit('update-available', info); setTimeout(() => e.emit('error', new Error('sha512 checksum mismatch')), 20) }
    expect(await new Updater({ current: '0.1.0', dataDir: await dir(), engine: broken }).readyWithin(5000)).toBeUndefined()
  })

  it('stops waiting when the network is too slow', async () => {
    const slow = new FakeEngine()
    slow.checkForUpdates = () => new Promise(() => undefined)
    const started = Date.now()
    expect(await new Updater({ current: '0.1.0', dataDir: await dir(), engine: slow }).readyWithin(50)).toBeUndefined()
    const stuck = new FakeEngine()
    stuck.next = (e) => e.emit('update-available', info)
    expect(await new Updater({ current: '0.1.0', dataDir: await dir(), engine: stuck }).readyWithin(50)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('packagedClaude', () => {
  it('points at the unpacked SDK binary in a packaged app, and leaves the SDK to find its own otherwise', async () => {
    const resources = await dir()
    expect(packagedClaude(undefined)).toBeUndefined()
    expect(packagedClaude(resources)).toBeUndefined()
    const pkg = join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`)
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'claude'), '')
    expect(packagedClaude(resources)).toBe(join(pkg, 'claude'))
  })
})
