import './agents.css'
import { useRef, type KeyboardEvent } from 'react'
import { PERMISSION_MODES, PROVIDERS, type AppSettings, type PermissionMode } from '@shared/types'
import { pickMode, unavailable, useModeAvailability, type ModeAvailabilities } from '../../../permissionModes'
import { Select, Toggle } from '../../../ui'
import { useStore } from '../../../store'
import { Page, Row, Section, SettingsLink, TagList } from '../kit'
import { patchSettings } from '../useSettings'

const TIMEOUTS = [{ value: '120', label: '2 min' }, { value: '300', label: '5 min' }, { value: '600', label: '10 min' }, { value: '1800', label: '30 min' }]

/**
 * The four modes as cards in a radio group (KERNEL-680). A mode no provider can run keeps its card, dimmed with the reason, and can't be
 * picked unless it is the saved one. One that only some providers can run says which can't. Arrow keys move the pick and the focus, and skip a dimmed mode.
 */
/** The cards' own short copy (AgentsPage.dc.html). The composer's mode menu keeps MODE_INFO's longer lines. */
const CARD: Record<PermissionMode, { label: string; desc: string }> = {
  default: { label: 'Manual', desc: 'Asks before every edit and command.' },
  acceptEdits: { label: 'Accept edits', desc: 'Edits files freely. Commands ask unless a rule allows them.' },
  auto: { label: 'Auto', desc: 'Routine work runs. Anything else asks you.' },
  bypassPermissions: { label: 'Bypass', desc: 'Skips prompts. Never allow, protected branches and network off still hold.' }
}

/** "Not on Codex yet" under a mode some provider can't run. The full reason is the note's tooltip. */
function notOn(mode: PermissionMode, availability: ModeAvailabilities | null): string | undefined {
  const key = mode === 'auto' ? 'auto' : mode === 'bypassPermissions' ? 'bypass' : null
  if (!availability || !key) return undefined
  const off = PROVIDERS.filter((p) => !availability[p.id][key]).map((p) => p.label)
  return off.length ? `Not on ${off.join(' or ')} yet` : undefined
}

function ModeCards({ value, availability }: { value: PermissionMode; availability: ModeAvailabilities | null }) {
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const rows = PERMISSION_MODES.map((mode) => ({ mode, ...unavailable(mode, availability) }))
  const pickable = (i: number) => !rows[i].dim || rows[i].mode === value
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    let next = i
    do next = (next + step + rows.length) % rows.length
    while (!pickable(next) && next !== i)
    if (next === i) return
    void pickMode(rows[next].mode)
    radios.current[next]?.focus()
  }
  return (
    <div className="ag-modes" role="radiogroup" aria-label="Permission mode">
      {rows.map(({ mode, lines, dim }, i) => {
        const on = mode === value
        const off = dim && !on
        const info = CARD[mode]
        const note = notOn(mode, availability)
        return (
          <button
            key={mode} ref={(el) => { radios.current[i] = el }} type="button" role="radio" className="ag-mode" aria-checked={on} aria-disabled={off || undefined}
            tabIndex={on ? 0 : -1} onClick={() => { if (!off) void pickMode(mode) }} onKeyDown={(e) => onKey(e, i)}
          >
            <span className="ag-mode-head"><span className="ag-ring" aria-hidden="true" />{info.label}</span>
            <span className="ag-mode-desc">{info.desc}</span>
            {note && <span className="ag-mode-note" data-tip={lines.join(' ')}>{note}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Settings > Permissions (AgentsPage.dc.html, KERNEL-680). Running sessions read these on their next tool call. */
export function Permissions({ s }: { s: AppSettings }) {
  const p = s.permissions
  const availability = useModeAvailability()
  const firstProject = useStore((st) => st.projects.find((r) => !r.hidden && !r.archived))
  const save = (permissions: Partial<AppSettings['permissions']>) => patchSettings({ permissions })
  const timeouts = TIMEOUTS.some((t) => t.value === String(p.approvalTimeoutSec)) ? TIMEOUTS : [...TIMEOUTS, { value: String(p.approvalTimeoutSec), label: `${p.approvalTimeoutSec} sec` }]
  const rule = (label: string, value: string[], key: 'alwaysAsk' | 'neverAllow' | 'protectedBranches', addLabel: string) => (
    <TagList label={label} value={value} addLabel={addLabel} onChange={(next) => save({ [key]: next })} />
  )
  return (
    <Page title="Permissions" desc="How much agents do without asking you.">
      <Section id="mode" title="Mode" plain>
        <ModeCards value={p.mode} availability={availability} />
        {p.mode === 'bypassPermissions' && <div className="set-card ag-wt"><Row id="only-in-worktrees" label="Only in worktrees" desc="Never skip prompts on your current branch."><Toggle label="Only in worktrees" checked={p.bypassOnlyInWorktrees} onChange={(v) => save({ bypassOnlyInWorktrees: v })} /></Row></div>}
      </Section>
      <Section title="Rules">
        <Row id="always-ask" className="ag-rule" label="Always ask before" desc="Every mode except Bypass." full={rule('Always ask before', p.alwaysAsk, 'alwaysAsk', 'Add command')} />
        <Row id="never-allow" className="ag-rule" label="Never allow" desc="Blocked in every mode, Bypass included." full={rule('Never allow', p.neverAllow, 'neverAllow', 'Add command')} />
        <Row id="protected-branches" className="ag-rule" label="Protected branches" desc="Pushes are blocked in Bypass. Other modes ask first." full={rule('Protected branches', p.protectedBranches, 'protectedBranches', 'Add branch')} />
      </Section>
      <Section title="Safety" footnote={<>Commands and tools you allow from an approval are saved per project, on {firstProject ? <>each project’s <SettingsLink to={{ page: 'project', projectId: firstProject.id, section: 'agents', row: 'mode' }}>Agents page</SettingsLink></> : 'each project’s Agents page'}.</>}>
        <Row id="network" label="Allow network access" desc="Off blocks the network in every mode."><Toggle label="Allow network access" checked={p.network} onChange={(v) => save({ network: v })} /></Row>
        <Row id="approval-timeout" label="Approval timeout" desc="Then the request falls back to Claude Code’s own prompt.">
          <Select label="Approval timeout" value={String(p.approvalTimeoutSec)} options={timeouts} onChange={(v) => save({ approvalTimeoutSec: Number(v) })} />
        </Row>
      </Section>
    </Page>
  )
}
