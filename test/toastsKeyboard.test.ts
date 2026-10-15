// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actions, getState, setState } from '../src/renderer/src/store'
import { Toasts } from '../src/renderer/src/components/Toasts'
import { SettingsPending } from '../src/renderer/src/screens/settings/SettingsLoad'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React })

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  setState((s) => ({ ui: { ...s.ui, toasts: [] } }))
})

const mount = () => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(React.createElement(Toasts)))
  return host
}
const key = (init: KeyboardEventInit) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })

describe('toasts by keyboard (KERNEL-866)', () => {
  it('keeps the newest three', () => {
    for (const n of [1, 2, 3, 4]) actions.ui.toast({ title: `T${n}` })
    expect(getState().ui.toasts.map((t) => t.title)).toEqual(['T2', 'T3', 'T4'])
  })

  it('Escape dismisses the newest toast, and leaves it to a layer that took the key', () => {
    vi.useFakeTimers()
    try {
      actions.ui.toast({ title: 'Older' })
      actions.ui.toast({ title: 'Newer' })
      const host = mount()
      key({ key: 'Escape', cancelable: true })
      act(() => { vi.advanceTimersByTime(400) })
      expect(getState().ui.toasts.map((t) => t.title)).toEqual(['Older'])
      expect(host.textContent).toContain('Older')
      const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      taken.preventDefault()
      act(() => { window.dispatchEvent(taken) })
      act(() => { vi.advanceTimersByTime(400) })
      expect(getState().ui.toasts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Command Option Z presses the newest toast action', () => {
    vi.useFakeTimers()
    try {
      actions.ui.toast({ title: 'Archived', action: { label: 'Open', route: { name: 'inbox' } } })
      mount()
      key({ code: 'KeyZ', key: 'Ω', metaKey: true, altKey: true })
      act(() => { vi.advanceTimersByTime(400) })
      expect(getState().ui.toasts).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Settings while its data loads or fails', () => {
  it('shows the title with the loading row', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPending, { title: 'Appearance', failed: false, what: 'settings', onRetry: () => undefined }))
    expect(html).toContain('Appearance')
    expect(html).toContain('Loading settings')
  })
  it('shows the title with Try again when it fails', () => {
    const html = renderToStaticMarkup(React.createElement(SettingsPending, { title: 'Appearance', failed: true, what: 'settings', onRetry: () => undefined }))
    expect(html).toContain('Appearance')
    expect(html).toContain('Could not load settings')
    expect(html).toContain('Try again')
  })
})
