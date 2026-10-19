import { useCallback, useEffect, useState } from 'react'
import type { HookProblem } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { Button, CopyButton, Icon, Modal, useBusy } from '../../ui'
import './onboarding.css'

export function ago(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'no events'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** Text with some parts in mono: a string is plain, a one-item list is a path or a setting. */
type Text = (string | [string])[]

/** What the card says for each problem, and its one fix: a command to copy, the line Kernel removes, or a button. */
interface Card {
  status: string
  code: string
  title: Text
  detail: Text
  /** Left out when there is nothing to fix, so the card has no fix and no button to try again. */
  fixLabel?: string
  command?: string
  line?: string
  copy?: { label: string; text: string }
  retry?: 'install' | 'check' | 'turnOn'
}

/** CheckHooksNotWritable.png, CheckHooksReadOnly.png, CheckHooksSymlink.png, CheckHooksManaged.png and CheckHooksOff.png (KERNEL-461). A workspace run has no PNG (KERNEL-679). */
export function problemCard(p: HookProblem): Card {
  const notInstalled = "Hooks aren't installed"
  const cantRun = "Hooks can't run"
  switch (p.kind) {
    case 'not-writable':
      return { status: notInstalled, code: p.code, title: ["Kernel can't write to ", [p.file]], detail: ["Your account can't add files to ", [p.dir], '. This often happens after running Claude Code with sudo.'], fixLabel: 'Run this in Terminal, then install again', command: p.fix, retry: 'install' }
    case 'read-only':
      return { status: notInstalled, code: p.code, title: [[p.dir], ' is on a read-only disk'], detail: ['The disk that holds it, ', [p.disk], ", is mounted read-only, so Kernel can't add hooks to it."], fixLabel: 'Run this in Terminal, then install again', command: p.fix, retry: 'install' }
    case 'symlink':
      return { status: notInstalled, code: p.code, title: [[p.file], ' links to a read-only file'], detail: ['It points into ', [p.store], p.nix ? ", which Nix keeps read-only, so Kernel can't change it." : ", which is read-only, so Kernel can't change it."], fixLabel: 'Replace the link with a copy, then install again', command: p.fix, retry: 'install' }
    case 'managed': {
      const where: Text = p.source ? [' is set in ', [p.source]] : [" is set in your organization's managed settings"]
      if (p.setting === 'disableAllHooks') return { status: cantRun, code: 'managed settings', title: ['Your organization turns hooks off'], detail: [['disableAllHooks'], ...where, ', so Claude Code runs no hooks at all.'], fixLabel: 'Ask whoever manages this Mac to turn hooks back on', retry: 'check' }
      return { status: cantRun, code: 'managed settings', title: ['Your organization allows only its own hooks'], detail: [['allowManagedHooksOnly'], ...where, ", so Claude Code skips the hooks in your own settings, Kernel's included."], fixLabel: `Ask whoever manages this Mac to add Kernel's hooks to ${p.source ? 'that file' : 'them'}`, copy: p.block ? { label: 'Copy hooks for your admin', text: p.block } : undefined, retry: 'check' }
    }
    case 'off':
      return { status: cantRun, code: 'disableAllHooks', title: ['Your Claude settings turn hooks off'], detail: [[p.file], ' sets ', ['disableAllHooks'], ' to true, so Claude Code runs no hooks at all.'], fixLabel: `Kernel removes this line and keeps a copy in ${p.file.split('/').pop()}.kernel-backup`, line: '"disableAllHooks": true', retry: 'turnOn' }
    case 'workspace-run':
      return { status: 'Hooks are off', code: 'workspace run', title: ['Hooks are off in a workspace run'], detail: ['This copy of Kernel never changes ', ['~/.claude/settings.json'], ", so it doesn't see Claude sessions started outside it."] }
  }
}

const Rich = ({ text }: { text: Text }) => <>{text.map((x, i) => (typeof x === 'string' ? x : <code key={i} className="hk-mono">{x[0]}</code>))}</>

/** CheckHooks.png: installs the hooks (the old settings file is kept as a backup), then confirms events arrive. */
export function CheckHooks() {
  const hooks = useStore((s) => s.system.hooks)
  const sessions = useStore((s) => Object.values(s.running).filter(Boolean).length)
  const [busy, run] = useBusy<'install' | 'test' | 'check' | 'turnOn'>()
  const [note, setNote] = useState<string | null>(null)
  const refresh = useCallback(() => call('hooks.status', undefined).then((s) => { actions.system.setHooks(s); return s }, () => undefined), [])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [refresh])

  const act = (key: 'install' | 'test' | 'turnOn', fn: () => Promise<unknown>, done: string) => run(key, async () => {
    setNote(null)
    try {
      await fn()
      setNote(done)
      await refresh()
    } catch (e) {
      // A write that failed in a way Kernel explains comes back as the status's problem, and the card says it.
      const kind = (await refresh())?.problem?.kind
      if (kind !== 'not-writable' && kind !== 'read-only' && kind !== 'symlink') setNote(cleanError(e))
    }
  })
  const install = () => act('install', () => call('hooks.install', { port: hooks?.port ?? 7420 }), 'Hooks installed. Your old settings file is kept next to it as a backup.')
  const test = () => act('test', () => call('hooks.test', undefined), 'Test event arrived.')
  const turnOn = () => act('turnOn', () => call('hooks.turnOn', undefined), 'Hooks are on. Your old settings file is kept next to it as a backup.')
  const check = () => run('check', async () => { setNote(null); await refresh() })

  if (hooks?.problem) return <ProblemModal problem={hooks.problem} busy={busy} note={note} retry={{ install, check, turnOn }} />

  const seen = hooks?.events.some((e) => e.lastSeen)
  const title = !hooks ? 'Checking hooks' : !hooks.listening ? 'Hook server is not running' : !hooks.installed ? 'Hooks are not installed' : seen ? 'Hooks are live' : 'Waiting for an event'
  const port = hooks?.port ?? 7420

  return (
    <Modal
      title="Check hooks"
      width={600}
      onClose={actions.ui.closeModal}
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" busy={busy === 'install'} busyLabel={hooks?.installed ? 'Reinstalling' : 'Installing'} disabled={busy !== null} onClick={() => void install()}>{hooks?.installed ? 'Reinstall hooks' : 'Install hooks'}</Button>
          <Button variant="primary" onClick={actions.ui.closeModal}>Done</Button>
        </>
      }
    >
      <p className="hk-lede">Hooks let Kernel see what every agent is doing. They post events to a local server only.</p>
      <div className="hk-status" role="status"><Icon name="plug" size={14} />{title}<span className="mono">localhost:{port}{sessions ? ` · ${sessions} ${sessions === 1 ? 'session' : 'sessions'}` : ''}</span></div>
      <div className="hk-events" role="list" aria-label="Hook events">
        {(hooks?.events ?? []).map((e) => (
          <div key={e.name} className="hk-event" role="listitem" data-seen={!!e.lastSeen}>
            <span className="mono">{e.name}</span>
            <span>{e.lastSeen ? 'Receiving' : e.installed ? 'Installed' : 'Not installed'}</span>
            <span>{e.lastSeen ? ago(e.lastSeen) : e.installed ? 'no events' : ''}</span>
          </div>
        ))}
      </div>
      <div className="hk-test">
        <Button busy={busy === 'test'} busyPattern="ripple" busyLabel="Sending" disabled={busy !== null || !hooks?.installed || !hooks.listening} onClick={() => void test()}>Send test event</Button>
        <span className="hk-note" role="status" aria-live="polite">{note}</span>
      </div>
      <pre className="code hk-snip"><span className="path">~/.claude/settings.json</span>{`\n"hooks": {\n  "PreToolUse": [{\n    "hooks": [{ "type": "command", "command": "/usr/bin/curl ... || true" }]\n  }],\n  ...one entry per event\n}`}</pre>
    </Modal>
  )
}

