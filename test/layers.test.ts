// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actions, getState, setState } from '../src/renderer/src/store'
import { NewChatTab } from '../src/renderer/src/screens/workspace/NewChatBar'
import { TelemetryAsk, askAboutTelemetry } from '../src/renderer/src/components/TelemetryAsk'
import { landing } from '../src/renderer/src/nav'
import { closeAllLayers, isOutsidePress, useLayer, useScreenEscape, useToastEscape } from '../src/renderer/src/ui/hooks'

vi.mock('../src/renderer/src/api', () => ({ call: vi.fn(async () => ({ telemetry: true })) }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// Minimal stand-ins for DOM nodes: `contains` is all the check uses.
const node = (...inside: object[]) => ({ contains: (n: object) => inside.includes(n) }) as unknown as HTMLElement

describe('isOutsidePress', () => {
  const inLayer = {}
  const inAnchor = {}
  const elsewhere = {}
  const layer = node(inLayer)
  const anchor = node(inAnchor)

  it('is false for a press inside the layer', () => {
    expect(isOutsidePress(inLayer as Node, layer, anchor)).toBe(false)
  })
  it('is false for a press inside the anchor, so the trigger can toggle the layer', () => {
    expect(isOutsidePress(inAnchor as Node, layer, anchor)).toBe(false)
  })
  it('is true for a press elsewhere', () => {
    expect(isOutsidePress(elsewhere as Node, layer, anchor)).toBe(true)
    expect(isOutsidePress(elsewhere as Node, layer)).toBe(true)
  })
  it('is false when there is no layer element yet', () => {
    expect(isOutsidePress(elsewhere as Node, null, anchor)).toBe(false)
  })
})

describe('layer stack', () => {
  let root: Root | null = null
  afterEach(() => { act(() => root?.unmount()); root = null })

  function Layer({ name, open, blocking, log }: { name: string; open: boolean; blocking?: boolean; log: string[] }) {
    useLayer({ onOutside: blocking ? undefined : () => log.push(name), onEscape: () => log.push(`${name}:escape`), blocking }, open)
    return null
  }
  type Spec = { name: string; open: boolean; blocking?: boolean }
  const mount = (specs: Spec[], log: string[]) => {
    root ??= createRoot(document.createElement('div'))
    act(() => root!.render(React.createElement(React.Fragment, null, ...specs.map((x) => React.createElement(Layer, { key: x.name, ...x, log })))))
  }

  it('a modal opening closes the menus below it, newest first', () => {
    const log: string[] = []
    mount([{ name: 'a', open: true }, { name: 'b', open: true }, { name: 'modal', open: false, blocking: true }], log)
    mount([{ name: 'a', open: true }, { name: 'b', open: true }, { name: 'modal', open: true, blocking: true }], log)
    expect(log).toEqual(['b', 'a'])
  })
  it('a menu opened inside a modal stays open', () => {
    const log: string[] = []
    mount([{ name: 'menu', open: true }, { name: 'modal', open: true, blocking: true }, { name: 'inner', open: false }], log)
    log.length = 0
    mount([{ name: 'menu', open: true }, { name: 'modal', open: true, blocking: true }, { name: 'inner', open: true }], log)
    expect(log).toEqual([])
  })
  it('a confirm over a modal leaves that modal open', () => {
    const log: string[] = []
    mount([{ name: 'modal', open: true, blocking: true }, { name: 'confirm', open: false, blocking: true }], log)
    mount([{ name: 'modal', open: true, blocking: true }, { name: 'confirm', open: true, blocking: true }], log)
    expect(log).toEqual([])
  })
  it('Escape closes only the top layer', () => {
    const log: string[] = []
    mount([{ name: 'a', open: true }, { name: 'b', open: true }], log)
    act(() => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(log).toEqual(['b:escape'])
  })
  it('never calls the handler of an escape-only layer', () => {
    const log: string[] = []
    function EscapeOnly() { useLayer({ onEscape: () => log.push('comment') }); return null }
    root ??= createRoot(document.createElement('div'))
    const specs = (modal: boolean) => React.createElement(React.Fragment, null, React.createElement(EscapeOnly), React.createElement(Layer, { name: 'menu', open: true, log }), React.createElement(Layer, { name: 'modal', open: modal, blocking: true, log }))
    act(() => root!.render(specs(false)))
    act(() => root!.render(specs(true)))
    closeAllLayers()
    expect(log).toEqual(['menu', 'menu'])
  })
  it('closeAllLayers closes menus and popovers but not a modal', () => {
    const log: string[] = []
    mount([{ name: 'a', open: true }, { name: 'modal', open: true, blocking: true }, { name: 'b', open: true }], log)
    log.length = 0
    closeAllLayers()
    expect(log).toEqual(['b', 'a'])
  })
})

describe('Escape order', () => {
  let root: Root | null = null
  let host: HTMLElement
  afterEach(() => { act(() => root?.unmount()); root = null; host?.remove() })

  const escape = (from: Element | Window = window) => {
    const e = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { from.dispatchEvent(e) })
    return e
  }
  function Stack({ log, layer, screen, toast }: { log: string[]; layer: boolean; screen: boolean; toast: boolean }) {
    useLayer({ onEscape: () => log.push('layer'), onOutside: () => undefined }, layer)
    useScreenEscape((_e, inField) => { log.push(inField ? 'screen:field' : 'screen'); return screen }, true)
    useToastEscape((_e, inField) => { if (inField) return false; log.push('toast'); return toast })
    return React.createElement(React.Fragment, null, React.createElement('input', { id: 'f' }), React.createElement('div', { id: 'c', 'data-composer-input': '', contentEditable: true, tabIndex: 0 }))
  }
  const mount = (log: string[], o: { layer?: boolean; screen?: boolean; toast?: boolean }) => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(React.createElement(Stack, { log, layer: !!o.layer, screen: o.screen ?? true, toast: o.toast ?? true })))
  }

  it('an open layer takes Escape before the screen and the toast', () => {
    const log: string[] = []
    mount(log, { layer: true })
    escape()
    expect(log).toEqual(['layer'])
  })
  it('the screen takes it before the toast, and a handled key stops there', () => {
    const log: string[] = []
    mount(log, {})
    const e = escape()
    expect(log).toEqual(['screen'])
    expect(e.defaultPrevented).toBe(true)
  })
  it('the toast gets what the screen leaves', () => {
    const log: string[] = []
    mount(log, { screen: false })
    escape()
    expect(log).toEqual(['screen', 'toast'])
  })
  it('a key a field already handled reaches neither', () => {
    const log: string[] = []
    mount(log, {})
    const e = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    e.preventDefault()
    act(() => { window.dispatchEvent(e) })
    expect(log).toEqual([])
  })
  it('a text field keeps Escape from the toast, and the screen is told it came from a field', () => {
    const log: string[] = []
    mount(log, { screen: false })
    escape(host.querySelector('#f')!)
    expect(log).toEqual(['screen:field'])
  })
  it('the composer is not a field that keeps Escape', () => {
    const log: string[] = []
    mount(log, { screen: false })
    escape(host.querySelector('#c')!)
    expect(log).toEqual(['screen', 'toast'])
  })
})

