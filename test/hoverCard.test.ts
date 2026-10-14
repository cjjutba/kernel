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
  beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.append(host) })
  afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); vi.useRealTimers() })

  const mount = async () => {
    const { useHoverCard } = await import('../src/renderer/src/components/sidebar/HoverCard')
    const Row = ({ name }: { name: string }) => {
      const { at, bind } = useHoverCard()
      return React.createElement('div', { 'data-row': name, ...bind }, name, at ? React.createElement('span', { className: 'hover-card', 'data-for': name }) : null)
    }
    root = createRoot(host)
    act(() => root!.render(React.createElement('div', null, React.createElement(Row, { name: 'a' }), React.createElement(Row, { name: 'b' }))))
  }
  const over = (name: string) => act(() => { host.querySelector(`[data-row="${name}"]`)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
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
})
