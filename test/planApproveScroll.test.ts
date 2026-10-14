// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../src/shared/types'
import { actions } from '../src/renderer/src/store'

// KERNEL-789: a plan taller than the chat leaves the transcript away from its end. Approving it from this chat's composer
// follows the end again and scrolls there, and approving a plan in another chat leaves a reader where they are.
// KERNEL-833: the scroll is the page's own glide, so it keeps aiming at an end that moves, and the reader takes it over at once.

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('../src/renderer/src/api', async (original) => ({ ...(await original<object>()), call: () => Promise.resolve(undefined) }))

const chat = { id: 'c1', workspaceId: 'w1', kind: 'agent', title: 'Plan chat' } as unknown as Chat

describe('the transcript after Approve', () => {
  let root: Root | null = null
  let host: HTMLElement
  let frames: FrameRequestCallback[] = []
  afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); frames = [] })

  const reduced = (on: boolean) => { window.matchMedia = ((q: string) => ({ matches: on, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia }
  // One animation frame at a time, so a test can move the end between two of them.
  const frame = () => act(() => { const run = frames; frames = []; run.forEach((f) => f(0)) })
  const frameTimes = (n: number) => { for (let i = 0; i < n; i++) frame() }

  const mount = async () => {
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const scrolled: ScrollIntoViewOptions[] = []
    Element.prototype.scrollIntoView = function (o?: boolean | ScrollIntoViewOptions) { scrolled.push(typeof o === 'object' ? o : {}) }
    const { Transcript } = await import('../src/renderer/src/screens/workspace/Transcript')
    const { PLAN_APPROVE_EVENT } = await import('../src/renderer/src/screens/workspace/cards/plan')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(React.createElement(Transcript, { chat, workspaceId: 'w1', changes: [], onEdit: () => undefined, onOpenDiff: () => undefined, onForked: () => undefined })))
    const el = host.querySelector('.ws-scroll') as HTMLElement
    const view = { top: 0, height: 3000 }
    Object.defineProperties(el, { scrollHeight: { get: () => view.height }, clientHeight: { value: 800 }, scrollTop: { get: () => view.top, set: (v: number) => { view.top = Math.max(0, Math.min(view.height - 800, v)) } } })
    const approve = (chatId = 'c1') => act(() => { window.dispatchEvent(new CustomEvent(PLAN_APPROVE_EVENT, { detail: { chatId } })) })
    const wheel = () => act(() => { el.dispatchEvent(new Event('wheel', { bubbles: true })) })
    return { el, view, scrolled, approve, wheel }
  }

  it('glides to its end again, only for its own chat', async () => {
    reduced(false)
    const { view, approve, wheel, el } = await mount()
    view.top = 2200
    wheel()
    view.top = 100
    act(() => { el.dispatchEvent(new Event('scroll')) })
    approve('other')
    frameTimes(3)
    expect(view.top).toBe(100)
    approve('c1')
    frameTimes(200)
    expect(view.top).toBe(2200)
  })

  it('jumps to one screen above an end more than 1.5 screens away, then glides the rest', async () => {
    reduced(false)
    const { view, approve } = await mount()
    view.top = 0
    approve()
    expect(view.top).toBe(1400)
    frame()
    expect(view.top).toBeGreaterThan(1400)
    expect(view.top).toBeLessThan(2200)
  })

  it('does not jump for an end less than 1.5 screens away', async () => {
    reduced(false)
    const { view, approve } = await mount()
    view.top = 1500
    approve()
    expect(view.top).toBe(1500)
  })

  it('keeps aiming while the end moves, and lands on the true end', async () => {
    reduced(false)
    const { view, approve } = await mount()
    view.top = 1500
    approve()
    frameTimes(5)
    // The composer shrinks and the reply lands: the end is further down than when the glide began.
    view.height = 3150
    frameTimes(5)
    view.height = 3400
    frameTimes(200)
    expect(view.top).toBe(2600)
  })

  it('stops at once when the reader scrolls, and does not pull them back', async () => {
    reduced(false)
    const { view, approve, wheel } = await mount()
    view.top = 1500
    approve()
    frameTimes(2)
    wheel()
    const held = view.top
    expect(held).toBeLessThan(2200)
    view.top = held - 300
    frameTimes(100)
    expect(view.top).toBe(held - 300)
  })

  it('stops for a scrolling key too', async () => {
    reduced(false)
    const { view, approve, el } = await mount()
    view.top = 1500
    approve()
    frameTimes(2)
    const held = view.top
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })) })
    frameTimes(50)
    expect(view.top).toBe(held)
  })

  it('is saved as at its end when the chat is switched away from mid-glide', async () => {
    reduced(false)
    actions.chats.set('w1', [chat])
    const { takePlace } = await import('../src/renderer/src/screens/workspace/chatPlace')
    const { view, approve } = await mount()
    view.top = 100
    approve()
    frameTimes(3)
    act(() => root!.unmount())
    root = null
    expect(takePlace('c1')?.pinned).toBe(true)
  })

  it('jumps instead with reduced motion', async () => {
    reduced(true)
    const { scrolled, approve, view } = await mount()
    view.top = 100
    scrolled.length = 0
    approve()
    expect(scrolled).toContainEqual({ block: 'end', behavior: 'auto' })
  })
})
