import './system.css'
import { useEffect, useState } from 'react'
import type { AppSettings, PrInstructions } from '@shared/types'
import { ALWAYS_REVIEW } from '@shared/merge'
// The pure text builders: the default a PR instruction goes back to. Nothing here reads a file.
import { addressReviewText, createPrText, fixChecksText, resolveText } from '@shared/prTexts'
import { Button, SegmentedControl, Toggle } from '../../../ui'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { Page, Row, Section, TagList } from '../kit'
import { patchSettings } from '../useSettings'
import { NumberField } from './fields'
import { INSTRUCTIONS, InstructionSheet } from './InstructionSheet'

type Pr = AppSettings['pr']
const set = (patch: Partial<Pr>) => void patchSettings({ pr: patch })
const setAuto = (patch: Partial<Pr['autoMerge']>) => patchSettings({ pr: { autoMerge: patch } })

/** The paths Kernel always sends to the user, in words. A path this doesn't know shows as written. */
const BUILT_IN: Record<string, string> = {
  '.kernel/**': 'Kernel settings',
  '**/.claude/agents/**': 'Agent files',
  '**/CLAUDE.md': 'CLAUDE.md',
  '**/AGENTS.md': 'AGENTS.md',
  '.github/workflows/**': 'CI workflows'
}

/** Kernel's own text for each instruction, which a row goes back to. */
const DEFAULTS: PrInstructions = { createInstructions: createPrText(), resolveInstructions: resolveText(), fixChecksInstructions: fixChecksText(), addressReviewInstructions: addressReviewText() }

/**
 * Settings > Pull requests (MorePage prs, KERNEL-680). Automatic merging comes first: it is only this Mac's, off by default (KERNEL-557).
 * Then merging, reviews, and the default instructions each PR button sends, which open in a sheet. A room can replace any of them.
 */
export function PRs({ s }: { s: AppSettings }) {
  const p = s.pr
  const auto = p.autoMerge
  const roomSettings = useStore((x) => x.roomSettings)
  const rooms = useStore((x) => x.rooms)
  useEffect(() => { for (const r of rooms) void call('settings.room', { roomId: r.id }).then((rs) => actions.settings.setRoom(r.id, rs)).catch(() => undefined) }, [rooms.map((r) => r.id).join()])
  const changedIn = (path: string) => rooms.filter((r) => ['local', 'override'].includes(roomSettings[r.id]?.sources?.[path] ?? '')).map((r) => ({ id: r.id, name: r.name, to: { page: 'room', roomId: r.id, section: 'prs' } as const }))
  const [editing, setEditing] = useState<(typeof INSTRUCTIONS)[number] | null>(null)
  return (
    <>
      <Page title="Pull requests">
        <Section title="Automatic merging" scope="mac">
          <Row label="Merge without asking me" desc="When reviews pass, checks are green and it’s under the size limit.">
            <Toggle label="Merge without asking me" checked={auto.on} onChange={(on) => setAuto({ on })} />
          </Row>
          <Row label="Size limit" desc="Bigger changes come to you."><NumberField label="Size limit" value={auto.maxLines} unit="lines" onSave={(maxLines) => setAuto({ maxLines }).then((saved) => saved?.pr.autoMerge.maxLines)} /></Row>
          <Row label="Paths you always review" desc="Changes here always come to you. Locked ones are built in." full={
            <div className="sys-paths"><TagList label="Paths you always review" value={auto.alwaysReview} locked={ALWAYS_REVIEW.map((path) => BUILT_IN[path] ?? path)} mono={false} addLabel="Add path" placeholder="db/migrations/**" onChange={(alwaysReview) => setAuto({ alwaysReview })} /></div>
          } />
        </Section>
        <Section title="Merging">
          <Row label="Merge method" changedIn={changedIn('pr.mergeMethod')}>
            <SegmentedControl label="Merge method" value={p.mergeMethod} onChange={(v) => set({ mergeMethod: v as Pr['mergeMethod'] })} options={[{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }]} />
          </Row>
          <Row label="Open as draft"><Toggle label="Open as draft" checked={p.draft} onChange={(v) => set({ draft: v })} /></Row>
          <Row label="Require green checks to merge"><Toggle label="Require green checks to merge" checked={p.requireGreen} onChange={(v) => set({ requireGreen: v })} /></Row>
          <Row label="Let Kernel merge when you ask" desc="Only when your own message asks."><Toggle label="Let Kernel merge when you ask" checked={p.leadMerge} onChange={(v) => set({ leadMerge: v })} /></Row>
        </Section>
        <Section title="Reviews" note="Each room picks which reviews run.">
          <Row label="Review every pull request automatically" desc="Off saves usage. You can still ask for a review."><Toggle label="Review every pull request automatically" checked={p.autoReview} onChange={(v) => set({ autoReview: v })} /></Row>
          <Row label="Wait for the reviewer’s approval to merge"><Toggle label="Wait for the reviewer’s approval to merge" checked={p.requireReviewer} onChange={(v) => set({ requireReviewer: v })} /></Row>
        </Section>
        <Section title="Instructions" note="A room can replace any of them.">
          {INSTRUCTIONS.map((i) => {
            const custom = !!p[i.key].trim() && p[i.key] !== DEFAULTS[i.key]
            return (
              <Row key={i.key} label={i.label} desc={`${i.desc}.`}>
                <span className={custom ? 'set-badge' : 'sys-state'}>{custom ? 'Customized' : 'Default'}</span>
                <Button aria-label={`Edit the ${i.label} instructions`} onClick={() => setEditing(i)}>Edit</Button>
              </Row>
            )
          })}
        </Section>
      </Page>
      {editing && <InstructionSheet title={editing.label} value={p[editing.key] || DEFAULTS[editing.key]} fallback={DEFAULTS[editing.key]} onSave={(text) => set({ [editing.key]: text ?? DEFAULTS[editing.key] })} onClose={() => setEditing(null)} />}
    </>
  )
}
