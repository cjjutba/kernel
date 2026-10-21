import { useState, type FormEvent } from 'react'
import { KNOWN_CLIS, type AppSettings, type TerminalPreset } from '@shared/types'
import { getState } from '../../../store'
import { selectedPreset, useTerminalPresets } from '../../../terminalPresets'
import './system.css'
import { Button, Icon, LoadingRow, Modal, Toggle, useBusy, type MenuEntry } from '../../../ui'
import { appliesTo, Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import { RowMenu } from './RowMenu'

type Custom = AppSettings['terminal']['custom'][number]

/** The command a preset types, in mono under its name. The shell has no command of its own, so it says so. */
const commandOf = (p: TerminalPreset): string => p.command ?? 'Your login shell'

/** What a built-in preset adds to its command: Skipping prompts follows "Terminal tabs only in worktrees". A custom command has nothing to add. */
const noteOf = (p: TerminalPreset, onlyInWorktrees: boolean): string | undefined => {
  if (p.id === 'claude-skip') return onlyInWorktrees ? 'Worktrees only' : 'Any workspace, your current branch included'
  return undefined
}

/** A custom command's id: its name as a slug. The prefix keeps it clear of the built-in and CLI ids, which main would refuse. */
function newId(name: string, taken: string[]): string {
  const base = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'command'}`
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/** Settings > Big terminal (MorePage terminal, KERNEL-680): the tab's switches, then what a new tab runs. */
export function BigTerminal({ s }: { s: AppSettings }) {
  const t = s.terminal
  const presets = useTerminalPresets()
  const [editing, setEditing] = useState<Custom | 'new' | null>(null)
  const set = (patch: Partial<AppSettings['terminal']>) => void patchSettings({ terminal: patch })
  const selected = presets ? selectedPreset(presets, t)?.id : t.preset
  const remove = (c: Custom) => set({ custom: t.custom.filter((x) => x.id !== c.id), ...(t.preset === c.id ? { preset: 'claude' } : {}) })
  return (
    <>
      <Page title="Big terminal" desc="A full terminal as a chat tab, for running Claude Code or Codex by hand.">
        <Section title="Tab">
          <Row id="big-terminal-tab" label="Big terminal tab" desc="Opens in the workspace folder."><Toggle label="Big terminal tab" checked={t.enabled} onChange={(v) => set({ enabled: v })} /></Row>
          <Row id="terminal-only-worktrees" setting="terminal.onlyInWorktrees" label="Terminal tabs only in worktrees" desc="Never on your current branch."><Toggle label="Terminal tabs only in worktrees" checked={t.onlyInWorktrees} onChange={(v) => set({ onlyInWorktrees: v })} /></Row>
        </Section>
        <Section
          title="New tab opens"
          note="A new tab runs the one marked Default."
          action={<Button icon="plus" disabled={!presets} onClick={() => setEditing('new')}>Add command</Button>}
          footnote={`The + menu in the tab strip opens a Terminal tab with this preset. ${appliesTo('terminal.preset')}.`}
        >
          {presets
            ? <PresetList presets={presets} selected={selected} onlyInWorktrees={t.onlyInWorktrees} onPick={(id) => set({ preset: id })} onEdit={(id) => setEditing(t.custom.find((c) => c.id === id) ?? null)} onRemove={(id) => { const c = t.custom.find((x) => x.id === id); if (c) remove(c) }} />
            : <LoadingRow what="presets" inline />}
        </Section>
      </Page>
      {editing && <PresetForm s={s} presets={presets ?? []} custom={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  )
}

/** One preset is the default: the one a new tab runs. Its row says so, and the menu at the end of any other row makes it the default. A custom command can also be edited or removed there. */
function PresetList({ presets, selected, onlyInWorktrees, onPick, onEdit, onRemove }: { presets: TerminalPreset[]; selected?: string; onlyInWorktrees: boolean; onPick: (id: string) => void; onEdit: (id: string) => void; onRemove: (id: string) => void }) {
  return (
    <div role="list" aria-label="New tab presets">
      {presets.map((p) => {
        const on = p.id === selected
        const note = noteOf(p, onlyInWorktrees)
        const items: MenuEntry[] = [
          ...(on ? [] : [{ id: 'default', label: 'Make default', onSelect: () => onPick(p.id) }]),
          ...(p.builtin ? [] : [{ id: 'edit', label: 'Edit', onSelect: () => onEdit(p.id) }, { id: 'remove', label: 'Remove', danger: true, onSelect: () => onRemove(p.id) }])
        ]
        return (
          <Row
            key={p.id} className="sys-preset" lead={<span className="sys-glyph" aria-hidden="true"><Icon name="term" size={16} /></span>}
            label={p.name} desc={<><span className="sys-cmd">{commandOf(p)}</span>{note && <span className="sys-cmd-note">{note}</span>}</>}
          >
            {on && <span className="sys-pill">Default</span>}
            {items.length > 0 && <RowMenu label={`More for ${p.name}`} items={items} />}
          </Row>
        )
      })}
    </div>
  )
}

/** Add or edit a custom command. It is saved in the app settings, so it is yours on this Mac and in every project. */
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
      title={custom ? `Edit ${custom.name}` : 'Add command'}
      onClose={onClose}
      width={480}
      top={200}
      footer={<>
        <span className="grow" />
        <Button variant="ghost" data-dismiss>Cancel</Button>
        <Button variant="primary" type="submit" form="terminal-preset-form" busy={busy === 'save'} busyLabel="Saving">Save</Button>
      </>}
    >
      <form id="terminal-preset-form" className="modal-body set-form" onSubmit={submit} noValidate>
        <p className="set-help">A new tab types this into your login shell, in the workspace folder. The + menu lists it by name.</p>
        <div className="set-field">
          <label htmlFor="terminal-preset-name">Name</label>
          <input id="terminal-preset-name" className="input set-text-input" autoComplete="off" spellCheck={false} maxLength={40} placeholder="Dev server logs" value={name} aria-invalid={shown && !!problem} aria-describedby="terminal-preset-name-note" onChange={(e) => { setName(e.target.value); setFailed(null) }} />
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
