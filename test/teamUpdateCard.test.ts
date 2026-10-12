import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, PrInfo, PrPending, TeamEventKind, TeamUpdate, Workspace } from '../src/shared/types'
import { cardData, eventTone, legacyRows, newestRows, sections, taskParts } from '../src/renderer/src/screens/workspace/cards/teamUpdate'

// KERNEL-127: Kernel's team update draws as a card, from the data saved with it or from an older update's lines.

Object.assign(globalThis, { React })

// The store reads need a browser, so the card gets a stand-in for MergeButton. It shows which workspace it was given, and draws
// the Merge place MergeButton draws, with `pending` standing for the store's prPending (KERNEL-520).
const pending = vi.hoisted(() => ({}) as Record<string, PrPending>)
vi.mock('../src/renderer/src/screens/workspace/pr/MergeButton', async (original) => {
  const real = await original<typeof import('../src/renderer/src/screens/workspace/pr/MergeButton')>()
  const noRules = { requireGreen: false, requireReviewer: false }
  return {
    ...real,
    MergeButton: ({ ws }: { ws: Workspace }) => React.createElement('span', { className: 'stub-merge' },
      React.createElement(real.MergeSlot, { ws, view: real.mergeView(ws, undefined, noRules, undefined, undefined, pending[ws.id]), onMerge: () => undefined }))
  }
})

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
    // A review with its kind in front (KERNEL-549) reads the same: approvals green, blockers red (KERNEL-581).
    expect([tone('review', 'Code review approved PR #491'), tone('review', 'Security review approved PR #491'), tone('review', 'UX review approved PR #491'), tone('review', 'Approved')]).toEqual(['add', 'add', 'add', 'add'])
    expect([tone('review', 'Code review found 2 blockers in PR #491'), tone('review', 'UX review found 1 blocker in Kai\'s work')]).toEqual(['del', 'del'])
    expect([tone('turn'), tone('turn', '', true), tone('pr.opened')]).toEqual(['muted', 'ink2', 'muted'])
    // GitHub lifting its block reads like the PR being ready; a block takes the grey of anything else (KERNEL-401).
    expect([tone('pr.unblocked'), tone('pr.blocked'), tone('pr.blocked', '', true)]).toEqual(['add', 'muted', 'ink2'])
  })
})

