// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// KERNEL-817: only one sidebar hover card is open at a time.

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

describe('sidebar hover cards', () => {
  let root: Root | null = null
  let host: HTMLElement
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host) })
  afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); vi.useRealTimers() })

  const mount = async () => {
    const { useHoverCard } = await import('../src/renderer/src/components/sidebar/HoverCard')
    const Row = ({ name }: { name: string }) => {
      const { at, bind } = useHoverCard()
      return React.createElement('div', { 'data-row': name, ...bind }, name, at ? React.createElement('span', { className: 'hover-card', 'data-for': name }) : null)
    }
    root = createRoot(host)
    const render = (names: string[]) => act(() => root!.render(React.createElement('div', null, ...names.map((n) => React.createElement(Row, { key: n, name: n })))))
    render(['a', 'b'])
    return render
  }
  const over = (name: string) => act(() => { host.querySelector(`[data-row="${name}"]`)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  const out = (name: string) => act(() => { host.querySelector(`[data-row="${name}"]`)!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
  const keyboardFocus = (name: string) => {
    const row = host.querySelector(`[data-row="${name}"]`)!
    const matches = row.matches.bind(row)
    vi.spyOn(row, 'matches').mockImplementation((sel: string) => sel === ':focus-visible' || matches(sel))
    act(() => { row.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
  }
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
  const cards = () => [...host.querySelectorAll('.hover-card')].map((c) => c.getAttribute('data-for'))

  it('closes the open card when the next row opens its own', async () => {
    await mount()
    over('a')
    expect(cards()).toEqual([])
    act(() => { vi.advanceTimersByTime(800) })
    expect(cards()).toEqual(['a'])
    over('b')
    expect(cards()).toEqual(['b'])
  })

  it('keeps the first card waiting for the open delay', async () => {
    await mount()
    over('a')
    wait(600)
    expect(cards()).toEqual([])
    wait(150)
    expect(cards()).toEqual(['a'])
  })

  it('makes the next card wait again once the open one has closed and the warm window passed', async () => {
    await mount()
    over('a')
    wait(800)
    expect(cards()).toEqual(['a'])
    out('a')
    wait(150)
    expect(cards()).toEqual([])
    wait(400)
    over('b')
    expect(cards()).toEqual([])
    wait(600)
    expect(cards()).toEqual([])
    wait(150)
    expect(cards()).toEqual(['b'])
  })

  it('makes the next card wait again once the open row has unmounted', async () => {
    const render = await mount()
    over('a')
    wait(800)
    expect(cards()).toEqual(['a'])
    render(['b'])
    expect(cards()).toEqual([])
    wait(400)
    over('b')
    expect(cards()).toEqual([])
    wait(600)
    expect(cards()).toEqual([])
    wait(150)
    expect(cards()).toEqual(['b'])
  })

  it('lets the mouse replace a card opened from the keyboard', async () => {
    await mount()
    keyboardFocus('a')
    expect(cards()).toEqual(['a'])
    over('b')
    expect(cards()).toEqual(['b'])
  })
})
