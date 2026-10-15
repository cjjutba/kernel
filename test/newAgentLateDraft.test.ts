// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentDraft } from '@shared/types'

vi.mock('../src/renderer/src/api', () => ({ call: vi.fn(), cleanError: (e: unknown) => String(e) }))
const { call } = await import('../src/renderer/src/api')
const { actions, getState, setState } = await import('../src/renderer/src/store')
const { NewAgent } = await import('../src/renderer/src/screens/agent/NewAgent')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React })

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  setState((s) => ({ ui: { ...s.ui, modal: null } }))
})

const draft: AgentDraft = { id: 'wren', name: 'Wren', description: 'A designer.', model: 'sonnet', tools: [], file: '.claude/agents/wren.md', text: '---\nname: wren\n---\n' }

describe('New agent draft that answers late (KERNEL-868)', () => {
  it('is ignored after Cancel and does not reopen the dialog', async () => {
    let answer!: (d: AgentDraft) => void
    vi.mocked(call).mockImplementation(() => new Promise((r) => { answer = r as (d: AgentDraft) => void }) as never)
    actions.ui.openModal({ name: 'newAgent', step: 'describe' })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(React.createElement(NewAgent, { step: 'describe', prefill: { name: 'Wren', description: 'A designer.', model: 'sonnet' } })))

    const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement
    await act(async () => { button('Draft with').click() })
    expect(call).toHaveBeenCalledWith('agents.draft', expect.anything())
    act(() => { button('Cancel').click() })
    expect(getState().ui.modal).toBeNull()

    await act(async () => { answer(draft) })
    expect(getState().ui.modal).toBeNull()
  })
})
