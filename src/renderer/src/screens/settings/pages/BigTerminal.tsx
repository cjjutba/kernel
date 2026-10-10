import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { KNOWN_CLIS, type AppSettings, type TerminalPreset } from '@shared/types'
import { getState } from '../../../store'
import { selectedPreset, useTerminalPresets } from '../../../terminalPresets'
import { Button, Icon, Modal, Toggle, useBusy } from '../../../ui'
import { Keys, Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

type Custom = AppSettings['terminal']['custom'][number]

/** The line under a preset's name. A custom command says so, and a CLI Kernel found on the PATH says where. */
const describe = (p: TerminalPreset): string => {
  if (!p.builtin) return 'Custom command'
  if (p.id === 'claude') return 'Claude Code in the workspace folder'
  if (p.id === 'claude-skip') return 'Worktrees only, never your current branch'
  if (p.id === 'shell') return 'Your login shell'
  return 'Found on your PATH'
}

/** A custom command's id: its name as a slug. The prefix keeps it clear of the built-in and CLI ids, which main would refuse. */
function newId(name: string, taken: string[]): string {
  const base = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'command'}`
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/** Settings > Big terminal (SettingsBigTerminal.png): the tab's switches, then what a new tab runs. */
export function BigTerminal({ s }: { s: AppSettings }) {
  const t = s.terminal
  const presets = useTerminalPresets()
  const [editing, setEditing] = useState<Custom | 'new' | null>(null)
  const set = (patch: Partial<AppSettings['terminal']>) => void patchSettings({ terminal: patch })
  const selected = presets ? selectedPreset(presets, t)?.id : t.preset
  const remove = (c: Custom) => set({ custom: t.custom.filter((x) => x.id !== c.id), ...(t.preset === c.id ? { preset: 'claude' } : {}) })
  return (
    <>
      <Page title="Big terminal" intro="A terminal tab next to your chats. Hooks still report to Kernel.">
        <Section title="Tab">
          <Row label="Big terminal tab" desc="Opens a terminal tab in the workspace folder"><Toggle label="Big terminal tab" checked={t.enabled} onChange={(v) => set({ enabled: v })} /></Row>
          <Row label="Only in worktrees" desc="Never skip permissions on your current branch"><Toggle label="Only in worktrees" checked={t.onlyInWorktrees} onChange={(v) => set({ onlyInWorktrees: v })} /></Row>
          <Row label="Shortcut"><Keys keys={['⌘', '⇧', 'T']} /></Row>
        </Section>
        <Section
          title="New tab preset"
          action={<Button disabled={!presets} onClick={() => setEditing('new')}>Add custom command</Button>}
          note="A new tab runs the selected preset. The + menu in the tab strip lists every preset."
        >
          {presets
            ? <PresetList presets={presets} selected={selected} onPick={(id) => set({ preset: id })} onEdit={(id) => setEditing(t.custom.find((c) => c.id === id) ?? null)} onRemove={(id) => { const c = t.custom.find((x) => x.id === id); if (c) remove(c) }} />
            : <div className="set-empty">Looking for presets</div>}
        </Section>
      </Page>
      {editing && <PresetForm s={s} presets={presets ?? []} custom={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/** One preset is selected. Arrow keys move the selection and the focus, and only the selected one is in the tab order. */
function PresetList({ presets, selected, onPick, onEdit, onRemove }: { presets: TerminalPreset[]; selected?: string; onPick: (id: string) => void; onEdit: (id: string) => void; onRemove: (id: string) => void }) {
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + presets.length) % presets.length
    onPick(presets[next].id)
    radios.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-label="New tab preset">
      {presets.map((p, i) => {
        const on = p.id === selected
        return (
          <div key={p.id} className="set-row set-preset">
            <button
              ref={(el) => { radios.current[i] = el }} type="button" role="radio" className="set-radio" aria-checked={on} aria-label={p.name} tabIndex={on ? 0 : -1} aria-describedby={`preset-desc-${p.id}`}
              onClick={() => onPick(p.id)} onKeyDown={(e) => onKey(e, i)}
            >{on && <Icon name="check" size={10} stroke={2.2} />}</button>
            <div className="set-text" onClick={() => onPick(p.id)}>
              <span className="set-label">{p.name}</span>
              <span id={`preset-desc-${p.id}`} className="set-desc">{describe(p)}</span>
            </div>
            {p.command && <span className="set-preset-cmd" title={p.command}>{p.command}</span>}
            {!p.builtin && (
              <div className="set-entry-actions">
                <Button variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => onEdit(p.id)}>Edit</Button>
                <Button variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => onRemove(p.id)}>Remove</Button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Add or edit a custom command. It is saved in the app settings, so it is yours on this Mac and in every room. */
function PresetForm({ s, presets, custom, onClose }: { s: AppSettings; presets: TerminalPreset[]; custom?: Custom; onClose: () => void }) {
  const [name, setName] = useState(custom?.name ?? '')
  const [command, setCommand] = useState(custom?.command ?? '')
  const [shown, setShown] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, run] = useBusy<'save'>()
  const trimmed = name.trim()
  // The list has the custom commands, and the settings are checked too. A CLI's name counts whether or not it is installed, or installing it later would list two rows with one name.
  const same = (n: string) => n.toLowerCase() === trimmed.toLowerCase()
  const problem = !trimmed
    ? 'Give the command a name.'
    : KNOWN_CLIS.some((c) => same(c.name)) ? `${trimmed} is the name of a CLI Kernel lists when it is installed. Pick another name.`
    : [...presets, ...s.terminal.custom].some((p) => p.id !== custom?.id && same(p.name)) ? `A preset named ${trimmed} is already in the list.` : undefined
  const noCommand = !command.trim()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setShown(true)
    if (problem || noCommand) return
    const entry: Custom = { id: custom?.id ?? newId(trimmed, [...presets.map((p) => p.id), ...s.terminal.custom.map((c) => c.id)]), name: trimmed, command: command.trim() }
    void run('save', async () => {
      await patchSettings({ terminal: { custom: custom ? s.terminal.custom.map((c) => (c.id === custom.id ? entry : c)) : [...s.terminal.custom, entry] } })
      // Main drops a command it can't use without saying so, so the saved settings are the answer. A failed save has already toasted.
      const saved = getState().settings?.terminal.custom.find((c) => c.id === entry.id)
      if (saved?.name === entry.name && saved.command === entry.command) return onClose()
      setFailed(getState().settings ? 'Kernel did not save this command. Try another name.' : 'Could not save the command.')
    })
  }
  return (
    <Modal
      title={custom ? `Edit ${custom.name}` : 'Add custom command'}
      onClose={onClose}
      width={480}
      top={200}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="terminal-preset-form" busy={busy === 'save'} busyLabel="Saving">Save</Button>
      </>}
    >
      <form id="terminal-preset-form" className="modal-body set-form" onSubmit={submit} noValidate>
        <p className="set-help">A new tab types this into your login shell, in the workspace folder. The + menu lists it by name.</p>
        <div className="set-field">
          <label htmlFor="terminal-preset-name">Name</label>
          <input id="terminal-preset-name" className="input" autoComplete="off" spellCheck={false} maxLength={40} placeholder="Dev server logs" value={name} aria-invalid={shown && !!problem} aria-describedby="terminal-preset-name-note" onChange={(e) => { setName(e.target.value); setFailed(null) }} />
          {shown && problem
            ? <span id="terminal-preset-name-note" role="alert" className="set-error">{problem}</span>
            : <span id="terminal-preset-name-note" className="set-help">The tab is called Terminal ({trimmed || 'name'}).</span>}
        </div>
        <div className="set-field">
          <label htmlFor="terminal-preset-command">Command</label>
          <textarea id="terminal-preset-command" className="input" spellCheck={false} placeholder="tail -f logs/dev.log" value={command} aria-invalid={shown && noCommand} aria-describedby="terminal-preset-command-note" onChange={(e) => { setCommand(e.target.value); setFailed(null) }} />
          {shown && noCommand
            ? <span id="terminal-preset-command-note" role="alert" className="set-error">Enter the command to run.</span>
            : <span id="terminal-preset-command-note" className="set-help">Flags go here too, for example claude --verbose.</span>}
        </div>
        {failed && <span role="alert" className="set-error">{failed}</span>}
      </form>
    </Modal>
  )
}
