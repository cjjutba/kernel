// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Clickable file mentions: a match picked from the menu is resolved on its own, anchored to the worktree.
const call = vi.fn()
vi.mock('../src/renderer/src/api', () => ({ call }))
vi.mock('../src/renderer/src/store', () => ({ actions: {}, getState: () => ({}), go: () => undefined }))
vi.mock('../src/renderer/src/screens/workspace/ChatTabs', () => ({ fileTab: (p: string) => `file:${p}`, diffTab: (p: string) => `diff:${p}` }))

const { resolveMatch } = await import('../src/renderer/src/screens/workspace/fileLinks')

// Like the engine: a path with no slash is a bare name, and one that several files have answers with the list.
const engine = (paths: string[]) => Promise.resolve(Object.fromEntries(paths.map((p) => [p, p.includes('/')
  ? { kind: 'file', path: p.replace(/^\.\//, '').replace(/:\d+$/, ''), sensitive: true }
  : { matches: ['package.json', 'packages/pdf/package.json'] }])))

describe('resolveMatch', () => {
  beforeEach(() => { call.mockReset(); call.mockImplementation((_c: string, a: { paths: string[] }) => engine(a.paths)) })

  it('resolves a match at the root as that file, with its sensitive flag', async () => {
    expect(await resolveMatch('w1', 'package.json', 'package.json')).toEqual({ kind: 'file', path: 'package.json', sensitive: true })
    expect(call).toHaveBeenCalledWith('workspaces.resolvePaths', { workspaceId: 'w1', paths: ['./package.json'] })
  })

  it('keeps the line the link named', async () => {
    await resolveMatch('w1', 'src/a.ts', 'a.ts:12-14')
    expect(call).toHaveBeenCalledWith('workspaces.resolvePaths', { workspaceId: 'w1', paths: ['./src/a.ts:12-14'] })
  })

  it('answers null when the file is gone', async () => {
    call.mockResolvedValue({})
    expect(await resolveMatch('w1', 'gone.ts', 'gone.ts')).toBeNull()
  })
})
