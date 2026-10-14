import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import type { ExecResult } from '../src/main/services/exec'
import { findApps, launch, MDFIND_MS, OPEN_APPS, type FoundApp, type OpenAppsSystem } from '../src/main/services/openApps'
import { tempRepo, freePort } from './helpers'

// KERNEL-427: Open in lists the catalog apps installed on this Mac and opens a path in one with `open -a`. Nothing here
// launches a real app: every test runs on a fake file system and a fake exec that records what it was asked to run.
const HOME = '/Users/sam'
const at = {
  finder: '/System/Library/CoreServices/Finder.app',
  vscode: '/Applications/Visual Studio Code.app',
  cursor: '/Applications/Cursor.app',
  zed: '/Applications/Zed.app',
  terminal: '/System/Applications/Utilities/Terminal.app',
  iterm: `${HOME}/Applications/iTerm.app`,
  ghostty: '/Applications/Ghostty.app'
}
type Call = { cmd: string; args: string[]; opts?: { timeoutMs?: number } }

/** A Mac with `apps` installed in the usual folders, and Spotlight answering `mdfind` with `spotlight`. */
function mac(apps: string[], spotlight: Partial<ExecResult> = { stdout: '' }, launches: Partial<ExecResult> = {}) {
  const calls: Call[] = []
  const sys: OpenAppsSystem = {
    exists: async (p) => apps.includes(p),
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return { code: 0, stdout: '', stderr: '', ...(cmd === 'mdfind' ? spotlight : launches) }
    }
  }
  return { sys, calls, opens: () => calls.filter((c) => c.cmd === 'open').map((c) => c.args) }
}
const found = (id: keyof typeof at): FoundApp => ({ app: OPEN_APPS.find((a) => a.id === id)!, path: at[id] })
const line = (path: string, id: string) => `${path}   kMDItemCFBundleIdentifier = ${id}`

describe('finding the apps (KERNEL-427)', () => {
  it('lists Finder, then the editors, then the terminals', () => {
    expect(OPEN_APPS.map((a) => a.name)).toEqual([
      'Finder',
      'VS Code', 'VS Code Insiders', 'Cursor', 'Windsurf', 'Zed', 'Sublime Text', 'Xcode', 'Android Studio', 'IntelliJ IDEA', 'WebStorm', 'PyCharm', 'Antigravity',
      'Terminal', 'iTerm', 'Warp', 'Ghostty'
    ])
    expect(new Set(OPEN_APPS.map((a) => a.id)).size).toBe(OPEN_APPS.length)
  })

  it('finds an app in each usual folder and asks Spotlight once about the rest', async () => {
    const { sys, calls } = mac([at.finder, at.vscode, at.terminal, at.iterm])
    expect((await findApps(sys, HOME)).map((f) => [f.app.id, f.path])).toEqual([['finder', at.finder], ['vscode', at.vscode], ['terminal', at.terminal], ['iterm', at.iterm]])
    const mdfind = calls.filter((c) => c.cmd === 'mdfind')
    expect(mdfind).toHaveLength(1)
    expect(mdfind[0].opts?.timeoutMs).toBe(MDFIND_MS)
    const query = mdfind[0].args.at(-1)!
    expect(query).toContain("kMDItemCFBundleIdentifier == 'com.todesktop.230313mzl4w4u92' || ")
    expect(query).not.toContain('com.microsoft.VSCode\'')
    expect(query).not.toContain('com.apple.finder')
  })

  it("finds an app outside those folders by its bundle id, in catalog order, and skips one in the Trash", async () => {
    const spotlight = [
      line('/Users/sam/.Trash/Zed.app', 'dev.zed.Zed'),
      line('/opt/tools/Ghostty.app', 'com.mitchellh.ghostty'),
      line('/Volumes/Work/Apps/Cursor Nightly.app', 'com.todesktop.230313mzl4w4u92'),
      line('/Users/sam/Downloads/Cursor.app', 'com.todesktop.230313mzl4w4u92'),
      'not a line Spotlight writes'
    ].join('\n')
    const { sys } = mac([at.finder], { stdout: spotlight })
    expect((await findApps(sys, HOME)).map((f) => [f.app.id, f.path])).toEqual([
      ['finder', at.finder], ['cursor', '/Volumes/Work/Apps/Cursor Nightly.app'], ['ghostty', '/opt/tools/Ghostty.app']
    ])
  })

  it('lists what the folders had when Spotlight runs out of time or fails', async () => {
    for (const spotlight of [{ code: 1, timedOut: true, stdout: line('/opt/Zed.app', 'dev.zed.Zed') }, { code: 1, stdout: '' }]) {
      const { sys } = mac([at.finder, at.vscode], spotlight)
      expect((await findApps(sys, HOME)).map((f) => f.app.id)).toEqual(['finder', 'vscode'])
    }
  })

  it("doesn't ask Spotlight when every app is in a usual folder", async () => {
    const all = OPEN_APPS.map((a) => join('/Applications', a.file))
    const { sys, calls } = mac(all)
    expect(await findApps(sys, HOME)).toHaveLength(OPEN_APPS.length)
    expect(calls).toEqual([])
  })
})

