import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Chat, ClaudePlan, Workspace } from '@shared/types'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { bashVerdict, pushesTo, usesNetwork } from '../src/main/services/bashGuard'
import { Sessions } from '../src/main/services/sessions'
import { Kernel } from '../src/main/kernel'
import { applySettingsPatch, deepMerge, DEFAULT_SETTINGS, loadAppSettings, PLAN_KEYS, planDefaults, planOf, resolveSettings, saveAppSettings } from '../src/main/services/settings'
import { tempRepo } from './helpers'

// Each query() is a scripted session that never answers on its own. A turn ends when the test feeds a result.
const sdk = vi.hoisted(() => ({ calls: [] as { feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    sdk.calls.push({ feed: (m) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) } })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}
    }
  }
}))

const flush = () => new Promise((r) => setTimeout(r, 10))

describe('applySettingsPatch', () => {
  const base = DEFAULT_SETTINGS('/home/cj')
  it('merges nested fields and replaces lists', () => {
    const next = applySettingsPatch(base, { appearance: { theme: 'light' }, permissions: { alwaysAsk: ['rm -rf'] } })
    expect(next.appearance.theme).toBe('light')
    expect(next.appearance.density).toBe(base.appearance.density)
    expect(next.permissions.alwaysAsk).toEqual(['rm -rf'])
  })
  it('clears quiet hours with null', () => {
    const on = applySettingsPatch(base, { notifications: { quietHours: { from: '22:00', to: '07:00' } } })
    expect(on.notifications.quietHours).toEqual({ from: '22:00', to: '07:00' })
    expect(applySettingsPatch(on, { notifications: { quietHours: null } }).notifications.quietHours).toBeNull()
  })
  it('keeps the agent limit and the timeout in range', () => {
    const next = applySettingsPatch(base, { models: { agentLimit: -2 }, permissions: { approvalTimeoutSec: 1 } })
    expect(next.models.agentLimit).toBe(0)
    expect(next.permissions.approvalTimeoutSec).toBe(10)
  })
  it('keeps the effort memory to known models and efforts, and merges it per model', () => {
    const one = applySettingsPatch(base, { models: { effortByModel: { 'claude-opus-5-5': 'xhigh' } } })
    const both = applySettingsPatch(one, { models: { effortByModel: { 'claude-sonnet-5-5': 'low', 'claude-nope': 'high', 'claude-haiku-4-5-20251001': 'max' } as never } })
    expect(both.models.effortByModel).toEqual({ 'claude-opus-5-5': 'xhigh', 'claude-sonnet-5-5': 'low' })
  })
  it('remembers Codex models by their own ids, with Codex efforts (KERNEL-406)', () => {
    const next = applySettingsPatch(base, { models: { effortByModel: { 'gpt-6-astra': 'ultra', 'gpt-5.6-luna': 'nope', '': 'low' } as never } })
    expect(next.models.effortByModel).toEqual({ 'gpt-6-astra': 'ultra' })
  })
  it('sets one role to Codex and leaves the others, and keeps each role valid (KERNEL-406)', () => {
    const next = applySettingsPatch(base, { models: { roles: { engineers: { provider: 'codex', model: 'gpt-6-astra', effort: 'max' } } } })
    expect(next.models.roles.engineers).toEqual({ provider: 'codex', model: 'gpt-6-astra', effort: 'max' })
    expect(next.models.roles.lead).toEqual(base.models.roles.lead)
    // A Claude role can't take a model or an effort Claude doesn't have, so the role it had stands.
    const bad = applySettingsPatch(next, { models: { roles: { lead: { model: 'gpt-6-astra' }, qa: { effort: 'ultra' } } } })
    expect(bad.models.roles.lead).toEqual(base.models.roles.lead)
    expect(bad.models.roles.qa).toEqual(base.models.roles.qa)
    // The effort alone moves within the role's provider.
    expect(applySettingsPatch(next, { models: { roles: { reviewer: { effort: 'low' } } } }).models.roles.reviewer).toEqual({ ...base.models.roles.reviewer, effort: 'low' })
  })
})

