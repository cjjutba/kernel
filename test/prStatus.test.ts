import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PrInfo, PrState, Workspace } from '../src/shared/types'
import { workspaceGlyph } from '../src/renderer/src/components/sidebar/workspaceGlyph'
import { PR_STATUS, headerView, localNote, localRow, localStand, localStatus } from '../src/renderer/src/screens/workspace/pr/model'
import { leadPrs } from '../src/renderer/src/screens/workspace/pr/leadPrList'
import { MergeSlot, PrStatusTag, mergeView } from '../src/renderer/src/screens/workspace/pr/MergeButton'

// KERNEL-417: a PR's state reads the same in every place that shows it: the PR band, the PRs tab, a Team update row and the
// sidebar icon. The same word, the same tone, and a spinner wherever something runs, whoever started it.

Object.assign(globalThis, { React })

const rules = { requireGreen: false, requireReviewer: false }
const ws = (prState: PrState): Workspace => ({ id: 'w1', roomId: 'room', agentId: 'kai', status: 'ready', prState, prNumber: 7 }) as Workspace
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
    const [row] = leadPrs([w], { leadId: undefined, roomId: 'room', prs: {}, rules, agents: [] })
    const tab = row.ready ? team : html(React.createElement(PrStatusTag, { status: row.state!, why: row.state!.why }))
    expect(tab).toBe(team)
    expect(team).toContain(`>${s.label}<`)
    expect(team).toContain(`data-tone="${s.tone}"`)
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
    expect(localNote('conflict', 'main', local({}, ['src/a.ts']), 'Noor')).toMatchObject({ title: 'Merging into main would conflict in 1 file', body: ['Resolve conflicts asks Noor to fix them on this branch.'], files: [{ letter: 'C', path: 'src/a.ts', why: 'both changed' }] })
    expect(localNote('dirty', 'main', local(dirty))?.files).toEqual([{ letter: 'M', path: 'package.json' }, { letter: 'U', path: 'notes.md' }])
  })
})