describe('the launch for each kind of app (KERNEL-427)', () => {
  const file = '/r/demo/src/run.command'
  const folder = '/r/demo/src'
  it('hands an editor the file or the folder', () => {
    expect(launch(found('vscode'), file, false)).toEqual({ args: ['-a', at.vscode, file] })
    expect(launch(found('cursor'), folder, true)).toEqual({ args: ['-a', at.cursor, folder] })
  })
  it('hands a terminal the folder, never the file', () => {
    expect(launch(found('terminal'), file, false)).toEqual({ args: ['-a', at.terminal, folder] })
    expect(launch(found('iterm'), folder, true)).toEqual({ args: ['-a', at.iterm, folder] })
  })
  it('starts a new Ghostty in the folder', () => {
    expect(launch(found('ghostty'), file, false)).toEqual({ args: ['-n', '-a', at.ghostty, '--args', `--working-directory=${folder}`] })
  })
  it('opens a folder in Finder and shows a file in its folder', () => {
    expect(launch(found('finder'), folder, true)).toEqual({ args: ['-a', at.finder, folder] })
    expect(launch(found('finder'), file, false)).toEqual({ reveal: file })
  })
})

describe('Open in (KERNEL-427)', () => {
  async function boot(apps: string[], o: { launches?: Partial<ExecResult>; openIn?: string } = {}) {
    const repo = await tempRepo({ 'README.md': '# demo\n', 'src/run.command': 'echo hi\n' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), ...(o.openIn ? { general: { openIn: o.openIn } } : {}) }))
    const revealed: string[] = []
    const k = new Kernel({ dataDir, home, reveal: (p) => void revealed.push(p), appIcon: async (p) => `data:image/png;base64,${Buffer.from(p).toString('base64')}` })
    onTestFinished(() => k.stop().catch(() => undefined))
    await k.start()
    const fake = mac(apps, { stdout: '' }, o.launches)
    k.app.system = fake.sys
    const h = k.handlers()
    await h['rooms.add']({ path: repo })
    return { k, h, repo, dataDir, revealed, ...fake }
  }

  it('lists the installed apps with their icons, and the first editor as the default', async () => {
    const { h } = await boot([at.finder, at.cursor, at.zed, at.terminal])
    const r = await h['app.openApps']()
    expect(r.apps.map((a) => [a.id, a.name, a.kind])).toEqual([['finder', 'Finder', 'finder'], ['cursor', 'Cursor', 'editor'], ['zed', 'Zed', 'editor'], ['terminal', 'Terminal', 'terminal']])
    expect(Buffer.from(r.apps[1].icon!.replace('data:image/png;base64,', ''), 'base64').toString()).toBe(at.cursor)
    expect(r.defaultId).toBe('cursor')
  })

  it('defaults to the last pick while it is installed, then to the first editor, then to Finder', async () => {
    expect((await (await boot([at.finder, at.cursor, at.zed], { openIn: 'zed' })).h['app.openApps']()).defaultId).toBe('zed')
    expect((await (await boot([at.finder, at.cursor, at.terminal], { openIn: 'zed' })).h['app.openApps']()).defaultId).toBe('cursor')
    expect((await (await boot([at.finder, at.terminal], { openIn: 'zed' })).h['app.openApps']()).defaultId).toBe('finder')
    expect((await (await boot([at.finder, at.cursor, at.terminal], { openIn: 'terminal' })).h['app.openApps']()).defaultId).toBe('terminal')
  })

  it('refuses a path outside every room and workspace, and an app it does not know or cannot find', async () => {
    const { h, repo, opens } = await boot([at.finder, at.vscode])
    await expect(h['app.openIn']({ path: '/System/Applications/Calculator.app' })).rejects.toThrow('inside a room or workspace')
    await expect(h['app.openIn']({ path: 'relative/run.command', app: 'vscode' })).rejects.toThrow('inside a room or workspace')
    await expect(h['app.openIn']({ path: `${repo}/../elsewhere`, app: 'vscode' })).rejects.toThrow('inside a room or workspace')
    await expect(h['app.openIn']({ path: repo, app: '/Applications/Calculator.app' })).rejects.toThrow("can't open files in")
    await expect(h['app.openIn']({ path: repo, app: 'zed' })).rejects.toThrow("Zed isn't installed")
    expect(opens()).toEqual([])
  })

  it('opens a file in the picked app and remembers the pick', async () => {
    const { k, h, repo, dataDir, opens } = await boot([at.finder, at.vscode, at.cursor, at.terminal])
    await h['app.openIn']({ path: join(repo, 'README.md'), app: 'cursor' })
    expect(opens()).toEqual([['-a', at.cursor, join(repo, 'README.md')]])
    expect(k.settings.general.openIn).toBe('cursor')
    expect(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')).general.openIn).toBe('cursor')
    expect((await h['app.openApps']()).defaultId).toBe('cursor')
    // A terminal gets the file's folder, and becomes the pick the menu shows.
    await h['app.openIn']({ path: join(repo, 'src', 'run.command'), app: 'terminal' })
    expect(opens().at(-1)).toEqual(['-a', at.terminal, join(repo, 'src')])
    expect((await h['app.openApps']()).defaultId).toBe('terminal')
  })

  it('says which app failed to open and keeps the old pick', async () => {
    const { k, h, repo } = await boot([at.finder, at.vscode, at.cursor], { launches: { code: 1, stderr: 'LSOpenURLsWithRole() failed' }, openIn: 'vscode' })
    await expect(h['app.openIn']({ path: repo, app: 'cursor' })).rejects.toThrow('Could not open in Cursor')
    expect(k.settings.general.openIn).toBe('vscode')
  })

  it('opens in the default editor with no app named, never a terminal, and shows the file in Finder with no editor', async () => {
    const withEditor = await boot([at.finder, at.vscode, at.cursor, at.terminal], { openIn: 'terminal' })
    await withEditor.h['app.openIn']({ path: join(withEditor.repo, 'src', 'run.command') })
    expect(withEditor.opens()).toEqual([['-a', at.vscode, join(withEditor.repo, 'src', 'run.command')]])
    expect(withEditor.k.settings.general.openIn).toBe('terminal')

    const pickedEditor = await boot([at.finder, at.vscode, at.cursor], { openIn: 'cursor' })
    await pickedEditor.h['app.openIn']({ path: pickedEditor.repo })
    expect(pickedEditor.opens()).toEqual([['-a', at.cursor, pickedEditor.repo]])

    const noEditor = await boot([at.finder, at.terminal, at.iterm], { openIn: 'iterm' })
    await noEditor.h['app.openIn']({ path: join(noEditor.repo, 'src', 'run.command') })
    expect(noEditor.revealed).toEqual([join(noEditor.repo, 'src', 'run.command')])
    await noEditor.h['app.openIn']({ path: join(noEditor.repo, 'src') })
    expect(noEditor.opens()).toEqual([['-a', at.finder, join(noEditor.repo, 'src')]])
  })

  it('opens a file in a workspace as well as in a room', async () => {
    const { k, h, opens } = await boot([at.finder, at.zed])
    const room = (await h['rooms.list']())[0]
    const wt = join(k.settings.worktreeRoot, 'demo', 'ws1')
    await mkdir(wt, { recursive: true })
    await expect(h['app.openIn']({ path: wt, app: 'zed' })).rejects.toThrow('inside a room or workspace')
    const ws: Workspace = { id: 'ws1', roomId: room.id, name: 'w', branch: 'b', baseRef: 'main', path: wt, mode: 'worktree', agentId: 'kernel-lead', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    k.store.saveWorkspace(ws)
    await h['app.openIn']({ path: wt, app: 'zed' })
    expect(opens()).toEqual([['-a', at.zed, wt]])
  })
})
