import { describe, expect, it } from 'vitest'
import { startAnywayLine, takenFindings } from '../src/renderer/src/screens/new-workspace/taken'
import type { IssueTaken } from '../src/shared/types'

// New chat asks whether someone else is on an issue before it starts from one (KERNEL-500). The check never blocks the start.
describe('takenFindings', () => {
  const found: IssueTaken = { findings: [{ kind: 'branch', ref: 'origin/feat/kernel-31-export-pdf' }, { kind: 'assignee', name: 'Maya Chen' }], notes: ['Couldn\'t check for an open pull request that names KERNEL-31: no answer in 10 seconds.'] }

  it('asks the engine about the room and the issue, and returns what it found in order', async () => {
    const asked: unknown[] = []
    const out = await takenFindings(async (req) => { asked.push(req); return found }, 'room-a', 'KERNEL-31')
    expect(asked).toEqual([{ roomId: 'room-a', issue: 'KERNEL-31' }])
    expect(out).toEqual(found.findings)
  })

  it('finds nothing when the engine finds nothing, notes or not', async () => {
    expect(await takenFindings(async () => ({ findings: [], notes: ['Couldn\'t check origin for a branch named after KERNEL-31: no answer in 10 seconds.'] }), 'room-a', 'KERNEL-31')).toEqual([])
  })

  it('fails open when the call errors', async () => {
    expect(await takenFindings(async () => { throw new Error('No handler for issues.taken') }, 'room-a', 'KERNEL-31')).toEqual([])
    expect(await takenFindings(() => { throw new Error('bridge is gone') }, 'room-a', 'KERNEL-31')).toEqual([])
  })

  it('fails open when the call never answers', async () => {
    const started = Date.now()
    expect(await takenFindings(() => new Promise<IssueTaken>(() => undefined), 'room-a', 'KERNEL-31', 30)).toEqual([])
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('returns as soon as the engine answers, without waiting out the limit', async () => {
    const started = Date.now()
    await takenFindings(async () => found, 'room-a', 'KERNEL-31', 60_000)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('startAnywayLine', () => {
  it('tells the Lead the user knows, and to pass confirm', () => {
    expect(startAnywayLine('KERNEL-31')).toBe('Someone else may already be on KERNEL-31. The user knows and chose to start anyway, so call create_workspace with confirm: true.')
  })
})
