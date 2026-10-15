import { beforeEach, describe, expect, it, vi } from 'vitest'

// KERNEL-860: an existing chat whose items have not arrived is loading, not empty, so the transcript must not show the new chat welcome.

const bridge = vi.hoisted(() => ({ failFor: new Set<string>(), chats: [] as { id: string; workspaceId: string }[] }))
vi.mock('../src/renderer/src/api', () => ({
  call: async (channel: string, req: { chatId?: string }) => {
    if (channel === 'chats.list') return bridge.chats
    if (channel === 'chats.items') {
      if (bridge.failFor.has(req.chatId!)) throw new Error('Kernel is starting')
      return [{ kind: 'user', id: `${req.chatId}-u`, ts: 1, parts: [{ type: 'text', text: 'hi' }] }]
    }
    return { ok: true }
  },
  onPush: () => () => undefined
}))
const { actions, getState, loadWorkspace, setState } = await import('../src/renderer/src/store')

beforeEach(() => {
  bridge.failFor.clear()
  bridge.chats = [{ id: 'a', workspaceId: 'w1' }, { id: 'b', workspaceId: 'w1' }]
  setState({ chats: {}, items: {}, itemsLoaded: {}, itemsFailed: {} })
})

describe('items loaded flag', () => {
  it('is false until a chat\'s items arrive, then true', async () => {
    expect(getState().itemsLoaded.a).toBeUndefined()
    await loadWorkspace('w1')
    expect(getState().itemsLoaded).toEqual({ a: true, b: true })
    expect(getState().items.a).toHaveLength(1)
  })

  it('marks a chat that failed to load and still loads the others', async () => {
    bridge.failFor.add('a')
    await loadWorkspace('w1')
    expect(getState().itemsFailed).toEqual({ a: true })
    expect(getState().itemsLoaded.a).toBeUndefined()
    expect(getState().itemsLoaded.b).toBe(true)
  })

  it('clears the failure when a later load succeeds', async () => {
    bridge.failFor.add('a')
    await loadWorkspace('w1')
    bridge.failFor.clear()
    await loadWorkspace('w1')
    expect(getState().itemsFailed.a).toBeUndefined()
    expect(getState().itemsLoaded.a).toBe(true)
  })

  it('counts a chat created after its workspace loaded as loaded, with nothing to wait for', async () => {
    await loadWorkspace('w1')
    actions.chats.upsert({ id: 'c', workspaceId: 'w1' } as never)
    expect(getState().itemsLoaded.c).toBe(true)
  })

  it('does not count a chat pushed into a workspace whose chats have not loaded', () => {
    actions.chats.upsert({ id: 'z', workspaceId: 'never-loaded' } as never)
    expect(getState().itemsLoaded.z).toBeUndefined()
  })
})
