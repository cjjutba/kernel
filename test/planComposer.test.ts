// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { actions } from '../src/renderer/src/store'
import type { Approval, Chat } from '../src/shared/types'

// KERNEL-895: the message box leaves plan mode in the frame its plan stops waiting, and the placeholder comes from the current state only.

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const call = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/api', async (original) => ({ ...(await original<object>()), call }))

const chat = { id: 'c1', workspaceId: 'w1', kind: 'agent', title: 'Plan chat', plan: true, model: 'claude-opus-5-5', effort: 'medium' } as unknown as Chat
const plan = { id: 'a1', chatId: 'c1', workspaceId: 'w1', kind: 'plan', status: 'pending', title: 'Plan', planText: '# Plan', toolName: 'ExitPlanMode' } as unknown as Approval

describe('the composer around the plan strip', () => {
  let root: Root | null = null
  let host: HTMLElement
  beforeEach(() => {
    call.mockReset()
    call.mockImplementation((name: string) => Promise.resolve(name === 'providers.status' ? { signedIn: false } : undefined))
    host = document.createElement('div')
    document.body.append(host)
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  })
  afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); vi.restoreAllMocks() })

  let Composer: typeof import('../src/renderer/src/screens/workspace/composer/Composer').Composer
  const render = (planning: boolean) => act(() => root!.render(React.createElement(Composer, { chat: { ...chat, plan: planning }, blocked: false, running: false })))
  const mount = async (planning = false) => {
    ;({ Composer } = await import('../src/renderer/src/screens/workspace/composer/Composer'))
    root = createRoot(host)
    render(planning)
  }
  const chip = () => host.querySelector('.cmp-mode')?.getAttribute('data-mode')
  const box = () => host.querySelector('.cmp') as HTMLElement
  const placeholder = () => host.querySelector('.cmp-input')?.getAttribute('data-placeholder')

  it('changes the placeholder, the chip and the glow in the frame the plan stops waiting', async () => {
    act(() => actions.approvals.set([plan]))
    await mount(true)
    expect(chip()).toBe('plan')
    expect(placeholder()).toBe('Enter your plan adjustments here')
    expect(box().getAttribute('data-plan')).toBe('true')
    act(() => actions.approvals.set([{ ...plan, status: 'allowed' }]))
    render(false)
    expect(host.querySelector('.cmp-planbar')).toBeNull()
    expect(placeholder()).not.toBe('Enter your plan adjustments here')
    expect(chip()).not.toBe('plan')
    expect(box().hasAttribute('data-plan')).toBe(false)
  })

  it('shows the plan placeholder only while a plan waits', async () => {
    await mount(false)
    expect(placeholder()).not.toBe('Enter your plan adjustments here')
    act(() => actions.approvals.set([plan]))
    expect(placeholder()).toBe('Enter your plan adjustments here')
    act(() => actions.approvals.set([]))
    expect(placeholder()).not.toBe('Enter your plan adjustments here')
  })
})
