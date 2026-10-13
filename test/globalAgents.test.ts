import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentDef } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import { claudeAgents } from '../src/main/services/pluginAgents'
import { tempRepo } from './helpers'

// The stub's `supportedAgents` answers with Claude Code's list of agents, as in ownAgents.test.ts (KERNEL-463).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const stub = await import('./sdkStub')
  return { ...await original<object>(), ...stub, query: () => ({ ...stub.query(), supportedAgents: async () => LISTED }) }
})

const LISTED = [
  { name: 'Explore', description: 'Fast read-only search agent.' },
  { name: 'kit:builder', description: 'Builds features end to end and opens a PR.' },
  { name: 'gone:helper', description: 'From a plugin that left no folder.' }
]

const KIT = join('.claude', 'plugins', 'cache', 'market', 'kit', '1.0.0')
const HOME = (home: string): Record<string, string> => ({
  '.claude/agents/scout.md': '---\nname: scout\ndescription: Researcher. Finds prior art, then opens a PR.\nmodel: sonnet\nfoo: kept\n---\nYou are Scout.',
  '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'kit@market': [{ scope: 'user', installPath: join(home, KIT), version: '1.0.0' }] } }),
  [join(KIT, 'agents', 'builder.md')]: '---\nname: builder\ndescription: Builds features end to end and opens a PR.\n---\nYou build features.'
})

/** A Kernel with no rooms, a home folder with one personal agent and the kit plugin, and every push it sends. */
async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  for (const [f, text] of Object.entries(HOME(home))) { await mkdir(dirname(join(home, f)), { recursive: true }); await writeFile(join(home, f), text) }
  // A folder named like an agent file, which Kernel can't read.
  await mkdir(join(home, '.claude', 'agents', 'broken.md'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home, claudeAgents })
  onTestFinished(() => k.stop())
  await k.start()
  const pushed: AgentDef[][] = []
  const onPush = (e: PushEvent) => { if (e.type === 'globalAgents') pushed.push(e.agents) }
  bus.on('push', onPush)
  onTestFinished(() => { bus.off('push', onPush) })
  return { k, h: k.handlers(), home, pushed }
}

