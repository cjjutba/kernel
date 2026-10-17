import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, freePort } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { actions, apply, getState } from '../src/renderer/src/store'
import type { ActivityEvent } from '../src/shared/types'

const TEAM = ['eli', 'eli-opus', 'teng', 'christian', 'sean', 'kernel', 'artkin', 'wren']
const agentFile = (id: string) => `---\nname: ${id}\ndescription: ${id}.\n${id === 'kernel' ? 'lead: true\n' : ''}---\nYou are ${id}.`

describe('projects.lastActivity (KERNEL-104)', () => {
  it("returns each agent's newest event from the whole log, so it holds past the 200-event window", async () => {
    const repo = await tempRepo({ 'README.md': '# r\n', ...Object.fromEntries(TEAM.map((id) => [`.claude/agents/${id}.md`, agentFile(id)])) })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort() }))
    const k = new Kernel({ dataDir, home: await mkdtemp(join(tmpdir(), 'kernel-home-')) })
    await k.start()
    const project = await k.addProject(repo)
    const other = await k.addProject(await tempRepo())
    try {
      const h = k.handlers()

      // Everyone acted once, a while ago. Then Eli logged 250 events, which push the others out of any 200-event window.
      const t = Date.now() + 10_000
      const once: Record<string, number> = { artkin: t + 50, sean: t + 40, kernel: t + 60, christian: t + 30, teng: t + 20 }
      for (const [agentId, ts] of Object.entries(once)) bus.activity({ kind: 'note', projectId: project.id, agentId, text: 'did something', ts })
      bus.activity({ kind: 'note', projectId: other.id, agentId: 'wren', text: 'worked in another project', ts: t + 5000 })
      for (let i = 0; i < 250; i++) bus.activity({ kind: 'tool.end', projectId: project.id, agentId: 'eli', text: 'ran a tool', ts: t + 100 + i })
      bus.activity({ kind: 'project.paused', projectId: project.id, actor: 'you', text: 'paused', ts: t + 9000 })

      const last = await h['projects.lastActivity']({ projectId: project.id })
      expect(last).toEqual({ ...once, eli: t + 349 })
      expect(last.wren).toBeUndefined()
      expect(last['eli-opus']).toBeUndefined()

      const window = await h['activity.recent']({ projectId: project.id, limit: 200 })
      expect(new Set(window.flatMap((e) => (e.agentId ? [e.agentId] : [])))).toEqual(new Set(['eli']))
    } finally { await k.stop() }
  })
})

describe('store lastActivity', () => {
  const ev = (agentId: string, ts: number, projectId = 'r-last'): ActivityEvent => ({ id: `${agentId}-${ts}-${projectId}`, kind: 'note', projectId, agentId, text: 'did something', ts })

  it('keeps an agent\'s time after its events leave the window, and new events move it forward', () => {
    actions.activity.setLast('r-last', { sean: 40, artkin: 50, eli: 10 })
    for (let i = 0; i < 250; i++) apply({ type: 'activity', event: ev('christian', 100 + i) })
    expect(getState().activity.some((e) => e.agentId === 'sean')).toBe(false)
    expect(getState().lastActivity['r-last']).toEqual({ sean: 40, artkin: 50, eli: 10, christian: 349 })

    apply({ type: 'activity', event: ev('sean', 400) })
    expect(getState().lastActivity['r-last']).toEqual({ sean: 400, artkin: 50, eli: 10, christian: 349 })
  })

  it('keeps a newer pushed time over an older loaded one, and leaves other projects alone', () => {
    apply({ type: 'activity', event: ev('teng', 900, 'r-race') })
    const before = getState().lastActivity
    actions.activity.setLast('r-race', { teng: 800, wren: 700 })
    expect(getState().lastActivity['r-race']).toEqual({ teng: 900, wren: 700 })
    expect(getState().lastActivity['r-last']).toBe(before['r-last'])
    apply({ type: 'activity', event: { ...ev('teng', 1000), projectId: undefined } })
    expect(getState().lastActivity['r-race'].teng).toBe(900)
  })
})
