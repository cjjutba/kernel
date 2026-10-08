import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '../src/shared/types'
import { earlierLabel, foldText, foldWhat, foldWho, isQuiet, logDays, logRows } from '../src/renderer/src/floor/logs'

// Vitest's esbuild compiles Logs.tsx with the classic JSX runtime, which looks for a global React.
Object.assign(globalThis, { React })

// The root tsconfig (main, preload, tests) sets no `jsx`, so it cannot import a .tsx file. Load it by path.
interface LogsModule {
  ShowEverything: (p: { on: boolean; onChange: (on: boolean) => void }) => React.ReactElement
  readEverything: () => boolean
  keepEverything: (on: boolean) => void
}
const logsPath = '../src/renderer/src/screens/floor/Logs'
const loadLogs = () => import(/* @vite-ignore */ logsPath) as Promise<LogsModule>

const NOW = new Date(2026, 9, 9, 15, 0).getTime()
const at = (min: number) => NOW - min * 60_000
let n = 0
const ev = (kind: ActivityEvent['kind'], min: number, rest: Partial<ActivityEvent> = {}): ActivityEvent =>
  ({ id: `e${++n}`, ts: at(min), roomId: 'r', agentId: 'rowan', kind, text: kind, ...rest })
const kinds = (rows: { event: ActivityEvent }[]) => rows.map((r) => r.event.kind)

describe('logs filter', () => {
  const lifecycle = [
    ev('session.start', 9), ev('session.end', 8), ev('turn.done', 7), ev('tool.start', 6), ev('tool.end', 5),
    ev('workspace.archived', 4), ev('workspace.restored', 3), ev('agent.status', 2),
    ev('note', 1, { text: 'heard from Kernel about', data: { leadUpdate: true } })
  ]
  const work = [
    ev('brief', 20, { actor: 'you' }), ev('prompt', 19), ev('task.created', 18), ev('task.assigned', 17), ev('task.completed', 16),
    ev('workspace.created', 15), ev('pr.changed', 14), ev('approval.requested', 13), ev('approval.decided', 12), ev('overlap', 11),
    ev('limit', 10), ev('room.paused', 9), ev('room.resumed', 8), ev('agent.joined', 7), ev('agent.retired', 6), ev('agent.talk', 5),
    ev('note', 4), ev('checkpoint.reverted', 3), ev('tool.failed', 2)
  ]

  it('hides lifecycle events and keeps what the team did', () => {
    const all = [...work, ...lifecycle].sort((a, b) => b.ts - a.ts)
    expect(lifecycle.every(isQuiet)).toBe(true)
    expect(work.some(isQuiet)).toBe(false)
    expect(logRows(all).map((r) => r.event.id).sort()).toEqual(work.map((e) => e.id).sort())
  })

  it('keeps notes that are not Lead updates', () => {
    expect(isQuiet(ev('note', 1, { data: { leadUpdate: false } }))).toBe(false)
    expect(isQuiet(ev('note', 1, { data: { detail: 'x' } }))).toBe(false)
  })

  it('shows every event with everything on', () => {
    const all = [...work, ...lifecycle].sort((a, b) => b.ts - a.ts)
    expect(logRows(all, true).flatMap((r) => [r.event, ...r.earlier])).toHaveLength(all.length)
  })

  it('keeps a failed tool call, with the object of its hidden start', () => {
    const start = ev('tool.start', 3, { object: 'npm test', data: { toolUseId: 't1' } })
    const failed = ev('tool.failed', 2, { text: 'failed', data: { toolUseId: 't1' } })
    const rows = logRows([failed, start])
    expect(kinds(rows)).toEqual(['tool.failed'])
    expect(rows[0].event.object).toBe('npm test')
  })

  it('folds failed tool calls into one run and words it as failures', () => {
    const rows = logRows([ev('tool.failed', 1), ev('tool.end', 2), ev('tool.failed', 3)])
    expect(rows).toHaveLength(1)
    expect(rows[0].earlier).toHaveLength(1)
    expect(earlierLabel(1, true)).toBe('1 earlier failed tool call')
    expect(earlierLabel(3)).toBe('3 earlier tool calls')
  })

  it('still folds tool calls into a run with everything on', () => {
    const rows = logRows([ev('tool.end', 1), ev('tool.start', 2, { data: { toolUseId: 'x' } }), ev('tool.end', 3)], true)
    expect(rows.filter((r) => r.earlier.length > 0)).toHaveLength(1)
    expect(rows[0].fold).toBeUndefined()
  })

  it('keeps a day heading with no rows when the day is all hidden', () => {
    const yesterday = new Date(2026, 9, 8, 12, 0).getTime()
    const events = [ev('brief', 5), { ...ev('turn.done', 0), ts: yesterday }, { ...ev('session.start', 0), ts: yesterday - 1000 }]
    expect(logDays(events, false, NOW).map((d) => [d.label, d.rows.length])).toEqual([['Today', 1], ['Yesterday', 0]])
    expect(logDays(events, true, NOW).map((d) => [d.label, d.rows.length])).toEqual([['Today', 1], ['Yesterday', 2]])
    expect(logDays([], false, NOW)).toEqual([])
  })
})

