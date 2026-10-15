// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ failAll: false }))
const issue = (id: string, title: string) => ({ id, title, url: `https://linear.app/x/issue/${id}`, state: { name: 'Todo', type: 'unstarted' }, priority: 2, team: { key: 'KERNEL' }, labels: [], updatedAt: new Date().toISOString(), assignee: null, project: null })

vi.mock('../src/renderer/src/api', () => ({
  cleanError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  call: vi.fn(async (channel: string, arg?: { filter?: { mine: boolean } }) => {
    if (channel === 'integrations.list') return [{ id: 'linear', connected: true }]
    if (channel === 'linear.scope') return { teams: [{ id: 't1', key: 'KERNEL', name: 'Kernel' }], projects: [], cycles: [] }
    if (channel === 'linear.issues') {
      if (calls.failAll) throw new Error('Linear returned an unexpected response.')
      return arg?.filter?.mine ? [issue('KERNEL-1', 'Mine issue')] : [issue('KERNEL-2', 'Other issue')]
    }
    throw new Error('not in this test')
  })
}))

import { LinearIssues } from '../src/renderer/src/screens/issues/LinearIssues'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React })

let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.replaceChildren(); calls.failAll = false })

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
const pill = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>('.pill')].find((b) => b.textContent?.startsWith(name))!
const titles = (host: HTMLElement) => [...host.querySelectorAll('.is-title')].map((t) => t.textContent)

describe('a failed Linear filter change (KERNEL-882)', () => {
  it('clears the rows, and going back to the filter that loaded reads it again', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(React.createElement(LinearIssues, { head: { rooms: [], room: undefined, onRoom: () => undefined } as never })))
    await settle()
    await act(async () => { pill(host, 'Mine').click() })
    await settle()
    expect(titles(host)).toEqual(['Mine issue'])

    calls.failAll = true
    await act(async () => { pill(host, 'All').click() })
    await settle()
    expect(titles(host)).toEqual([])
    expect(host.textContent).toContain('No issues are shown for this filter.')

    calls.failAll = false
    await act(async () => { pill(host, 'Mine').click() })
    await settle()
    expect(titles(host)).toEqual(['Mine issue'])
    expect(host.textContent).not.toContain('No issues are shown for this filter.')
  })
})
