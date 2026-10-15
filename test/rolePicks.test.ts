import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Workspace } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { agentFromFile, updateAgent } from '../src/main/services/agents'
import { tempRepo } from './helpers'
import { fakeCodex } from './helpers/fakeCodex'

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
const IVY = '---\nname: ivy\nrole: QA\ndescription: Tests things.\n---\nYou are Ivy.'

async function kernel(files: Record<string, string> = { '.claude/agents/kai.md': KAI }) {
  const repo = await tempRepo({ 'README.md': '# demo\n', ...files })
  const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
  await k.start()
  // No session starts: the chats are what's under test.
  k.sessions.send = async () => ({ queued: false })
  const room = await k.addRoom(repo)
  return { k, room, repo }
}

const agent = (o: Partial<AgentDef>): AgentDef => ({ id: 'kai', name: 'Kai', role: 'Frontend', description: '', lead: false, prompt: '', file: '', ...o })

describe('which provider, model and effort an agent runs on (KERNEL-406)', () => {
  it("takes the role's default from Settings, and the file's effort over the role's", async () => {
    const { k } = await kernel()
    await k.config.setSettings({ models: { roles: { engineers: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' }, qa: { provider: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'low' } } } })
    expect(k.team.pickFor(agent({}))).toEqual({ provider: 'codex', model: 'gpt-6-astra', effort: 'medium' })
    expect(k.team.pickFor(agent({ effort: 'xhigh' }))).toEqual({ provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' })
    expect(k.team.pickFor(agent({ role: 'QA' }))).toEqual({ provider: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'low' })
    expect(k.team.pickFor(agent({ lead: true }))).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    await k.stop()
  })

  it("reads a review chat as the reviewer's, and a chat with no agent as the Lead's or an engineer's (feat-compact-window-per-role-with-plan)", async () => {
    const { k, room } = await kernel()
    const ws = (o: Partial<Workspace>): Workspace => ({ id: 'ws', roomId: room.id, name: 'w', branch: 'feat/w', baseRef: 'main', path: '/tmp/w', mode: 'worktree', agentId: 'kai', port: 4300, status: 'ready', prState: 'none', createdAt: 1, ...o })
    expect(k.team.roleFor(ws({}), agent({}))).toBe('engineers')
    expect(k.team.roleFor(ws({}), agent({ role: 'QA' }))).toBe('qa')
    expect(k.team.roleFor(ws({ lead: true }), agent({ lead: true }))).toBe('lead')
    // A review is the reviewer's whichever agent runs it, an engineer and one that pins a model included.
    expect(k.team.roleFor(ws({ reviewOf: 'other' }), agent({}))).toBe('reviewer')
    expect(k.team.roleFor(ws({ reviewOf: 'other' }), agent({ lead: true, model: 'opus' }))).toBe('reviewer')
    expect(k.team.roleFor(ws({ reviewOf: 'other' }), undefined)).toBe('reviewer')
    // A pinned model changes the model, not the role.
    expect(k.team.roleFor(ws({}), agent({ role: 'QA', model: 'opus' }))).toBe('qa')
    expect(k.team.roleFor(ws({ lead: true }), undefined)).toBe('lead')
    expect(k.team.roleFor(ws({}), undefined)).toBe('engineers')
    await k.stop()
  })

  it("lets the agent file's model pin that agent, on its provider line or the one its model belongs to", async () => {
    const { k } = await kernel()
    await k.config.setSettings({ models: { roles: { engineers: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } } } })
    expect(k.team.pickFor(agent({ model: 'opus' }))).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' })
    expect(k.team.pickFor(agent({ model: 'claude-sonnet-5-5', effort: 'high' }))).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' })
    expect(k.team.pickFor(agent({ model: 'gpt-5.6-luna' }))).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna' })
    expect(k.team.pickFor(agent({ model: 'my-local-model', provider: 'codex' }))).toMatchObject({ provider: 'codex', model: 'my-local-model' })
    // `inherit`, or a model Kernel can't place, follows the role as it always did.
    expect(k.team.pickFor(agent({ model: 'inherit' }))).toEqual({ provider: 'codex', model: 'gpt-6-astra', effort: 'medium' })
    await k.stop()
  })

  it('starts a hand-off on the role default, and on the agent alone when its file pins a model', async () => {
    const { k, room } = await kernel({ '.claude/agents/kai.md': KAI, '.claude/agents/ivy.md': IVY.replace('role: QA', 'role: QA\nmodel: gpt-5.6-luna\nprovider: codex') })
    await k.config.setSettings({ models: { roles: { engineers: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' } } } })
    const kai = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai' })
    expect(k.store.chats(kai.id)[0]).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', effort: 'high' })
    const ivy = await k.createWorkspace(room.id, { prompt: 'Test it', agentId: 'ivy' })
    expect(k.store.chats(ivy.id)[0]).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna' })
    // A model picked in New workspace runs on its own provider.
    const picked = await k.createWorkspace(room.id, { prompt: 'Again', agentId: 'kai', model: 'claude-opus-5-5', effort: 'low' })
    expect(k.store.chats(picked.id)[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
    expect(k.store.chats(picked.id)[0].provider).toBeUndefined()
    await k.stop()
  })

  it('leaves chats exactly as before while every role runs on Claude', async () => {
    const { k, room } = await kernel()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai' })
    const chat = k.store.chats(ws.id)[0]
    expect(chat).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
    expect(chat).not.toHaveProperty('provider')
    await k.stop()
  })

  it('opens "New chat on Codex" on the agent\'s Codex pick, and keeps a started chat on its provider', async () => {
    const { k, room } = await kernel()
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai' })
    const h = k.handlers()
    // No Codex role: the tab asks for Codex's models, which come from Codex itself, so the test names one.
    const tab = await h['chats.create']({ workspaceId: ws.id, provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium' })
    expect(tab).toMatchObject({ provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium' })
    await k.config.setSettings({ models: { roles: { engineers: { provider: 'codex', model: 'gpt-6-astra', effort: 'low' } } } })
    expect(await h['chats.create']({ workspaceId: ws.id, provider: 'codex' })).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' })
    // A plain new tab follows the workspace's first chat, as before.
    expect(await h['chats.create']({ workspaceId: ws.id })).toMatchObject({ model: 'claude-sonnet-5-5' })
    const first = k.store.chats(ws.id)[0]
    k.store.saveChat({ ...first, sessionId: 'session-1' })
    await expect(h['chats.configure']({ chatId: first.id, model: 'gpt-6-astra' })).rejects.toThrow('Start a new chat to use gpt-6-astra')
    // One that hasn't started moves to the other provider.
    expect(await h['chats.configure']({ chatId: tab.id, model: 'claude-opus-5-5' })).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' })
    await k.stop()
  })

  it("lists Claude's models with their efforts, the current ones first and the older ones marked legacy", async () => {
    const { k } = await kernel()
    const models = await k.handlers()['models.list']({ provider: 'claude' })
    expect(models.filter((m) => !m.legacy).map((m) => m.id)).toEqual(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])
    expect(models.slice(0, 4).every((m) => !m.legacy)).toBe(true)
    expect(models.find((m) => m.id === 'claude-opus-4-8')).toMatchObject({ label: 'Opus 4.8', legacy: true })
    expect(models[0]).toMatchObject({ provider: 'claude', label: 'Fable 5.1', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' })
    await k.stop()
  })

  it("marks Codex's older models legacy: a lower major version, or the same name at a lower version", async () => {
    const fake = await fakeCodex()
    process.env.FAKE_CODEX_MODELS = JSON.stringify(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna', 'codex-mini'])
    try {
      const { k } = await kernel()
      await k.providers.setPath('codex', { path: fake.bin })
      const models = await k.handlers()['models.list']({ provider: 'codex' })
      expect(models.filter((m) => m.legacy).map((m) => m.id)).toEqual(['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-luna'])
      await k.stop()
    } finally { delete process.env.FAKE_CODEX_MODELS }
  })
})

describe("an agent file's provider line (KERNEL-406)", () => {
  it('reads provider with a model, and drops it with the model when the pin is cleared', async () => {
    expect(agentFromFile('/r/.claude/agents/ivy.md', '---\nname: ivy\ndescription: QA.\nmodel: gpt-5.6-luna\nprovider: codex\neffort: max\n---\nHi')).toMatchObject({ model: 'gpt-5.6-luna', provider: 'codex', effort: 'max' })
    expect(agentFromFile('/r/.claude/agents/ivy.md', '---\nname: ivy\ndescription: QA.\nprovider: codex\n---\nHi').provider).toBeUndefined()
    const repo = await tempRepo({ '.claude/agents/ivy.md': '---\nname: ivy\ndescription: QA.\ncolor: green\n---\nHi' })
    expect(await updateAgent(repo, 'ivy', { model: 'gpt-6-astra', provider: 'codex' })).toMatchObject({ model: 'gpt-6-astra', provider: 'codex' })
    expect(await readFile(join(repo, '.claude/agents/ivy.md'), 'utf8')).toBe('---\nname: ivy\ndescription: QA.\ncolor: green\nmodel: gpt-6-astra\nprovider: codex\n---\n\nHi\n')
    const cleared = await updateAgent(repo, 'ivy', { model: '' })
    expect(cleared.model).toBeUndefined()
    expect(cleared.provider).toBeUndefined()
    expect(await readFile(join(repo, '.claude/agents/ivy.md'), 'utf8')).toBe('---\nname: ivy\ndescription: QA.\ncolor: green\n---\n\nHi\n')
  })
})
