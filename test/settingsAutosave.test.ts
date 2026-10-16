// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSettings } from '@shared/types'
import { fixtures } from '../fixtures'
import { ids } from '../fixtures/base'

// Settings text that edits a value already saved has no Save button: it saves when the field loses focus (KERNEL-721).
// These drive the real setup script editor and the PR instructions sheet.

vi.mock('../src/renderer/src/api', () => ({ call: vi.fn(), cleanError: (e: unknown) => String(e) }))
const { call } = await import('../src/renderer/src/api')
const { actions, getState, setState } = await import('../src/renderer/src/store')
const { ProjectSetup } = await import('../src/renderer/src/screens/settings/pages/ProjectSetup')
const { InstructionSheet } = await import('../src/renderer/src/screens/settings/pages/InstructionSheet')

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React })

const P = ids.projectA
const scene = fixtures.SettingsProjectScripts
let root: Root | undefined
let fail = false

beforeEach(() => {
  fail = false
  setState({ projects: scene.projects, settings: scene.settings, projectSettings: structuredClone(scene.projectSettings) } as never)
  vi.mocked(call).mockImplementation((async (channel: string) => {
    if (channel === 'settings.project') return getState().projectSettings[P]
    if (channel === 'settings.setProject') {
      if (fail) throw new Error('disk full')
      return getState().projectSettings[P]
    }
    return channel === 'scripts.suggest' ? [] : undefined
  }) as never)
})

afterEach(async () => {
  // A page going away saves text still in its fields, so let that save land before the next test resets the store.
  await act(async () => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.mocked(call).mockReset()
})

function mount(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(el))
}

const field = (label: string) => document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!
const type = (el: HTMLTextAreaElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const blur = (el: HTMLElement) => act(async () => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
const key = (el: HTMLElement, k: string, meta = false) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: meta, bubbles: true })) })
const saves = () => vi.mocked(call).mock.calls.filter(([c]) => c === 'settings.setProject').map(([, a]) => (a as { patch: unknown }).patch)
const savedSetup = () => getState().projectSettings[P].scripts.setup

describe('Setup script saves without a Save button', () => {
  it('saves when the field loses focus and says Saved, with no Save button on the page', async () => {
    mount(React.createElement(ProjectSetup, { projectId: P }))
    const setup = field('Setup script')
    type(setup, 'pnpm install')
    await blur(setup)
    expect(saves()).toEqual([{ scripts: { setup: 'pnpm install' } }])
    expect(savedSetup()).toBe('pnpm install')
    expect(document.querySelector('.set-save')?.textContent).toBe('Saved')
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Save'))).toBe(false)
  })

  it('saves on Cmd+Enter, and a cleared script takes the key away', async () => {
    mount(React.createElement(ProjectSetup, { projectId: P }))
    const setup = field('Setup script')
    type(setup, '   ')
    await key(setup, 'Enter', true)
    expect(saves()).toEqual([{ scripts: { setup: null } }])
  })

  it('puts the saved script back on Escape and saves nothing, not even when focus leaves after', async () => {
    mount(React.createElement(ProjectSetup, { projectId: P }))
    const setup = field('Setup script')
    const before = setup.value
    type(setup, 'rm -rf /')
    await key(setup, 'Escape')
    expect(setup.value).toBe(before)
    await blur(setup)
    expect(saves()).toEqual([])
  })

  it('keeps what is being typed when settings.toml changes on disk, and takes the new value when nothing is typed', async () => {
    mount(React.createElement(ProjectSetup, { projectId: P }))
    const setup = field('Setup script')
    const outside = (text: string) => act(() => {
      const rs = getState().projectSettings[P]
      actions.settings.setProject(P, { ...rs, scripts: { ...rs.scripts, setup: text } } as ProjectSettings)
    })
    type(setup, 'pnpm install --frozen-lockfile')
    outside('make deps')
    expect(setup.value).toBe('pnpm install --frozen-lockfile')
    await blur(setup)
    expect(savedSetup()).toBe('pnpm install --frozen-lockfile')
    outside('make deps')
    expect(setup.value).toBe('make deps')
  })

  it('puts the saved script back when the save fails', async () => {
    mount(React.createElement(ProjectSetup, { projectId: P }))
    const setup = field('Setup script')
    const before = setup.value
    fail = true
    type(setup, 'pnpm install')
    await blur(setup)
    expect(setup.value).toBe(before)
    expect(savedSetup()).toBe(before)
    expect(document.querySelector('.set-save')).toBeNull()
  })

  it('saves text still in the field when the page goes away', async () => {
    mount(React.createElement(ProjectSetup, { projectId: P }))
    type(field('Setup script'), 'pnpm install')
    await act(async () => root!.unmount())
    root = undefined
    expect(saves()).toEqual([{ scripts: { setup: 'pnpm install' } }])
  })
})

