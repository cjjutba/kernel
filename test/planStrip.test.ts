// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getState } from '../src/renderer/src/store'
import type { Approval } from '../src/shared/types'

// KERNEL-789: Approve closes the plan strip with no spinner, and the strip stays until its close animation ends.

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const call = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/api', async (original) => ({ ...(await original<object>()), call }))

const plan = { id: 'a1', chatId: 'c1', kind: 'plan', status: 'pending', title: 'Plan', planText: '# Plan' } as unknown as Approval

describe('the plan strip', () => {
  let root: Root | null = null
  let host: HTMLElement
  beforeEach(() => { call.mockReset(); host = document.createElement('div'); document.body.append(host) })
  afterEach(() => { act(() => root?.unmount()); root = null; host.remove() })

  const mount = async (a: Approval | undefined) => {
    const { PlanStrip } = await import('../src/renderer/src/screens/workspace/cards/plan')
    root ??= createRoot(host)
    act(() => root!.render(React.createElement(PlanStrip, { plan: a })))
  }
  const strip = () => host.querySelector('.cmp-planbar') as HTMLElement | null
  const approve = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Approve'))!
  const click = (el: HTMLElement) => act(() => { el.click() })
  const settle = () => act(async () => { await Promise.resolve() })
  const end = (el: HTMLElement) => act(() => { const e = new Event('animationend', { bubbles: true }); Object.assign(e, { animationName: 'planbar-out' }); el.dispatchEvent(e) })

  it('closes at once on Approve, with no Approving label, and ignores a second press', async () => {
    call.mockResolvedValue(undefined)
    await mount(plan)
    expect(strip()?.hasAttribute('data-closing')).toBe(false)
    click(approve())
    expect(strip()?.hasAttribute('data-closing')).toBe(true)
    expect(host.textContent).not.toContain('Approving')
    click(approve())
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, metaKey: true })) })
    await settle()
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('approvals.decide', { id: 'a1', decision: { behavior: 'allow' } })
  })

  it('stays mounted after the plan stops waiting, until the close animation ends', async () => {
    await mount(plan)
    await mount(undefined)
    expect(strip()?.hasAttribute('data-closing')).toBe(true)
    end(strip()!)
    expect(strip()).toBeNull()
  })

  it('opens again when the approval fails', async () => {
    call.mockRejectedValue(new Error('no'))
    await mount(plan)
    click(approve())
    expect(strip()?.hasAttribute('data-closing')).toBe(true)
    await settle()
    expect(strip()?.hasAttribute('data-closing')).toBe(false)
    expect(getState().ui.toasts.map((t) => t.title)).toContain('Could not approve the plan')
    click(approve())
    await settle()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('tells the transcript of this chat to scroll to its end', async () => {
    call.mockResolvedValue(undefined)
    const seen: unknown[] = []
    const on = (e: Event) => seen.push((e as CustomEvent).detail)
    const { PLAN_APPROVE_EVENT } = await import('../src/renderer/src/screens/workspace/cards/plan')
    window.addEventListener(PLAN_APPROVE_EVENT, on)
    await mount(plan)
    click(approve())
    window.removeEventListener(PLAN_APPROVE_EVENT, on)
    expect(seen).toEqual([{ chatId: 'c1' }])
  })
})
