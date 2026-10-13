import { useRef, type KeyboardEvent } from 'react'
import { PERMISSION_MODES, type AppSettings, type PermissionMode } from '@shared/types'
import { MODE_INFO, pickMode, unavailable, useModeAvailability, type ModeAvailabilities } from '../../../permissionModes'
import { Icon, Select, Toggle } from '../../../ui'
import { LinesField, ListField, Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

const TIMEOUTS = [{ value: '120', label: '2 min' }, { value: '300', label: '5 min' }, { value: '600', label: '10 min' }, { value: '1800', label: '30 min' }]

/**
 * The four modes as a radio list, like Big terminal's presets. A mode no provider can run keeps its row, dimmed with the reason, and can't be picked
 * unless it is the saved one. One that only some providers can run says which can't. Arrow keys move the pick and the focus, and skip a dimmed mode.
 */
function ModeList({ value, availability }: { value: PermissionMode; availability: ModeAvailabilities | null }) {
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
    <div role="radiogroup" aria-label="Permission mode">
      {rows.map(({ mode, lines, dim }, i) => {
        const on = mode === value
        const off = dim && !on
        const info = MODE_INFO[mode]
        const pick = () => { if (!off) void pickMode(mode) }
        return (
          <div key={mode} className="set-row set-preset set-mode" aria-disabled={off || undefined}>
            <button
              ref={(el) => { radios.current[i] = el }} type="button" role="radio" className="set-radio" aria-checked={on} aria-disabled={off || undefined} aria-label={info.label}
              tabIndex={on ? 0 : -1} aria-describedby={`mode-${mode}`} onClick={pick} onKeyDown={(e) => onKey(e, i)}
            >{on && <Icon name="check" size={12} />}</button>
            <div id={`mode-${mode}`} className="set-text" onClick={pick}>
              <span className="set-label">{info.label}</span>
              <span className="set-desc">{info.desc}</span>
              {info.note && <span className="set-desc">{info.note}</span>}
              {lines.map((line) => <span key={line} className="set-avail"><Icon name="info" size={14} />{line}</span>)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Settings > Permissions (SettingsPermissions.png). Running sessions read these on their next tool call. */
export function Permissions({ s }: { s: AppSettings }) {
  const p = s.permissions
  const availability = useModeAvailability()
  return (
    <Page title="Permissions" intro="The mode new chats start in. A room can set its own.">
      <Section title="Mode">
        <ModeList value={p.mode} availability={availability} />
        <Row className="set-sub" label="Only in worktrees" desc="Never skip permissions on your current branch"><Toggle label="Only in worktrees" checked={p.bypassOnlyInWorktrees} onChange={(v) => void patchSettings({ permissions: { bypassOnlyInWorktrees: v } })} /></Row>
      </Section>
      <Section title="Network">
        <Row label="Allow network access" desc="When off, agents can’t reach the network in any mode, Bypass permissions included"><Toggle label="Allow network access" checked={p.network} onChange={(v) => void patchSettings({ permissions: { network: v } })} /></Row>
      </Section>
      <Section title="Commands">
        <Row label="Always ask before" desc="You decide these in every mode except Bypass permissions" full={<LinesField label="Always ask before" value={p.alwaysAsk} onSave={(alwaysAsk) => void patchSettings({ permissions: { alwaysAsk } })} />} />
        <Row label="Never allow" desc="Blocked in every mode, Bypass permissions included" full={<LinesField label="Never allow" value={p.neverAllow} onSave={(neverAllow) => void patchSettings({ permissions: { neverAllow } })} />} />
        <Row label="Protected branches" desc="Pushes to these are blocked in every mode">
          <ListField label="Protected branches" value={p.protectedBranches} onSave={(protectedBranches) => void patchSettings({ permissions: { protectedBranches } })} />
        </Row>
        <Row label="Approval timeout" desc="After this, the request falls back to the normal prompt in Claude Code">
          <Select label="Approval timeout" value={String(p.approvalTimeoutSec)} options={TIMEOUTS.some((t) => t.value === String(p.approvalTimeoutSec)) ? TIMEOUTS : [...TIMEOUTS, { value: String(p.approvalTimeoutSec), label: `${p.approvalTimeoutSec} sec` }]} onChange={(e) => void patchSettings({ permissions: { approvalTimeoutSec: Number(e.target.value) } })} />
        </Row>
      </Section>
    </Page>
  )
}
