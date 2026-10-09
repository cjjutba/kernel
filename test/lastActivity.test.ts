import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { actions, apply, getState } from '../src/renderer/src/store'
import { roomSeating } from '../src/renderer/src/floor/useSeating'
import type { ActivityEvent, AgentDef } from '../src/shared/types'

const TEAM = ['eli', 'eli-opus', 'ivy', 'kai', 'lumi', 'noor', 'rowan', 'theo']
const agentFile = (id: string) => `---\nname: ${id}\ndescription: ${id}.\n${id === 'rowan' ? 'lead: true\n' : ''}---\nYou are ${id}.`

describe('rooms.lastActivity (KERNEL-104)', () => {
  it("returns each agent's newest event from the whole log, so seating holds past the 200-event window", async () => {
    const repo = await tempRepo({ 'README.md': '# r\n', ...Object.fromEntries(TEAM.map((id) => [`.claude/agents/${id}.md`, agentFile(id)])) })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900) }))
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    await k.start()
    const room = await k.addRoom(repo)
    const other = await k.addRoom(await tempRepo())
    try {
      const agents = await k.agents(room.id)
      const h = k.handlers()

      // Everyone acted once, a while ago. Then Eli logged 250 events, which push the others out of any 200-event window.
      const t = Date.now() + 10_000
      const once: Record<string, number> = { theo: t + 50, noor: t + 40, rowan: t + 60, kai: t + 30, ivy: t + 20 }
      for (const [agentId, ts] of Object.entries(once)) bus.activity({ kind: 'note', roomId: room.id, agentId, text: 'did something', ts })
      bus.activity({ kind: 'note', roomId: other.id, agentId: 'lumi', text: 'worked in another room', ts: t + 5000 })
      for (let i = 0; i < 250; i++) bus.activity({ kind: 'tool.end', roomId: room.id, agentId: 'eli', text: 'ran a tool', ts: t + 100 + i })
      bus.activity({ kind: 'room.paused', roomId: room.id, actor: 'you', text: 'paused', ts: t + 9000 })

      const last = await h['rooms.lastActivity']({ roomId: room.id })
      expect(last).toEqual({ ...once, eli: t + 349 })
      expect(last.lumi).toBeUndefined()
      expect(last['eli-opus']).toBeUndefined()

      const window = await h['activity.recent']({ roomId: room.id, limit: 200 })
      expect(new Set(window.flatMap((e) => (e.agentId ? [e.agentId] : [])))).toEqual(new Set(['eli']))

      const seats = (ctx: Parameters<typeof roomSeating>[2]) => roomSeating(agents, room, ctx).seated.map((a) => a.id)
      expect(seats({ lastActivity: last })).toEqual(['rowan', 'eli', 'theo', 'noor', 'kai', 'ivy'])
    } finally { await k.stop() }
  })
})

describe('store lastActivity', () => {
  const a = (id: string, lead = false): AgentDef => ({ id, name: id, role: 'Dev', description: '', lead, prompt: '', file: `${id}.md` })
  const ev = (agentId: string, ts: number, roomId = 'r-last'): ActivityEvent => ({ id: `${agentId}-${ts}-${roomId}`, kind: 'note', roomId, agentId, text: 'did something', ts })

  it('keeps an agent ranked after its events leave the window, and new events move it forward', () => {
    actions.activity.setLast('r-last', { noor: 40, theo: 50, eli: 10 })
    for (let i = 0; i < 250; i++) apply({ type: 'activity', event: ev('kai', 100 + i) })
    expect(getState().activity.some((e) => e.agentId === 'noor')).toBe(false)
    expect(getState().lastActivity['r-last']).toEqual({ noor: 40, theo: 50, eli: 10, kai: 349 })

    const team = [a('eli'), a('eli-opus'), a('kai'), a('noor'), a('rowan', true), a('theo')]
    const seats = () => roomSeating(team, undefined, { lastActivity: getState().lastActivity['r-last'] }).seated.map((x) => x.id)
    expect(seats()).toEqual(['rowan', 'kai', 'theo', 'noor', 'eli', 'eli-opus'])

    apply({ type: 'activity', event: ev('noor', 400) })
    expect(seats()).toEqual(['rowan', 'noor', 'kai', 'theo', 'eli', 'eli-opus'])
  })

  it('keeps a newer pushed time over an older loaded one, and leaves other rooms alone', () => {
    apply({ type: 'activity', event: ev('ivy', 900, 'r-race') })
    const before = getState().lastActivity
    actions.activity.setLast('r-race', { ivy: 800, lumi: 700 })
    expect(getState().lastActivity['r-race']).toEqual({ ivy: 900, lumi: 700 })
    expect(getState().lastActivity['r-last']).toBe(before['r-last'])
    apply({ type: 'activity', event: { ...ev('ivy', 1000), roomId: undefined } })
    expect(getState().lastActivity['r-race'].ivy).toBe(900)
  })
})
