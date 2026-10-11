import { describe, expect, it } from 'vitest'
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
