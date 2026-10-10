import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { MAX_LINE, pipeLines, runScript, stopAllScripts, stopScript } from '../src/main/services/scripts'
import { loadRepoSettings, saveRepoSettings } from '../src/main/services/settings'
import { isWebUrl, localUrlIn, resolvePreviewUrl } from '../src/shared/previewUrl'
import type { PushEvent } from '../src/shared/ipc'

process.env.SHELL = '/bin/sh'

const events: PushEvent[] = []
bus.on('push', (e: PushEvent) => { if (e.type === 'script.output' || e.type === 'script.exit' || e.type === 'script.url') events.push(e) })
afterEach(() => { stopAllScripts(); events.length = 0 })

const until = async (ok: () => boolean, what: string, ms = 15000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const urls = (workspaceId: string, name = 'run') => events.flatMap((e) => (e.type === 'script.url' && e.workspaceId === workspaceId && e.name === name ? [e.url] : []))
const tick = () => new Promise((r) => setImmediate(r))
const lines = (workspaceId: string) => events.flatMap((e) => (e.type === 'script.output' && e.workspaceId === workspaceId ? [e.line] : []))
const exits = (workspaceId: string) => events.filter((e) => e.type === 'script.exit' && e.workspaceId === workspaceId).length

/** Vite 5's banner as it prints it, color codes and all. The port sits inside the URL's colors. */
const VITE = '\n  \x1b[32m\x1b[1mVITE\x1b[22m v5.4.2\x1b[39m  \x1b[2mready in \x1b[0m\x1b[1m312\x1b[22m\x1b[2m\x1b[0m ms\x1b[22m\n\n' +
  '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n' +
  '  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b[22m: \x1b[2muse \x1b[22m\x1b[1m--host\x1b[22m\x1b[2m to expose\x1b[22m\n'
/** Next 15's banner. The Network line comes after and isn't local. */
const NEXT = '   ▲ Next.js 15.0.3\n   - Local:        http://localhost:3000\n   - Network:      http://192.168.1.20:3000\n\n ✓ Starting...\n ✓ Ready in 1.2s\n'

let n = 0
async function run(files: Record<string, string>, script: string, name = 'run') {
  const cwd = await mkdtemp(join(tmpdir(), 'kernel-run-'))
  for (const [f, text] of Object.entries(files)) await writeFile(join(cwd, f), text)
  const workspaceId = `ws-${++n}`
  const done = runScript({ workspaceId, kind: 'run', name, script, cwd, port: 4300, root: cwd })
  return { workspaceId, done }
}

describe('resolvePreviewUrl (KERNEL-246)', () => {
  it('fills in every port form', () => {
    expect(resolvePreviewUrl('http://localhost:$KERNEL_PORT', 4310)).toBe('http://localhost:4310')
    expect(resolvePreviewUrl('http://localhost:${KERNEL_PORT}/admin', 4310)).toBe('http://localhost:4310/admin')
    expect(resolvePreviewUrl('https://127.0.0.1:$PORT/', 4310)).toBe('https://127.0.0.1:4310/')
    expect(resolvePreviewUrl('http://localhost:$((KERNEL_PORT + 1))/docs', 4310)).toBe('http://localhost:4311/docs')
    expect(resolvePreviewUrl('http://localhost:$((KERNEL_PORT+0))', 4310)).toBe('http://localhost:4310')
    expect(resolvePreviewUrl('  http://localhost:$(( KERNEL_PORT + 9 ))  ', 4310)).toBe('http://localhost:4319')
    expect(resolvePreviewUrl('https://staging.example.com', 4310)).toBe('https://staging.example.com')
  })

  it('rejects a port past the block, a scheme other than http(s) and junk', () => {
    expect(resolvePreviewUrl('http://localhost:$((KERNEL_PORT + 10))', 4310)).toBeNull()
    expect(resolvePreviewUrl('http://localhost:4310/$((KERNEL_PORT + 12))', 4310)).toBeNull()
    expect(resolvePreviewUrl('http://localhost:4310/${OTHER}', 4310)).toBeNull()
    expect(resolvePreviewUrl('file:///etc/passwd', 4310)).toBeNull()
    expect(resolvePreviewUrl('javascript:alert(1)', 4310)).toBeNull()
    expect(resolvePreviewUrl('JavaScript:alert($PORT)', 4310)).toBeNull()
    expect(resolvePreviewUrl('localhost:$KERNEL_PORT', 4310)).toBeNull()
    expect(resolvePreviewUrl('not a url', 4310)).toBeNull()
    expect(resolvePreviewUrl('', 4310)).toBeNull()
    expect(resolvePreviewUrl('http://', 4310)).toBeNull()
  })

  it('isWebUrl, the check system.openExternal makes, takes http and https only', () => {
    expect(isWebUrl('https://github.com/a/b/pull/1')).toBe(true)
    expect(isWebUrl('http://localhost:4310/')).toBe(true)
    for (const url of ['file:///Applications/Calculator.app', 'javascript:alert(1)', 'smb://host/share', 'x-apple.systempreferences:', '', '/etc/hosts']) expect(isWebUrl(url), url).toBe(false)
  })
})

describe('localUrlIn (KERNEL-246)', () => {
  it('finds the local URL in Vite and Next banners', () => {
    expect(VITE.split('\n').map(localUrlIn).filter(Boolean)).toEqual(['http://localhost:5173/'])
    expect(NEXT.split('\n').map(localUrlIn).filter(Boolean)).toEqual(['http://localhost:3000'])
  })

  it('rewrites 0.0.0.0, keeps 127.0.0.1 and [::1], and leaves off the end of a sentence', () => {
    expect(localUrlIn('Listening on http://0.0.0.0:8000/api.')).toBe('http://localhost:8000/api')
    expect(localUrlIn('Serving at http://127.0.0.1:8080, press Ctrl+C')).toBe('http://127.0.0.1:8080')
    expect(localUrlIn('(ready at https://[::1]:4443/)')).toBe('https://[::1]:4443/')
  })

  it('skips a URL with no port, another host and an impossible port', () => {
    expect(localUrlIn('Docs at http://localhost/docs')).toBeNull()
    expect(localUrlIn('Network: http://192.168.1.20:3000')).toBeNull()
    expect(localUrlIn('http://localhost.evil.com:3000')).toBeNull()
    expect(localUrlIn('http://localhost:99999')).toBeNull()
  })
})

describe('whole lines of run output (KERNEL-246)', () => {
  it('joins a line split across chunks, a CRLF split between them and a character split in half', async () => {
    const s = new PassThrough()
    const got: string[] = []
    const flush = pipeLines(s, (l) => got.push(l))
    s.write('Local: http://local')
    s.write('host:5173/\r')
    s.write('\nnext ')
    const arrow = Buffer.from('➜ done')
    s.write(arrow.subarray(0, 2))
    s.write(arrow.subarray(2))
    await tick()
    expect(got).toEqual(['Local: http://localhost:5173/'])
    flush()
    expect(got).toEqual(['Local: http://localhost:5173/', 'next ➜ done'])
  })

  it('hands over a line that reaches 64 KB without a newline, the way a spinner writes', async () => {
    const s = new PassThrough()
    const got: string[] = []
    pipeLines(s, (l) => got.push(l))
    const frame = '\r⠋ building'
    for (let i = 0; i < Math.ceil(MAX_LINE / frame.length); i++) s.write(frame)
    await tick()
    expect(got).toHaveLength(1)
    expect(got[0].length).toBeGreaterThanOrEqual(MAX_LINE)
  })

  it('shows a URL a script prints in two writes as one line, and finds it', async () => {
    const { workspaceId } = await run({}, "printf 'Local: http://local'; sleep 0.3; printf 'host:5173/\\n'; sleep 30")
    await until(() => urls(workspaceId).includes('http://localhost:5173/'), 'the URL')
    expect(lines(workspaceId).slice(1)).toEqual(['Local: http://localhost:5173/'])
  })

  it('shows a last line with no newline once the script exits', async () => {
    const { workspaceId, done } = await run({}, "printf 'one\\ntwo'")
    await done
    expect(lines(workspaceId).slice(1)).toEqual(['one', 'two'])
  })
})

describe('the URL a run script prints (KERNEL-246)', () => {
  it('pushes Vite\'s Local URL, clears it on start and on exit', async () => {
    const { workspaceId, done } = await run({ 'vite.txt': VITE }, 'cat vite.txt; sleep 30')
    await until(() => urls(workspaceId).length === 2, 'the URL')
    expect(urls(workspaceId)).toEqual([null, 'http://localhost:5173/'])
    stopScript(workspaceId, 'run')
    await done
    expect(urls(workspaceId)).toEqual([null, 'http://localhost:5173/', null])
  })

  it('pushes Next\'s Local URL and not its Network one, for the run script that printed it', async () => {
    const { workspaceId, done } = await run({ 'next.txt': NEXT }, 'cat next.txt', 'web')
    await done
    expect(urls(workspaceId, 'web')).toEqual([null, 'http://localhost:3000', null])
    expect(urls(workspaceId, 'run')).toEqual([])
  })

  it('keeps the first URL a run prints', async () => {
    const { workspaceId, done } = await run({}, 'echo http://localhost:4300/; echo http://localhost:4301/')
    await done
    expect(urls(workspaceId)).toEqual([null, 'http://localhost:4300/', null])
  })

  it('finds no URL in setup output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kernel-run-'))
    await runScript({ workspaceId: 'ws-setup', kind: 'setup', script: 'echo http://localhost:4300/', cwd, port: 4300, root: cwd })
    expect(events.filter((e) => e.type === 'script.url')).toEqual([])
  })

  it('a restart\'s URL isn\'t cleared when the process it replaced exits', async () => {
    const first = await run({}, "trap 'echo http://localhost:4399/; exit 0' TERM; echo http://localhost:4300/; sleep 30 & wait")
    await until(() => urls(first.workspaceId).includes('http://localhost:4300/'), 'the first URL')
    const cwd = await mkdtemp(join(tmpdir(), 'kernel-run-'))
    void runScript({ workspaceId: first.workspaceId, kind: 'run', name: 'run', script: 'echo http://localhost:4301/; sleep 30', cwd, port: 4300, root: cwd })
    await until(() => exits(first.workspaceId) === 1 && urls(first.workspaceId).includes('http://localhost:4301/'), 'the restart')
    // The old process's last words and its exit change nothing: the new run's URL stands.
    expect(urls(first.workspaceId)).toEqual([null, 'http://localhost:4300/', null, 'http://localhost:4301/'])
  })
})

