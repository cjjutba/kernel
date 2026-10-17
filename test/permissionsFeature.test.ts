import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDef, Chat, ChatRunMode, Project, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { CODEX_AUTO, RETRY_MS } from '../src/main/features/permissions'
import { claudePolicy, policyOf, supportsAuto, type ClaudePolicy } from '../src/main/services/claudeSettings'

// The SDK's settings reader is scripted: each test says what the merged settings hold and which source set them.
const sdk = vi.hoisted(() => ({ resolved: { effective: {}, provenance: {}, sources: [] } as any, asked: [] as unknown[], filtered: 0 }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => { throw new Error('no sessions in this test') },
  resolveSettings: async (o: unknown) => { sdk.asked.push(o); return sdk.resolved },
  filterEscalatingDefaultMode: (r: { effective: Record<string, unknown> }) => { sdk.filtered++; const { permissions, ...rest } = r.effective as { permissions?: Record<string, unknown> }; const { defaultMode: _d, ...kept } = permissions ?? {}; return { ...rest, ...(permissions ? { permissions: kept } : {}) } }
}))

const flush = () => new Promise((r) => setTimeout(r, 10))
const model = (value: string, o: Partial<ModelInfo> = {}): ModelInfo => ({ value, displayName: value, description: '', ...o })

async function kernel(o: { policy?: () => Promise<ClaudePolicy>; models?: () => Promise<ModelInfo[]> } = {}) {
  const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-perm-data-')), home: await mkdtemp(join(tmpdir(), 'kernel-perm-home-')) })
  const policyReads: (string | undefined)[] = []
  let modelReads = 0
  k.permissions.readPolicy = async (cwd) => { policyReads.push(cwd); return o.policy ? o.policy() : {} }
  k.permissions.readModels = async () => { modelReads++; return o.models ? o.models() : [] }
  const moves = vi.spyOn(k.sessions, 'applyModes')
  await k.start()
  onTestFinished(() => k.stop())
  const project = k.store.saveProject({ id: 'project', name: 'invoices', path: '/tmp/invoices', defaultBranch: 'main', paused: false, createdAt: 1 } as Project)
  const ws = { id: 'ws', projectId: project.id, path: '/tmp/invoices-ws', mode: 'worktree' } as Workspace
  const chat = (o: Partial<Chat> = {}) => ({ id: 'chat', model: 'claude-sonnet-5-5', plan: false, ...o }) as Chat
  return { k, project, ws, chat, policyReads, moves, modelReads: () => modelReads }
}

describe('permissions.availability (KERNEL-447)', () => {
  it('says Auto runs on Claude when a model supports it and never on Codex, and Bypass permissions runs on both', async () => {
    const { k } = await kernel({ models: async () => [model('sonnet', { resolvedModel: 'claude-sonnet-5-5', supportsAutoMode: true }), model('haiku')] })
    expect(await k.handlers()['permissions.availability']()).toEqual({
      claude: { auto: true, bypass: true },
      codex: { auto: false, bypass: true, reason: CODEX_AUTO }
    })
  })

  it('turns a mode off on both providers when policy does, and names who turned it off', async () => {
    const { k } = await kernel({ policy: async () => ({ bypass: { admin: true }, auto: { admin: false } }), models: async () => [model('sonnet', { supportsAutoMode: true })] })
    const a = await k.handlers()['permissions.availability']()
    expect(a.claude).toEqual({ auto: false, bypass: false, reason: "Auto is turned off in your Claude Code settings. Bypass permissions is turned off by your organization's Claude Code policy." })
    expect(a.codex).toEqual({ auto: false, bypass: false, reason: `${CODEX_AUTO} Bypass permissions is turned off by your organization's Claude Code policy.` })
  })

  it("keeps Auto off on an account with no model that runs it, and both modes off when Kernel can't read the settings", async () => {
    const none = await kernel()
    expect((await none.k.handlers()['permissions.availability']()).claude).toEqual({ auto: false, bypass: true, reason: "Auto isn't available on this Claude account." })
    const broken = await kernel({ models: async () => { throw new Error('Claude Code failed to start') } })
    expect((await broken.k.handlers()['permissions.availability']()).claude).toEqual({ auto: false, bypass: true, reason: "Kernel couldn't ask Claude Code whether this account runs Auto." })
    const unread = await kernel({ policy: async () => { throw new Error('plutil failed') } })
    const a = await unread.k.handlers()['permissions.availability']()
    expect(a.claude).toMatchObject({ auto: false, bypass: false })
    expect(a.codex).toMatchObject({ auto: false, bypass: false })
  })
})