describe('the Team update card', () => {
  type View = (p: { item: ChatItem; workspaceOf: (id: string) => object | undefined; useNewest?: (target: string, itemId: string, rowId: string) => boolean }) => React.ReactElement
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/cards/TeamUpdateCard' as string) as Promise<{ TeamUpdateView: View }>
  const item: ChatItem = {
    kind: 'user', id: 'u', ts: 0, from: 'kernel', parts: [{ type: 'text', text: 'Team update from Kernel, not from the user.' }],
    update: { omitted: 1, rows: [{ workspaceId: 'w1', agentId: 'kai', name: 'Kai', task: 'Remove the Try section', prNumber: 108, reply: 'x'.repeat(300),
      events: [{ kind: 'pr.opened', text: 'Opened PR #108', actionable: false }, { kind: 'pr.ready', text: 'Passed checks, no conflicts', actionable: true }] }] }
  }

  it('shows the issue key from the workspace, and the reply with inline code as chips (KERNEL-411)', async () => {
    const { TeamUpdateView } = await load()
    const real: ChatItem = { ...item, update: { rows: [{ ...item.update!.rows[0], task: 'Home and Inbox count a workspace waiting for script trust', reply: 'Merged `origin/main` and `pnpm test:changed` passes.' }] } }
    const workspaceOf = (id: string) => (id === 'w1' ? { id: 'w1', status: 'ready', source: { kind: 'issue', id: 'KERNEL-395', title: 'Home and Inbox' } } : undefined)
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: real, useNewest: () => false, workspaceOf }))
    // The task has no key, so it comes from the issue the workspace started on, as the PRs tab reads it.
    expect(html).toContain('<span class="tucard-key">KERNEL-395</span>')
    expect(html).toContain('<code class="md-code">origin/main</code>')
    expect(html).toContain('<code class="md-code">pnpm test:changed</code>')
    expect(html).not.toContain('`')
  })

  it('draws a card from Kernel with the teammate, its events, the reply and Copy, and no Edit', async () => {
    const { TeamUpdateView } = await load()
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item, useNewest: () => false, workspaceOf: (id) => (id === 'w1' ? { id: 'w1', status: 'ready' } : undefined) }))
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
    expect(html).toContain('aria-label="Copy"')
    expect(html).not.toContain('aria-label="Edit"')
    expect(html).toMatch(/<button[^>]*aria-label="Open Kai&#x27;s workspace for Remove the Try section"[^>]*>Open<\/button>/)
  })

  it('counts what an older update left out in updates, and shows one with no rows it can read as a note', async () => {
    const { TeamUpdateView } = await load()
    const legacy = (text: string): ChatItem => ({ kind: 'user', id: 'u', ts: 0, parts: [{ type: 'text', text }] })
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: legacy(LEGACY), useNewest: () => false, workspaceOf: () => undefined }))
    expect(html).toContain('2 earlier updates left out')
    const odd = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: legacy('Update from Kernel (not the user):\nSomething Kernel no longer writes'), useNewest: () => false, workspaceOf: () => undefined }))
    expect(odd).not.toContain('tucard')
    expect(odd).toContain('class="note"')
    expect(odd).toContain('Something Kernel no longer writes')
  })

  it('names a closed tab of this chat apart from a closed Lead chat, from saved rows and from the lines (KERNEL-337)', async () => {
    const { TeamUpdateView } = await load()
    const row = (workspaceId: string, extra: object) => ({ workspaceId, agentId: 'kai', name: 'Kai', task: 'T', events: [], ...extra })
    const saved: ChatItem = { ...item, update: { rows: [row('w1', { fromChat: 'Icons', fromTab: true }), row('w2', { fromChat: 'Icons' })] } }
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: saved, useNewest: () => false, workspaceOf: () => undefined }))
    expect(html).toContain('From &quot;Icons&quot;, a tab you closed')
    expect(html).toContain('From &quot;Icons&quot;, a Lead chat that is now closed')
    const text = ['Update from Kernel (not the user):', 'From "Icons", a tab you closed:', '- Kai · T (workspace w1): checks failed on PR #54', 'From "Icons", a Lead chat that is now closed:', '- Kai · T (workspace w1): checks failed on PR #54'].join('\n')
    expect(sections(legacyRows(text).rows).map((s) => [s.fromChat, s.fromTab, s.rows.length])).toEqual([['Icons', true, 1], ['Icons', undefined, 1]])
  })

  it('sends an archived workspace to History, and shows no Open for one that is gone', async () => {
    const { TeamUpdateView } = await load()
    const archived = renderToStaticMarkup(React.createElement(TeamUpdateView, { item, useNewest: () => false, workspaceOf: () => ({ id: 'w1', status: 'archived' }) }))
    expect(archived).toMatch(/aria-label="Find Kai&#x27;s workspace for Remove the Try section in History"[^>]*>In History</)
    const gone = renderToStaticMarkup(React.createElement(TeamUpdateView, { item, useNewest: () => false, workspaceOf: () => undefined }))
    expect(gone).not.toContain('tucard-open')
  })
})

