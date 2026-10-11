import { beforeEach, describe, expect, it } from 'vitest'
import { actions, getState, setState } from '../src/renderer/src/store'
import { kindLabel, versionLine } from '../src/renderer/src/screens/workspace/shared/shared'
import { sharedHere } from '../src/renderer/src/screens/workspace/shared/SharedPanel'
import type { AgentDef, SharedFile, Workspace } from '../src/shared/types'

const file = (id: string, workspaceId: string, updatedAt: number, versions = [1], mime = 'text/html'): SharedFile => ({
  id, roomId: 'r1', workspaceId, agentId: 'noor', source: `${id}.html`, title: id, kind: 'html', createdAt: 1, updatedAt,
  versions: versions.map((n) => ({ n, at: n, file: 'f', mime, bytes: 1, sha256: `${id}${n}` }))
})
const ws = (id: string, agentId: string) => ({ id, roomId: 'r1', agentId }) as Workspace
const agents = { r1: [{ id: 'rowan', lead: true }, { id: 'noor' }] as AgentDef[] }

describe('versionLine', () => {
  it('names the kind and version, and says "of" when newer versions exist', () => {
    const f = file('a', 'w1', 1, [1, 2, 3])
    expect(versionLine(f, 3)).toBe('HTML · v3')
    expect(versionLine(f, 2)).toBe('HTML · v2 of 3')
  })
  it('names an image by its type', () => {
    expect(kindLabel('image', 'image/png')).toBe('PNG')
    expect(kindLabel('image', 'image/x-unknown')).toBe('Image')
  })
})

describe('sharedHere', () => {
  const shared = { a: file('a', 'w1', 10), b: file('b', 'w2', 30), c: file('c', 'w1', 20) }
  it("lists a teammate's workspace's own files, newest first", () => {
    expect(sharedHere({ shared, agents }, ws('w1', 'noor')).map((f) => f.id)).toEqual(['c', 'a'])
  })
  it('lists every file in the room in the Lead\'s workspace', () => {
    expect(sharedHere({ shared, agents }, ws('lead', 'rowan')).map((f) => f.id)).toEqual(['b', 'c', 'a'])
  })
  it('lists nothing when nothing was shared', () => {
    expect(sharedHere({ shared: {}, agents }, ws('w1', 'noor'))).toEqual([])
  })
})

/** What a card's Open does: it opens the tab at the card's own version (`useCard` in cards/SharedCard.tsx). */
describe('a card opens its own version', () => {
  const pick = () => getState().ui.tabs.w1?.sharedVersion?.a
  beforeEach(() => setState((s) => ({ shared: { a: file('a', 'w1', 1, [1, 2]) }, ui: { ...s.ui, tabs: {} } })))

  it('shows the newer version a card is for, even after an older one was picked', () => {
    actions.ui.openShared('w1', 'a', 1)
    expect(pick()).toBe(1)
    // Noor shares v3 and its card appears.
    actions.shared.upsert(file('a', 'w1', 1, [1, 2, 3]))
    actions.ui.openShared('w1', 'a', 3)
    expect(pick()).toBeUndefined()
    expect(getState().ui.tabs.w1.tab).toBe('shared:a')
  })
  it('picks the version of an older card', () => {
    actions.shared.upsert(file('a', 'w1', 1, [1, 2, 3]))
    actions.ui.openShared('w1', 'a', 2)
    expect(pick()).toBe(2)
  })
  it('follows new versions again once the latest card is opened', () => {
    actions.shared.upsert(file('a', 'w1', 1, [1, 2, 3]))
    actions.ui.openShared('w1', 'a', 2)
    actions.ui.openShared('w1', 'a', 3)
    actions.shared.upsert(file('a', 'w1', 1, [1, 2, 3, 4]))
    expect(pick()).toBeUndefined()
  })
  it('picks nothing for a file that has not loaded', () => {
    actions.ui.openShared('w1', 'gone', 2)
    expect(getState().ui.tabs.w1.sharedVersion).toBeUndefined()
    expect(getState().ui.tabs.w1.shared).toEqual(['gone'])
  })
})
