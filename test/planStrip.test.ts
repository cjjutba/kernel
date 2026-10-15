// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getState } from '../src/renderer/src/store'
import type { Approval } from '../src/shared/types'

// KERNEL-789: Approve closes the plan strip with no spinner, and the strip stays until its close animation ends.
// KERNEL-833: the box holds plan mode with it, a slow approval or a hidden window can't leave it behind, and Approve asks first when the box has text.

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const call = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/api', async (original) => ({ ...(await original<object>()), call }))

const plan = { id: 'a1', chatId: 'c1', kind: 'plan', status: 'pending', title: 'Plan', planText: '# Plan' } as unknown as Approval
const next = { ...plan, id: 'a2' } as Approval

describe('the plan strip', () => {
  let root: Root | null = null
  let host: HTMLElement
  const calls = { focus: 0, send: 0, back: 0 }
  beforeEach(() => {
    call.mockReset()
    calls.focus = calls.send = calls.back = 0
    host = document.createElement('div')
    document.body.append(host)
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  })
  afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); vi.restoreAllMocks() })

  // What the composer does: it owns the strip's state and reads `holding` for the placeholder, the chip and the glow.
  let Harness: (p: { plan: Approval | undefined; text: boolean }) => React.ReactElement
  const mount = async (a: Approval | undefined, hasText = false) => {
    const { PlanStrip, usePlanStrip } = await import('../src/renderer/src/screens/workspace/cards/plan')
    // One component type, so a second render keeps its state.
    Harness ??= function Harness({ plan: p, text }) {
      const strip = usePlanStrip(p, () => { calls.focus++ })
      return React.createElement('div', { 'data-holding': !!strip.shown || undefined },
        React.createElement(PlanStrip, { strip, hasText: text, onSendChanges: () => { calls.send++ }, onBack: () => { calls.back++ } }),
        React.createElement('span', { className: 'said' }, strip.said))
    }
    root ??= createRoot(host)
    act(() => root!.render(React.createElement(Harness, { plan: a, text: hasText })))
  }
  const strip = () => host.querySelector('.cmp-planbar') as HTMLElement | null
  const holding = () => host.firstElementChild!.hasAttribute('data-holding')
  const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(name))!
  const click = (el: HTMLElement) => act(() => { el.click() })
  const settle = () => act(async () => { await Promise.resolve() })
  const fire = (el: HTMLElement, type: 'animationend' | 'animationcancel') => act(() => { const e = new Event(type, { bubbles: true }); Object.assign(e, { animationName: 'planbar-out' }); el.dispatchEvent(e) })
  const end = (el: HTMLElement) => fire(el, 'animationend')
  const meta = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, metaKey: true })) })

  it('closes at once on Approve, with no Approving label, and ignores a second press', async () => {
    call.mockResolvedValue(undefined)
    await mount(plan)
    expect(strip()?.hasAttribute('data-closing')).toBe(false)
    click(button('Approve'))
    expect(strip()?.hasAttribute('data-closing')).toBe(true)
    expect(host.textContent).not.toContain('Approving')
    click(button('Approve'))
    meta()
    await settle()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('approvals.decide', { id: 'a1', decision: { behavior: 'allow' } })
  })

  it('stays mounted after the plan stops waiting, and the box holds plan mode until the close animation ends', async () => {
    await mount(plan)
    await mount(undefined)
    expect(strip()?.hasAttribute('data-closing')).toBe(true)
    expect(holding()).toBe(true)
    end(strip()!)
    expect(strip()).toBeNull()
    expect(holding()).toBe(false)
  })

  it('is removed when its animation ends even though the plan still waits, and stays gone', async () => {
    call.mockReturnValue(new Promise(() => undefined))
    await mount(plan)
    click(button('Approve'))
    end(strip()!)
    expect(strip()).toBeNull()
    expect(holding()).toBe(false)
    await mount({ ...plan })
    expect(strip()).toBeNull()
  })

  it('is removed when its animation is cancelled', async () => {
    await mount(plan)
    await mount(undefined)
    fire(strip()!, 'animationcancel')
    expect(strip()).toBeNull()
  })

  it('is removed at once in a hidden window, where no animation runs', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await mount(plan)
    click(button('Approve'))
    await settle()
    expect(strip()).toBeNull()
  })

  it('opens again when the approval fails, as a new strip if the old one had gone', async () => {
    call.mockRejectedValue(new Error('no'))
    await mount(plan)
    click(button('Approve'))
    expect(strip()?.hasAttribute('data-closing')).toBe(true)
    await settle()
    expect(strip()?.hasAttribute('data-closing')).toBe(false)
    expect(getState().ui.toasts.map((t) => t.title)).toContain('Could not approve the plan')
    click(button('Approve'))
    await settle()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('mounts a strip that had gone again when a slow approval fails', async () => {
    let fail: (e: Error) => void = () => undefined
    call.mockReturnValue(new Promise((_, no) => { fail = no }))
    await mount(plan)
    click(button('Approve'))
    end(strip()!)
    expect(strip()).toBeNull()
    fail(new Error('no'))
    await settle()
    expect(strip()).not.toBeNull()
    expect(strip()?.hasAttribute('data-closing')).toBe(false)
  })

  it('lets the old strip finish before a new plan opens its own', async () => {
    await mount(plan)
    await mount(next)
    expect(strip()?.hasAttribute('data-closing')).toBe(true)
    expect(holding()).toBe(true)
    end(strip()!)
    expect(strip()).not.toBeNull()
    expect(strip()?.hasAttribute('data-closing')).toBe(false)
  })

  it('moves the caret to the box and says "Plan approved" once the approval went through', async () => {
    call.mockResolvedValue(undefined)
    await mount(plan)
    expect(host.querySelector('.said')?.textContent).toBe('')
    click(button('Approve'))
    expect(calls.focus).toBe(1)
    await settle()
    expect(host.querySelector('.said')?.textContent).toBe('Plan approved')
  })

  it('tells the transcript of this chat to scroll to its end', async () => {
    call.mockResolvedValue(undefined)
    const seen: unknown[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    const { PLAN_APPROVE_EVENT } = await import('../src/renderer/src/screens/workspace/cards/plan')
    window.addEventListener(PLAN_APPROVE_EVENT, on)
    await mount(plan)
    click(button('Approve'))
    window.removeEventListener(PLAN_APPROVE_EVENT, on)
    await settle()
    expect(seen).toEqual([{ chatId: 'c1' }])
  })

  describe('with text in the box', () => {
    it('asks before approving, from the button and from ⌘⇧↵, and approves nothing yet', async () => {
      call.mockResolvedValue(undefined)
      await mount(plan, true)
      click(button('Approve'))
      expect(host.textContent).toContain('Approve without your changes?')
      expect(call).not.toHaveBeenCalled()
      expect(strip()?.hasAttribute('data-closing')).toBe(false)
      expect(document.activeElement?.textContent).toBe('Send changes')
    })

    it('opens the question on ⌘⇧↵, and a second ⌘⇧↵ approves', async () => {
      call.mockResolvedValue(undefined)
      await mount(plan, true)
      meta()
      expect(host.textContent).toContain('Approve without your changes?')
      meta()
      await settle()
      expect(call).toHaveBeenCalledTimes(1)
      expect(calls.send).toBe(0)
    })

    it('sends the text as the change request on Send changes, and approves nothing', async () => {
      await mount(plan, true)
      click(button('Approve'))
      click(button('Send changes'))
      expect(calls.send).toBe(1)
      expect(call).not.toHaveBeenCalled()
      expect(host.textContent).not.toContain('Approve without your changes?')
    })

    it('approves and leaves the text alone on Approve', async () => {
      call.mockResolvedValue(undefined)
      await mount(plan, true)
      click(button('Approve'))
      click(button('Approve'))
      await settle()
      expect(call).toHaveBeenCalledWith('approvals.decide', { id: 'a1', decision: { behavior: 'allow' } })
      expect(calls.send).toBe(0)
      expect(strip()?.hasAttribute('data-closing')).toBe(true)
    })

    it('backs out on Escape and hands the caret back to the box', async () => {
      await mount(plan, true)
      click(button('Approve'))
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
      expect(host.textContent).not.toContain('Approve without your changes?')
      expect(calls.back).toBe(1)
      expect(call).not.toHaveBeenCalled()
    })

    it('keeps Escape for a text field being edited, and the question stays', async () => {
      await mount(plan, true)
      click(button('Approve'))
      const field = document.createElement('input')
      host.append(field)
      field.focus()
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      act(() => { field.dispatchEvent(e) })
      expect(host.textContent).toContain('Approve without your changes?')
      expect(calls.back).toBe(0)
      expect(e.defaultPrevented).toBe(false)
    })

    it('drops the question when the text is cleared', async () => {
      await mount(plan, true)
      click(button('Approve'))
      await mount(plan, false)
      expect(host.textContent).not.toContain('Approve without your changes?')
    })
  })
})
