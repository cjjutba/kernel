import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookCallback, HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, Project, Workspace } from '@shared/types'
import { bus } from '../src/main/bus'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { Sessions } from '../src/main/services/sessions'
import { loadRepoSettings, referencesInProject, saveRepoSettings, type AppSettings } from '../src/main/services/settings'
import { decide, referenceWrite, REFERENCE_READ_ONLY } from '../src/main/services/permissions'
import { searchFiles } from '../src/main/services/files'
import { sessionDeps } from '../src/main/features/sessionDeps'
import type { Kernel } from '../src/main/kernel'
import { tempRepo } from './helpers'

// KERNEL-748: a project pins folders outside its repo as read-only references. Claude reads them, Kernel denies edits under
// them, and the @ menu searches them.

const sdk = vi.hoisted(() => ({ calls: [] as { options: Options; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Options }) => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    const feed = (m: unknown) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) }
    sdk.calls.push({ options, feed })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {}
    }
  }
}))

afterEach(() => { sdk.calls.length = 0; bus.removeAllListeners('activity') })

const folder = async (files: Record<string, string> = {}) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'kernel-ref-')))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  return dir
}

const writeLocal = async (repo: string, text: string) => {
  await mkdir(join(repo, '.kernel'), { recursive: true })
  await writeFile(join(repo, '.kernel', 'settings.local.toml'), text)
}

describe('reference folders in project settings (KERNEL-748)', () => {
  it('reads them from the personal file only, and names the ones that are missing', async () => {
    const repo = await tempRepo({ '.kernel/settings.toml': 'references = ["/shared/is/ignored"]\n' })
    const api = await folder()
    await writeLocal(repo, `references = ["${api}", "relative/path", "/nowhere/kernel-748", "${api}/"]\n`)
    const rs = await loadRepoSettings(repo)
    expect(rs.references).toEqual([api, '/nowhere/kernel-748'])
    expect(rs.missingReferences).toEqual(['/nowhere/kernel-748'])
    expect(rs.sources.references).toBe('local')
    expect(referencesInProject(repo)).toEqual({ present: [api], missing: ['/nowhere/kernel-748'] })
  })

  it('saves the list to the personal file, refuses the shared one, and removes the key when emptied', async () => {
    const repo = await tempRepo({ 'README.md': '# ui\n' })
    const api = await folder()
    expect((await saveRepoSettings(repo, { references: [api] })).references).toEqual([api])
    expect(await readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')).toContain(api)
    await expect(saveRepoSettings(repo, { references: [api] }, true)).rejects.toThrow(/settings.local.toml/)
    await expect(saveRepoSettings(repo, { references: ['api'] })).rejects.toThrow(/full path/)
    expect((await saveRepoSettings(repo, { references: null })).references).toEqual([])
  })
})

describe('edits under a reference folder (KERNEL-748)', () => {
  it('denies Edit, Write, MultiEdit and NotebookEdit under one, and leaves reads and other paths alone', async () => {
    const api = await folder({ 'src/server.ts': 'export {}\n' })
    const refs = [api]
    for (const tool of ['Edit', 'Write', 'MultiEdit']) expect(referenceWrite({ tool, input: { file_path: join(api, 'src/server.ts') } }, refs)).toEqual({ behavior: 'deny', message: REFERENCE_READ_ONLY })
    expect(referenceWrite({ tool: 'NotebookEdit', input: { notebook_path: join(api, 'n.ipynb') } }, refs)?.behavior).toBe('deny')
    // A file Write would create, and a relative path from a cwd inside the folder.
    expect(referenceWrite({ tool: 'Write', input: { file_path: join(api, 'new/file.ts') } }, refs)?.behavior).toBe('deny')
    expect(referenceWrite({ tool: 'Edit', input: { file_path: 'src/server.ts' }, cwd: api }, refs)?.behavior).toBe('deny')
    expect(referenceWrite({ tool: 'Read', input: { file_path: join(api, 'src/server.ts') } }, refs)).toBeUndefined()
    expect(referenceWrite({ tool: 'Edit', input: { file_path: `${api}-other/x.ts` } }, refs)).toBeUndefined()
    expect(referenceWrite({ tool: 'Edit', input: { file_path: join(api, 'src/server.ts') } }, [])).toBeUndefined()
  })

  it('denies an edit through a symlink into the folder, in Bypass permissions too', async () => {
    const api = await folder({ 'a.ts': '' })
    const ui = await folder()
    await symlink(api, join(ui, 'api'))
    const rules = { permissions: { mode: 'bypassPermissions', alwaysAsk: [], neverAllow: [], protectedBranches: [] } as unknown as AppSettings['permissions'], mode: 'bypassPermissions' as const, projectAllow: () => [], projectTools: () => [], references: [api] }
    expect(decide({ tool: 'Edit', input: { file_path: join(ui, 'api', 'a.ts') } }, rules)).toEqual({ behavior: 'deny', message: REFERENCE_READ_ONLY })
    expect(decide({ tool: 'Edit', input: { file_path: join(ui, 'b.ts') } }, rules)).toBeUndefined()
  })
})

describe('Claude sessions with reference folders (KERNEL-748)', () => {
  const noor = { id: 'noor', file: '.claude/agents/noor.md', name: 'Noor', role: 'Engine', description: 'Engine', lead: false, prompt: 'You are Noor.' } as AgentDef

  async function start(references: string[] | undefined) {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-ref-db-')), 'kernel.db'))
    const ws: Workspace = { id: 'ws', projectId: 'project', name: 'ui', branch: 'feat/ui', baseRef: 'main', path: await folder(), mode: 'worktree', agentId: 'noor', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'UI', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat(chat)
    const settings = { permissions: { mode: 'acceptEdits', alwaysAsk: [], neverAllow: [], protectedBranches: [], approvalTimeoutSec: 300 }, models: { agentLimit: 0 } } as unknown as AppSettings
    const sessions = new Sessions({ store, approvals: new Approvals(store), settings: () => settings, agentFor: () => noor, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {}, referencesFor: () => references })
    await sessions.send(chat.id, [{ type: 'text', text: 'Match the API' }])
    return sdk.calls.at(-1)!.options
  }

  const writeHook = (options: Options) => (options.hooks!.PreToolUse as HookCallbackMatcher[]).find((m) => m.matcher === 'Edit|Write|MultiEdit|NotebookEdit')!.hooks[0] as HookCallback

  it('passes the folders as additionalDirectories and denies an edit under one in the hook', async () => {
    const api = await folder({ 'server.ts': '' })
    const options = await start([api])
    expect(options.additionalDirectories).toEqual([api])
    const hook = writeHook(options)
    const signal = new AbortController().signal
    const ask = (file_path: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: options.cwd! } as never, 't', { signal })
    expect(await ask(join(api, 'server.ts'))).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REFERENCE_READ_ONLY } })
    expect(await ask(join(options.cwd!, 'app.ts'))).toEqual({})
  })

  it('starts with no additionalDirectories when the project has none', async () => {
    const options = await start(undefined)
    expect(options.additionalDirectories).toBeUndefined()
  })

  it('skips a missing folder, so the session still starts, and warns in the project log once', async () => {
    const repo = await tempRepo({ 'README.md': '# ui\n' })
    const api = await folder()
    await writeLocal(repo, `references = ["${api}", "/nowhere/kernel-748"]\n`)
    const project = { id: 'project', path: repo } as Project
    const deps = sessionDeps({ store: { project: () => project } } as unknown as Kernel)
    const notes: { text: string; object?: string; warn?: boolean }[] = []
    bus.on('activity', (a) => notes.push(a))
    const ws = { projectId: 'project' } as Workspace
    expect(deps.referencesFor!(ws)).toEqual([api])
    expect(deps.referencesFor!(ws)).toEqual([api])
    expect(notes).toEqual([expect.objectContaining({ object: '/nowhere/kernel-748', warn: true })])
  })
})