/** The event list gives way to why the hooks can't be written or can't run, with one fix and one way to try again. */
function ProblemModal({ problem, busy, note, retry }: { problem: HookProblem; busy: string | null; note: string | null; retry: Record<NonNullable<Card['retry']>, () => Promise<void>> }) {
  const c = problemCard(problem)
  const button = c.retry && { install: ['Install hooks', 'Installing'], check: ['Check again', 'Checking'], turnOn: ['Turn hooks on', 'Turning on'] }[c.retry]
  return (
    <Modal
      title="Check hooks"
      width={600}
      onClose={actions.ui.closeModal}
      footer={
        <>
          <span className="grow" />
          <Button variant={button ? 'ghost' : 'primary'} onClick={actions.ui.closeModal}>Done</Button>
          {c.retry && button && <Button variant="primary" busy={busy === c.retry} busyPattern={c.retry === 'check' ? 'ripple' : undefined} busyLabel={button[1]} disabled={busy !== null} onClick={() => void retry[c.retry!]()}>{button[0]}</Button>}
        </>
      }
    >
      <p className="hk-lede">Hooks let Kernel see what every agent is doing. They post events to a local server only.</p>
      <div className="hk-problem">
        <div className="hk-status" role="status"><Icon name="plug" size={14} />{c.status}<span className="mono">{c.code}</span></div>
        <div className="hk-card">
          <div className="hk-card-head">
            <p className="hk-card-title"><Rich text={c.title} /></p>
            <p className="hk-card-detail"><Rich text={c.detail} /></p>
          </div>
          {c.fixLabel && <div className="hk-fix">
            <p className="hk-fix-label">{c.fixLabel}</p>
            {c.command && <div className="hk-command"><span>{c.command}</span><CopyButton text={c.command} label="Copy command" /></div>}
            {c.line && <div className="hk-line">{c.line}</div>}
            {c.copy && <div><CopyButton text={c.copy.text} label={c.copy.label} /></div>}
          </div>}
        </div>
        <p className="hk-keep" role="status" aria-live="polite">{note ?? 'Agents keep working. Their statuses stop updating, and approvals fall back to the terminal.'}</p>
      </div>
    </Modal>
  )
}
