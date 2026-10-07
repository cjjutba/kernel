import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { installHooks, uninstallHooks, withKernelHooks } from '../src/main/services/hooksInstaller'
import { discoverMcp } from '../src/main/services/integrations'
import { loadRepoSettings, saveRepoSettings } from '../src/main/services/settings'
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
    expect(await readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).not.toContain('setup')
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
    k.store.db.close()
  })
})