describe('PR instructions sheet saves without a Save button', () => {
  const sheet = (onSave: (t: string | null) => Promise<unknown>) =>
    mount(React.createElement(InstructionSheet, { title: 'Create PR', value: 'Open a PR.', fallback: 'Default text.', onSave: onSave as never, onClose: () => {} }))

  it('saves on blur, has Done in place of Cancel and Save, and sends null for the fallback', async () => {
    const onSave = vi.fn(async (t: string | null) => t)
    sheet(onSave)
    const text = field('Create PR')
    type(text, 'Open a draft PR.')
    await blur(text)
    expect(onSave).toHaveBeenLastCalledWith('Open a draft PR.')
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toContain('Done')
    expect(labels).not.toContain('Save')
    expect(labels).not.toContain('Cancel')
    type(text, 'Default text.')
    await blur(text)
    expect(onSave).toHaveBeenLastCalledWith(null)
  })

  it('saves text still in the field when the sheet goes away', async () => {
    const onSave = vi.fn(async (t: string | null) => t)
    sheet(onSave)
    type(field('Create PR'), 'Kept.')
    await act(async () => root!.unmount())
    root = undefined
    expect(onSave.mock.calls).toEqual([['Kept.']])
  })

  it('saves what was typed when a press on the scrim closes it', async () => {
    const onSave = vi.fn(async (t: string | null) => t)
    let open = true
    const Host = () => {
      const [shown, setShown] = React.useState(true)
      return shown ? React.createElement(InstructionSheet, { title: 'Create PR', value: 'Open a PR.', fallback: 'Default text.', onSave: onSave as never, onClose: () => { open = false; setShown(false) } }) : null
    }
    mount(React.createElement(Host))
    const text = field('Create PR')
    type(text, 'Keep this.')
    await act(async () => { document.querySelector('.scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    const dialog = document.querySelector<HTMLElement>('.modal')!
    await blur(text)
    await act(async () => { dialog.dispatchEvent(Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'modal-out' })) })
    expect(open).toBe(false)
    expect(onSave.mock.calls).toEqual([['Keep this.']])
  })

  it('closes on Escape without saving the text in the field, though the modal takes the key first', async () => {
    const onSave = vi.fn(async (t: string | null) => t)
    let open = true
    const Host = () => {
      const [shown, setShown] = React.useState(true)
      return shown ? React.createElement(InstructionSheet, { title: 'Create PR', value: 'Open a PR.', fallback: 'Default text.', onSave: onSave as never, onClose: () => { open = false; setShown(false) } }) : null
    }
    mount(React.createElement(Host))
    const text = field('Create PR')
    type(text, 'Not this.')
    await key(text, 'Escape')
    // The exit marks the dialog inert, which takes focus out of the field, then the modal leaves when its animation ends.
    const dialog = document.querySelector<HTMLElement>('.modal')!
    expect(dialog.dataset.closing).toBe('true')
    await blur(text)
    await act(async () => { dialog.dispatchEvent(Object.assign(new Event('animationend', { bubbles: true }), { animationName: 'modal-out' })) })
    expect(open).toBe(false)
    expect(onSave).not.toHaveBeenCalled()
  })
})
