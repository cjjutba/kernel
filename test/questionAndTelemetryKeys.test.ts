// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Approval } from '@shared/types'
import { actions, getState, setState } from '../src/renderer/src/store'
import { activeRow, rowStep } from '../src/renderer/src/screens/workspace/cards/questionRows'
import { ApprovalCard } from '../src/renderer/src/screens/workspace/cards/ApprovalCard'
import { TelemetryAsk } from '../src/renderer/src/components/TelemetryAsk'

const patchSettings = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../src/renderer/src/screens/settings/useSettings', () => ({ patchSettings }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React })

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  patchSettings.mockClear()
  setState((s) => ({ ui: { ...s.ui, modal: null } }))
})

const mount = (el: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host
}
const press = (target: Element | Window, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })

describe('question card choices (KERNEL-882)', () => {
  it('moves with the arrows, stops at the ends and jumps with Home and End', () => {
    expect(rowStep('ArrowDown', 0, 3)).toBe(1)
    expect(rowStep('ArrowDown', 2, 3)).toBe(2)
    expect(rowStep('ArrowUp', 0, 3)).toBe(0)
    expect(rowStep('ArrowUp', 2, 3)).toBe(1)
    expect(rowStep('Home', 2, 3)).toBe(0)
    expect(rowStep('End', 0, 3)).toBe(2)
    expect(rowStep('a', 0, 3)).toBe(-1)
  })

  it('keeps one choice in the tab order: the cursor, else the picked one, else the first', () => {
    expect(activeRow(null, -1, 3)).toBe(0)
    expect(activeRow(null, 1, 3)).toBe(1)
    expect(activeRow(2, 1, 3)).toBe(2)
    expect(activeRow(9, -1, 3)).toBe(2)
  })

  const question: Approval = { id: 'a1', kind: 'question', source: 'sdk', roomId: 'r1', chatId: 'c1', agentId: 'kai', title: 'Keep the invoice number?', options: ['Yes', 'No', 'Random'], status: 'pending', createdAt: 0 } as Approval

  it('renders the choices as one group with one tab stop, and the arrows move focus', () => {
    const host = mount(React.createElement(ApprovalCard, { approval: question }))
    const rows = [...host.querySelectorAll<HTMLButtonElement>('button.qrow')]
    expect(rows).toHaveLength(4)
    expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1])
    act(() => rows[0].focus())
    press(rows[0], 'ArrowDown')
    expect(document.activeElement).toBe(rows[1])
    expect(rows.map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1])
    press(rows[1], 'ArrowDown')
    press(rows[2], 'ArrowDown')
    press(rows[3], 'ArrowDown')
    expect(document.activeElement).toBe(rows[3])
    press(rows[3], 'ArrowUp')
    expect(document.activeElement).toBe(rows[2])
  })

  it('a number key still picks its choice', () => {
    const host = mount(React.createElement(ApprovalCard, { approval: question }))
    const rows = [...host.querySelectorAll<HTMLButtonElement>('button.qrow')]
    act(() => rows[0].focus())
    press(rows[0], '2')
    expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('No')
  })
})

describe('the usage data question closes without an answer (KERNEL-882)', () => {
  beforeEach(() => {
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    actions.ui.openModal({ name: 'telemetryAsk' })
  })

  it('Escape closes it and saves nothing', () => {
    mount(React.createElement(TelemetryAsk))
    press(window, 'Escape')
    expect(getState().ui.modal).toBeNull()
    expect(patchSettings).not.toHaveBeenCalled()
  })

  it('a press on the scrim closes it and saves nothing', () => {
    const host = mount(React.createElement(TelemetryAsk))
    act(() => { host.querySelector('.scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(getState().ui.modal).toBeNull()
    expect(patchSettings).not.toHaveBeenCalled()
  })

  it('Don’t share saves off', async () => {
    const host = mount(React.createElement(TelemetryAsk))
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Don’t share')!
    await act(async () => { button.click() })
    expect(patchSettings).toHaveBeenCalledWith({ privacy: { telemetry: 'off' } })
  })
})