describe('what a chat can run (KERNEL-447)', () => {
  it("reads the app's policy and every open project's at launch", async () => {
    const { policyReads } = await kernel()
    expect(policyReads).toContain(undefined)
  })

  it("reads nothing for a mode that needs nothing, and the project's policy once for Bypass permissions, moving live chats when it lands", async () => {
    const { k, ws, chat, policyReads, moves } = await kernel()
    const launch = policyReads.length
    expect(k.permissions.forChat(chat(), ws, 'acceptEdits')).toEqual({ auto: false, bypass: false })
    expect(policyReads.length).toBe(launch)
    expect(k.permissions.forChat(chat(), ws, 'bypassPermissions')).toEqual({ auto: false, bypass: false })
    expect(k.permissions.forChat(chat(), ws, 'bypassPermissions')).toEqual({ auto: false, bypass: false })
    await flush()
    expect(policyReads.slice(launch)).toEqual(['/tmp/invoices'])
    expect(moves).toHaveBeenCalled()
    expect(k.permissions.forChat(chat(), ws, 'bypassPermissions')).toEqual({ auto: false, bypass: true })
  })

  it("waits before reading again after a read failed, so a broken CLI isn't started at every step", async () => {
    let fail = true
    const { k, ws, chat, policyReads } = await kernel({ policy: async () => { if (fail) throw new Error('nope'); return {} } })
    const launch = policyReads.length
    k.permissions.forChat(chat(), ws, 'bypassPermissions')
    await flush()
    fail = false
    k.permissions.forChat(chat(), ws, 'bypassPermissions')
    await flush()
    expect(policyReads.length).toBe(launch + 1)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + RETRY_MS + 1)
    onTestFinished(() => { vi.mocked(Date.now).mockRestore() })
    k.permissions.forChat(chat(), ws, 'bypassPermissions')
    await flush()
    expect(policyReads.length).toBe(launch + 2)
    expect(k.permissions.forChat(chat(), ws, 'bypassPermissions')).toEqual({ auto: false, bypass: true })
  })

  it("gives Auto to a Claude chat whose model runs it, and never to a Codex chat or another model", async () => {
    const { k, ws, chat, modelReads } = await kernel({ models: async () => [model('sonnet', { resolvedModel: 'claude-sonnet-5-5', supportsAutoMode: true }), model('claude-haiku-4-5-20251001')] })
    k.permissions.forChat(chat(), ws, 'auto')
    await flush()
    k.permissions.forChat(chat(), ws, 'auto')
    await flush()
    expect(k.permissions.forChat(chat(), ws, 'auto')).toEqual({ auto: true, bypass: true })
    expect(k.permissions.forChat(chat({ model: 'claude-haiku-4-5-20251001' }), ws, 'auto')).toEqual({ auto: false, bypass: true })
    const reads = modelReads()
    expect(k.permissions.forChat(chat({ provider: 'codex', model: 'gpt-6-astra' }), ws, 'auto')).toEqual({ auto: false, bypass: true })
    expect(modelReads()).toBe(reads)
  })

  it("reads Claude Code's models again on another account", async () => {
    const { k, ws, chat, modelReads } = await kernel({ models: async () => [model('sonnet', { resolvedModel: 'claude-sonnet-5-5', supportsAutoMode: true })] })
    k.permissions.forChat(chat(), ws, 'auto')
    await flush()
    k.permissions.forChat(chat(), ws, 'auto')
    await flush()
    expect(k.permissions.forChat(chat(), ws, 'auto')).toEqual({ auto: true, bypass: true })
    expect(modelReads()).toBe(1)
    vi.spyOn(k.providers, 'active').mockReturnValue('work')
    expect(k.permissions.forChat(chat(), ws, 'auto')).toEqual({ auto: false, bypass: true })
    await flush()
    expect(modelReads()).toBe(2)
  })

  it("moves the project's live chats when its mode changes", async () => {
    const { k, project, moves } = await kernel()
    moves.mockClear()
    await k.handlers()['projects.update']({ projectId: project.id, patch: { name: 'Invoices' } })
    expect(moves).not.toHaveBeenCalled()
    await k.handlers()['projects.update']({ projectId: project.id, patch: { permissionMode: 'bypassPermissions' } })
    expect(moves).toHaveBeenCalledTimes(1)
  })
})