describe('[preview] urls in a room\'s settings (KERNEL-246)', () => {
  it('reads [[preview.urls]] in order and drops entries with no address', async () => {
    const repo = await tempRepo({
      '.kernel/settings.toml': '[[preview.urls]]\nname = "Web"\nurl = "http://localhost:$KERNEL_PORT"\n\n[[preview.urls]]\nname = "Broken"\n\n[[preview.urls]]\nname = "API"\nurl = "http://localhost:$((KERNEL_PORT + 1))/docs"\n'
    })
    const rs = await loadRepoSettings(repo)
    expect(rs.preview.urls).toEqual([{ name: 'Web', url: 'http://localhost:$KERNEL_PORT' }, { name: 'API', url: 'http://localhost:$((KERNEL_PORT + 1))/docs' }])
    expect(rs.sources['preview.urls']).toBe('shared')
    expect((await loadRepoSettings(await tempRepo())).preview).toEqual({ urls: [] })
  })

  it('round trips through settings.setRoom: the patch replaces the list, sources follow, null removes it', async () => {
    const repo = await tempRepo({ 'README.md': '# r\n', '.kernel/settings.toml': '[[preview.urls]]\nname = "Web"\nurl = "http://localhost:$KERNEL_PORT"\n' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900) }))
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    await k.start()
    try {
      const h = k.handlers()
      const room = await k.addRoom(repo)
      expect((await h['settings.room']({ roomId: room.id })).sources).toEqual({ 'preview.urls': 'shared' })
      const mine = [{ name: 'Storybook', url: 'http://localhost:$((KERNEL_PORT + 2))' }, { name: 'App', url: 'http://localhost:$KERNEL_PORT/app' }]
      const rs = await h['settings.setRoom']({ roomId: room.id, patch: { preview: { urls: mine } } })
      expect(rs.preview.urls).toEqual(mine)
      expect(rs.sources['preview.urls']).toBe('override')
      expect(await readFile(join(repo, '.kernel/settings.local.toml'), 'utf8')).toContain('[[preview.urls]]\nname = "Storybook"')
      // A shorter list replaces the whole one, rather than merging by position.
      expect((await h['settings.setRoom']({ roomId: room.id, patch: { preview: { urls: [mine[1]] } } })).preview.urls).toEqual([mine[1]])
      const back = await h['settings.setRoom']({ roomId: room.id, patch: { preview: { urls: null } } })
      expect(back.preview.urls).toEqual([{ name: 'Web', url: 'http://localhost:$KERNEL_PORT' }])
      expect(back.sources['preview.urls']).toBe('shared')
    } finally { await k.stop() }
  })

  it('writes only entries with a name and an address, and keeps an empty list', async () => {
    const repo = await tempRepo()
    const junk = [{ name: 'Web', url: 'http://localhost:$KERNEL_PORT' }, { name: 'Blank', url: '  ' }, { url: 'http://x' }, 'nope'] as unknown as { name: string; url: string }[]
    expect((await saveRepoSettings(repo, { preview: { urls: junk } }, true)).preview.urls).toEqual([{ name: 'Web', url: 'http://localhost:$KERNEL_PORT' }])
    const rs = await saveRepoSettings(repo, { preview: { urls: [] } })
    expect(rs.preview.urls).toEqual([])
    expect(rs.sources['preview.urls']).toBe('override')
  })
})
