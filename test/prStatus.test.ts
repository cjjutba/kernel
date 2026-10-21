import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PrInfo, PrPending, PrState, Workspace } from '../src/shared/types'
import { chatGlyph, workspaceGlyph } from '../src/renderer/src/components/sidebar/workspaceGlyph'
import { PR_STATUS, busyLabel, headerView, localNote, localRow, localStand, localStatus, type PrAction } from '../src/renderer/src/screens/workspace/pr/model'
import { leadPrs } from '../src/renderer/src/screens/workspace/pr/leadPrList'
import { MergeSlot, PrStatusTag, mergeView } from '../src/renderer/src/screens/workspace/pr/MergeButton'

// KERNEL-417: a PR's state reads the same in every place that shows it: the PR band, the PRs tab, a Team update row and the
// sidebar icon. The same word, the same tone, and a spinner wherever something runs, whoever started it.

Object.assign(globalThis, { React })

const rules = { requireGreen: false, requireReviewer: false }
const ws = (prState: PrState): Workspace => ({ id: 'w1', projectId: 'project', agentId: 'christian', status: 'ready', prState, prNumber: 7 }) as Workspace
const states = Object.keys(PR_STATUS) as (keyof typeof PR_STATUS)[]
const html = (el: React.ReactElement) => renderToStaticMarkup(el)

