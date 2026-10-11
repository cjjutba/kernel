import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PrState, Workspace } from '../src/shared/types'
import { workspaceGlyph } from '../src/renderer/src/components/sidebar/workspaceGlyph'
import { PR_STATUS, headerView } from '../src/renderer/src/screens/workspace/pr/model'
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