describe('@ search in reference folders (KERNEL-748)', () => {
  it('returns rows from each folder with an absolute path and the folder name', async () => {
    const ui = await tempRepo({ 'src/App.tsx': '' })
    const api = await realpath(await tempRepo({ 'src/invoices/routes.ts': '', 'README.md': '' }))
    const rows = await searchFiles(ui, 'routes', 8, [api])
    expect(rows[0]).toEqual({ path: join(api, 'src/invoices/routes.ts'), dir: false, reference: api.split('/').at(-1) })
    // The worktree's own rows carry no label.
    expect((await searchFiles(ui, 'app', 8, [api])).find((r) => r.path === 'src/App.tsx')).toEqual({ path: 'src/App.tsx', dir: false })
  })

  it('walks a folder that is not a git checkout, without hidden or build folders', async () => {
    const ui = await tempRepo({ 'README.md': '' })
    const docs = await folder({ 'guide/billing.md': '', '.cache/billing.md': '', 'node_modules/billing/index.js': '' })
    const rows = await searchFiles(ui, 'billing', 8, [docs])
    expect(rows.filter((r) => !r.dir).map((r) => r.path)).toEqual([join(docs, 'guide/billing.md')])
  })

  it('skips a folder that is gone without failing the search', async () => {
    const ui = await tempRepo({ 'src/App.tsx': '' })
    expect(await searchFiles(ui, 'app', 8, ['/nowhere/kernel-748'])).toEqual([{ path: 'src/App.tsx', dir: false }])
  })
})