describe("a PR's state in every place it shows", () => {
  it.each(states)('%s reads the same in the band, the PRs tab, a Team update row and the sidebar', (state) => {
    const s = PR_STATUS[state]
    const w = ws(state)
    // The band: what runs is its busy button, a settled state its state word, on a band in the same tone.
    const band = headerView(state)
    expect(band.state.tone).toBe(s.tone)
    if (s.spin) expect(band.button).toEqual({ label: s.label, kind: 'busy' })
    else expect(band.state.label).toBe(s.label)
    // The sidebar icon spins for what runs, and says the same word.
    const glyph = workspaceGlyph(w, { waiting: [], running: false })
    expect(glyph).toMatchObject({ label: s.label })
    expect(glyph.icon === 'spin').toBe(s.spin)
    // A Team update row draws the Merge place, and the PRs tab draws the same place for a ready row, else the row's state.
    const team = html(React.createElement(MergeSlot, { ws: w, view: mergeView(w, undefined, rules), onMerge: () => undefined }))
    const [row] = leadPrs([w], { leadId: undefined, projectId: 'project', prs: {}, rules, agents: [] })
    const tab = row.ready ? team : html(React.createElement(PrStatusTag, { status: row.state!, why: row.state!.why }))
    expect(tab).toBe(team)
    expect(team).toContain(`>${s.label}<`)
    // A merge that runs keeps the green Merge button, spinning in its word. Every other state is a word in its tone.
    if (state === 'merging') expect(team).toContain('class="btn merge sm"')
    else expect(team).toContain(`data-tone="${s.tone}"`)
    expect(team.includes('aria-busy="true"')).toBe(s.spin)
  })

  it('leaves every other PR its own state, so a ready one next to a merging one keeps Merge', () => {
    const draw = (w: Workspace) => html(React.createElement(MergeSlot, { ws: w, view: mergeView(w, undefined, rules), onMerge: () => undefined }))
    expect(draw(ws('merging'))).toContain('aria-busy="true"')
    const ready = draw({ ...ws('ready'), id: 'w2', prNumber: 8 })
    expect(ready).toMatch(/<button[^>]*aria-label="Merge PR #8"[^>]*>Merge #8<\/button>/)
    expect(ready).not.toContain('aria-busy')
  })
})

// KERNEL-520: an action main announces as pending spins every place showing the PR in the same frame, before the PR's own state moves.

describe('a PR action pending (KERNEL-520)', () => {
  const draw = (w: Workspace, pending?: PrPending) => html(React.createElement(MergeSlot, { ws: w, view: mergeView(w, undefined, rules, undefined, pending), onMerge: () => undefined }))
  const idle = { waiting: [], running: false }

  it('spins a ready PR as Merging in the band, the sidebar, a Team update row and the PRs tab, and returns them together', () => {
    const w = ws('ready')
    // The PRs tab draws a ready row with the same Merge place as a Team update row.
    const [row] = leadPrs([w], { leadId: undefined, projectId: 'project', prs: {}, rules, agents: [] })
    expect(row.ready).toBe(true)
    expect(headerView('ready', true, false, undefined, false, 'merge')).toMatchObject({ state: { label: 'Ready to merge', tone: 'ready' }, button: { label: 'Merging', kind: 'busy' } })
    expect(workspaceGlyph(w, { ...idle, pending: 'merge' })).toEqual({ icon: 'spin', tone: 'muted', label: 'Merging' })
    const spinning = draw(w, 'merge')
    expect(spinning).toMatch(/^<button[^>]*class="btn merge sm"[^>]*aria-busy="true"[^>]*><span class="dots"[^>]*>.*<\/span>Merging<\/button>$/)
    expect(spinning).toContain('disabled')
    // It reads as the engine's own merging state does, so the two can't disagree.
    expect(spinning).toBe(draw(ws('merging')))
    // Another PR in the same list has nothing pending and keeps its button.
    expect(draw({ ...w, id: 'w2', prNumber: 8 })).toMatch(/aria-label="Merge PR #8"/)
    // A refused merge clears the pending, and every place reads Merge again from the same state.
    expect(headerView('ready').button).toMatchObject({ label: 'Merge PR', action: 'merge' })
    expect(workspaceGlyph(w, idle)).toMatchObject({ icon: 'prReady', label: 'Ready to merge' })
    expect(draw(w)).toContain('Merge #7')
  })

  it("spins the band in each action's word, with nothing to press and no key to answer", () => {
    for (const action of Object.keys(busyLabel) as PrAction[]) {
      const view = headerView('closed', true, false, undefined, false, action)
      // No action means no ⌘⇧ key, and no Archive or caret to press while it runs.
      expect(view.button, action).toEqual({ label: busyLabel[action], kind: 'busy' })
      expect([view.archive, view.caret, view.merged]).toEqual([false, false, false])
    }
    expect(headerView('none', true, false, undefined, false, 'create')).toMatchObject({ caret: false, state: { label: 'No PR yet' } })
    // The state's own word and tone stay, as they do under the pressed button's own spinner.
    expect(headerView('cifail', true, false, undefined, false, 'resolve')).toMatchObject({ state: { label: 'Checks failed', tone: 'fail' }, button: { label: 'Sending', kind: 'busy' } })
    // A branch that merges on the Mac keeps its pill, and Merge anyway spins instead of asking.
    expect(headerView('ready', true, false, { base: 'main', stand: 'ready' }, false, 'merge')).toMatchObject({ pill: 'main', button: { label: 'Merging', kind: 'busy' } })
    expect(headerView('ready', true, false, undefined, true, 'merge').button).toEqual({ label: 'Merging', kind: 'busy' })
  })

  it("spins the sidebar icon in each action's word, after what waits on you and what runs", () => {
    for (const action of Object.keys(busyLabel) as PrAction[]) expect(workspaceGlyph(ws('conflict'), { ...idle, pending: action }), action).toEqual({ icon: 'spin', tone: 'muted', label: busyLabel[action] })
    // A branch on the Mac spins instead of showing its branch glyph.
    expect(workspaceGlyph(ws('ready'), { ...idle, pending: 'merge', local: { stand: 'ready', base: 'main' } })).toMatchObject({ icon: 'spin', label: 'Merging' })
    expect(workspaceGlyph(ws('ready'), { waiting: [], running: true, pending: 'merge' })).toMatchObject({ label: 'Working' })
  })

  it('leaves a merged PR as it is, since its merge is done and the pending clears a moment later', () => {
    expect(headerView('merged', true, false, undefined, false, 'merge')).toEqual(headerView('merged'))
    expect(draw(ws('merged'), 'merge')).toContain('tucard-merged')
    expect(workspaceGlyph(ws('merged'), { ...idle, pending: 'merge' })).toMatchObject({ icon: 'merged', label: 'Merged' })
  })
})

// KERNEL-478: a branch that merges on the Mac reads like a PR on GitHub. Conflicts, Resolving and Merging are the PR's own entries, and
// Behind main and Can't merge are the two words it adds.

const local = (o: Partial<NonNullable<PrInfo['local']>> = {}, conflicts: string[] = []): Pick<PrInfo, 'local' | 'conflicts'> =>
  ({ conflicts, local: { ahead: 3, behind: 0, stat: { files: 8, added: 304, removed: 15 }, method: 'squash', checkout: { path: '/Users/you/Projects/shop', dirty: [] }, ...o } })
const dirty = { checkout: { path: '/Users/you/Projects/shop', dirty: [{ status: 'M', path: 'package.json' }, { status: '??', path: 'notes.md' }] } }

describe('a branch that merges on the Mac', () => {
  it('stands ready, behind, dirty or conflicting from the state and what git said', () => {
    expect(localStand('ready', local())).toBe('ready')
    expect(localStand('ready')).toBe('ready')
    expect(localStand('ready', local({ behind: 4 }))).toBe('behind')
    // A refused merge is red and says what the user can fix, so it wins over a branch that is only behind.
    expect(localStand('ready', local({ behind: 4, ...dirty }))).toBe('dirty')
    expect(localStand('conflict', local({ behind: 2 }))).toBe('conflict')
    expect(localStand('merging', local())).toBe('merging')
    expect(localStand('merged', local({ behind: 4 }))).toBe('merged')
    expect(localStand('none')).toBe('none')
  })

  it('takes the PR band for each state, with the pill where the number was', () => {
    const view = (stand: Parameters<typeof localStatus>[0]) => headerView('ready', true, false, { base: 'main', stand })
    expect(view('ready')).toMatchObject({ link: false, pill: 'main', state: { label: 'Ready to merge', tone: 'ready', glyph: 'branch' }, button: { label: 'Merge', kind: 'primary', action: 'merge' } })
    expect(view('behind')).toMatchObject({ state: { label: 'Behind main', tone: 'idle' }, button: { label: 'Update branch', kind: 'secondary', action: 'update' } })
    expect(view('dirty')).toMatchObject({ state: { label: "Can't merge", tone: 'fail' }, button: { label: 'Try again', kind: 'secondary', action: 'merge' } })
    expect(view('conflict')).toMatchObject({ state: { label: PR_STATUS.conflict.label, tone: PR_STATUS.conflict.tone }, button: { label: 'Resolve conflicts', action: 'resolve' } })
    expect(view('merged')).toMatchObject({ merged: true, state: { label: 'Merged', tone: 'merged', glyph: 'merged' } })
    // Merging keeps the green band and its word, and the busy button reads as a PR's does.
    expect(view('merging')).toMatchObject({ state: { label: 'Ready to merge', tone: 'ready' }, button: headerView('merging').button })
    expect(view('resolving').button).toEqual(headerView('resolving').button)
    // Nothing committed has no Create PR: the branch is what merges.
    expect(headerView('none', true, false, { base: 'main', stand: 'none' }).button).toBeUndefined()
  })

  it('shows in the sidebar as the branch glyph in the same tone, and spins for what runs as a PR does', () => {
    const w = ws('ready')
    const glyph = (stand: Parameters<typeof localStatus>[0], prState: PrState = 'ready') => workspaceGlyph({ ...w, prState }, { waiting: [], running: false, local: { stand, base: 'main' } })
    expect(glyph('ready')).toEqual({ icon: 'branch', tone: 'add', label: 'Ready to merge' })
    expect(glyph('behind')).toEqual({ icon: 'branch', tone: 'muted', label: 'Behind main' })
    expect(glyph('dirty')).toEqual({ icon: 'branch', tone: 'del', label: "Can't merge" })
    expect(glyph('conflict', 'conflict')).toEqual({ icon: 'branch', tone: 'del', label: PR_STATUS.conflict.label })
    expect(glyph('merged', 'merged')).toMatchObject({ icon: 'merged', tone: 'merged' })
    expect(glyph('merging', 'merging')).toEqual(workspaceGlyph(ws('merging'), { waiting: [], running: false }))
  })

  it('says the state in the chat row and the note in the same words', () => {
    expect(localRow('ready', 'main', local())).toBe('Ready to merge into main. 3 ahead, no conflicts.')
    expect(localRow('behind', 'main', local({ behind: 4 }))).toBe('main has 4 new commits. Update this branch before it merges.')
    expect(localRow('conflict', 'main', local({}, ['a.ts', 'b.ts']))).toBe('Merging into main would conflict in 2 files.')
    expect(localRow('dirty', 'main', local(dirty))).toBe('Merge refused. ~/Projects/shop has uncommitted changes.')
    expect(localRow('merged', 'main', local())).toBeUndefined()
    expect(localNote('behind', 'main', local({ behind: 1 }))?.title).toBe('main has 1 new commit')
    expect(localNote('conflict', 'main', local({}, ['src/a.ts']), 'Sean')).toMatchObject({ title: 'Merging into main would conflict in 1 file', body: ['Resolve conflicts asks Sean to fix them on this branch.'], files: [{ letter: 'C', path: 'src/a.ts', why: 'both changed' }] })
    expect(localNote('dirty', 'main', local(dirty))?.files).toEqual([{ letter: 'M', path: 'package.json' }, { letter: 'U', path: 'notes.md' }])
  })
})

describe('a Lead chat row shows its own pull request (KERNEL-993)', () => {
  const none: Workspace = { ...ws('none'), prNumber: undefined }
  const idle = { waiting: [], running: false }
  const chat = { icon: 'chat', tone: 'muted', label: '' }

  it('keeps the chat icon without a PR, whatever the workspace holds', () => {
    expect(chatGlyph({ ...idle, ws: none })).toEqual(chat)
    expect(chatGlyph({ ...idle, ws: { ...none, stat: { files: 2, added: 3, removed: 1 } } as Workspace })).toEqual(chat)
    expect(chatGlyph({ ...idle })).toEqual(chat)
  })

  it.each(states)('%s reads on the chat row as on a workspace row', (state) => {
    expect(chatGlyph({ ...idle, ws: ws(state) })).toEqual(workspaceGlyph(ws(state), idle))
  })

  it('shows a PR being created, though it has no number yet', () => {
    expect(chatGlyph({ ...idle, ws: { ...none, prState: 'creating' } })).toMatchObject({ icon: 'spin', label: PR_STATUS.creating.label })
  })

  it('lets what waits, setup and a running turn win over the PR', () => {
    expect(chatGlyph({ ...idle, running: true, ws: ws('ready') })).toEqual({ icon: 'spin', tone: 'muted', label: 'Working' })
    expect(chatGlyph({ ...idle, ws: { ...ws('ready'), status: 'setup' } })).toMatchObject({ label: 'Setting up' })
    expect(chatGlyph({ ...idle, ws: { ...ws('ready'), folderGone: true } })).toMatchObject({ label: 'Folder missing' })
  })

  it('spins a pending action, but not once merged', () => {
    expect(chatGlyph({ ...idle, ws: ws('ready'), pending: 'merge' })).toEqual({ icon: 'spin', tone: 'muted', label: 'Merging' })
    expect(chatGlyph({ ...idle, ws: ws('merged'), pending: 'merge' })).toMatchObject({ icon: 'merged' })
    expect(chatGlyph({ ...idle, ws: none, pending: 'merge' })).toEqual({ icon: 'spin', tone: 'muted', label: 'Merging' })
  })

  it('shows a local merge with the branch icon, and keeps the bubble for a fresh chat', () => {
    const local = { stand: 'ready' as const, base: 'main' }
    const changed = { ...none, stat: { files: 1, added: 1, removed: 0 } } as Workspace
    expect(chatGlyph({ ...idle, ws: changed, local })).toMatchObject({ icon: 'branch' })
    expect(chatGlyph({ ...idle, ws: none, local: { stand: 'none', base: 'main' } })).toEqual(chat)
  })

  it('leaves workspace rows as they were', () => {
    expect(workspaceGlyph(none, idle)).toEqual({ icon: 'branch', tone: 'muted', label: 'No changes yet' })
    expect(workspaceGlyph({ ...none, stat: { files: 1, added: 1, removed: 0 } } as Workspace, idle)).toEqual({ icon: 'branch', tone: 'muted', label: 'No PR yet' })
  })
})
