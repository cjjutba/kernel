// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getState } from '../src/renderer/src/store'
import type { Approval } from '../src/shared/types'

// KERNEL-789: Approve closes the plan strip with no spinner. KERNEL-895: it leaves in the frame of the press, with no close animation.
// KERNEL-833: Approve asks first when the box has text.

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

  // What the composer does: it owns the strip's state.
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
    const meta = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, metaKey: true })) })

  it('leaves in the frame of Approve, with no Approving label and no animation, and ignores a second press', async () => {
    call.mockResolvedValue(undefined)
    await mount(plan)
    expect(strip()).not.toBeNull()
    click(button('Approve'))
    expect(strip()).toBeNull()
    expect(holding()).toBe(false)
    expect(host.textContent).not.toContain('Approving')
    meta()
    await settle()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('approvals.decide', { id: 'a1', decision: { behavior: 'allow' } })
  })

  it('is gone the moment its plan stops waiting, and a new plan opens at once', async () => {
    await mount(plan)
    await mount(undefined)
    expect(strip()).toBeNull()
    await mount(next)
    expect(strip()).not.toBeNull()
  })

  it('stays gone while a slow approval is in flight, and comes back when it fails', async () => {
    let fail: (e: Error) => void = () => undefined
    call.mockReturnValue(new Promise((_, no) => { fail = no }))
    await mount(plan)
    click(button('Approve'))
    await mount({ ...plan })
    expect(strip()).toBeNull()
    fail(new Error('no'))
    await settle()
    expect(strip()).not.toBeNull()
    expect(getState().ui.toasts.map((t) => t.title)).toContain('Could not approve the plan')
  })

  it('can be approved again after a failed approval', async () => {
    call.mockRejectedValueOnce(new Error('no')).mockResolvedValue(undefined)
    await mount(plan)
    click(button('Approve'))
    await settle()
    click(button('Approve'))
    await settle()
    expect(call).toHaveBeenCalledTimes(2)
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

  describe('with text in the box', () => {
    it('asks before approving, from the button and from ⌘⇧↵, and approves nothing yet', async () => {
      call.mockResolvedValue(undefined)
      await mount(plan, true)
      click(button('Approve'))
      expect(host.textContent).toContain('Approve without your changes?')
      expect(call).not.toHaveBeenCalled()
      expect(strip()).not.toBeNull()
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
      expect(strip()).toBeNull()
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

// Who does each step is picked on the plan card and sent with Approve (plan-step-owners).
describe('the owner of a plan step', () => {
  const agents = [
    { id: 'lead', name: 'Kernel', role: 'Lead', lead: true, member: false },
    { id: 'sean', name: 'Sean', role: 'Engine', lead: false, member: true },
    { id: 'helper', name: 'Scout', role: 'Helper', lead: false, member: false }
  ] as never
  const steps = [{ title: 'T-1 Renderer', agentId: 'sean' }, { title: 'T-2 Docs' }]
  const owned = (id: string, status: Approval['status'] = 'pending') => ({ id, chatId: 'c1', kind: 'plan', status, title: 'Plan', detail: '# Plan', steps }) as unknown as Approval
  let root: Root
  let host: HTMLElement
  beforeEach(() => {
    call.mockReset()
    host = document.createElement('div')
    document.body.append(host)
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
    root = createRoot(host)
  })
  afterEach(() => { act(() => root.unmount()); host.remove(); document.body.querySelectorAll('.menu-anchor').forEach((m) => m.remove()) })

  const draw = async (a: Approval) => {
    const { PlanTasks, usePlanStrip } = await import('../src/renderer/src/screens/workspace/cards/plan')
    function Both() {
      const strip = usePlanStrip(a)
      return React.createElement('div', null, React.createElement(PlanTasks, { a, agents }), React.createElement('button', { type: 'button', onClick: strip.approve }, 'Approve'))
    }
    act(() => root.render(React.createElement(Both)))
  }
  const press = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click() })
  const trigger = (n: number) => host.querySelector(`button[aria-label^="Who does step ${n}:"]`)
  const items = () => [...document.body.querySelectorAll('[role=menuitemradio], [role=menuitem]')]
  const approve = async () => {
    press([...host.querySelectorAll('button')].find((b) => b.textContent === 'Approve'))
    await act(async () => { await Promise.resolve() })
  }

  it('shows Kernel for a step with no owner, and lists Kernel then the teammates who take tasks', async () => {
    await draw(owned('o1'))
    expect(trigger(2)?.textContent).toContain('Kernel')
    press(trigger(2))
    expect(items().map((i) => i.textContent?.replace(/does it itself|Engine/, '').trim())).toEqual(['Kernel', 'Sean'])
    expect(trigger(2)?.getAttribute('aria-expanded')).toBe('true')
  })

  it('sends only the owners the user changed, with Approve', async () => {
    call.mockResolvedValue(undefined)
    await draw(owned('o2'))
    press(trigger(2))
    press(items().find((i) => i.textContent?.startsWith('Sean')))
    expect(trigger(2)?.textContent).toContain('Sean')
    await approve()
    expect(call).toHaveBeenCalledWith('approvals.decide', { id: 'o2', decision: { behavior: 'allow', owners: ['sean', 'sean'] } })
  })

  it('sends no owners when a pick goes back to what the Lead proposed', async () => {
    call.mockResolvedValue(undefined)
    await draw(owned('o3'))
    press(trigger(2))
    press(items().find((i) => i.textContent?.startsWith('Sean')))
    press(trigger(2))
    press(items().find((i) => i.textContent?.startsWith('Kernel')))
    await approve()
    expect(call).toHaveBeenCalledWith('approvals.decide', { id: 'o3', decision: { behavior: 'allow' } })
  })

  it('is plain text once the plan is decided', async () => {
    await draw(owned('o4', 'allowed'))
    expect(host.querySelector('button[aria-haspopup=menu]')).toBeNull()
    expect(host.querySelector('.plan-who')?.textContent).toContain('Sean')
  })
})
