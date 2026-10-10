import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@shared/types'

const user = (o: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem => ({ kind: 'user', id: 'u1', ts: 1, parts: [{ type: 'text', text: 'Build it' }], ...o })

describe('what a reader scrolled up follows', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/Transcript' as string) as Promise<{ followsSend: (item: ChatItem | undefined) => boolean }>

  it('follows the message the user just sent', async () => {
    const { followsSend } = await load()
    expect(followsSend(user())).toBe(true)
  })

  it("stays put when the Lead messages a teammate's chat, or Kernel posts into it", async () => {
    const { followsSend } = await load()
    expect(followsSend(user({ from: 'lead' }))).toBe(false)
    expect(followsSend(user({ from: 'kernel' }))).toBe(false)
  })

  it('stays put for anything the agent writes', async () => {
    const { followsSend } = await load()
    expect(followsSend({ kind: 'text', id: 't1', ts: 1, text: 'Done.' })).toBe(false)
    expect(followsSend({ kind: 'tool', id: 'tl1', ts: 1, toolUseId: 'x', name: 'Bash', label: 'Run', detail: 'ls', status: 'done' })).toBe(false)
    expect(followsSend(undefined)).toBe(false)
  })
})
