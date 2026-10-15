// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { actions, apply, getState } from '../src/renderer/src/store'
import type { Chat, ChatItem, ChatPart, QueuedMessage, Workspace } from '../src/shared/types'

// KERNEL-895: a send draws its result in one render, main's row replaces it by id, and a failure puts everything back.

const call = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/api', async (original) => ({ ...(await original<object>()), call }))

const chat = { id: 'c1', workspaceId: 'w1', kind: 'agent', title: 'Chat', plan: false, model: 'claude-opus-5-5', effort: 'medium' } as unknown as Chat
const text = (t: string): ChatPart[] => [{ type: 'text', text: t }]
const items = () => getState().items.c1 ?? []
const queue = () => getState().queue.c1 ?? []
const ids = () => items().map((i) => i.id)

describe('one send path', () => {
  let send: typeof import('../src/renderer/src/screens/workspace/composer/sendMessage')
  beforeEach(async () => {
    call.mockReset()
    send = await import('../src/renderer/src/screens/workspace/composer/sendMessage')
    actions.chats.set('w1', [chat])
    actions.chats.setItems('c1', [])
    actions.chats.setQueue('c1', [], null)
    actions.chats.setRunning('c1', false)
    actions.workspaces.set([{ id: 'w1' } as unknown as Workspace])
    actions.system.setOnline(true)
  })

  it('draws the bubble and the running state before the call answers, and main\'s row replaces it by id', async () => {
    let answer: (v: unknown) => void = () => undefined
    call.mockReturnValue(new Promise((r) => { answer = r }))
    const sent = send.sendMessage('c1', text('hi'))
    expect(items()).toHaveLength(1)
    expect(getState().running.c1).toBe(true)
    expect(getState().assumed.c1).toBe(true)
    const id = items()[0].id
    expect(call).toHaveBeenCalledWith('chats.send', { chatId: 'c1', parts: text('hi'), clientId: id })
    // Main pushes the row under the same id and the running event, then answers.
    apply({ type: 'chat.item', chatId: 'c1', item: { kind: 'user', id, ts: 5, parts: text('hi') } })
    apply({ type: 'chat.running', chatId: 'c1', running: true })
    expect(items()).toHaveLength(1)
    expect(items()[0].ts).toBe(5)
    expect(getState().assumed.c1).toBeUndefined()
    answer({ queued: false })
    expect(await sent).toBe(true)
    expect(items()).toHaveLength(1)
  })

  it('keeps the starting state while main is slow, and has no timer to clear it', async () => {
    vi.useFakeTimers()
    call.mockReturnValue(new Promise(() => undefined))
    void send.sendMessage('c1', text('hi'))
    vi.advanceTimersByTime(60_000)
    expect(getState().running.c1).toBe(true)
    vi.useRealTimers()
  })

  it('rolls everything back and gives the text to onFail when the call fails', async () => {
    call.mockRejectedValue(new Error('no'))
    const onFail = vi.fn()
    expect(await send.sendMessage('c1', text('hi'), { onFail })).toBe(false)
    expect(items()).toHaveLength(0)
    expect(getState().running.c1).toBe(false)
    expect(getState().assumed.c1).toBeUndefined()
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('leaves a running state main already confirmed when the call then fails', async () => {
    call.mockImplementation(async () => { apply({ type: 'chat.running', chatId: 'c1', running: true }); throw new Error('no') })
    await send.sendMessage('c1', text('hi'), { onFail: () => undefined })
    expect(getState().running.c1).toBe(true)
  })

  it('draws a row in the tray, not a bubble, while a turn runs, and the engine\'s row replaces it in place', async () => {
    actions.chats.setRunning('c1', true)
    let answer: (v: unknown) => void = () => undefined
    call.mockReturnValue(new Promise((r) => { answer = r }))
    const sent = send.sendMessage('c1', text('later'))
    expect(items()).toHaveLength(0)
    expect(queue()).toHaveLength(1)
    expect(getState().assumed.c1).toBeUndefined()
    const id = queue()[0].id
    expect(queue()[0].clientId).toBe(id)
    answer({ queued: true })
    await sent
    // The turn ends: the tray loses the message and its row arrives under the same id.
    apply({ type: 'chat.queue', chatId: 'c1', queue: [] })
    apply({ type: 'chat.item', chatId: 'c1', item: { kind: 'user', id, ts: 9, parts: text('later') } })
    expect(queue()).toHaveLength(0)
    expect(ids()).toEqual([id])
  })

  it('removes a tray row whose call failed, and keeps the other rows', async () => {
    actions.chats.setRunning('c1', true)
    const other = { id: 'o', chatId: 'c1', parts: text('other'), ts: 1 } as QueuedMessage
    actions.chats.setQueue('c1', [other])
    call.mockRejectedValue(new Error('no'))
    await send.sendMessage('c1', text('later'), { onFail: () => undefined })
    expect(queue().map((q) => q.id)).toEqual(['o'])
  })

  it('moves a bubble to the tray in one step when main queues the message instead', async () => {
    call.mockImplementation(async () => ({ queued: true, why: 'capacity' }))
    await send.sendMessage('c1', text('hi'))
    expect(items()).toHaveLength(0)
    expect(queue()).toHaveLength(1)
    expect(getState().queueWhy.c1).toBe('capacity')
    expect(getState().running.c1).toBe(false)
  })

  it('shows as queued while the Mac is offline', async () => {
    actions.system.setOnline(false)
    call.mockReturnValue(new Promise(() => undefined))
    void send.sendMessage('c1', text('hi'))
    expect(items()).toHaveLength(0)
    expect(queue()).toHaveLength(1)
    expect(getState().queueWhy.c1).toBe('offline')
  })

  it('gives two quick sends separate ids', async () => {
    call.mockReturnValue(new Promise(() => undefined))
    void send.sendMessage('c1', text('one'))
    void send.sendMessage('c1', text('two'))
    // The first made the chat run, so the second waits behind it.
    expect(ids()).toHaveLength(1)
    expect(queue()).toHaveLength(1)
    expect(queue()[0].id).not.toBe(ids()[0])
    const sent = call.mock.calls.map((c) => c[1].clientId)
    expect(new Set(sent).size).toBe(2)
  })

  it('keeps attachments in the drawn row, so the row main saves is the same height', async () => {
    const parts: ChatPart[] = [{ type: 'text', text: 'look' }, { type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AA', width: 10, height: 5 }]
    call.mockReturnValue(new Promise(() => undefined))
    void send.sendMessage('c1', parts)
    expect((items()[0] as Extract<ChatItem, { kind: 'user' }>).parts).toEqual(parts)
  })

  it('does not touch another chat while a send is in flight', async () => {
    actions.chats.setItems('c2', [])
    call.mockReturnValue(new Promise(() => undefined))
    void send.sendMessage('c1', text('hi'))
    expect(getState().items.c2).toEqual([])
    expect(getState().running.c2).toBeUndefined()
  })

  it('Send now moves the row out of the tray and into the chat in one render, and a failure puts it back', async () => {
    actions.chats.setRunning('c1', true)
    const q = { id: 'q1', chatId: 'c1', parts: text('queued'), ts: 1, clientId: 'q1' } as QueuedMessage
    actions.chats.setQueue('c1', [q])
    let fail: (e: Error) => void = () => undefined
    call.mockReturnValue(new Promise((_, no) => { fail = no }))
    const done = send.sendQueuedNow('c1', q)
    expect(queue()).toHaveLength(0)
    expect(ids()).toEqual(['q1'])
    // Main still lists it until the interrupted turn ends: it stays out of the tray.
    actions.chats.setQueue('c1', [q])
    expect(queue()).toHaveLength(0)
    actions.chats.setQueue('c1', [])
    fail(new Error('no'))
    await expect(done).rejects.toThrow('no')
    expect(ids()).toEqual([])
    expect(queue().map((x) => x.id)).toEqual(['q1'])
  })

  it('draws a plan\'s answer with its images in the frame of the send', async () => {
    const { answerRow } = await import('../src/renderer/src/screens/workspace/cards/optimisticAnswer')
    const row = answerRow({ id: 'a1', kind: 'plan', toolName: 'ExitPlanMode', status: 'pending', chatId: 'c1' } as never, { behavior: 'deny', message: ' Split it. ', images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AA' }] })
    expect(row).toMatchObject({ id: 'answer-a1', parts: [{ type: 'text', text: 'Split it.' }, { type: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AA' }] })
  })
})
