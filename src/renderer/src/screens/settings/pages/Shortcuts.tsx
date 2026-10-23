import { useEffect, useRef, useState } from 'react'
import { DEFAULT_HOTKEYS, FIXED_HOTKEYS, HOTKEYS, comboKeys, comboSpoken, hotkeyDef, recorded, type HotkeyGroup, type HotkeyId } from '@shared/hotkeys'
import { Button, Icon, IconButton } from '../../../ui'
import { useBusy } from '../../../ui/hooks'
import { hotkeys, useHotkeys } from '../../../hotkeys'
import { Keys, Page, Section } from '../kit'
import { patchSettings } from '../useSettings'
import './personal.css'

const GROUPS: HotkeyGroup[] = ['Workspaces', 'Agents', 'App']

type Row = { id?: HotkeyId; label: string; keys: string[]; spoken: string; changed: boolean }

/** The rows Settings, Shortcuts lists, by group: every shortcut as bound now, then the fixed ones. Also what the screen tests read. */
export function shortcutRows(keys = hotkeys()): { title: HotkeyGroup; rows: Row[] }[] {
  return GROUPS.map((title) => ({
    title,
    rows: [
      ...HOTKEYS.filter((d) => d.group === title).map((d): Row => {
        const range = 'range' in d ? d.range : undefined
        return { id: d.id, label: d.label, keys: comboKeys(keys[d.id], range), spoken: comboSpoken(keys[d.id], range), changed: keys[d.id] !== DEFAULT_HOTKEYS[d.id] }
      }),
      ...FIXED_HOTKEYS.filter((f) => f.group === title).map((f): Row => ({ label: f.label, keys: f.keys, spoken: f.keys.join(' '), changed: false }))
    ]
  }))
}

/**
 * Settings > Shortcuts (KERNEL-680, configurable-hotkeys): a filter, then each group's shortcuts in two columns. Pressing a shortcut's
 * keys records a new combo for it. A combo another shortcut has, one macOS owns or one with no ⌘, ⌃ or ⌥ is refused and says why.
 * Esc cancels. A changed shortcut has its own reset, and Reset all puts every one back.
 */
export function Shortcuts() {
  const keys = useHotkeys()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<HotkeyId | null>(null)
  const [error, setError] = useState<{ id: HotkeyId; text: string } | null>(null)
  const [busy, run] = useBusy<'all'>()
  const q = query.trim().toLowerCase()
  const groups = shortcutRows(keys).map((g) => ({ ...g, rows: g.rows.filter((r) => !q || r.label.toLowerCase().includes(q)) })).filter((g) => g.rows.length)
  const anyChanged = HOTKEYS.some((d) => keys[d.id] !== DEFAULT_HOTKEYS[d.id])
  const save = (id: HotkeyId, combo: string | null) => { setError(null); void patchSettings({ hotkeys: { [id]: combo } }) }
  const resetAll = () => run('all', async () => { setError(null); await patchSettings({ hotkeys: Object.fromEntries(HOTKEYS.map((d) => [d.id, null])) }) })
  return (
    <Page title="Shortcuts" desc="The keys Kernel listens for. Click a shortcut and press the keys you want instead."
      action={<Button size="sm" disabled={!anyChanged} busy={busy === 'all'} busyLabel="Resetting" onClick={() => void resetAll()}>Reset all</Button>}>
      <div className="pe-filter">
        <span aria-hidden="true"><Icon name="search" size={12} /></span>
        <input type="search" aria-label="Filter shortcuts" placeholder="Filter shortcuts" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {groups.map((g) => {
        // Two columns read down, then across, so the first half of a group sits on the left.
        const per = g.rows.length > 1 ? Math.ceil(g.rows.length / 2) : 1
        return (
          <Section key={g.title} title={g.title}>
            <div className="pe-grid" role="list" aria-label={g.title} style={{ gridTemplateRows: `repeat(${per}, auto)` }}>
              {g.rows.map((r, i) => (
                <div key={r.id ?? r.label} role="listitem" className="pe-key" data-right={i >= per || undefined} data-first={i % per === 0 || undefined} data-error={error?.id === r.id || undefined}>
                  <span className="pe-key-label">
                    {r.label}
                    {r.id && error?.id === r.id && <span className="pe-key-error" role="alert">{error.text}</span>}
                  </span>
                  {r.id && r.changed && recording !== r.id && <IconButton className="pe-key-reset" icon="refresh" size={12} box="xs" label={`Reset ${r.label} to ${comboSpoken(DEFAULT_HOTKEYS[r.id], hotkeyDef(r.id).range)}`} data-tip="Reset to default" onClick={() => save(r.id!, null)} />}
                  {r.id
                    ? <Recorder id={r.id} row={r} recording={recording === r.id}
                        onStart={() => { setError(null); setRecording(r.id!) }}
                        onStop={() => setRecording(null)}
                        onCombo={(combo) => { setRecording(null); if (combo !== keys[r.id!]) save(r.id!, combo) }}
                        onError={(text) => setError({ id: r.id!, text })} />
                    : <span className="pe-key-fixed" role="img" aria-label={`${r.spoken}, can't be changed`}><Keys keys={r.keys} /></span>}
                </div>
              ))}
            </div>
          </Section>
        )
      })}
      {!groups.length && <p className="pe-empty">No shortcuts match “{query}”</p>}
    </Page>
  )
}

