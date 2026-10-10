import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatItem, TeamEventKind, TeamUpdate } from '../src/shared/types'
import { cardData, eventTone, legacyRows, sections, taskParts } from '../src/renderer/src/screens/workspace/cards/teamUpdate'

// KERNEL-127: Kernel's team update draws as a card, from the data saved with it or from an older update's lines.

Object.assign(globalThis, { React })

const LEGACY = [
  'Update from Kernel (not the user):',
  '- 2 earlier updates are left out.',
  '- Kai · Remove the Try section (workspace w1): opened PR #108 "feat(sidebar): remove the Try section"',
  '- Kai · Remove the Try section (workspace w1): PR #108 is ready to merge',
  '- Theo · Review PR 108 (workspace w2): finished a turn: "PR #108 is ready to merge. I found no blockers."',
  'From "Chat icons sizing", a Lead chat that is now closed:',
  '- Noor · Chat icons (workspace w3): checks failed on PR #54'
].join('\n')

describe('reading an update from before KERNEL-117', () => {
  it('groups its lines into one row per workspace, keeps the closed chat and the reply, and counts what was left out', () => {
    expect(legacyRows(LEGACY)).toEqual({
      omitted: 2,
      rows: [
        { workspaceId: 'w1', agentId: '', name: 'Kai', task: 'Remove the Try section', prNumber: 108, events: [
          { kind: 'pr.opened', text: 'Opened PR #108 "feat(sidebar): remove the Try section"', actionable: true },
          { kind: 'pr.ready', text: 'PR #108 is ready to merge', actionable: true }
        ] },
        { workspaceId: 'w2', agentId: '', name: 'Theo', task: 'Review PR 108', events: [{ kind: 'turn', text: 'Finished a turn', actionable: true }], reply: 'PR #108 is ready to merge. I found no blockers.' },
        { workspaceId: 'w3', agentId: '', name: 'Noor', task: 'Chat icons', prNumber: 54, fromChat: 'Chat icons sizing', events: [{ kind: 'pr.cifail', text: 'Checks failed on PR #54', actionable: true }] }
      ]
    })
  })

  it('uses the saved card data when there is some, and reads the lines otherwise', () => {
    const update: TeamUpdate = { rows: [{ workspaceId: 'w1', agentId: 'kai', name: 'Kai', task: 'T', events: [] }] }
    const item = (extra: object): Extract<ChatItem, { kind: 'user' }> => ({ kind: 'user', id: 'u', ts: 0, parts: [{ type: 'text', text: LEGACY }], ...extra })
    expect(cardData(item({ from: 'kernel', update }))).toBe(update)
    expect(cardData(item({})).rows).toHaveLength(3)
  })

  it('groups rows under the closed chat they came from, in order', () => {
    expect(sections(legacyRows(LEGACY).rows).map((s) => [s.fromChat, s.rows.map((r) => r.name)])).toEqual([[undefined, ['Kai', 'Theo']], ['Chat icons sizing', ['Noor']]])
  })

  it('reads a reply with quotes in it, and a task with brackets, whole', () => {
    const text = [
      'Update from Kernel (not the user):',
      '- Kai · Fix the (beta) toggle (workspace w1): finished a turn: "Renamed it to "Beta" (workspace w9): done"'
    ].join('\n')
    expect(legacyRows(text).rows).toEqual([
      { workspaceId: 'w1', agentId: '', name: 'Kai', task: 'Fix the (beta) toggle', events: [{ kind: 'turn', text: 'Finished a turn', actionable: true }], reply: 'Renamed it to "Beta" (workspace w9): done' }
    ])
  })

  it('sets an issue key apart from the task, and colors only what failed, merged or passed (KERNEL-274)', () => {
    expect(taskParts('KERNEL-182 New chats focus the composer')).toEqual({ key: 'KERNEL-182', title: 'New chats focus the composer' })
    expect(taskParts('Remove the Try section')).toEqual({ title: 'Remove the Try section' })
    const tone = (kind: TeamEventKind, text = '', actionable = false) => eventTone({ kind, text, actionable })
    expect([tone('pr.cifail'), tone('pr.conflict'), tone('crash'), tone('setup.failed')]).toEqual(['del', 'del', 'del', 'del'])
    expect([tone('pr.merged'), tone('pr.ready'), tone('setup.passed')]).toEqual(['merged', 'add', 'muted'])
    expect([tone('review', 'Approved PR #108'), tone('review', 'Found 2 blockers in PR #108')]).toEqual(['add', 'del'])
    expect([tone('turn'), tone('turn', '', true), tone('pr.opened')]).toEqual(['muted', 'ink2', 'muted'])
  })
})

