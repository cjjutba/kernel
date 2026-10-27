import { useEffect, useRef, useState } from 'react'
import type { ScriptSuggestion, Workspace } from '@shared/types'
import { onSharedFolder } from '@shared/leadWorkspace'
import { scriptKey } from '@shared/scriptLog'
import { call } from '../../../api'
import { isLeadWorkspace, leadOf, openLeadChat } from '../../../lead'
import { actions, go, useStore, type State } from '../../../store'
import { useRemembered } from '../../../remember'
import { Button, EmptyList, Icon, IconButton, Menu, MENU_SEPARATOR, Spinner, SplitButton, useBusy, type MenuEntry } from '../../../ui'
import { patchProjectSettings, useProjectSettings } from '../../settings/useSettings'
import { attempt } from '../MessageActions'
import { BottomResize } from '../BottomResize'
import { collapsedWord } from '../bottomWord'
import { bottomKindOf } from '../bottomSplit'
import { pickerNames, runAllNames, runningRuns } from '../runScripts'
import { ScriptView } from '../ScriptView'
import { TerminalView } from '../terminal/Terminal'
import { SHARED_NOTHING, sharedWhy } from './ChangesTab'
import { TabStrip } from './TabStrip'
import { comboLabel, hotkeys } from '../../../hotkeys'

/** Setup is running from its first line until it exits. A new start clears the exit, so the lines of its last run don't count as a stop. */
function setupRunning(s: Pick<State, 'scripts' | 'scriptExit'>, workspaceId: string) {
  return (s.scripts[workspaceId] ?? []).some((l) => l.kind === 'setup') && s.scriptExit[workspaceId]?.setup === undefined
}

/** What `scripts.suggest` found for the project (KERNEL-682). Empty until the first answer, and on a failed read. */
function useSuggestions(projectId: string) {
  const [found, setFound] = useState<ScriptSuggestion[]>([])
  useEffect(() => {
    let live = true
    setFound([])
    call('scripts.suggest', { projectId }).then((next) => { if (live) setFound(next) }, () => {})
    return () => { live = false }
  }, [projectId])
  return found
}

/** The Setup tab of a project with no setup script: take Kernel's suggestion, ask the Lead to write one, or type it in Settings (Pen 9.21, SetupNoScript, KERNEL-685). */
function AddSetup({ projectId, onManual }: { projectId: string; onManual: () => void }) {
  const found = useSuggestions(projectId)
  const lead = useStore((s) => leadOf(s.agents, projectId)?.name ?? 'Kernel')
  const [busy, doing] = useBusy<'use' | 'ask'>()
  // The first suggestion that has a setup script, in the order the engine returns them.
  const pick = found.find((s) => s.patch.scripts?.setup)
  const ask = () => doing('ask', () => attempt(`Could not ask ${lead}`, async () => {
    const chat = await call('scripts.askLead', { projectId })
    await openLeadChat(projectId, chat.id)
  }))
  return (
    <EmptyList icon="term" title="Add setup script" action={
      <>
        {pick
          ? <Button variant="primary" busy={busy === 'use'} busyLabel="Saving" disabled={busy !== null} onClick={() => void doing('use', () => patchProjectSettings(projectId, pick.patch))}>Use the suggested setup script</Button>
          : <Button variant="primary" busy={busy === 'ask'} busyPattern="snake" busyLabel="Starting" disabled={busy !== null} onClick={() => void ask()}>Ask {lead}</Button>}
        <Button disabled={busy !== null} onClick={onManual}>Add manually</Button>
      </>
    }>
      Runs when a workspace is created, to install dependencies or set up the environment.
    </EmptyList>
  )
}

