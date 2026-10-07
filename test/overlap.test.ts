import { afterEach, describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivityEvent, Overlap, Workspace } from '../src/shared/types'
import type { PushEvent } from '../src/shared/ipc'
import { tempRepo } from './helpers'
import { bus } from '../src/main/bus'
import { createWorktree, freeBranch, mergeBase } from '../src/main/services/worktrees'
import { Overlaps, formatRanges, lineRanges } from '../src/main/services/overlap'

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
const edit = async (dir: string, file: string, from: number, to: number) => {
  const rows = (await readFile(join(dir, file), 'utf8')).split('\n')
  for (let i = from; i <= to; i++) rows[i - 1] = `${rows[i - 1]} changed`
  await writeFile(join(dir, file), rows.join('\n'))
}

async function room() {
  const repo = await tempRepo({ 'src/invoices.ts': lines(60), 'src/other.ts': lines(5), 'src/third.ts': lines(5) })
  const mk = async (name: string, agentId: string, createdAt: number): Promise<Workspace> => {
    const branch = await freeBranch(repo, `feat/${name}`)
    const path = await createWorktree({ repo, root: join(repo, '..', `wt-${name}-${Date.now()}`), branch, baseRef: 'main' })
    return { id: `ws-${name}`, roomId: 'r', name, branch, baseRef: 'main', path, mode: 'worktree', agentId, port: 4000, status: 'ready', prState: 'none', createdAt }
  }
  return { repo, kai: await mk('invoice-table', 'kai', 1), noor: await mk('invoice-schema', 'noor', 2) }
}

const pushed: PushEvent[] = []
const logged: ActivityEvent[] = []
const onPush = (e: PushEvent) => pushed.push(e)
const onActivity = (e: ActivityEvent) => logged.push(e)
bus.on('push', onPush).on('activity', onActivity)
afterEach(() => { pushed.length = 0; logged.length = 0 })

const service = (all: () => Workspace[]) => new Overlaps({
  workspaces: () => all(),
  since: (ws) => mergeBase(ws.path, ws.baseRef),
  leadId: () => 'rowan'
})
const overlapEvents = () => pushed.filter((e): e is Extract<PushEvent, { type: 'overlap' }> => e.type === 'overlap').map((e) => e.overlap)

describe('line ranges', () => {
  it('collapses and formats hunks', () => {
    expect(formatRanges([[20, 34]])).toBe('lines 20-34')
    expect(formatRanges([[7, 7]])).toBe('line 7')
    expect(formatRanges([[30, 34], [20, 25], [26, 28]])).toBe('lines 20-28, 30-34')
  })
  it('reads the lines a worktree changed', async () => {
    const { kai } = await room()
    await edit(kai.path, 'src/invoices.ts', 20, 34)
    expect(await lineRanges(kai.path, await mergeBase(kai.path, 'main'), 'src/invoices.ts')).toBe('lines 20-34')
  })
})

describe('overlap detection across two real worktrees', () => {
  it('raises an overlap for a file both workspaces changed, with each side\'s lines, and logs it once', async () => {
    const { kai, noor } = await room()
    const svc = service(() => [kai, noor])
    await edit(kai.path, 'src/invoices.ts', 20, 34)
    await edit(noor.path, 'src/invoices.ts', 18, 40)
    await edit(kai.path, 'src/other.ts', 1, 1)

    const found = await svc.check('r')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ roomId: 'r', path: 'src/invoices.ts' })
    expect(found[0].parties).toEqual([
      { agentId: 'kai', workspaceId: kai.id, lines: 'lines 20-34' },
      { agentId: 'noor', workspaceId: noor.id, lines: 'lines 18-40' }
    ])
    const line = logged.find((e) => e.kind === 'overlap')!
    expect(line).toMatchObject({ roomId: 'r', agentId: 'rowan', object: 'invoices.ts', warn: true })
    expect(line.data).toMatchObject({ workspaceIds: [kai.id, noor.id] })

    // The next turn changes nothing: no second line, no second push.
    await svc.check('r')
    expect(logged.filter((e) => e.kind === 'overlap')).toHaveLength(1)
    expect(overlapEvents()).toHaveLength(1)
  })

  it('stays quiet for different files', async () => {
    const { kai, noor } = await room()
    await edit(kai.path, 'src/other.ts', 1, 2)
    await edit(noor.path, 'src/third.ts', 1, 2)
    expect(await service(() => [kai, noor]).check('r')).toEqual([])
    expect(logged.filter((e) => e.kind === 'overlap')).toEqual([])
  })

  it('clears when one workspace merges, and when the overlap goes away', async () => {
    const { kai, noor } = await room()
    let all = [kai, noor]
    const svc = service(() => all)
    await edit(kai.path, 'src/invoices.ts', 20, 34)
    await edit(noor.path, 'src/invoices.ts', 18, 40)
    await svc.check('r')

    all = [{ ...kai, prState: 'merged', mergedAt: Date.now() }, noor]
    expect(await svc.check('r')).toEqual([])
    const cleared = overlapEvents().at(-1) as Overlap
    expect(cleared).toMatchObject({ path: 'src/invoices.ts', resolved: true })

    // It comes back as new when both touch the file again, and goes when one reverts it.
    all = [kai, noor]
    expect(await svc.check('r')).toHaveLength(1)
    await writeFile(join(noor.path, 'src/invoices.ts'), lines(60))
    expect(await svc.check('r')).toEqual([])
  })

  it('stays off the floor once handed to the Lead, until it clears', async () => {
    const { kai, noor } = await room()
    const svc = service(() => [kai, noor])
    await edit(kai.path, 'src/invoices.ts', 20, 34)
    await edit(noor.path, 'src/invoices.ts', 18, 40)
    const [o] = await svc.check('r')
    svc.resolve(o.id)
    await edit(noor.path, 'src/invoices.ts', 41, 42)
    const [again] = await svc.check('r')
    expect(again.resolved).toBe(true)
    expect(again.parties[1].lines).toBe('lines 18-42')
    expect(logged.filter((e) => e.kind === 'overlap')).toHaveLength(1)
  })

  it('ignores archived workspaces', async () => {
    const { kai, noor } = await room()
    await edit(kai.path, 'src/invoices.ts', 1, 3)
    await edit(noor.path, 'src/invoices.ts', 1, 3)
    expect(await service(() => [kai, { ...noor, status: 'archived' }]).check('r')).toEqual([])
  })
})