describe('logs fold', () => {
  const archived = (min: number, agentId: string) => ev('workspace.archived', min, { agentId, text: 'archived', object: `ws-${min}` })

  it('folds neighbors of one kind into the newest, with the rest under earlier', () => {
    const rows = logRows([archived(1, 'theo'), archived(2, 'noor'), archived(3, 'kai')], true)
    expect(rows).toHaveLength(1)
    expect(rows[0].fold).toEqual({ verb: 'archived', one: 'workspace', many: 'workspaces' })
    expect(rows[0].event.object).toBe('ws-1')
    expect(rows[0].earlier.map((e) => e.object)).toEqual(['ws-2', 'ws-3'])
  })

  it('words one actor and several actors', () => {
    const f = { verb: 'assigned', one: 'task', many: 'tasks' }
    expect(foldText(['Rowan', 'Rowan', 'Rowan', 'Rowan'], f, 4)).toBe('Rowan assigned 4 tasks')
    expect(foldText(['Theo', 'Noor', 'Kai', 'Theo'], { verb: 'archived', one: 'workspace', many: 'workspaces' }, 8)).toBe('Theo, Noor and Kai archived 8 workspaces')
    expect(foldWho(['Theo', 'Noor'])).toBe('Theo and Noor')
    expect(foldWhat(f, 2)).toBe('assigned 2 tasks')
  })

  it('folds the Lead assigning tasks, but not into a different kind of event', () => {
    const rows = logRows([
      ev('workspace.created', 1, { text: 'assigned Fix the table to' }), ev('workspace.created', 2, { text: 'assigned Add PDF to' }),
      ev('workspace.created', 3, { text: 'assigned Add CSV to' }), ev('task.assigned', 4, { text: 'assigned it to' })
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].earlier).toHaveLength(2)
    expect(foldWhat(rows[0].fold!, 3)).toBe('assigned 3 tasks')
    expect(rows[1].fold).toBeUndefined()
  })

  it('folds hand-offs, where each assignment also logs the agent starting its workspace', () => {
    const handoff = (min: number, ws: string) => [
      ev('workspace.created', min, { workspaceId: ws, agentId: 'kai', text: 'started', object: ws }),
      ev('workspace.created', min - 0.1, { workspaceId: ws, text: `assigned ${ws} to` })
    ]
    const events = [...handoff(1, 'a'), ...handoff(2, 'b'), ...handoff(3, 'c'), ...handoff(4, 'd')].sort((x, y) => y.ts - x.ts)
    const rows = logRows(events)
    expect(rows).toHaveLength(1)
    expect(rows[0].earlier).toHaveLength(3)
    expect(foldText(['Rowan'], rows[0].fold!, 4)).toBe('Rowan assigned 4 tasks')
    expect(logRows(events, true).flatMap((r) => [r.event, ...r.earlier])).toHaveLength(8)
    // Started with no assignment (a workspace you made) still shows.
    expect(logRows([ev('workspace.created', 1, { workspaceId: 'z', text: 'started' })])).toHaveLength(1)
  })

  it('keeps a folded row\'s id as events join it, so an open row stays open', () => {
    const three = [archived(1, 'theo'), archived(2, 'noor'), archived(3, 'kai')]
    expect(logRows(three, true)[0].id).toBe(logRows([archived(0, 'ivy'), ...three], true)[0].id)
  })

  it('does not fold across another kind, another verb or another day', () => {
    expect(logRows([archived(1, 'theo'), ev('brief', 2), archived(3, 'kai')], true)).toHaveLength(3)
    expect(logRows([ev('workspace.created', 1, { text: 'started' }), ev('workspace.created', 2, { text: 'assigned X to' })])).toHaveLength(2)
    const earlier = { ...archived(0, 'kai'), ts: new Date(2026, 9, 8, 23, 59).getTime() }
    const later = { ...archived(0, 'theo'), ts: new Date(2026, 9, 9, 0, 1).getTime() }
    expect(logRows([later, earlier], true)).toHaveLength(2)
  })

  it('does not fold kinds with no plural noun', () => {
    expect(logRows([ev('brief', 1), ev('brief', 2), ev('pr.changed', 3), ev('pr.changed', 4), ev('task.completed', 5, { text: 'merged' }), ev('task.completed', 6, { text: 'merged' })])).toHaveLength(6)
  })

  it('leaves a single event plain', () => {
    expect(logRows([archived(1, 'theo')], true)[0].fold).toBeUndefined()
  })

  it('leaves out archives, and folds shown rows that only hidden events separated', () => {
    const rows = logRows([archived(1, 'theo'), ev('turn.done', 2), archived(3, 'noor')])
    expect(rows).toEqual([])
    const done = logRows([ev('task.completed', 1, { text: 'finished' }), ev('turn.done', 2), ev('task.completed', 3, { text: 'finished' })])
    expect(done).toHaveLength(1)
  })
})

describe('Show everything toggle', () => {
  afterEach(() => vi.unstubAllGlobals())
  const store = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
  }

  it('is a button that reports whether it is on', async () => {
    const { ShowEverything } = await loadLogs()
    const html = (on: boolean) => renderToStaticMarkup(React.createElement(ShowEverything, { on, onChange: () => {} }))
    expect(html(false)).toMatch(/<button[^>]*type="button"[^>]*aria-pressed="false"[^>]*>Show everything<\/button>/)
    expect(html(true)).toContain('aria-pressed="true"')
  })

  it('remembers its state in localStorage', async () => {
    const { keepEverything, readEverything } = await loadLogs()
    vi.stubGlobal('localStorage', store())
    expect(readEverything()).toBe(false)
    keepEverything(true)
    expect(readEverything()).toBe(true)
    keepEverything(false)
    expect(readEverything()).toBe(false)
  })

  it('works when localStorage is missing or blocked', async () => {
    const { keepEverything, readEverything } = await loadLogs()
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
    vi.stubGlobal('localStorage', blocked)
    expect(readEverything()).toBe(false)
    expect(() => keepEverything(true)).not.toThrow()
  })
})