describe('loadAppSettings', () => {
  it('moves the old default branch pattern to the new one, and keeps a custom pattern (KERNEL-275)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
    await writeFile(file, JSON.stringify({ workspace: { branchPattern: 'feat/{slug}' } }))
    expect((await loadAppSettings(file, '/home/cj')).resolved.workspace.branchPattern).toBe('{type}/{task}-{slug}')
    await writeFile(file, JSON.stringify({ workspace: { branchPattern: 'cj/{task}-{slug}' } }))
    expect((await loadAppSettings(file, '/home/cj')).resolved.workspace.branchPattern).toBe('cj/{task}-{slug}')
    await writeFile(file, JSON.stringify({}))
    expect((await loadAppSettings(file, '/home/cj')).resolved.workspace.branchPattern).toBe('{type}/{task}-{slug}')
  })
  it('loads a file that still has the unused setUpstream, without it (KERNEL-460)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
    await writeFile(file, JSON.stringify({ workspace: { setUpstream: false, archiveOnMerge: false } }))
    const { saved, resolved } = await loadAppSettings(file, '/home/cj')
    expect(saved.workspace).toEqual({ archiveOnMerge: false })
    expect(resolved.workspace).not.toHaveProperty('setUpstream')
    expect(DEFAULT_SETTINGS('/home/cj').workspace).not.toHaveProperty('setUpstream')
  })
  it('moves the old model per role and the one effort into Claude roles at that effort (KERNEL-406)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
    await writeFile(file, JSON.stringify({ models: { lead: 'claude-fable-5-1', engineers: 'claude-opus-5-5', qa: 'claude-haiku-4-5-20251001', reviewer: 'claude-sonnet-5-5', effort: 'xhigh', agentLimit: 3 } }))
    const { saved, resolved: s } = await loadAppSettings(file, '/home/cj')
    expect(s.models.roles).toEqual({
      lead: { provider: 'claude', model: 'claude-fable-5-1', effort: 'xhigh' },
      engineers: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
      qa: { provider: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'xhigh' },
      reviewer: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'xhigh' }
    })
    expect(s.models.agentLimit).toBe(3)
    for (const k of ['lead', 'engineers', 'qa', 'reviewer', 'effort']) expect(s.models).not.toHaveProperty(k)
    expect(saved.models).toEqual({
      roles: {
        lead: { provider: 'claude', model: 'claude-fable-5-1', effort: 'xhigh' },
        engineers: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
        qa: { provider: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'xhigh' },
        reviewer: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'xhigh' }
      },
      agentLimit: 3
    })
    // Saved and read again, the roles stand as they are.
    await saveAppSettings(file, saved)
    expect((await loadAppSettings(file, '/home/cj')).resolved.models.roles).toEqual(s.models.roles)
  })
  it('fills a role the old file left out, or set to a model Kernel no longer has, from the defaults (KERNEL-406)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
    const d = DEFAULT_SETTINGS('/home/cj').models.roles
    await writeFile(file, JSON.stringify({ models: { lead: 'claude-opus-4', effort: 'low' } }))
    const s = (await loadAppSettings(file, '/home/cj')).resolved
    expect(s.models.roles.lead).toEqual({ ...d.lead, effort: 'low' })
    expect(s.models.roles.engineers).toEqual({ ...d.engineers, effort: 'low' })
    await writeFile(file, JSON.stringify({ models: { roles: { qa: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' }, lead: { provider: 'mystery' } } } }))
    const next = (await loadAppSettings(file, '/home/cj')).resolved
    expect(next.models.roles.qa).toEqual({ provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' })
    expect(next.models.roles.lead).toEqual(d.lead)
  })
  it('starts every role on Claude, and both providers on their bundled binary (KERNEL-406)', () => {
    const s = DEFAULT_SETTINGS('/home/cj')
    expect(Object.values(s.models.roles).map((r) => r.provider)).toEqual(['claude', 'claude', 'claude', 'claude'])
    expect(s.providers).toEqual({ claude: { path: '', useSystem: false }, codex: { path: '', useSystem: false, personality: 'pragmatic' } })
  })
  it('drops unknown models and efforts from a saved effort memory', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
    await writeFile(file, JSON.stringify({ models: { effortByModel: { 'claude-opus-5-5': 'xhigh', 'claude-nope': 'low', 'claude-sonnet-5-5': 'max' } } }))
    expect((await loadAppSettings(file, '/home/cj')).resolved.models.effortByModel).toEqual({ 'claude-opus-5-5': 'xhigh' })
    await writeFile(file, JSON.stringify({ models: { effortByModel: ['xhigh'] } }))
    expect((await loadAppSettings(file, '/home/cj')).resolved.models.effortByModel).toEqual({})
  })
  it('keeps the Lead from merging until it is turned on, and remembers the switch after a restart (KERNEL-352)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
    await writeFile(file, JSON.stringify({ pr: { mergeMethod: 'rebase' } }))
    const { saved, resolved: before } = await loadAppSettings(file, '/home/cj')
    expect(before.pr.leadMerge).toBe(false)
    await saveAppSettings(file, deepMerge(saved, { pr: { leadMerge: true } }))
    expect((await loadAppSettings(file, '/home/cj')).resolved.pr).toMatchObject({ leadMerge: true, mergeMethod: 'rebase' })
  })
  it("drops one stack's commands from the default Always ask list, and keeps a list the user saved (KERNEL-444)", async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
    // settings.json is sparse, so a file that never changed the list follows the new default.
    await writeFile(file, JSON.stringify({ version: 2, permissions: { mode: 'acceptEdits' } }))
    expect((await loadAppSettings(file, '/home/cj')).resolved.permissions.alwaysAsk).toEqual(['rm -rf', 'git push --force'])
    const mine = ['rm -rf', 'git push --force', 'drizzle-kit push', 'pnpm db:reset']
    await writeFile(file, JSON.stringify({ version: 2, permissions: { mode: 'acceptEdits', alwaysAsk: mine } }))
    expect((await loadAppSettings(file, '/home/cj')).resolved.permissions.alwaysAsk).toEqual(mine)
    // A file from before KERNEL-225 saved the old list on every launch. It no longer equals the default, so it stays.
    await writeFile(file, JSON.stringify({ permissions: { alwaysAsk: mine } }))
    expect((await loadAppSettings(file, '/home/cj')).resolved.permissions.alwaysAsk).toEqual(mine)
  })

  describe('permission modes (KERNEL-432)', () => {
  const load = async (data?: unknown) => {
    const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
    if (data !== undefined) await writeFile(file, JSON.stringify(data))
    return { file, ...(await loadAppSettings(file, '/home/cj')) }
  }

  it('reads Ask as Manual, and keeps the rest of the permissions as saved', async () => {
    const { saved, resolved } = await load({ version: 2, permissions: { mode: 'ask', alwaysAsk: ['rm -rf'], network: false } })
    expect(saved.permissions).toEqual({ mode: 'default', alwaysAsk: ['rm -rf'], network: false })
    expect(resolved.permissions).toMatchObject({ mode: 'default', bypassOnlyInWorktrees: true, alwaysAsk: ['rm -rf'], network: false })
  })

  it('reads Bypass in worktrees as Bypass permissions with Only in worktrees on', async () => {
    const { saved, resolved } = await load({ version: 2, permissions: { mode: 'bypassInWorktrees' } })
    expect(saved.permissions).toEqual({ mode: 'bypassPermissions', bypassOnlyInWorktrees: true })
    expect(resolved.permissions).toMatchObject({ mode: 'bypassPermissions', bypassOnlyInWorktrees: true })
  })

  it('pins a file with no mode to Accept edits, so a later default leaves it where it was', async () => {
    const { saved, resolved } = await load({ version: 2, general: { menuBar: false } })
    expect(saved.permissions).toEqual({ mode: 'acceptEdits' })
    expect(resolved.permissions.mode).toBe('acceptEdits')
    const auto = deepMerge(DEFAULT_SETTINGS('/home/cj'), { permissions: { mode: 'auto' } })
    expect(resolveSettings(auto, saved, 'unknown').permissions.mode).toBe('acceptEdits')
    // A file from before KERNEL-225 saved Accept edits on every launch, which reads as unset, and is pinned the same way.
    expect((await load({ permissions: { mode: 'acceptEdits', network: true } })).saved.permissions).toEqual({ mode: 'acceptEdits' })
  })

  it('pins a mode Kernel does not know, and permissions that are not a table, to Accept edits', async () => {
    expect((await load({ version: 2, permissions: { mode: 'plan' } })).saved.permissions).toEqual({ mode: 'acceptEdits' })
    expect((await load({ version: 2, permissions: 'bypass' })).saved.permissions).toEqual({ mode: 'acceptEdits' })
  })

  it('keeps the new modes as saved', async () => {
    for (const mode of ['default', 'acceptEdits', 'auto'] as const) expect((await load({ version: 2, permissions: { mode } })).resolved.permissions.mode).toBe(mode)
    const { resolved } = await load({ version: 2, permissions: { mode: 'bypassPermissions', bypassOnlyInWorktrees: false } })
    expect(resolved.permissions).toMatchObject({ mode: 'bypassPermissions', bypassOnlyInWorktrees: false })
  })

  it('gives a new install, with no file, the default and pins nothing', async () => {
    const { saved, resolved } = await load()
    expect(saved).toEqual({})
    expect(resolved.permissions).toMatchObject({ mode: 'acceptEdits', bypassOnlyInWorktrees: true })
  })

  it('reads a moved mode back the same after a save', async () => {
    const { file, saved, resolved } = await load({ version: 2, permissions: { mode: 'ask' } })
    await saveAppSettings(file, saved)
    const again = await loadAppSettings(file, '/home/cj')
    expect(again.saved).toEqual(saved)
    expect(again.resolved.permissions).toEqual(resolved.permissions)
  })
})

describe('open to (replaces the default home view)', () => {
    const load = async (general?: Record<string, unknown>) => {
      const file = join(await mkdtemp(join(tmpdir(), 'kernel-settings-')), 'settings.json')
      if (general) await writeFile(file, JSON.stringify({ general }))
      return (await loadAppSettings(file, '/home/cj')).resolved.general as Record<string, unknown>
    }
    it('opens where you left off for a saved home or last room, which every launch wrote without a choice', async () => {
      for (const homeView of ['home', 'lastRoom']) {
        const g = await load({ homeView, menuBar: false })
        expect(g.openTo).toBe('lastPlace')
        expect('homeView' in g).toBe(false)
        expect(g.menuBar).toBe(false)
      }
    })
    it('keeps Inbox', async () => {
      const g = await load({ homeView: 'inbox' })
      expect(g.openTo).toBe('inbox')
      expect('homeView' in g).toBe(false)
    })
    it('keeps an openTo that was already chosen, even next to a leftover homeView', async () => {
      expect((await load({ openTo: 'home' })).openTo).toBe('home')
      expect((await load({ openTo: 'home', homeView: 'inbox' })).openTo).toBe('home')
    })
    it('defaults a fresh install, with no file, to where you left off', async () => {
      expect((await load()).openTo).toBe('lastPlace')
      expect(DEFAULT_SETTINGS('/home/cj').general.openTo).toBe('lastPlace')
    })
  })
})

describe('protected branches', () => {
  it('finds pushes that name a protected branch', () => {
    expect(pushesTo('git push origin main', ['main'])).toBe(true)
    expect(pushesTo('git push origin HEAD:dev', ['main', 'dev'])).toBe(true)
    expect(pushesTo('npm test && git push origin main', ['main'])).toBe(true)
    expect(pushesTo('git push -u origin feat/x', ['main'])).toBe(false)
    expect(pushesTo('git push', ['main'])).toBe(false)
    expect(pushesTo('echo main', ['main'])).toBe(false)
  })
  it('sees git -C and full ref names', () => {
    expect(pushesTo('git -C ../app push origin main', ['main'])).toBe(true)
    expect(pushesTo('git push origin HEAD:refs/heads/main', ['main'])).toBe(true)
    expect(pushesTo('git -c user.name=x push origin refs/heads/dev', ['dev'])).toBe(true)
    expect(pushesTo('git -C ../app push origin feat/x', ['main'])).toBe(false)
  })
  it('denies them, and only them', () => {
    const p = { neverAllow: [], alwaysAsk: [], protectedBranches: ['main'] }
    expect(bashVerdict('git push origin main', p, [])).toBe('deny')
    expect(bashVerdict('git push origin feat/x', p, [])).toBeUndefined()
  })
})

describe('network access off', () => {
  const off = { neverAllow: [], alwaysAsk: [], network: false }
  it('recognises commands that reach the network', () => {
    for (const c of ['curl https://x.dev', 'FOO=1 wget x', 'npm test && npm install left-pad', 'git -C app fetch', 'git push origin feat/x', 'gh pr create', 'echo hi | ssh box']) expect(usesNetwork(c), c).toBe(true)
    for (const c of ['npm test', 'git status', 'git commit -m "curl it"', 'ls -la', 'echo curl']) expect(usesNetwork(c), c).toBe(false)
  })
  it('denies them only while the setting is off', () => {
    expect(bashVerdict('curl https://x.dev', off, [])).toBe('deny')
    expect(bashVerdict('curl https://x.dev', { ...off, network: true }, [])).toBeUndefined()
    expect(bashVerdict('npm test', off, [])).toBeUndefined()
  })
})

describe('agents working at once', () => {
  /** Chats a, b and c belong to teammates; the ids in `leads` are chats with the Lead. */
  async function setup(agentLimit: number, leads: string[] = []) {
    const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-limit-')), 'kernel.db'))
    for (const id of ['a', 'b', 'c', ...leads]) {
      const ws: Workspace = { id: `ws-${id}`, roomId: 'room', name: id, branch: `feat/${id}`, baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: leads.includes(id) ? 'rowan' : id, port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
      const chat: Chat = { id, workspaceId: ws.id, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 }
      store.saveWorkspace(ws)
      store.saveChat(chat)
    }
    const settings = { ...DEFAULT_SETTINGS('/home/cj'), models: { ...DEFAULT_SETTINGS('/home/cj').models, agentLimit } }
    const sessions = new Sessions({ store, approvals: new Approvals(store), settings: () => settings, agentFor: (ws) => (ws.agentId === 'rowan' ? rowan : undefined), mcpFor: () => undefined, roomAllow: () => [], allowInRoom: () => {} })
    return { sessions, settings }
  }
  const rowan: AgentDef = { id: 'rowan', name: 'Rowan', role: 'Lead', description: '', lead: true, prompt: '', file: '' }
  const text = (t: string) => [{ type: 'text' as const, text: t }]
  const result = { type: 'result', subtype: 'success', is_error: false, uuid: 'r', duration_ms: 1, result: '', session_id: 's' }

  it('queues a send past the limit and starts it when a turn ends', async () => {
    const { sessions } = await setup(2)
    expect((await sessions.send('a', text('one'))).queued).toBe(false)
    expect((await sessions.send('b', text('two'))).queued).toBe(false)
    expect((await sessions.send('c', text('three'))).queued).toBe(true)
    expect(sessions.isRunning('c')).toBe(false)
    sdk.calls[sdk.calls.length - 2].feed(result)
    await flush()
    expect(sessions.isRunning('c')).toBe(true)
    expect(sessions.queued('c')).toEqual([])
  })

  it('starts waiting work when the limit goes up', async () => {
    const { sessions, settings } = await setup(1)
    await sessions.send('a', text('one'))
    expect((await sessions.send('b', text('two'))).queued).toBe(true)
    settings.models.agentLimit = 2
    sessions.applySettings()
    expect(sessions.isRunning('b')).toBe(true)
  })

  it('leaves the Lead out of the limit', async () => {
    const { sessions } = await setup(1, ['lead1', 'lead2'])
    expect((await sessions.send('lead1', text('plan'))).queued).toBe(false)
    expect((await sessions.send('a', text('one'))).queued).toBe(false)
    expect((await sessions.send('lead2', text('plan more'))).queued).toBe(false)
    expect((await sessions.send('b', text('two'))).queued).toBe(true)
  })
})

describe('defaults that fit the plan (KERNEL-225)', () => {
  const dir = () => mkdtemp(join(tmpdir(), 'kernel-settings-'))
  const fileOf = async (saved?: object) => { const file = join(await dir(), 'settings.json'); if (saved) await writeFile(file, JSON.stringify(saved)); return file }
  /** The models group as every launch saved it before KERNEL-406. */
  /** An existing file that saved no permission mode reads as Accept edits, pinned (KERNEL-432). */
  const PINNED = { permissions: { mode: 'acceptEdits' } }
  const OLD_MODELS = { lead: 'claude-opus-5-5', engineers: 'claude-sonnet-5-5', qa: 'claude-sonnet-5-5', reviewer: 'claude-opus-5-5', effort: 'high' }
  const MAX_LIKE = { roles: { lead: { model: 'claude-opus-5-5', effort: 'high' }, reviewer: { model: 'claude-sonnet-5-5', effort: 'high' }, engineers: { effort: 'high' }, qa: { effort: 'high' } }, agentLimit: 0 }

  it('reads the plan from the type `claude auth status` gives', () => {
    expect(['pro', 'Pro', 'max', 'Max', 'max_5x', 'team', 'enterprise', 'free', '', undefined, null, 7].map(planOf))
      .toEqual(['pro', 'pro', 'max', 'max', 'max', 'team', 'enterprise', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
  })

  it('gives a fresh Pro install Sonnet for Rowan and the reviewer, medium effort, two teammates and no auto review', async () => {
    const { saved, resolved } = await loadAppSettings(await fileOf(), '/home/cj', 'pro')
    expect(saved).toEqual({})
    expect(resolved.models.roles).toEqual({
      lead: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      engineers: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      qa: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
      reviewer: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }
    })
    expect(resolved.models.agentLimit).toBe(2)
    expect(resolved.pr.autoReview).toBe(false)
    expect(resolved.plan).toBe('pro')
    expect(resolved.planDefaulted).toEqual([...PLAN_KEYS])
  })

  it.each<ClaudePlan>(['max', 'team', 'enterprise', 'unknown'])('keeps everything as it was on %s, but for a Sonnet reviewer', async (plan) => {
    const { resolved } = await loadAppSettings(await fileOf(), '/home/cj', plan)
    expect(resolved.models).toMatchObject(MAX_LIKE)
    expect(resolved.pr.autoReview).toBe(true)
    expect(resolved.plan).toBe(plan)
    expect(planDefaults(plan)).toEqual({ models: { roles: { reviewer: { model: 'claude-sonnet-5-5' } } } })
  })

  it('starts the base defaults with a Sonnet reviewer and agent teams off, which nothing needs (D-104)', () => {
    expect(DEFAULT_SETTINGS('/home/cj').models).toMatchObject({ roles: { reviewer: { model: 'claude-sonnet-5-5' } }, agentTeams: false })
  })

  it('reads a file from before as unset: every launch saved the old defaults, so they pick up the plan', async () => {
    const { roles: _roles, ...rest } = DEFAULT_SETTINGS('/home/cj').models
    const file = await fileOf({ ...DEFAULT_SETTINGS('/home/cj'), models: { ...rest, ...OLD_MODELS, reviewer: 'claude-opus-5-5', agentTeams: true }, hookPort: 7421, permissions: { ...DEFAULT_SETTINGS('/home/cj').permissions, alwaysAsk: ['rm -rf', 'make deploy'] } })
    const { saved, resolved } = await loadAppSettings(file, '/home/cj', 'pro')
    // Only what differs from the defaults survives: the port, the extra rule, and agent teams, which was saved on and nobody can tell from a choice.
    expect(saved).toEqual({ hookPort: 7421, permissions: { alwaysAsk: ['rm -rf', 'make deploy'], mode: 'acceptEdits' }, models: { agentTeams: true } })
    expect(resolved.models).toMatchObject({ roles: { lead: { model: 'claude-sonnet-5-5', effort: 'medium' }, reviewer: { model: 'claude-sonnet-5-5', effort: 'medium' }, engineers: { effort: 'medium' }, qa: { effort: 'medium' } }, agentLimit: 2, agentTeams: true })
    expect(resolved.pr.autoReview).toBe(false)
    expect(resolved.hookPort).toBe(7421)
    expect(resolved.permissions.alwaysAsk).toEqual(['rm -rf', 'make deploy'])
    expect(resolved.planDefaulted).toEqual([...PLAN_KEYS])
  })

  it("reads the Address review and Create PR texts every launch saved as unset, so the new text reaches existing installs (KERNEL-222, KERNEL-468)", async () => {
    const old = '# Address review\n1. Make each requested change below. Ask if one is unclear.\n2. Run the tests and push.\n3. Reply to each comment with what changed.'
    const oldCreate = '# Create a pull request\n1. Rebase on the base branch and run the test suite.\n2. Title it as a Conventional Commit.\n3. Fill in summary, scope and risk.\n4. Open it with `gh pr create` and print the URL.'
    const full = DEFAULT_SETTINGS('/home/cj')
    const { saved, resolved } = await loadAppSettings(await fileOf({ ...full, pr: { ...full.pr, addressReviewInstructions: old, createInstructions: oldCreate } }), '/home/cj', 'max')
    expect(saved).toEqual(PINNED)
    expect(resolved.pr.addressReviewInstructions).toBe(full.pr.addressReviewInstructions)
    expect(resolved.pr.addressReviewInstructions).toContain('Act only on the comments listed here.')
    // Kernel's own Create PR text, which Create PR fits to each repo.
    expect(resolved.pr.createInstructions).toBe(full.pr.createInstructions)
    expect(resolved.pr.createInstructions).not.toContain('Conventional Commit')
    // Text someone wrote stays.
    const mine = await loadAppSettings(await fileOf({ pr: { addressReviewInstructions: '# Mine' } }), '/home/cj', 'max')
    expect(mine.saved).toEqual({ pr: { addressReviewInstructions: '# Mine' }, ...PINNED })
  })

  it('keeps only the terminal keys a file has, so one saved key does not pin the rest (KERNEL-248)', async () => {
    const { saved, resolved } = await loadAppSettings(await fileOf({ version: 2, terminal: { preset: 'shell' } }), '/home/cj', 'max')
    expect(saved).toEqual({ terminal: { preset: 'shell' }, ...PINNED })
    expect(resolved.terminal).toEqual({ ...DEFAULT_SETTINGS('/home/cj').terminal, preset: 'shell' })
    // A value Kernel can't use is still corrected, in what is saved too.
    const bad = await loadAppSettings(await fileOf({ version: 2, terminal: { preset: 7, custom: [{ id: 'codex', name: 'x', command: 'x' }] } }), '/home/cj', 'max')
    expect(bad.saved).toEqual({ terminal: { preset: 'claude', custom: [] }, ...PINNED })
  })

  it('keeps a value from before that differs from the old default', async () => {
    const full = DEFAULT_SETTINGS('/home/cj')
    const { roles: _roles, ...rest } = full.models
    const file = await fileOf({ ...full, models: { ...rest, ...OLD_MODELS, lead: 'claude-sonnet-5-5', reviewer: 'claude-haiku-4-5-20251001', effort: 'low', agentLimit: 4 }, pr: { ...full.pr, autoReview: false } })
    const { saved, resolved } = await loadAppSettings(file, '/home/cj', 'max')
    const roles = { lead: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' }, reviewer: { provider: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'low' }, engineers: { effort: 'low' }, qa: { effort: 'low' } }
    expect(saved).toEqual({ models: { roles, agentLimit: 4 }, pr: { autoReview: false }, ...PINNED })
    expect(resolved.models).toMatchObject({ roles, agentLimit: 4 })
    expect(resolved.pr.autoReview).toBe(false)
    expect(resolved.planDefaulted).toEqual([])
  })

  it("keeps a choice made after the change, even one equal to what the setting used to default to", async () => {
    const file = await fileOf({ version: 2, models: { roles: { reviewer: { provider: 'claude', model: 'claude-opus-5-5' }, lead: { effort: 'high' } } } })
    const { saved, resolved } = await loadAppSettings(file, '/home/cj', 'pro')
    expect(saved).toEqual({ models: { roles: { reviewer: { provider: 'claude', model: 'claude-opus-5-5' }, lead: { effort: 'high' } } }, ...PINNED })
    expect(resolved.models).toMatchObject({ roles: { reviewer: { model: 'claude-opus-5-5', effort: 'medium' }, lead: { model: 'claude-sonnet-5-5', effort: 'high' } }, agentLimit: 2 })
    expect(resolved.planDefaulted).toEqual(['models.roles.lead.model', 'models.roles.engineers.effort', 'models.roles.qa.effort', 'models.roles.reviewer.effort', 'models.agentLimit', 'pr.autoReview'])
  })

  it('reads a file written since KERNEL-225 with the models as they were then, keeping each choice in its role (KERNEL-406)', async () => {
    const file = await fileOf({ version: 2, models: { reviewer: 'claude-opus-5-5', effort: 'high' } })
    const { saved, resolved } = await loadAppSettings(file, '/home/cj', 'pro')
    expect(saved).toEqual({ models: { roles: { reviewer: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, lead: { effort: 'high' }, engineers: { effort: 'high' }, qa: { effort: 'high' } } }, ...PINNED })
    expect(resolved.models.roles.reviewer).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    expect(resolved.models.roles.lead).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' })
    expect(resolved.planDefaulted).toEqual(['models.roles.lead.model', 'models.agentLimit', 'pr.autoReview'])
  })

  it('writes only what is saved, with its version, and reads it back the same', async () => {
    const file = await fileOf()
    await saveAppSettings(file, { appearance: { theme: 'light' }, models: { roles: { qa: { effort: 'high' } } } })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, appearance: { theme: 'light' }, models: { roles: { qa: { effort: 'high' } } } })
    const again = await loadAppSettings(file, '/home/cj', 'pro')
    expect(again.saved).toEqual({ appearance: { theme: 'light' }, models: { roles: { qa: { effort: 'high' } } }, ...PINNED })
    expect(again.resolved.models.roles.qa.effort).toBe('high')
    expect(again.resolved.appearance.theme).toBe('light')
    // The two fields Kernel fills in are never read back from the file.
    await writeFile(file, JSON.stringify({ version: 2, plan: 'max', planDefaulted: [], models: { roles: { lead: { model: 'claude-opus-5-5' } } } }))
    expect((await loadAppSettings(file, '/home/cj', 'pro')).resolved).toMatchObject({ plan: 'pro', models: { roles: { lead: { model: 'claude-opus-5-5' } } } })
  })

  /** A Kernel on a data folder, with the account answering `plan`. */
  async function kernel(o: { settings?: object; plan?: string; dataDir?: string } = {}) {
    const dataDir = o.dataDir ?? await dir()
    const home = await dir()
    if (o.settings) await writeFile(join(dataDir, 'settings.json'), JSON.stringify(o.settings))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const account = { type: o.plan as string | undefined, signedIn: true }
    k.accountReader = async () => (account.signedIn ? { signedIn: true, name: 'Sam', ...(account.type ? { subscriptionType: account.type } : {}) } : { signedIn: false })
    return { k, dataDir, home, h: k.handlers(), account, file: join(dataDir, 'settings.json') }
  }

  it("doesn't save anything at launch, and saves only the keys a change names", async () => {
    const { k, h, file, dataDir } = await kernel()
    await expect(stat(file)).rejects.toThrow()
    expect(k.settings.planDefaulted).toEqual([...PLAN_KEYS])
    await h['settings.set']({ patch: { appearance: { theme: 'light' } } })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, appearance: { theme: 'light' } })
    // A limit pulled back into range is saved as the engine kept it. A choice equal to the default is still a choice.
    await h['settings.set']({ patch: { models: { agentLimit: 99, roles: { lead: { effort: 'high' }, engineers: { effort: 'high' }, qa: { effort: 'high' }, reviewer: { effort: 'high' } } } } })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, appearance: { theme: 'light' }, models: { agentLimit: 12, roles: { lead: { effort: 'high' }, engineers: { effort: 'high' }, qa: { effort: 'high' }, reviewer: { effort: 'high' } } } })
    expect(k.settings.planDefaulted).toEqual(['models.roles.lead.model', 'models.roles.reviewer.model', 'pr.autoReview'])
    // Kernel's own fields can't be set from Settings.
    await h['settings.set']({ patch: { plan: 'pro', planDefaulted: [], models: { effortByModel: { 'claude-opus-5-5': 'xhigh' } } } as never })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, appearance: { theme: 'light' }, models: { agentLimit: 12, roles: { lead: { effort: 'high' }, engineers: { effort: 'high' }, qa: { effort: 'high' }, reviewer: { effort: 'high' } }, effortByModel: { 'claude-opus-5-5': 'xhigh' } } })
    expect(k.settings.plan).toBe('unknown')
    await k.stop()
    // The next launch reads the same settings, and still writes nothing.
    const before = await readFile(file, 'utf8')
    const next = await kernel({ dataDir })
    expect(next.k.settings.models).toMatchObject({ agentLimit: 12, roles: { qa: { effort: 'high' } } })
    expect(await readFile(file, 'utf8')).toBe(before)
    await next.k.stop()
  })

  it("moves what a user never set when the account's plan changes, and leaves what they chose", async () => {
    const { k, h, file, dataDir, account } = await kernel({ plan: 'pro' })
    expect(k.settings.models.roles.lead.model).toBe('claude-opus-5-5')
    // The first read of the account tells the plan.
    expect(await h['account.get'](undefined)).toMatchObject({ signedIn: true, name: 'Sam' })
    expect(await h['account.get'](undefined)).not.toHaveProperty('subscriptionType')
    expect(k.settings).toMatchObject({ plan: 'pro', models: { roles: { lead: { model: 'claude-sonnet-5-5', effort: 'medium' } }, agentLimit: 2 }, pr: { autoReview: false } })
    expect((await h['settings.get'](undefined)).planDefaulted).toEqual([...PLAN_KEYS])
    // Nothing was written: a plan isn't a choice.
    await expect(stat(file)).rejects.toThrow()
    await h['settings.set']({ patch: { models: { roles: { lead: { effort: 'high' } } } } })
    account.type = 'max'
    await h['account.get'](undefined)
    expect(k.settings).toMatchObject({ plan: 'max', models: { roles: { lead: { model: 'claude-opus-5-5', effort: 'high' }, engineers: { effort: 'high' } }, agentLimit: 0 }, pr: { autoReview: true } })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, models: { roles: { lead: { effort: 'high' } } } })
    // A sign-out says nothing about the plan, so it keeps the last one.
    account.signedIn = false
    await h['account.get'](undefined)
    expect(k.settings.plan).toBe('max')
    await k.stop()
    // The next launch has the plan before it reads the account.
    const next = await kernel({ dataDir })
    expect(next.k.settings.plan).toBe('max')
    await next.k.stop()
  })

  it('runs Rowan and the reviewer on the plan-resolved models, and an agent file with a model still wins', async () => {
    const repo = await tempRepo({
      'README.md': '# x\n',
      '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nrole: Lead\nlead: true\n---\nYou are Rowan.',
      '.claude/agents/theo.md': '---\nname: theo\ndescription: Reviewer.\nrole: Reviewer\n---\nYou are Theo.',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\nrole: Frontend\n---\nYou are Kai.',
      '.claude/agents/noor.md': '---\nname: noor\ndescription: Backend.\nrole: Backend\nmodel: opus\n---\nYou are Noor.'
    })
    const { k, h } = await kernel({ plan: 'pro' })
    const room = await k.addRoom(repo)
    await h['account.get'](undefined)
    const models = async () => Object.fromEntries((await k.team.agents(room.id)).map((a) => [a.id, k.team.modelFor(a)]))
    expect(await models()).toMatchObject({ rowan: 'claude-sonnet-5-5', theo: 'claude-sonnet-5-5', kai: 'claude-sonnet-5-5', noor: 'claude-opus-5-5' })
    await h['settings.set']({ patch: { models: { roles: { lead: { provider: 'claude', model: 'claude-opus-5-5' } } } } })
    expect((await models()).rowan).toBe('claude-opus-5-5')
    await k.stop()
    const max = await kernel({ plan: 'max' })
    const room2 = await max.k.addRoom(repo)
    await max.h['account.get'](undefined)
    expect(max.k.team.modelFor((await max.k.team.agents(room2.id)).find((a) => a.lead)!)).toBe('claude-opus-5-5')
    await max.k.stop()
  })

  it("moves the hook port as a choice, saved with the rest", async () => {
    const { k, h, file } = await kernel()
    const port = k.settings.hookPort + 1
    await h['hooks.restart']({ port })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 2, hookPort: port })
    await k.stop()
  })

  it("leaves the model out of the starter agent files, so Kernel's role models decide", async () => {
    for (const id of ['rowan', 'theo', 'kai', 'noor', 'ivy']) {
      const text = await readFile(join(__dirname, '..', 'docs', 'starter-agents', `${id}.md`), 'utf8')
      expect(text.split('\n---\n')[0], id).not.toMatch(/^model:/m)
    }
  })
})
