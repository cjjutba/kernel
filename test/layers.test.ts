// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { closeAllLayers, isOutsidePress, useLayer } from '../src/renderer/src/ui/hooks'

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
