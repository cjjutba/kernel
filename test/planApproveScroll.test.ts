// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '../src/shared/types'

// KERNEL-789: a plan taller than the chat leaves the transcript away from its end. Approving it from this chat's composer
// follows the end again and scrolls there, and approving a plan in another chat leaves a reader where they are.

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('../src/renderer/src/api', async (original) => ({ ...(await original<object>()), call: vi.fn().mockResolvedValue(undefined) }))

const chat = { id: 'c1', workspaceId: 'w1', kind: 'agent', title: 'Plan chat' } as unknown as Chat

describe('the transcript after Approve', () => {
  let root: Root | null = null
  let host: HTMLElement
  afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); vi.restoreAllMocks() })

  it('follows its end again and scrolls there, only for its own chat', async () => {
    const scrolled: ScrollIntoViewOptions[] = []
    Element.prototype.scrollIntoView = function (o?: boolean | ScrollIntoViewOptions) { scrolled.push(typeof o === 'object' ? o : {}) }
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    const { Transcript } = await import('../src/renderer/src/screens/workspace/Transcript')
    const { PLAN_APPROVE_EVENT } = await import('../src/renderer/src/screens/workspace/cards/plan')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(React.createElement(Transcript, { chat, workspaceId: 'w1', changes: [], onEdit: () => undefined, onOpenDiff: () => undefined, onForked: () => undefined })))
    const el = host.querySelector('.ws-scroll') as HTMLElement
    let top = 2200
    Object.defineProperties(el, { scrollHeight: { value: 3000 }, clientHeight: { value: 800 }, scrollTop: { get: () => top, set: (v: number) => { top = v } } })
    // The reader's own scroll up to the plan's first lines.
    act(() => { el.dispatchEvent(new Event('wheel', { bubbles: true })) })
    top = 100
    act(() => { el.dispatchEvent(new Event('scroll')) })
    // The empty chat draws no jump button, so the follow state is read from where the end scroll goes.
    scrolled.length = 0
    act(() => { window.dispatchEvent(new CustomEvent(PLAN_APPROVE_EVENT, { detail: { chatId: 'other' } })) })
    expect(scrolled).toEqual([])
    act(() => { window.dispatchEvent(new CustomEvent(PLAN_APPROVE_EVENT, { detail: { chatId: 'c1' } })) })
    expect(scrolled).toContainEqual({ block: 'end', behavior: 'smooth' })
  })

  it('jumps instead with reduced motion', async () => {
    const scrolled: ScrollIntoViewOptions[] = []
    Element.prototype.scrollIntoView = function (o?: boolean | ScrollIntoViewOptions) { scrolled.push(typeof o === 'object' ? o : {}) }
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    const { Transcript } = await import('../src/renderer/src/screens/workspace/Transcript')
    const { PLAN_APPROVE_EVENT } = await import('../src/renderer/src/screens/workspace/cards/plan')
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(React.createElement(Transcript, { chat, workspaceId: 'w1', changes: [], onEdit: () => undefined, onOpenDiff: () => undefined, onForked: () => undefined })))
    scrolled.length = 0
    act(() => { window.dispatchEvent(new CustomEvent(PLAN_APPROVE_EVENT, { detail: { chatId: 'c1' } })) })
    expect(scrolled).toContainEqual({ block: 'end', behavior: 'auto' })
  })
})
