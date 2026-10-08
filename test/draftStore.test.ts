import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatPart } from '../src/shared/types'
import { dropDrafts, liveChatIds, loadDraft, pruneDrafts, saveDraft } from '../src/renderer/src/screens/workspace/composer/draftStore'

const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]

describe('composer draft store', () => {
  beforeEach(() => pruneDrafts(new Set()))

  it('keeps a draft per chat and forgets one saved empty', () => {
    saveDraft('a', words('hello'))
    saveDraft('b', words('other'))
    expect(loadDraft('a')).toEqual(words('hello'))
    expect(loadDraft('b')).toEqual(words('other'))
    saveDraft('a', [])
    expect(loadDraft('a')).toBeUndefined()
    expect(loadDraft('b')).toEqual(words('other'))
  })

  it('drops the drafts of closed chats', () => {
    saveDraft('a', words('1'))
    saveDraft('b', words('2'))
    saveDraft('c', words('3'))
    dropDrafts(['a', 'c', 'never-had-one'])
    expect([loadDraft('a'), loadDraft('b'), loadDraft('c')]).toEqual([undefined, words('2'), undefined])
  })

  it('prunes against the live chat list: closed chats and archived workspaces free their drafts', () => {
    saveDraft('open', words('1'))
    saveDraft('closed', words('2'))
    saveDraft('archived-chat', words('3'))
    const live = liveChatIds({
      workspaces: [{ id: 'w1', status: 'ready' }, { id: 'w2', status: 'archived' }, { id: 'w3', status: 'ready' }],
      chats: { w1: [{ id: 'open' }], w2: [{ id: 'archived-chat' }], w4: [{ id: 'closed' }] }
    })
    expect([...live]).toEqual(['open'])
    pruneDrafts(live)
    expect([loadDraft('open'), loadDraft('closed'), loadDraft('archived-chat')]).toEqual([words('1'), undefined, undefined])
  })
})
