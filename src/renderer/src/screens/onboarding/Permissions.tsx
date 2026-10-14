import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { PERMISSION_MODES, type ModeAvailability, type PermissionMode, type Provider } from '@shared/types'
import { call, cleanError } from '../../api'
import { rememberBypassConfirmed } from '../../bypassConfirm'
import { MODE_INFO, saveAppMode } from '../../permissionModes'
import { go, launchRoute, useStore } from '../../store'
import { Button, Icon, Spinner, useBusy } from '../../ui'
import { FirstRoom } from './FirstRoom'
import './onboarding.css'

interface ModeRow {
  mode: PermissionMode
  title: string
  desc: string
  /** A second sentence under the description: what still stops Bypass permissions. */
  note?: string
  /** The warning block under Bypass permissions. */
  caution?: string
}

/** What the step adds under Bypass permissions, the warning SetupPermissions.png draws. The rest of each row is the copy Settings, Permissions uses (`MODE_INFO`). */
const BYPASS_CAUTION = 'Use it for work you would let run unattended. Only in worktrees stays on, so it never applies to your current branch.'

/** The four modes in the order Settings, Permissions lists them. */
const MODES: ModeRow[] = PERMISSION_MODES.map((mode) => ({
  mode, title: MODE_INFO[mode].label, desc: MODE_INFO[mode].desc, note: MODE_INFO[mode].note,
  caution: mode === 'bypassPermissions' ? BYPASS_CAUTION : undefined
}))

const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }

/** What Kernel shows when it can't ask main what the Lead's provider can run: Auto and Bypass permissions stay off, as in main's own fallback. */
const UNKNOWN: ModeAvailability = { auto: false, bypass: false }

/** SetupPermissions.png and SetupPermissionsNoAuto.png: the step after Checks. It picks the mode new chats start in and writes `permissions.mode`. */
export function Permissions() {
  const settings = useStore((s) => s.settings)
  const rooms = useStore((s) => s.rooms)
  const lead: Provider = settings?.models.roles.lead.provider ?? 'claude'
  const [avail, setAvail] = useState<Record<Provider, ModeAvailability> | null>(null)
  const [picked, setPicked] = useState<PermissionMode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, run] = useBusy<'save'>()
  const radios = useRef<Partial<Record<PermissionMode, HTMLButtonElement | null>>>({})

  useEffect(() => {
    let live = true
    call('permissions.availability', undefined)
      .then((a) => { if (live) setAvail(a) })
      .catch((e) => { if (live) { setError(`${cleanError(e)} Auto and Bypass permissions stay off until Kernel can check.`); setAvail({ claude: UNKNOWN, codex: UNKNOWN }) } })
    return () => { live = false }
  }, [])

  if (done) return <FirstRoom />

  const can = avail?.[lead]
  // Auto where the Lead's provider can run it, Accept edits otherwise. A choice the user made replaces it.
  const recommended: PermissionMode | null = !can ? null : can.auto ? 'auto' : 'acceptEdits'
  const pick = picked ?? recommended
  const allowed = (m: PermissionMode) => (m === 'auto' ? !!can?.auto : m === 'bypassPermissions' ? !!can?.bypass : true)
  // One line says why a mode is off. A Codex Lead has its own sentence (SetupPermissionsNoAuto.png). The reason covers Auto and Bypass together, so it sits under Auto when that is off.
  const why = (m: PermissionMode): string | undefined => {
    if (!can || allowed(m)) return undefined
    if (m === 'auto') return lead === 'codex' ? `Auto isn't available for Codex agents yet. Kernel runs on ${PROVIDER_NAME[lead]}.` : can.reason ?? "Auto isn't available on this Claude account."
    return can.auto ? can.reason : undefined
  }
  const foot = recommended === 'auto' ? `Kernel runs on ${PROVIDER_NAME[lead]}, so Auto is the default.`
    : lead === 'codex' ? `Kernel runs on ${PROVIDER_NAME[lead]}, so Accept edits is the default.`
      : "Auto isn't available, so Accept edits is the default."

  const choose = (m: PermissionMode) => { if (allowed(m)) setPicked(m) }
  // Arrow keys move the choice and the focus to the next mode that can run, and only the chosen one is in the tab order.
  const onKey = (e: KeyboardEvent, from: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    for (let i = 1; i < MODES.length; i++) {
      const next = MODES[(from + step * i + MODES.length * i) % MODES.length]
      if (!allowed(next.mode)) continue
      choose(next.mode)
      radios.current[next.mode]?.focus()
      return
    }
  }

  const next = () => run('save', async () => {
    if (!pick) return
    // `saveAppMode` says why on a toast when it can't save, and the step stays where it is.
    if (!(await saveAppMode(pick))) return
    // The step shows Bypass permissions with its warning, so choosing it here counts as answering ConfirmBypass (KERNEL-435).
    if (pick === 'bypassPermissions') rememberBypassConfirmed()
    // Reached with a room already open, which only a launch route or a fixture does: carry on to where the app opens.
    if (rooms.length) go(launchRoute(), { history: 'replace' }); else setDone(true)
  })

  return (
    <div className="panel" style={{ background: 'transparent', border: 0 }}>
      <div className="ob-page">
        <div className="ob-col">
          <h1 className="ob-h1">Choose how agents ask</h1>
          <p className="ob-sub">Pick the mode new chats start in. You can change it later in Settings, Permissions, or for a room.</p>
          {avail ? (
            <div role="radiogroup" aria-label="Permission mode" className="ob-list ob-modes">
              {MODES.map((m, i) => {
                const on = pick === m.mode
                const off = !allowed(m.mode)
                const line = why(m.mode)
                return (
                  <div key={m.mode} className="ob-mode" data-disabled={off}>
                    <button
                      ref={(el) => { radios.current[m.mode] = el }} type="button" role="radio" className="ob-radio" aria-checked={on} aria-disabled={off}
                      aria-labelledby={`ob-mode-${m.mode}`} aria-describedby={[`ob-mode-${m.mode}-desc`, line && `ob-mode-${m.mode}-why`, m.caution && `ob-mode-${m.mode}-caution`].filter(Boolean).join(' ')} tabIndex={on ? 0 : -1}
                      onClick={() => choose(m.mode)} onKeyDown={(e) => onKey(e, i)}
                    >{on && <Icon name="check" size={12} />}</button>
                    <div className="ob-mode-body">
                      <span id={`ob-mode-${m.mode}`} className="ob-mode-title" onClick={() => choose(m.mode)}>
                        {m.title}
                        {recommended === m.mode && <span className="ob-tag">Recommended</span>}
                      </span>
                      <span id={`ob-mode-${m.mode}-desc`} className="ob-mode-desc" onClick={() => choose(m.mode)}>
                        {m.desc}
                        {m.note && <span className="ob-mode-note">{m.note}</span>}
                      </span>
                      {line && <span id={`ob-mode-${m.mode}-why`} className="ob-mode-why"><Icon name="info" size={14} />{line}</span>}
                      {m.caution && <span id={`ob-mode-${m.mode}-caution`} className="ob-caution"><Icon name="warning" size={14} />{m.caution}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="ob-list ob-modes" aria-busy="true"><div className="ob-check"><Spinner label="Checking" /><span className="muted">Checking</span></div></div>
          )}
          <div className="ob-bar ob-modes-bar">
            <span role="status">{error ?? (avail ? foot : '')}</span>
            <Button variant="primary" size="lg" disabled={!pick} busy={busy === 'save'} busyLabel="Saving" onClick={() => void next()}>Continue</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