describe('personal and plugin agents without a room (KERNEL-640)', () => {
  it('lists the personal agents then the plugin agents with no rooms, flagged like a room flags them', async () => {
    const { k, h, home } = await boot()
    expect(k.store.rooms()).toEqual([])
    const list = await h['agents.listGlobal']({})
    expect(list.map((a) => [a.id, a.origin, a.warnings?.map((w) => w.kind)])).toEqual([
      ['broken', 'personal', ['unreadable-file']],
      ['scout', 'personal', undefined],
      ['kit:builder', 'plugin', undefined],
      ['gone:helper', 'plugin', ['unreadable-file']]
    ])
    expect(list.find((a) => a.id === 'scout')).toMatchObject({ name: 'Scout', model: 'sonnet', prompt: 'You are Scout.', file: join(home, '.claude', 'agents', 'scout.md') })
    expect(list.find((a) => a.id === 'kit:builder')).toMatchObject({ name: 'Builder', prompt: 'You build features.' })
  })

  it("rewrites a personal agent's file, and every open room and the page pick it up", async () => {
    const { k, h, home, pushed } = await boot()
    const room = await k.rooms.addRoom(await tempRepo({ 'README.md': '# shop\n' }))
    expect((await k.team.agents(room.id)).find((a) => a.id === 'scout')?.model).toBe('sonnet')
    const rooms: AgentDef[][] = []
    const onPush = (e: PushEvent) => { if (e.type === 'agents' && e.roomId === room.id) rooms.push(e.agents) }
    bus.on('push', onPush)
    onTestFinished(() => { bus.off('push', onPush) })

    const saved = await h['agents.saveGlobal']({ agentId: 'scout', patch: { model: 'opus', prompt: 'You are Scout, and you dig.' } })
    expect(saved).toMatchObject({ id: 'scout', origin: 'personal', model: 'opus', prompt: 'You are Scout, and you dig.' })
    const text = await readFile(join(home, '.claude', 'agents', 'scout.md'), 'utf8')
    expect(text).toContain('model: opus')
    // Frontmatter Kernel doesn't know stays as written.
    expect(text).toContain('foo: kept')
    // The room read its team again before the save returned, and told the renderer.
    expect(k.team.agentsSync(room.id).find((a) => a.id === 'scout')).toMatchObject({ model: 'opus', prompt: 'You are Scout, and you dig.' })
    expect(rooms.at(-1)?.find((a) => a.id === 'scout')?.model).toBe('opus')
    await vi.waitFor(() => expect(pushed.at(-1)?.find((a) => a.id === 'scout')?.model).toBe('opus'), { timeout: 5000 })
  })

  it("refuses to save a plugin agent, and leaves the plugin's file as it is", async () => {
    const { h, home } = await boot()
    const file = join(home, KIT, 'agents', 'builder.md')
    const before = await readFile(file, 'utf8')
    await expect(h['agents.saveGlobal']({ agentId: 'kit:builder', patch: { model: 'opus' } })).rejects.toThrow("Builder comes from the kit plugin, and Kernel doesn't change a plugin's files.")
    await expect(h['agents.saveGlobal']({ agentId: 'nobody', patch: { model: 'opus' } })).rejects.toThrow('nobody is not in ~/.claude/agents.')
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('pushes the list when ~/.claude/agents changes, with no rooms', async () => {
    const { h, home, pushed } = await boot()
    await h['agents.listGlobal']({})
    await writeFile(join(home, '.claude', 'agents', 'mira.md'), '---\nname: mira\ndescription: Writer. Drafts release notes.\n---\nYou are Mira.')
    await vi.waitFor(() => expect(pushed.at(-1)?.map((a) => a.id)).toContain('mira'), { timeout: 5000 })
    expect(pushed.at(-1)?.find((a) => a.id === 'mira')).toMatchObject({ origin: 'personal', role: 'Writer' })
  })

  it('drafts and creates a personal agent with no rooms, and the page hears of it', async () => {
    const { k, h, home, pushed } = await boot()
    expect(k.store.rooms()).toEqual([])
    await h['agents.listGlobal']({})
    const draft = await h['agents.draft']({ description: 'Writer. Drafts release notes.', name: 'Mira' })
    expect(draft).toMatchObject({ id: 'mira', name: 'Mira' })
    const mira = await h['agents.create']({ draft })
    expect(mira).toMatchObject({ id: 'mira', origin: 'personal', file: join(home, '.claude', 'agents', 'mira.md') })
    expect(await readFile(join(home, '.claude', 'agents', 'mira.md'), 'utf8')).toBe(`${draft.text.trimEnd()}\n`)
    expect((await h['agents.listGlobal']({})).find((a) => a.id === 'mira')).toMatchObject({ origin: 'personal' })
    await vi.waitFor(() => expect(pushed.at(-1)?.map((a) => a.id)).toContain('mira'), { timeout: 5000 })
  })

  it('refuses a team agent with no room, and writes nothing', async () => {
    const { h, home } = await boot()
    const draft = await h['agents.draft']({ description: 'QA. Runs the tests.', name: 'Ivy' })
    await expect(h['agents.create']({ draft, scope: 'team' })).rejects.toThrow("A team agent is saved in a room's repo. Open a room to add one.")
    await expect(readFile(join(home, '.claude', 'agents', 'ivy.md'), 'utf8')).rejects.toThrow()
  })

  it('creates with no room open, and a room Kernel has read picks the agent up', async () => {
    const { k, h } = await boot()
    const room = await k.rooms.addRoom(await tempRepo({ 'README.md': '# shop\n', '.claude/agents/ivy.md': '---\nname: ivy\ndescription: QA.\n---\nYou are Ivy.' }))
    await k.team.agents(room.id)
    // A room's file would win over the user's own, so its names are taken.
    const ivy = await h['agents.draft']({ description: 'QA. Runs the tests.', name: 'Ivy' })
    await expect(h['agents.create']({ draft: ivy })).rejects.toThrow('Ivy is already on the team.')
    const nia = await h['agents.draft']({ description: 'Docs writer. Keeps the README current.', name: 'Nia' })
    await h['agents.create']({ draft: nia })
    expect(k.team.agentsSync(room.id).find((a) => a.id === 'nia')).toMatchObject({ origin: 'personal' })
  })
})
