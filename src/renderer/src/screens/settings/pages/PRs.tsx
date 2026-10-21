import './system.css'
import { useEffect, useState } from 'react'
import type { AppSettings, PrInstructions } from '@shared/types'
import { ALWAYS_REVIEW } from '@shared/merge'
// The pure text builders: the default a PR instruction goes back to. Nothing here reads a file.
import { addressReviewText, createPrText, fixChecksText, resolveText } from '@shared/prTexts'
import { Button, Icon, Select, Toggle } from '../../../ui'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { Page, Row, Section, SettingsLink, TagList } from '../kit'
import { patchSettings } from '../useSettings'
import { NumberField } from './fields'
import { INSTRUCTIONS, InstructionSheet } from './InstructionSheet'

type Pr = AppSettings['pr']
const set = (patch: Partial<Pr>) => void patchSettings({ pr: patch })
const setAuto = (patch: Partial<Pr['autoMerge']>) => patchSettings({ pr: { autoMerge: patch } })
const METHODS: { value: Pr['mergeMethod']; label: string }[] = [{ value: 'squash', label: 'Squash' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }]

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
 * Then merging, reviews, and the default instructions each PR button sends, which open in a sheet. A project can replace any of them.
 */
export function PRs({ s }: { s: AppSettings }) {
  const p = s.pr
  const auto = p.autoMerge
  const projectSettings = useStore((x) => x.projectSettings)
  const projects = useStore((x) => x.projects)
  useEffect(() => { for (const r of projects) void call('settings.project', { projectId: r.id }).then((rs) => actions.settings.setProject(r.id, rs)).catch(() => undefined) }, [projects.map((r) => r.id).join()])
  // A project that sets its own merge method says so under the row, with a link to the place it is set.
  const methodOverrides = projects.flatMap((r) => {
    const ps = projectSettings[r.id]
    const method = METHODS.find((m) => m.value === ps?.pr?.mergeMethod)
    return method && ['local', 'override', 'shared'].includes(ps?.sources?.['pr.mergeMethod'] ?? '') ? [{ id: r.id, name: r.name, method: method.label }] : []
  })
  const [editing, setEditing] = useState<(typeof INSTRUCTIONS)[number] | null>(null)
  return (
    <>
      <Page title="Pull requests" desc="When Kernel merges on its own, how it merges, and which reviews run.">
        <Section title="Automatic merging" note="This Mac">
          <Row id="merge-without-asking" label="Merge without asking me" desc="When checks are green, it’s under the size limit and reviews pass.">
            <Toggle label="Merge without asking me" checked={auto.on} onChange={(on) => setAuto({ on })} />
          </Row>
          <Row id="merge-without-review" label="Merge without a review" desc="Green checks and the size limit are enough. Paths you always review still come to you.">
            <Toggle label="Merge without a review" checked={auto.withoutReview} disabled={!auto.on} onChange={(withoutReview) => setAuto({ withoutReview })} />
          </Row>
          <Row id="size-limit" label="Size limit" desc="Bigger changes come to you."><NumberField label="Size limit" value={auto.maxLines} unit="lines" onSave={(maxLines) => setAuto({ maxLines }).then((saved) => saved?.pr.autoMerge.maxLines)} /></Row>
          <Row id="always-review" label="Paths you always review" desc="Changes here always come to you. Locked ones are built in." full={
            <div className="sys-paths"><TagList label="Paths you always review" value={auto.alwaysReview} locked={ALWAYS_REVIEW.map((path) => BUILT_IN[path] ?? path)} mono={false} addLabel="Add path" placeholder="db/migrations/**" onChange={(alwaysReview) => setAuto({ alwaysReview })} /></div>
          } />
        </Section>
        <Section title="Merging">
          <Row
            id="merge-method" label="Merge method"
            desc={methodOverrides.length > 0 && methodOverrides.map((o) => (
              <span key={o.id} className="sys-override">
                {o.name} uses {o.method}.
                <SettingsLink variant="quiet" to={{ page: 'project', projectId: o.id, section: 'prs', row: 'merge-method' }}>Open {o.name}’s settings<Icon name="ext" size={12} /></SettingsLink>
              </span>
            ))}
          >
            <Select label="Merge method" align="right" value={p.mergeMethod} options={METHODS} onChange={(v) => set({ mergeMethod: v as Pr['mergeMethod'] })} />
          </Row>
          <Row id="draft" label="Open as draft"><Toggle label="Open as draft" checked={p.draft} onChange={(v) => set({ draft: v })} /></Row>
          <Row id="require-green" label="Require green checks to merge"><Toggle label="Require green checks to merge" checked={p.requireGreen} onChange={(v) => set({ requireGreen: v })} /></Row>
          <Row id="lead-merge" label="Let Kernel merge when you ask" desc="Only when your own message asks."><Toggle label="Let Kernel merge when you ask" checked={p.leadMerge} onChange={(v) => set({ leadMerge: v })} /></Row>
        </Section>
        <Section title="Reviews" note="Each project picks which reviews run.">
          <Row id="auto-review" label="Review every pull request automatically" desc="Off saves usage. You can still ask for a review."><Toggle label="Review every pull request automatically" checked={p.autoReview} onChange={(v) => set({ autoReview: v })} /></Row>
          <Row id="evidence-comment" label="Post the evidence on the pull request" desc="One comment on GitHub, kept up to date, lists each acceptance criterion with its state."><Toggle label="Post the evidence on the pull request" checked={p.evidenceComment} onChange={(v) => set({ evidenceComment: v })} /></Row>
          <Row id="require-reviewer" label="Wait for the reviewer’s approval to merge"><Toggle label="Wait for the reviewer’s approval to merge" checked={p.requireReviewer} onChange={(v) => set({ requireReviewer: v })} /></Row>
        </Section>
        <Section title="Instructions" note="A project can replace any of them.">
          {INSTRUCTIONS.map((i) => {
            const custom = !!p[i.key].trim() && p[i.key] !== DEFAULTS[i.key]
            return (
              <Row key={i.key} id={`instructions-${i.key.replace(/Instructions$/, '')}`} label={i.label} desc={`${i.desc}.`}>
                <span className="sys-state" data-custom={custom || undefined}>{custom ? 'Customized' : 'Default'}</span>
                <Button aria-label={`Edit the ${i.label} instructions`} onClick={() => setEditing(i)}>Edit</Button>
              </Row>
            )
          })}
        </Section>
      </Page>
      {editing && <InstructionSheet title={editing.label} note={`Kernel sends this when you press ${editing.label}. A project can replace it on its own Pull requests page.`} value={p[editing.key] || DEFAULTS[editing.key]} fallback={DEFAULTS[editing.key]} onSave={(text) => patchSettings({ pr: { [editing.key]: text ?? DEFAULTS[editing.key] } })} onClose={() => setEditing(null)} />}
    </>
  )
}