describe('the Team update card', () => {
  type View = (p: { item: ChatItem; workspaceOf: (id: string) => object | undefined }) => React.ReactElement
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/cards/TeamUpdateCard' as string) as Promise<{ TeamUpdateView: View }>
  const item: ChatItem = {
    kind: 'user', id: 'u', ts: 0, from: 'kernel', parts: [{ type: 'text', text: 'Team update from Kernel, not from the user.' }],
    update: { omitted: 1, rows: [{ workspaceId: 'w1', agentId: 'kai', name: 'Kai', task: 'Remove the Try section', prNumber: 108, reply: 'x'.repeat(300),
      events: [{ kind: 'pr.opened', text: 'Opened PR #108', actionable: false }, { kind: 'pr.ready', text: 'Passed checks, no conflicts', actionable: true }] }] }
  }

  it('draws a card from Kernel with the teammate, its events, the reply and Copy, and no Edit', async () => {
    const { TeamUpdateView } = await load()
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item, workspaceOf: (id) => (id === 'w1' ? { id: 'w1', status: 'ready' } : undefined) }))
    expect(html).toContain('aria-label="Team update from Kernel"')
    expect(html).toContain('Team update')
    expect(html).toContain('<span class="tucard-name">Kai</span>')
    // Events read as one line between dots; only what passed, failed or merged takes a color (KERNEL-274).
    expect(html).toContain('<span class="tucard-ev" data-tone="muted">Opened PR #108<span class="sr-only">. </span></span>')
    expect(html).toContain('<span class="tucard-sep" aria-hidden="true">·</span>')
    expect(html).toContain('<span class="tucard-ev" data-tone="add">Passed checks, no conflicts<span class="sr-only">. </span></span>')
    // The reply starts clamped. Show more waits until the lines are measured and run over, which a static render never does.
    expect(html).toContain('data-clamped="true"')
    expect(html).not.toContain('Show more')
    expect(html).toContain('<h3 class="tucard-title">Team update</h3>')
    expect(html).toContain('Updates on 1 more workspace left out')
    expect(html).toContain('>Copy<')
    expect(html).not.toContain('>Edit<')
    expect(html).toMatch(/<button[^>]*aria-label="Open Kai&#x27;s workspace for Remove the Try section"[^>]*>Open<\/button>/)
  })

  it('counts what an older update left out in updates, and shows one with no rows it can read as a note', async () => {
    const { TeamUpdateView } = await load()
    const legacy = (text: string): ChatItem => ({ kind: 'user', id: 'u', ts: 0, parts: [{ type: 'text', text }] })
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: legacy(LEGACY), workspaceOf: () => undefined }))
    expect(html).toContain('2 earlier updates left out')
    const odd = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: legacy('Update from Kernel (not the user):\nSomething Kernel no longer writes'), workspaceOf: () => undefined }))
    expect(odd).not.toContain('tucard')
    expect(odd).toContain('class="note"')
    expect(odd).toContain('Something Kernel no longer writes')
  })

  it('sends an archived workspace to History, and shows no Open for one that is gone', async () => {
    const { TeamUpdateView } = await load()
    const archived = renderToStaticMarkup(React.createElement(TeamUpdateView, { item, workspaceOf: () => ({ id: 'w1', status: 'archived' }) }))
    expect(archived).toMatch(/aria-label="Find Kai&#x27;s workspace for Remove the Try section in History"[^>]*>In History</)
    const gone = renderToStaticMarkup(React.createElement(TeamUpdateView, { item, workspaceOf: () => undefined }))
    expect(gone).not.toContain('tucard-open')
  })
})