describe('Merge on a Team update row (KERNEL-351)', () => {
  const load = () => import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/cards/TeamUpdateCard' as string) as Promise<{ TeamUpdateView: (p: { item: ChatItem; workspaceOf: (id: string) => object | undefined; useNewest: (target: string, itemId: string, rowId: string) => boolean }) => React.ReactElement }>
  const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, roomId: 'r', name: id, branch: id, baseRef: 'main', path: `/${id}`, mode: 'worktree', agentId: 'kai', status: 'ready', prState: 'ready', prNumber: 7, createdAt: 0, ...over } as Workspace)
  const card = (id: string, ...rows: [workspaceId: string, name?: string][]): ChatItem => ({
    kind: 'user', id, ts: 0, from: 'kernel', parts: [{ type: 'text', text: 'Team update' }],
    update: { rows: rows.map(([workspaceId, name]) => ({ workspaceId, agentId: 'kai', name: name ?? 'Kai', task: 'T', events: [] })) }
  })
  const workspaces = [ws('w1', { prNumber: 162 }), ws('w2', { prNumber: 161 }), ws('review', { reviewOf: 'w2', prState: 'none', prNumber: undefined }), ws('review2', { reviewOf: 'w2', prState: 'none', prNumber: undefined })]
  // What the card's store hook answers, from the same map.
  const newestIn = (items: ChatItem[]) => (target: string, itemId: string, rowId: string) => {
    const row = newestRows(items, workspaces).get(target)
    return row?.itemId === itemId && row.workspaceId === rowId
  }
  // The rows of a drawn card by the name on them, each with whether it shows Merge.
  const mergeByName = (html: string) => Object.fromEntries(html.split('<div class="tucard-row">').slice(1).map((r) => [/tucard-name">([^<]+)</.exec(r)?.[1], r.includes('stub-merge')]))

  it('maps each PR to the newest card with a row about it, and a reviewer row to the work it reviewed', () => {
    const items = [card('old', ['w1'], ['w2']), card('new', ['w1']), card('review-card', ['review'])]
    expect([...newestRows(items, workspaces)]).toEqual([['w1', { itemId: 'new', workspaceId: 'w1' }], ['w2', { itemId: 'review-card', workspaceId: 'review' }]])
    // The same arrays give the same map, and a chat with no items gives an empty one.
    expect(newestRows(items, workspaces)).toBe(newestRows(items, workspaces))
    expect(newestRows(undefined, workspaces).size).toBe(0)
  })

  it('offers Merge only on the newest row, and a reviewer row merges the reviewed PR', async () => {
    const { TeamUpdateView } = await load()
    const items = [card('old', ['w1']), card('new', ['w1'], ['review'])]
    const useNewest = newestIn(items)
    const draw = (item: ChatItem) => renderToStaticMarkup(React.createElement(TeamUpdateView, { item, useNewest, workspaceOf: (id) => workspaces.find((w) => w.id === id) }))
    expect(draw(items[0])).not.toContain('stub-merge')
    const html = draw(items[1])
    expect(html).toContain('Merge #162')
    // The reviewer's row (the second) names the reviewed PR, not a number of its own.
    expect(html).toContain('Merge #161')
    expect(html.indexOf('Merge #162')).toBeLessThan(html.indexOf('>Open<'))
  })

  it('offers one Merge for a PR in a card, on the author\'s row when it is there, wherever it sits (KERNEL-581)', async () => {
    const { TeamUpdateView } = await load()
    // Two reviewers come first and the author last, the order the card draws its rows in.
    const items = [card('new', ['review', 'Theo'], ['review2', 'Mira'], ['w2', 'Noor'])]
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: items[0], useNewest: newestIn(items), workspaceOf: (id) => workspaces.find((w) => w.id === id) }))
    expect(html.match(/stub-merge/g)).toHaveLength(1)
    expect(mergeByName(html)).toEqual({ Theo: false, Mira: false, Noor: true })
    // Every row still has its Open.
    expect(html.match(/>Open</g)).toHaveLength(3)
    // A PR of its own in the same card keeps its Merge.
    const two = [card('two', ['w1', 'Kai'], ['review', 'Theo'], ['w2', 'Noor'])]
    expect(mergeByName(renderToStaticMarkup(React.createElement(TeamUpdateView, { item: two[0], useNewest: newestIn(two), workspaceOf: (id) => workspaces.find((w) => w.id === id) })))).toEqual({ Kai: true, Theo: false, Noor: true })
  })

  it('puts the one Merge on the first reviewer row when the author has none in the card (KERNEL-581)', async () => {
    const { TeamUpdateView } = await load()
    const items = [card('new', ['review', 'Theo'], ['review2', 'Mira'])]
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: items[0], useNewest: newestIn(items), workspaceOf: (id) => workspaces.find((w) => w.id === id) }))
    expect(html.match(/stub-merge/g)).toHaveLength(1)
    expect(mergeByName(html)).toEqual({ Theo: true, Mira: false })
    expect(html).toContain('Merge #161')
  })

  it('keeps Merge off an older card, even when only that card has the author row (KERNEL-351, KERNEL-581)', async () => {
    const { TeamUpdateView } = await load()
    const items = [card('old', ['w2', 'Noor']), card('new', ['review', 'Theo'])]
    expect(newestRows(items, workspaces).get('w2')).toEqual({ itemId: 'new', workspaceId: 'review' })
    const draw = (item: ChatItem) => mergeByName(renderToStaticMarkup(React.createElement(TeamUpdateView, { item, useNewest: newestIn(items), workspaceOf: (id) => workspaces.find((w) => w.id === id) })))
    expect(draw(items[0])).toEqual({ Noor: false })
    expect(draw(items[1])).toEqual({ Theo: true })
  })

  it('spins a row whose merge is pending, wherever it was pressed, and leaves the other rows on Merge (KERNEL-520)', async () => {
    const { TeamUpdateView } = await load()
    const items = [card('new', ['w1'], ['w2'])]
    const useNewest = newestIn(items)
    const draw = () => renderToStaticMarkup(React.createElement(TeamUpdateView, { item: items[0], useNewest, workspaceOf: (id) => workspaces.find((w) => w.id === id) }))
    expect(draw()).toContain('aria-label="Merge PR #162"')
    pending.w1 = 'merge'
    try {
      const html = draw()
      // w1 spins in its Merge place, disabled and saying Merging, while w2 keeps its button.
      expect(html).not.toContain('aria-label="Merge PR #162"')
      expect(html).toMatch(/<button[^>]*disabled[^>]*aria-busy="true"[^>]*>.*Merging<\/button>/)
      expect(html).toContain('aria-label="Merge PR #161"')
    } finally { delete pending.w1 }
    // The merge was refused: the pending clears and the row reads Merge again.
    expect(draw()).toContain('aria-label="Merge PR #162"')
  })

  it('offers no Merge for an archived workspace, whose row says In History', async () => {
    const { TeamUpdateView } = await load()
    const gone = [ws('w1', { status: 'archived', prState: 'merged' })]
    const html = renderToStaticMarkup(React.createElement(TeamUpdateView, { item: card('c', ['w1']), useNewest: () => true, workspaceOf: (id) => gone.find((w) => w.id === id) }))
    expect(html).not.toContain('stub-merge')
    expect(html).toContain('In History')
  })

  const rules = { requireGreen: true, requireReviewer: true }
  const pr = (over: Partial<PrInfo> = {}): PrInfo => ({ workspaceId: 'w1', number: 7, url: '', title: '', state: 'ready', baseRef: 'main', checks: [{ name: 'ci', state: 'pass' }], comments: [], conflicts: [], ...over })

  it('decides what the button place shows from the shared merge rule', async () => {
    const { mergeView } = await import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/pr/MergeButton' as string) as typeof import('../src/renderer/src/screens/workspace/pr/MergeButton')
    expect(mergeView(ws('w1'), pr(), rules)).toEqual({ kind: 'ready' })
    expect(mergeView(ws('w1', { prState: 'merging' }), pr(), rules)).toEqual({ kind: 'merging' })
    expect(mergeView(ws('w1', { prState: 'merged' }), pr(), rules)).toEqual({ kind: 'merged' })
    // An open PR that can't merge yet says where it stands, in the PRs tab's words (KERNEL-411). One with no PR yet says nothing.
    expect(mergeView(ws('w1', { prState: 'cifail', prNumber: 7 }), pr(), rules)).toEqual({ kind: 'state', label: 'Checks failed', tone: 'fail', spin: false })
    expect(mergeView(ws('w1', { prState: 'checks', prNumber: 7 }), pr(), rules)).toEqual({ kind: 'state', label: 'Checks running', tone: 'idle', spin: true })
    expect(mergeView(ws('w1', { prState: 'none' }), pr(), rules)).toEqual({ kind: 'none' })
    // In a Merge all run, a PR whose turn is still to come reads Next; the one merging now reads Merging.
    const queue = { ids: ['w0', 'w1'], current: 'w0' }
    expect(mergeView(ws('w1'), pr(), rules, undefined, queue)).toEqual({ kind: 'next' })
    expect(mergeView(ws('w1', { prState: 'merging' }), pr(), rules, undefined, { ids: ['w1'], current: 'w1' })).toEqual({ kind: 'merging' })
    expect(mergeView(ws('w1'), pr(), rules, undefined, { ids: ['w1', 'w2'], current: 'w2' })).toEqual({ kind: 'ready' })
    // A merge pending on the PR reads merging before GitHub's state moves, whoever pressed it, including the PR Merge all is on (KERNEL-520).
    expect(mergeView(ws('w1'), pr(), rules, undefined, undefined, 'merge')).toEqual({ kind: 'merging' })
    expect(mergeView(ws('w1'), pr(), rules, undefined, { ids: ['w1', 'w2'], current: 'w1' }, 'merge')).toEqual({ kind: 'merging' })
    expect(mergeView(ws('w1', { prState: 'merged' }), pr(), rules, undefined, undefined, 'merge')).toEqual({ kind: 'merged' })
    expect(mergeView(ws('w1'), pr({ checks: [{ name: 'ci', state: 'fail' }] }), rules)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('Checks have not passed') })
    const reviewed = ws('w1', { prHead: 'new', reviews: [{ workspaceId: 'r1', agentId: 'theo', verdict: 'approved', summary: '', sha: 'old', prNumber: 7, ts: 1 }] })
    expect(mergeView(reviewed, pr({ head: 'new' }), rules, () => 'Theo')).toMatchObject({ kind: 'blocked', reason: expect.stringContaining("The code review hasn't approved") })
  })

  it('draws the button, the reason, the spinner and the merged label, and toasts a failed merge', async () => {
    const mod = await import(/* @vite-ignore */ '../src/renderer/src/screens/workspace/pr/MergeButton' as string) as typeof import('../src/renderer/src/screens/workspace/pr/MergeButton')
    const draw = (view: Parameters<typeof mod.MergeSlot>[0]['view'], busy?: string) => renderToStaticMarkup(React.createElement(mod.MergeSlot, { ws: ws('w1', { prNumber: 162 }), view, busy, onMerge: () => undefined }))
    expect(draw({ kind: 'ready' })).toMatch(/<button[^>]*aria-label="Merge PR #162"[^>]*>Merge #162<\/button>/)
    // While merging, the button spins, says Merging and is disabled, so it can't be pressed twice.
    const spinning = draw({ kind: 'ready' }, 'Merging')
    expect(spinning).toContain('aria-busy="true"')
    expect(spinning).toContain('disabled')
    expect(spinning).toContain('Merging')
    // A PR that reads merging spins in every place it shows, whoever started the merge: this button, another, Rowan or Merge
    // all (KERNEL-417). The spinner sits in the ready band's green, as the Merge button did.
    expect(draw({ kind: 'merging' }, 'Merging')).toMatch(/aria-busy="true"[^>]*>.*Merging/)
    expect(draw({ kind: 'merging' })).toMatch(/^<span class="pr-tone" data-tone="ready"><button[^>]*disabled[^>]*aria-busy="true"[^>]*>.*Merging<\/button><\/span>$/)
    expect(draw({ kind: 'next' })).toBe('<span class="tucard-why">Next</span>')
    // An open PR's state, as the PR band says it: a spinner while checks run, and the word in red for what failed.
    expect(draw({ kind: 'state', label: 'Checks running', tone: 'idle', spin: true })).toMatch(/data-tone="idle"><button[^>]*aria-busy="true"[^>]*>.*Checks running/)
    expect(draw({ kind: 'state', label: 'Checks failed', tone: 'fail', spin: false })).toBe('<span class="pr-word" data-tone="fail">Checks failed</span>')
    expect(draw({ kind: 'blocked', reason: "Theo hasn't approved the latest commit. Merging waits (Settings, Pull requests)." })).toContain("Theo hasn&#x27;t approved the latest commit.</span>")
    expect(draw({ kind: 'blocked', reason: 'x' })).not.toContain('<button')
    expect(draw({ kind: 'merged' })).toContain('tucard-merged')
    expect(draw({ kind: 'none' })).toBe('')

    const { actions } = await import(/* @vite-ignore */ '../src/renderer/src/store' as string) as typeof import('../src/renderer/src/store')
    const toast = vi.spyOn(actions.ui, 'toast').mockImplementation(() => 't1')
    Object.assign(globalThis, { window: { kernel: { invoke: async () => { throw new Error("Error invoking remote method 'pr.merge': Error: Checks have not passed yet.") } } } })
    await mod.mergeAndToast('w1')
    expect(toast).toHaveBeenCalledWith({ title: 'Could not merge', sub: 'Checks have not passed yet.' })
  })
})
