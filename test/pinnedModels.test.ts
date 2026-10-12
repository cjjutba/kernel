import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Provider, ProviderModel } from '@shared/types'
import { Kernel } from '../src/main/kernel'
import { warningText } from '../src/renderer/src/screens/team/model'
import { tempRepo } from './helpers'

const KAI = '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.'
const NOOR = '---\nname: noor\ndescription: Backend engineer.\nmodel: opus\n---\nYou are Noor.'
const IVY = '---\nname: ivy\nrole: QA\ndescription: Tests things.\nmodel: gpt-6-astra\n---\nYou are Ivy.'

const codexModel = (id: string): ProviderModel => ({ provider: 'codex', id, label: id, efforts: ['medium'], defaultEffort: 'medium' })

/**
 * A room whose agents pin models, on a Kernel that checks pins. Who is signed in, and what Codex's `model/list` returns, are
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
  const room = await k.rooms.addRoom(repo)
  const read = async () => {
    const team: AgentDef[] = await k.handlers()['agents.list']({ roomId: room.id })
    return Object.fromEntries(team.filter((a) => !a.builtIn).map((a) => [a.id, (a.warnings ?? []).map((w) => w.kind).filter((w) => w === 'model-unavailable')]))
  }
  return { k, state, signedIn, read }
}

describe('an agent that pins a model no signed-in provider offers (KERNEL-550)', () => {
  it('warns about a Codex pin while Codex is signed out, and the next read after signing in clears it', async () => {
    const { k, state, read } = await kernel({ '.claude/agents/kai.md': KAI, '.claude/agents/noor.md': NOOR, '.claude/agents/ivy.md': IVY })
    // Kai has no model line and Noor pins Claude's Opus, which the signed-in Claude offers.
    expect(await read()).toEqual({ kai: [], noor: [], ivy: ['model-unavailable'] })
    state.signedIn.codex = true
    expect(await read()).toEqual({ kai: [], noor: [], ivy: [] })
    // Signed in, but Codex's list doesn't offer the model.
    state.codex = async () => [codexModel('gpt-5.6-luna')]
    expect(await read()).toEqual({ kai: [], noor: [], ivy: ['model-unavailable'] })
    await k.stop()
  })

  it('warns about a Claude pin while Claude is signed out, or one Claude does not offer', async () => {
    const { k, state, read } = await kernel({ '.claude/agents/noor.md': NOOR, '.claude/agents/kai.md': KAI.replace('---\nYou', 'model: claude-sonnet-3-7\n---\nYou') })
    expect(await read()).toEqual({ noor: [], kai: ['model-unavailable'] })
    state.signedIn.claude = false
    expect(await read()).toEqual({ noor: ['model-unavailable'], kai: ['model-unavailable'] })
    await k.stop()
  })

  it("asks only the providers the pins name, and flags nothing when it can't tell", async () => {
    const { k, signedIn, read } = await kernel({ '.claude/agents/noor.md': NOOR, '.claude/agents/kai.md': KAI.replace('---\nYou', 'model: inherit\n---\nYou') })
    signedIn.mockClear()
    await read()
    expect(signedIn.mock.calls).toEqual([['claude']])
    await k.stop()

    const codex = await kernel({ '.claude/agents/ivy.md': IVY })
    codex.state.signedIn.codex = true
    codex.state.codex = async () => { throw new Error('model/list failed') }
    expect(await codex.read()).toEqual({ ivy: [] })
    await codex.k.stop()
  })

  it("never asks a provider on a Kernel that doesn't check pins", async () => {
    const { k, signedIn, read } = await kernel({ '.claude/agents/ivy.md': IVY }, {})
    expect(await read()).toEqual({ ivy: [] })
    expect(signedIn).not.toHaveBeenCalled()
    await k.stop()
  })

  it('says so on Team and in Room setup', () => {
    expect(warningText({ kind: 'model-unavailable' })).toBe('Pins a model you’re not signed in for.')
  })
})
