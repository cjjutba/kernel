import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, ClaudeAccount, Provider, ProviderModel } from '@shared/types'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { warningText } from '../src/renderer/src/screens/agent/model'
import { tempRepo } from './helpers'

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
const NOOR = '---\nname: noor\ndescription: Backend engineer.\nmodel: opus\n---\nYou are Noor.'
const IVY = '---\nname: ivy\nrole: QA\ndescription: Tests things.\nmodel: gpt-6-astra\n---\nYou are Ivy.'

const codexModel = (id: string): ProviderModel => ({ provider: 'codex', id, label: id, efforts: ['medium'], defaultEffort: 'medium' })

/**
 * A project whose agents pin models, on a Kernel that checks pins. Who is signed in, and what Codex's `model/list` returns, are
 * stubs the test changes, so no read starts Claude Code or Codex.
 */
async function kernel(files: Record<string, string>, o: { checkPins?: boolean } = { checkPins: true }) {
  const repo = await tempRepo({ 'README.md': '# demo\n', ...files })
  const k = new Kernel({ dataDir: await mkdtemp(join(tmpdir(), 'kernel-data-')), home: await mkdtemp(join(tmpdir(), 'kernel-home-')), ...o })
  const state: { signedIn: Record<Provider, boolean>; codex: () => Promise<ProviderModel[]> } = {
    signedIn: { claude: true, codex: false },
    codex: async () => [codexModel('gpt-6-astra'), codexModel('gpt-5.6-luna')]
  }
  const claudeModels = k.providers.models.bind(k.providers)
  const signedIn = vi.spyOn(k.providers, 'signedIn').mockImplementation(async (p) => state.signedIn[p])
  vi.spyOn(k.providers, 'models').mockImplementation((p) => (p === 'codex' ? state.codex() : claudeModels(p)))
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const project = await k.projects.addProject(repo)
  const read = async () => {
    const team: AgentDef[] = await k.handlers()['agents.list']({ projectId: project.id })
    return Object.fromEntries(team.filter((a) => !a.builtIn).map((a) => [a.id, (a.warnings ?? []).map((w) => w.kind).filter((w) => w === 'model-unavailable' || w === 'model-unknown')]))
  }
  return { k, state, signedIn, read }
}

describe('an agent that pins a model no signed-in provider offers (KERNEL-550)', () => {
  it('warns about a Codex pin while Codex is signed out, and the next read after signing in clears it', async () => {
    const { k, state, read } = await kernel({ '.claude/agents/kai.md': KAI, '.claude/agents/noor.md': NOOR, '.claude/agents/ivy.md': IVY })
    // Kai has no model line and Noor pins Claude's Opus, which the signed-in Claude offers.
    expect(await read()).toEqual({ kai: [], noor: [], ivy: ['model-unavailable'] })
    state.signedIn.codex = true
    k.team.forgetOffers()
    expect(await read()).toEqual({ kai: [], noor: [], ivy: [] })
    // Signed in, but Codex's list doesn't offer the model.
    state.codex = async () => [codexModel('gpt-5.6-luna')]
    k.team.forgetOffers('codex')
    expect(await read()).toEqual({ kai: [], noor: [], ivy: ['model-unknown'] })
    await k.stop()
  })

  it('warns about a Claude pin while Claude is signed out, or one Claude does not offer', async () => {
    const { k, state, read } = await kernel({ '.claude/agents/noor.md': NOOR, '.claude/agents/kai.md': KAI.replace('---\nYou', 'model: claude-sonnet-3-7\n---\nYou') })
    // Signed in, so an id Kernel doesn't know isn't a sign-in problem (KERNEL-634).
    expect(await read()).toEqual({ noor: [], kai: ['model-unknown'] })
    state.signedIn.claude = false
    k.team.forgetOffers()
    expect(await read()).toEqual({ noor: ['model-unavailable'], kai: ['model-unavailable'] })
    await k.stop()
  })

  it("asks only the providers the pins name, and flags nothing when it can't tell", async () => {
    const { k, signedIn, read } = await kernel({ '.claude/agents/noor.md': NOOR, '.claude/agents/kai.md': KAI.replace('---\nYou', 'model: inherit\n---\nYou') })
    k.team.forgetOffers()
    signedIn.mockClear()
    await read()
    expect(signedIn.mock.calls).toEqual([['claude']])
    await k.stop()

    const codex = await kernel({ '.claude/agents/ivy.md': IVY })
    codex.state.signedIn.codex = true
    codex.state.codex = async () => { throw new Error('model/list failed') }
    codex.k.team.forgetOffers()
    expect(await codex.read()).toEqual({ ivy: [] })
    await codex.k.stop()
  })

  it("never asks a provider on a Kernel that doesn't check pins", async () => {
    const { k, signedIn, read } = await kernel({ '.claude/agents/ivy.md': IVY }, {})
    expect(await read()).toEqual({ ivy: [] })
    expect(signedIn).not.toHaveBeenCalled()
    await k.stop()
  })

  it('says so on Team and in Project setup', () => {
    expect(warningText({ kind: 'model-unavailable' })).toBe('Pins a model you’re not signed in for.')
    expect(warningText({ kind: 'model-unknown' })).toBe('Pins a model Kernel doesn’t recognize.')
  })
})

describe('the sign-in check behind pinned models (KERNEL-634)', () => {
  it('asks once, and again after a sign-in, a sign-out or another executable', async () => {
    const { k, state, signedIn, read } = await kernel({ '.claude/agents/noor.md': NOOR, '.claude/agents/ivy.md': IVY })
    state.signedIn.codex = true
    k.team.forgetOffers()
    const models = vi.mocked(k.providers.models)
    signedIn.mockClear(); models.mockClear()
    await read()
    const asked = { signedIn: signedIn.mock.calls.length, models: models.mock.calls.length }
    await read()
    await k.team.agents(k.store.projects()[0].id)
    expect({ signedIn: signedIn.mock.calls.length, models: models.mock.calls.length }).toEqual(asked)

    // Claude signed out, as its account push says.
    state.signedIn.claude = false
    bus.push({ type: 'account', account: { signedIn: false } as ClaudeAccount })
    expect(await read()).toEqual({ noor: ['model-unavailable'], ivy: [] })

    // Codex's list changed with its account, which `accounts` says.
    state.codex = async () => [codexModel('gpt-5.6-luna')]
    bus.push({ type: 'accounts', accounts: [] })
    expect(await read()).toEqual({ noor: ['model-unavailable'], ivy: ['model-unknown'] })
    signedIn.mockClear()
    await read()
    expect(signedIn).not.toHaveBeenCalled()

    // Claude runs from another executable now.
    state.signedIn.claude = true
    await k.providers.setPath('claude', { path: join(tmpdir(), 'no-such-claude') })
    expect(await read()).toEqual({ noor: [], ivy: ['model-unknown'] })
    await k.stop()
  })

  it("asks again after a read that couldn't tell", async () => {
    const { k, state, signedIn, read } = await kernel({ '.claude/agents/ivy.md': IVY })
    state.signedIn.codex = true
    state.codex = async () => { throw new Error('model/list failed') }
    k.team.forgetOffers()
    expect(await read()).toEqual({ ivy: [] })
    state.codex = async () => [codexModel('gpt-5.6-luna')]
    signedIn.mockClear()
    expect(await read()).toEqual({ ivy: ['model-unknown'] })
    expect(signedIn).toHaveBeenCalledTimes(1)
    await k.stop()
  })
})