describe('Escape with nothing to do (KERNEL-896)', () => {
  let root: Root | null = null
  let host: HTMLElement
  afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); setState((s) => ({ ui: { ...s.ui, modal: null, toasts: [] } })) })
  const press = () => {
    const e = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(e) })
    return e
  }
  const mountAll = (...els: React.ReactElement[]) => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(React.createElement(React.Fragment, null, ...els)))
  }

  it('New chat with nowhere to go back to passes Escape to the toast', () => {
    const toast: string[] = []
    function Toast() { useToastEscape(() => { toast.push('toast'); return true }); return null }
    setState((s) => ({ ui: { ...s.ui, route: landing(s) } }))
    mountAll(React.createElement(NewChatTab), React.createElement(Toast))
    const route = getState().ui.route
    const e = press()
    expect(toast).toEqual(['toast'])
    expect(getState().ui.route).toEqual(route)
    expect(e.defaultPrevented).toBe(true)
  })
  it('the usage question closes on the first Escape and does not ask again', async () => {
    setState((s) => ({ settings: { ...s.settings, privacy: { ...s.settings?.privacy, telemetry: 'ask' } } as typeof s.settings, projects: [{ id: 'p' } as never], ui: { ...s.ui, route: { name: 'inbox' }, modal: { name: 'telemetryAsk' } } }))
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    mountAll(React.createElement(TelemetryAsk))
    press()
    expect(getState().ui.modal).toBeNull()
    await askAboutTelemetry()
    expect(getState().ui.modal).toBeNull()
  })
})

describe('focus return', () => {
  let root: Root | null = null
  let host: HTMLElement
  afterEach(() => { act(() => root?.unmount()); root = null; host?.remove() })

  function Overlay({ open, inputFocus }: { open: boolean; inputFocus?: boolean }) {
    const ref = React.useRef<HTMLDivElement>(null)
    useLayer({ onEscape: () => undefined, onOutside: () => undefined, ref }, open)
    return open ? React.createElement('div', { ref }, React.createElement('input', { id: 'in', autoFocus: inputFocus })) : null
  }
  const setup = (opener: boolean) => {
    host = document.createElement('div')
    document.body.append(host)
    const btn = document.createElement('button')
    btn.id = 'opener'
    const composer = document.createElement('div')
    composer.setAttribute('data-composer-input', '')
    composer.tabIndex = 0
    const other = document.createElement('input')
    host.append(btn, composer, other)
    if (opener) btn.focus()
    const mount = document.createElement('div')
    host.append(mount)
    root = createRoot(mount)
    return { btn, composer, other, render: (open: boolean, inputFocus = true) => act(() => root!.render(React.createElement(Overlay, { open, inputFocus }))) }
  }

  it('returns focus to the element that opened the overlay, even when a field in it took focus on open', () => {
    const t = setup(true)
    t.render(true)
    expect(document.activeElement?.id).toBe('in')
    t.render(false)
    expect(document.activeElement).toBe(t.btn)
  })
  it('falls back to the composer when the opener is gone', () => {
    const t = setup(true)
    t.render(true)
    t.btn.remove()
    t.render(false)
    expect(document.activeElement).toBe(t.composer)
  })
  it('leaves focus alone when it moved to another field', () => {
    const t = setup(true)
    t.render(true)
    t.other.focus()
    t.render(false)
    expect(document.activeElement).toBe(t.other)
  })
  it('survives a StrictMode double mount, as pnpm dev runs it', () => {
    const t = setup(true)
    act(() => root!.render(React.createElement(React.StrictMode, null, React.createElement(Overlay, { open: true, inputFocus: true }))))
    expect(document.activeElement?.id).toBe('in')
    act(() => root!.render(React.createElement(React.StrictMode, null, React.createElement(Overlay, { open: false }))))
    expect(document.activeElement).toBe(t.btn)
  })
})