describe("the mode a chat runs in, for the renderer (KERNEL-572)", () => {
  /** A chat with no process, in a current-branch workspace unless `worktree`, and every `chat.runMode` push Kernel sends for it. */
  async function idleChat(o: Parameters<typeof kernel>[0] & { worktree?: boolean } = {}) {
    const t = await kernel(o)
    t.k.store.saveWorkspace({ id: 'ws', projectId: t.project.id, name: 'invoices', branch: 'main', baseRef: 'main', path: '/tmp/invoices', mode: o.worktree ? 'worktree' : 'current', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 })
    t.k.store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Invoices', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 })
    const pushed: ChatRunMode[] = []
    const onPush = (e: PushEvent) => { if (e.type === 'chat.runMode' && e.chatId === 'chat') pushed.push(e.mode) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })
    const h = t.k.handlers()
    return { ...t, h, pushed, runMode: () => h['chats.runMode']({ chatId: 'chat' }) }
  }

  it('updates a chat that never picked a mode when Settings, Permissions changes, then follows the project and the chat', async () => {
    const { h, project, pushed, runMode } = await idleChat()
    await h['settings.set']({ patch: { permissions: { mode: 'acceptEdits' } } })
    expect(await runMode()).toEqual({ mode: 'acceptEdits', picked: 'acceptEdits', pickedIn: 'app' })
    pushed.length = 0
    await h['settings.set']({ patch: { permissions: { mode: 'default' } } })
    expect(pushed).toEqual([{ mode: 'default', picked: 'default', pickedIn: 'app' }])

    await h['projects.update']({ projectId: project.id, patch: { permissionMode: 'bypassPermissions' } })
    // Kernel reads the project's policy once Bypass permissions fits the workspace, and the chat runs in it when the read lands.
    await h['settings.set']({ patch: { permissions: { bypassOnlyInWorktrees: false } } })
    await flush()
    await h['chats.configure']({ chatId: 'chat', mode: 'default' })
    expect(pushed.slice(1)).toEqual([
      { mode: 'acceptEdits', picked: 'bypassPermissions', pickedIn: 'project', why: 'worktreesOnly' },
      { mode: 'acceptEdits', picked: 'bypassPermissions', pickedIn: 'project', why: 'noBypass' },
      { mode: 'bypassPermissions', picked: 'bypassPermissions', pickedIn: 'project' },
      { mode: 'default', picked: 'default', pickedIn: 'chat' }
    ])
    expect(await runMode()).toEqual(pushed.at(-1))
  })

  it('sends nothing when what the renderer has still holds', async () => {
    const { h, project, pushed, runMode } = await idleChat()
    await runMode()
    await h['projects.update']({ projectId: project.id, patch: { name: 'Invoices' } })
    await h['settings.set']({ patch: { permissions: { approvalTimeoutSec: 120 } } })
    await h['chats.configure']({ chatId: 'chat', effort: 'high' })
    expect(pushed).toEqual([])
  })

  it('moves a chat on Auto once Kernel learns its model runs it', async () => {
    const { h, pushed, runMode } = await idleChat({ models: async () => [model('sonnet', { resolvedModel: 'claude-sonnet-5-5', supportsAutoMode: true })] })
    await h['settings.set']({ patch: { permissions: { mode: 'auto' } } })
    expect(await runMode()).toEqual({ mode: 'acceptEdits', picked: 'auto', pickedIn: 'app', why: 'noAuto' })
    await flush()
    expect(pushed).toEqual([{ mode: 'auto', picked: 'auto', pickedIn: 'app' }])
  })

  it("says when Claude Code's settings turn Bypass permissions off", async () => {
    const { h, runMode } = await idleChat({ worktree: true, policy: async () => ({ bypass: { admin: true } }) })
    await h['chats.configure']({ chatId: 'chat', mode: 'bypassPermissions' })
    await flush()
    expect(await runMode()).toEqual({ mode: 'acceptEdits', picked: 'bypassPermissions', pickedIn: 'chat', why: 'noBypass' })
  })

  it("says when the agent file's mode is stricter, once the agent changes", async () => {
    const { k, h, pushed, runMode } = await idleChat()
    await h['chats.configure']({ chatId: 'chat', mode: 'acceptEdits' })
    expect(await runMode()).toEqual({ mode: 'acceptEdits', picked: 'acceptEdits', pickedIn: 'chat' })
    vi.spyOn(k.team, 'agentOf').mockReturnValue({ id: 'sean', permissionMode: 'default' } as AgentDef)
    k.sessions.restartIdle(['ws'])
    expect(pushed.at(-1)).toEqual({ mode: 'default', picked: 'acceptEdits', pickedIn: 'chat', why: 'agentFile' })
  })

  it('tells a new plan from the mode picked', async () => {
    const { h, runMode } = await idleChat()
    await h['settings.set']({ patch: { permissions: { mode: 'acceptEdits' } } })
    await h['chats.configure']({ chatId: 'chat', plan: true })
    expect(await runMode()).toEqual({ mode: 'plan', picked: 'acceptEdits', pickedIn: 'app', why: 'plan' })
  })
})

