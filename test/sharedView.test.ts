import { beforeEach, describe, expect, it } from 'vitest'
import { actions, getState, setState } from '../src/renderer/src/store'
import { kindLabel, versionLine } from '../src/renderer/src/screens/workspace/shared/shared'
import { sharedHere } from '../src/renderer/src/screens/workspace/shared/SharedPanel'
import type { AgentDef, SharedFile, Workspace } from '../src/shared/types'

const file = (id: string, workspaceId: string, updatedAt: number, versions = [1], mime = 'text/html'): SharedFile => ({
  id, roomId: 'r1', workspaceId, agentId: 'noor', source: `${id}.html`, title: id, kind: 'html', createdAt: 1, updatedAt,
  versions: versions.map((n) => ({ n, at: n, file: 'f', mime, bytes: 1, sha256: `${id}${n}` }))
})
const ws = (id: string, agentId: string, threadId?: string) => ({ id, roomId: 'r1', agentId, ...(threadId ? { threadId } : {}) }) as Workspace
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
  const ids = (files: SharedFile[]) => files.map((f) => f.id)
  it("lists a teammate's workspace's own files, newest first", () => {
    expect(ids(sharedHere({ shared, agents, workspaces: [] }, ws('w1', 'noor')))).toEqual(['c', 'a'])
  })
  it('lists every file in the room in the Lead workspace from before each chat had its own', () => {
    expect(ids(sharedHere({ shared, agents, workspaces: [] }, ws('lead', 'rowan')))).toEqual(['b', 'c', 'a'])
  })
  it('lists nothing when nothing was shared', () => {
    expect(sharedHere({ shared: {}, agents, workspaces: [] }, ws('w1', 'noor'))).toEqual([])
  })

  describe('with two chats with Rowan in one room', () => {
    const chat1 = ws('lead1', 'rowan', 't1')
    const chat2 = ws('lead2', 'rowan', 't2')
    const noor1 = ws('noor1', 'noor', 't1')
    const noor2 = ws('noor2', 'noor', 't2')
    const workspaces = [chat1, chat2, noor1, noor2, ws('legacy', 'rowan')]
    const all = {
      own1: file('own1', 'lead1', 10), team1: file('team1', 'noor1', 30),
      own2: file('own2', 'lead2', 20), team2: file('team2', 'noor2', 40),
      old: file('old', 'legacy', 5)
    }
    const here = (w: Workspace) => ids(sharedHere({ shared: all, agents, workspaces }, w))

    it("lists the chat's own files and its teammates' files, and none of the other chat's", () => {
      expect(here(chat1)).toEqual(['team1', 'own1'])
      expect(here(chat2)).toEqual(['team2', 'own2'])
    })
    it('keeps a teammate to its own files', () => {
      expect(here(noor1)).toEqual(['team1'])
      expect(here(noor2)).toEqual(['team2'])
    })
    it("lists the whole room in the Lead workspace from before KERNEL-405, which has no chat", () => {
      expect(here(workspaces[4])).toEqual(['team2', 'team1', 'own2', 'own1', 'old'])
    })
    it('still lists a handed-off teammate after its chat tab closed, since threadId is kept', () => {
      expect(here({ ...chat1, status: 'archived' } as Workspace)).toEqual(['team1', 'own1'])
    })
    it("lists only the chat's own files before it handed anything off", () => {
      expect(ids(sharedHere({ shared: all, agents, workspaces: [chat1, chat2] }, chat1))).toEqual(['own1'])
    })
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
