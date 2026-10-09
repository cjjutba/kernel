import { describe, expect, it } from 'vitest'
import { actions, getState, setState } from '../src/renderer/src/store'

const asked = { chatId: 'chat-1', since: 100, question: 'Who is blocked?' }

describe('Ask Rowan slice', () => {
  it('keeps a draft per room', () => {
    setState({ quickAsk: {} })
    actions.quickAsk.setDraft('a', 'hello')
    actions.quickAsk.setDraft('b', 'other')
    expect(getState().quickAsk).toEqual({ a: { draft: 'hello' }, b: { draft: 'other' } })
  })

  it('clears the draft once the question is sent, and keeps the question until Ask another', () => {
    setState({ quickAsk: {} })
    actions.quickAsk.setDraft('a', 'Who is blocked?')
    actions.quickAsk.setAsked('a', asked)
    expect(getState().quickAsk.a).toEqual({ draft: '', asked })
    actions.quickAsk.clearAsked('a')
    expect(getState().quickAsk.a).toEqual({ draft: '' })
  })
})