describe("Claude Code's settings (KERNEL-447)", () => {
  it('reads every source for a folder, and only managed policy and the user\'s for the app, after the trust filter', async () => {
    sdk.asked = []
    sdk.filtered = 0
    sdk.resolved = { effective: { disableAutoMode: 'disable', permissions: { defaultMode: 'bypassPermissions' } }, provenance: {}, sources: [{ source: 'project', settings: { disableAutoMode: 'disable' } }] }
    expect(await claudePolicy('/tmp/invoices')).toEqual({ auto: { admin: false } })
    expect(await claudePolicy()).toEqual({ auto: { admin: false } })
    expect(sdk.asked).toEqual([{ cwd: '/tmp/invoices', settingSources: ['user', 'project', 'local'] }, { settingSources: ['user'] }])
    expect(sdk.filtered).toBe(2)
  })

  it('names managed policy when it is among the sources that turn a mode off', () => {
    const bypassOff = { permissions: { disableBypassPermissionsMode: 'disable' as const } }
    expect(policyOf({ sources: [{ source: 'managed', settings: bypassOff }] }, bypassOff)).toEqual({ bypass: { admin: true } })
    expect(policyOf({ sources: [{ source: 'user', settings: bypassOff }] }, bypassOff)).toEqual({ bypass: { admin: false } })
    expect(policyOf({ sources: [] }, {})).toEqual({})
  })

  it('matches a model by its id or the id it resolves to, and reads a model it lists without the flag, or not at all, as no', () => {
    const models = [model('sonnet', { resolvedModel: 'claude-sonnet-5-5', supportsAutoMode: true }), model('opus[1m]', { supportsAutoMode: true }), model('haiku')]
    expect(supportsAuto(models, 'claude-sonnet-5-5')).toBe(true)
    expect(supportsAuto(models, 'Sonnet')).toBe(true)
    expect(supportsAuto(models, 'opus')).toBe(true)
    expect(supportsAuto(models, 'haiku')).toBe(false)
    expect(supportsAuto(models, 'claude-fable-5-1')).toBeUndefined()
  })
})
