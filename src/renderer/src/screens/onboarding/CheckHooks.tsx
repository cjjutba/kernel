import { useCallback, useEffect, useState } from 'react'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Button, Icon, Modal } from '../../ui'
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

/** CheckHooks.png: installs the http hooks (the old settings file is kept as a backup), then confirms events arrive. */
export function CheckHooks() {
  const hooks = useStore((s) => s.system.hooks)
  const sessions = useStore((s) => Object.values(s.running).filter(Boolean).length)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const refresh = useCallback(() => call('hooks.status', undefined).then(actions.system.setHooks).catch(() => undefined), [])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [refresh])

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setNote(null)
    try { await fn(); setNote(done); await refresh() } catch (e) { setNote((e as Error).message) } finally { setBusy(false) }
  }
  const install = () => act(() => call('hooks.install', { port: hooks?.port ?? 7420 }), 'Hooks installed. Your old settings file is kept next to it as a backup.')
  const test = () => act(() => call('hooks.test', undefined), 'Test event arrived.')

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
          <Button variant="ghost" disabled={busy} onClick={() => void install()}>{hooks?.installed ? 'Reinstall hooks' : 'Install hooks'}</Button>
          <Button variant="primary" onClick={actions.ui.closeModal}>Done</Button>
        </>
      }
    >
      <p className="hk-lede">Hooks let the office see what every agent is doing. They post events to a local server only.</p>
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
        <Button disabled={busy || !hooks?.installed || !hooks.listening} onClick={() => void test()}>Send test event</Button>
        <span className="hk-note" role="status" aria-live="polite">{note}</span>
      </div>
      <pre className="code hk-snip"><span className="path">~/.claude/settings.json</span>{`\n"hooks": {\n  "PreToolUse": [{\n    "hooks": [{ "type": "http", "url": "http://localhost:${port}/hooks" }]\n  }],\n  ...one entry per event\n}`}</pre>
    </Modal>
  )
}
