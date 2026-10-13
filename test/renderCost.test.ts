// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import { fixtures } from '../fixtures'
import { fixtureHandlers, fixturePush } from '../src/main/fixtures'
import type { PushEvent } from '../src/shared/ipc'

// Every push event used to replace a whole map in the store, and about 24 components read whole maps, so a message in a chat nobody was looking at redrew
// parts of the window (the window sat at 5 to 12% CPU while agents worked). This mounts the Workspace fixture, pushes events for a chat that is on screen and
// one that is not, and records which components React ran for each. A component of another workspace, or the screen itself, must not run for an off-screen event.

Object.assign(globalThis, {
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestIdleCallback: (cb: () => void) => setTimeout(cb, 0),
  cancelIdleCallback: (id: number) => clearTimeout(id)
})

type Fiber = { tag: number; type: unknown; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps: Record<string, unknown> | null }
const PERFORMED_WORK = 1
const RUNS_USER_CODE = [0, 11, 15] // function component, forwardRef, simple memo

const nameOf = (t: unknown): string => {
  if (!t) return ''
  if (typeof t === 'function') return (t as { displayName?: string }).displayName || t.name
  const x = t as { displayName?: string; type?: unknown; render?: unknown }
  return x.displayName || nameOf(x.type ?? x.render)
}

/** The components that ran in one commit, as `Name` or `Name[workspace id]` for rows that carry a `ws`. A fiber that bailed out keeps its last render's flags, so this only descends where the commit made new fibers, the way DevTools diffs against `alternate`. */
function ran(parent: Fiber, out: string[]) {
  if (parent.alternate && parent.child === parent.alternate.child) return
  for (let f = parent.child; f; f = f.sibling) {
    if (RUNS_USER_CODE.includes(f.tag) && f.flags & PERFORMED_WORK) {
      const name = nameOf(f.type)
      const ws = (f.memoizedProps?.ws as { id?: string } | undefined)?.id
      if (name) out.push(ws ? `${name}[${ws}]` : name)
    }
    ran(f, out)
  }
}

const commits: string[][] = []
Object.assign(globalThis, {
  __REACT_DEVTOOLS_GLOBAL_HOOK__: {
    supportsFiber: true,
    inject: () => 1,
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      const out: string[] = []
      ran(root.current, out)
      commits.push(out)
    }
  }
})

const fixture = fixtures.Workspace
const SCREEN = 'ws-invoice-table'
const ON = 'chat-invoice-table'
const OFF = 'chat-invoice-schema'
const OFF_WS = 'ws-invoice-schema'
const workspaceOf = (id: string) => fixture.workspaces.find((w) => w.id === id)!

let push: (e: PushEvent) => void = () => {}
beforeAll(async () => {
  const handlers = fixtureHandlers(fixture) as Record<string, (req: unknown) => Promise<unknown>>
  Object.assign(window, {
    kernel: {
      invoke: async (c: string, r: unknown) => (c === 'system.fixture' ? { ui: fixture.ui, push: fixturePush(fixture) } : handlers[c](r)),
      on: (l: (e: PushEvent) => void) => { push = l; return () => {} }
    }
  })
  // React reads the DevTools hook when it loads, so it comes after the hook above.
  const { createRoot } = await import('react-dom/client')
  const { App } = await import('../src/renderer/src/App')
  const store = await import('../src/renderer/src/store')
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => { createRoot(host).render(React.createElement(App)); await store.boot() })
  for (let i = 0; i < 100 && !store.getState().system.booted; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  expect(store.getState().system.booted).toBe(true)
})

let n = 0
/** The components an event made React run. One event of the same kind goes first, so first-time work (effects, lazy loads) is not counted. */
async function renders(make: (n: number) => PushEvent): Promise<string[]> {
  await act(async () => { push(make(++n)) })
  commits.length = 0
  await act(async () => { push(make(++n)) })
  if (process.env.RENDER_COST) console.log(`RENDER_COST ${make.name} ${commits.flat().length} ${JSON.stringify(commits.flat())}`)
  return commits.flat()
}