/** The keys of one shortcut as a button. Pressed, it listens for the next combo; Esc or leaving it cancels. */
function Recorder({ id, row, recording, onStart, onStop, onCombo, onError }: {
  id: HotkeyId; row: Row; recording: boolean; onStart: () => void; onStop: () => void; onCombo: (combo: string) => void; onError: (text: string) => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const latest = useRef({ onCombo, onError, onStop })
  latest.current = { onCombo, onError, onStop }
  useEffect(() => {
    if (!recording) return
    const el = ref.current
    el?.focus()
    const take = (e: KeyboardEvent) => {
      // While recording, every key is for this button and none reaches the app's own shortcuts.
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return latest.current.onStop()
      const r = recorded(hotkeys(), id, e)
      if (!r) return
      if ('error' in r) latest.current.onError(r.error)
      else latest.current.onCombo(r.combo)
    }
    // Main hands ⌘W and ⌘R over as their own events while they are bound, so a press of one is that shortcut's combo.
    const handed = (which: 'closeTab' | 'runScript') => (e: Event) => { e.stopImmediatePropagation(); const combo = hotkeys()[which]; const r = recorded(hotkeys(), id, comboEvent(combo)); if (r && 'error' in r) latest.current.onError(r.error); else if (r) latest.current.onCombo(r.combo) }
    const close = handed('closeTab')
    const runKey = handed('runScript')
    window.addEventListener('keydown', take, true)
    window.addEventListener('kernel:close-tab', close, true)
    window.addEventListener('kernel:run-script', runKey, true)
    return () => { window.removeEventListener('keydown', take, true); window.removeEventListener('kernel:close-tab', close, true); window.removeEventListener('kernel:run-script', runKey, true) }
  }, [recording, id])
  return (
    <button ref={ref} type="button" className="pe-key-rec" data-recording={recording || undefined} data-changed={row.changed || undefined}
      aria-label={recording ? `Recording a shortcut for ${row.label}. Press the keys, or Escape to cancel` : `${row.label}: ${row.spoken}. Change`}
      aria-pressed={recording}
      onClick={() => (recording ? onStop() : onStart())} onBlur={() => { if (recording) onStop() }}>
      {recording ? <span className="pe-key-listening">Press keys</span> : <Keys keys={row.keys} />}
    </button>
  )
}

/** A combo as the key event that presses it, for the keys main hands over as events. */
function comboEvent(combo: string) {
  const parts = combo.split('+')
  const code = parts[parts.length - 1]
  return { key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code, code, metaKey: parts.includes('meta'), ctrlKey: parts.includes('ctrl'), altKey: parts.includes('alt'), shiftKey: parts.includes('shift') }
}