/** One run script in the Run menu: its name, its command in muted mono and, when it runs, Running (Pen 9.18, BottomPanelRunMenu). */
function ScriptRow({ name, command, on }: { name: string; command?: string; on: boolean }) {
  return (
    <span className="run-row">
      <Icon name={on ? 'stop' : 'play'} size={14} />
      <span className="run-row-name">{name}</span>
      {command && <span className="mono run-row-cmd ellipsis">{command}</span>}
      {on && <span className="run-row-on">Running</span>}
    </span>
  )
}

/**
 * The split Run button, always at the right of the tab strip: the play part runs or stops the picked script, and says its name while it runs. The chevron lists every script and Edit run
 * scripts (Pen 9.18).
 */
function RunSplit({ label, commands, none, running, names, runningNames, busy, onPlay, onToggle, onConfigure }: {
  label: string; commands: Record<string, string>; none: boolean; running: boolean; names: string[]; runningNames: string[]; busy: string | null
  onPlay: () => void; onToggle: (name: string) => void; onConfigure: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const playing = busy === 'play'
  const items: (MenuEntry | typeof MENU_SEPARATOR)[] = [
    ...names.map((n): MenuEntry => {
      const on = runningNames.includes(n)
      return { id: n, label: n, icon: on ? 'stop' : 'play', content: <ScriptRow name={n} command={commands[n]} on={on} />, ariaLabel: `${on ? 'Stop' : 'Run'} ${n}`, onSelect: () => onToggle(n) }
    }),
    ...(names.length ? [MENU_SEPARATOR] : []),
    { id: 'configure', label: 'Edit run scripts', icon: 'sliders', onSelect: onConfigure }
  ]
  return (
    <SplitButton
      size="sm"
      icon={running ? 'stop' : 'play'}
      className="run-split"
      data-running={running || undefined}
      disabled={none || (busy !== null && !playing)}
      busy={playing}
      mainProps={{ 'aria-label': playing ? (running ? 'Stopping' : 'Starting') : none ? 'Run' : `${running ? 'Stop' : 'Run'} ${label}`, 'data-tip-kbd': running ? undefined : comboLabel(hotkeys().runScript) }}
      onClick={onPlay}
      caretLabel="Run scripts"
      expanded={open}
      onCaret={() => setOpen((o) => !o)}
      anchorRef={anchor}
      menu={open && <Menu label="Run scripts" heading="Run scripts" anchorRef={anchor} onClose={() => setOpen(false)} style={{ right: 0, top: 30, width: 300 }} items={items} />}
    >
      {running ? label : 'Run'}
    </SplitButton>
  )
}

/**
 * The bottom pane: Setup, Run and Terminal under the files, a third of the panel until it is dragged (KERNEL-513). The chevron folds it to its tab bar, and
 * pressing a tab opens it again. Lead chats and teammates' workspaces each remember whether it is folded. Folded, the bar still says when something runs (Pen 9.18).
 */
export function BottomPanel({ ws }: { ws: Workspace }) {
  const bottom = useStore((s) => s.ui.workspace.bottom)
  const kind = useStore((s) => bottomKindOf(s, ws))
  const collapsed = useStore((s) => s.ui.bottomCollapsed[kind])
  const panel = useRef<HTMLDivElement>(null)
  const pick = (id: string) => {
    actions.ui.setWorkspaceView({ bottom: id as typeof bottom })
    if (collapsed) actions.ui.setBottomCollapsed(kind, false)
  }
  const rs = useProjectSettings(ws.projectId)
  // A script that is running stays in the picker, so it can be stopped, even after Settings renamed or removed it or before they load.
  const runningNames = useStore((s) => runningRuns(s, ws.id).join('\n')).split('\n').filter(Boolean)
  const names = pickerNames((rs?.runScripts ?? []).map((r) => r.name), runningNames)
  const commands = Object.fromEntries((rs?.runScripts ?? []).map((r) => [r.name, r.command]))
  // The Run tab shows one run script at a time. Each keeps its own output and exit (KERNEL-249). The pick is the project's, since its
  // scripts are, and it stays when you leave the workspace (DESIGN.md, Remembered choices).
  const [picked, setPicked] = useRemembered(`kernel.runScript:${ws.projectId}`, (raw) => raw ?? '')
  // Until one is picked, or when the picked one is gone from Settings, the tab shows a script that is running, else the first.
  const selected = names.includes(picked) ? picked : names.find((n) => runningNames.includes(n)) ?? names[0] ?? 'run'
  const scriptName = bottom === 'run' ? selected : undefined
  const dataKey = scriptKey(bottom === 'run' ? 'run' : 'setup', scriptName)
  const fallback = useStore((s) => (s.scripts[ws.id] ?? []).filter((l) => (bottom === 'setup' ? l.kind === 'setup' : l.kind === 'run' && l.name === selected)).map((l) => l.line + '\r\n').join(''))
  const output = useStore((s) => s.scriptData[ws.id]?.[dataKey] ?? '') || fallback
  const hasOutput = output.length > 0
  const logLabel = bottom === 'run' && names.length > 1 ? `${selected} output` : `${bottom} output`
  const setupBusy = useStore((s) => setupRunning(s, ws.id))
  const selectedRunning = runningNames.includes(selected)
  // A project without a setup script never runs one, so the tab says so instead of waiting for output that won't come.
  const noSetup = !!rs && !rs.scripts.setup
  const noRun = !!rs && names.length === 0
  const [busy, doing] = useBusy<'setup' | 'play' | 'menu' | 'stopSetup'>()
  const startRun = async (name: string) => {
    actions.workspaces.clearScriptExit(ws.id, 'run', name)
    await attempt(`Could not start ${name}`, () => call('scripts.run', { workspaceId: ws.id, kind: 'run', name }))
  }
  const stopRun = (name: string) => attempt(`Could not stop ${name}`, () => call('scripts.stop', { workspaceId: ws.id, kind: 'run', name }))
  const startSetup = () => doing('setup', async () => {
    actions.workspaces.clearScriptExit(ws.id, 'setup')
    await attempt('Could not start setup', () => call('scripts.run', { workspaceId: ws.id, kind: 'setup' }))
  })
  const stopSetup = () => doing('stopSetup', () => attempt('Could not stop setup', () => call('scripts.stop', { workspaceId: ws.id, kind: 'setup' })))
  const showRun = (name?: string) => {
    if (name) setPicked(name)
    actions.ui.setWorkspaceView({ bottom: 'run' })
    if (collapsed) actions.ui.setBottomCollapsed(kind, false)
  }
  const play = () => doing('play', async () => {
    showRun()
    await (selectedRunning ? stopRun(selected) : startRun(selected))
  })
  const toggleScript = (name: string) => doing('menu', async () => {
    showRun(name)
    await (runningNames.includes(name) ? stopRun(name) : startRun(name))
  })
  const runAll = () => doing('menu', async () => {
    showRun()
    await Promise.all(runAllNames(names, runningNames).map(startRun))
  })
  const addScript = () => go({ name: 'settings', page: 'project', projectId: ws.projectId, section: 'setup' })
  // The log stays mounted, so its first lines are announced; an empty one shows what to do instead (KERNEL-274).
  const onShared = onSharedFolder(ws)
  const empty = onShared ? (
    <EmptyList icon="fork" title={SHARED_NOTHING}>{sharedWhy()}</EmptyList>
  ) : bottom === 'run'
    ? noRun ? (
      <EmptyList icon="play" title="No run script yet" action={<Button onClick={addScript}>Add a run script</Button>}>Add one in Settings, Project setup, and Run starts your app here.</EmptyList>
    ) : (
      <EmptyList icon="play" title={`Run ${selected}`} action={!selectedRunning && <Button variant="primary" className="idle-run" busy={busy === 'play'} busyPattern="snake" busyLabel="Starting" disabled={busy !== null} onClick={() => void play()}>Run<kbd className="kbd-on-ink">{comboLabel(hotkeys().runScript)}</kbd></Button>}>
        {commands[selected] ? `${commands[selected]} in ${ws.name}` : `Runs on port ${ws.port}. Output shows here.`}
      </EmptyList>
    )
    : noSetup ? (
      <AddSetup projectId={ws.projectId} onManual={addScript} />
    ) : (
      <EmptyList icon="doc" title="No setup output yet" action={<Button busy={busy === 'setup'} busyPattern="snake" busyLabel="Starting" disabled={setupBusy || busy !== null} onClick={() => void startSetup()}>Run setup</Button>}>Setup output appears here after it runs.</EmptyList>
    )
  const word = collapsedWord({ setupRunning: setupBusy, setupFailed: ws.status === 'failed', running: runningNames, scripts: names.length, noRun })
  return (
    <div ref={panel} className="bottom-panel" data-collapsed={collapsed || undefined}>
      {!collapsed && <BottomResize panel={panel} />}
      <div className="bottom-tabs">
        <IconButton icon="chevron" size={14} label={collapsed ? 'Expand bottom panel' : 'Collapse bottom panel'} aria-expanded={!collapsed} data-tip-kbd={comboLabel(hotkeys().bottomPanel)} onClick={() => actions.ui.setBottomCollapsed(kind, !collapsed)} />
        <TabStrip label="Scripts" value={collapsed ? '' : bottom} onChange={pick} tabs={[{ id: 'setup', label: 'Setup', busy: setupBusy }, { id: 'run', label: 'Run', busy: bottom === 'run' && selectedRunning && !collapsed }, { id: 'terminal', label: 'Terminal' }]} />
        {/* Folded, the bar says what the scripts are doing, so you can tell the app is up without opening it (KERNEL-529). */}
        {collapsed && word && <span className="bottom-word" role="status">{word}</span>}
        <span className="grow" />
        <RunSplit label={selected} commands={commands} none={names.length === 0 || onShared} running={selectedRunning} names={names} runningNames={runningNames} busy={busy} onPlay={() => void play()} onToggle={(n) => void toggleScript(n)} onConfigure={addScript} />
      </div>
      {!collapsed && bottom === 'run' && names.length > 1 && (
        <div className="run-picker" role="tablist" aria-label="Run script">
          {names.map((name) => (
            <button key={name} type="button" role="tab" aria-selected={name === selected} className="run-tab" onClick={() => setPicked(name)}>
              {runningNames.includes(name) && <Spinner label={null} pattern="snake" />}{name}
            </button>
          ))}
          <span className="grow" />
          <Button size="xs" icon="play" disabled={busy !== null || runAllNames(names, runningNames).length === 0} onClick={() => void runAll()}>Run all</Button>
          <IconButton icon="sliders" size={14} box="sm" label="Edit run scripts" onClick={addScript} />
        </div>
      )}
      {!collapsed && bottom === 'terminal' && <TerminalView id={`shell:${ws.id}`} label="Terminal" compact />}
      {!collapsed && bottom !== 'terminal' && (hasOutput
        ? <ScriptView key={`${ws.id}:${dataKey}`} workspaceId={ws.id} kind={bottom === 'run' ? 'run' : 'setup'} name={scriptName} label={logLabel} fallback={fallback} />
        : <div className="log selectable mono" role="log" aria-label={logLabel} data-empty="true">{empty}</div>)}
      {!collapsed && bottom === 'setup' && !noSetup && hasOutput && (
        <div className="script-actions">
          {setupBusy
            ? <Button size="sm" busy={busy === 'stopSetup'} busyPattern="snake" busyLabel="Stopping" disabled={busy !== null} onClick={() => void stopSetup()}>Stop</Button>
            : <Button size="sm" icon="refresh" busy={busy === 'setup'} busyPattern="snake" busyLabel="Starting" disabled={busy !== null} onClick={() => void startSetup()}>Rerun setup</Button>}
        </div>
      )}
    </div>
  )
}