const item = (chatId: string) => (i: number): PushEvent => ({ type: 'chat.item', chatId, item: { kind: 'text', id: `rc-${i}`, ts: Date.now(), text: 'hello' } })
const running = (chatId: string) => (i: number): PushEvent => ({ type: 'chat.running', chatId, running: i % 2 === 1 })
const terminal = (chatId: string) => (i: number): PushEvent => ({ type: 'terminal.data', chatId, data: `line ${i}\r\n` })
const queue = (chatId: string) => (): PushEvent => ({ type: 'chat.queue', chatId, queue: [] })
const workspace = (id: string) => (i: number): PushEvent => ({ type: 'workspace', workspace: { ...workspaceOf(id), branch: `${workspaceOf(id).branch}-${i}` } })

/** Parts of the screen in view. */
const SCREEN_PARTS = ['Workspace', 'Transcript2', 'Composer', 'ChatTabs', 'RightPanel', 'BottomPanel']
const named = (list: string[], names: string[]) => list.filter((r) => names.some((n) => r === n || r.startsWith(`${n}[`)))
const ofOtherWorkspace = (list: string[], mine: string) => list.filter((r) => /\[ws-[^\]]+\]$/.test(r) && !r.endsWith(`[${mine}]`))

describe('what a store event redraws', () => {
  it('draws nothing for a message in a chat that is not on screen', async () => {
    expect(await renders(item(OFF))).toEqual([])
  })

  it('draws the transcript, and nothing in the sidebar or another workspace, for a message in the chat on screen', async () => {
    const list = await renders(item(ON))
    expect(list).toContain('Transcript2')
    expect(named(list, ['AppSidebar', 'RoomItem', 'ChatItemRow', 'WorkspaceItemRow', 'Toasts', 'AskRowanButton'])).toEqual([])
    expect(ofOtherWorkspace(list, SCREEN)).toEqual([])
    expect(named(list, ['Workspace', 'Composer', 'RightPanel', 'BottomPanel', 'ChatTabs'])).toEqual([])
  })

  it('draws only the chat\'s own sidebar row when an off-screen chat starts or stops', async () => {
    const list = await renders(running(OFF))
    expect(list).toContain(`WorkspaceItemRow[${OFF_WS}]`)
    expect(named(list, ['AppSidebar', 'RoomItem', 'ChatItemRow', 'Toasts', 'AskRowanButton', ...SCREEN_PARTS])).toEqual([])
    expect(ofOtherWorkspace(list, OFF_WS)).toEqual([])
  })

  it('draws nothing for terminal output or a queue change in an off-screen chat', async () => {
    expect(await renders(terminal(OFF))).toEqual([])
    expect(await renders(queue(OFF))).toEqual([])
  })

  it('draws only that workspace\'s sidebar row (and its room) when an off-screen workspace changes', async () => {
    const list = await renders(workspace(OFF_WS))
    expect(list).toContain(`WorkspaceItemRow[${OFF_WS}]`)
    expect(named(list, ['AppSidebar', 'ChatItemRow', 'Toasts', 'AskRowanButton', 'UpdateCard', ...SCREEN_PARTS])).toEqual([])
    expect(ofOtherWorkspace(list, OFF_WS)).toEqual([])
    expect(list.filter((r) => r === 'RoomItem')).toHaveLength(1)
  })

  it('draws the workspace on screen, and no other row, when it changes', async () => {
    const list = await renders(workspace(SCREEN))
    expect(list).toContain('Workspace')
    expect(named(list, ['AppSidebar', 'ChatItemRow', 'Toasts', 'AskRowanButton'])).toEqual([])
    expect(ofOtherWorkspace(list, SCREEN)).toEqual([])
  })
})
