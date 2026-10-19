import { useEffect, useState } from 'react'
import { call, cleanError } from '../../api'
import { saveAppMode } from '../../permissionModes'
import { actions, getState, go } from '../../store'
import { Button, Icon, useBusy } from '../../ui'
import { patchSettings, useSettings } from '../settings/useSettings'
import { needsHookCheck } from './hookCheck'
import { Card } from './parts'
import type { StepFrame } from './Onboarding'

/** What the Mac has said about banners. macOS has no way to read it back, so it is what the last Allow did. A fixture opens on either answer. */
type NotifyState = 'idle' | 'allowed' | 'denied'
const startState = (): NotifyState => { const m = getState().ui.menu; return m === 'obAllowed' ? 'allowed' : m === 'obDenied' ? 'denied' : 'idle' }

const ASKS: { id: 'on' | 'off'; name: string; what: string }[] = [
  { id: 'on', name: 'Share usage data', what: 'Anonymous errors and counts of what goes wrong. Never code, prompts, file paths or names.' },
  { id: 'off', name: 'Don’t share', what: 'Nothing is sent. You can change this in Settings, Privacy.' }
]

/** Stay in the loop (KERNEL-1088): banners when an agent needs you, and the one question about usage data, with no answer picked for you. */
export function useLoop(): StepFrame {
  const s = useSettings()
  // Only a build that can send asks. Until main answers, the question shows, since most builds can.
  const [sends, setSends] = useState(true)
  useEffect(() => { void call('app.info', undefined).then((i) => setSends(i.telemetry)).catch(() => undefined) }, [])
  const [notify, setNotify] = useState<NotifyState>(startState)
  const [pick, setPick] = useState<'on' | 'off' | null>(null)
  const [busy, run] = useBusy<'allow' | 'finish'>()
  const answer = pick ?? (s && s.privacy.telemetry !== 'ask' ? s.privacy.telemetry : null)
  const allow = () => run('allow', async () => {
    try {
      // The banner is what makes macOS ask. If it can't show one, banners are off for Kernel.
      await call('notifications.playSound', { sound: getState().settings?.notifications.sound ?? 'chime' })
      setNotify('allowed')
    } catch (e) {
      setNotify('denied')
      actions.ui.toast({ title: 'Could not show a banner', sub: cleanError(e) })
    }
  })
  const finish = () => run('finish', async () => {
    const saved = await patchSettings({ onboarding: { done: true }, ...(sends && answer ? { privacy: { telemetry: answer } } : {}) })
    if (!saved) return
    await saveAppMode(saved.permissions.mode).catch(() => undefined)
    go({ name: 'leadNew', projectId: '' }, { history: 'replace' })
    if (needsHookCheck(await call('hooks.status', undefined).catch(() => null))) actions.ui.openModal({ name: 'checkHooks' })
  })
  return {
    title: 'Stay in the loop',
    sub: 'Agents work while you do something else. Kernel tells you when one needs an answer, and asks you one question about usage data.',
    canContinue: !!s && (!sends || !!answer),
    busy: busy === 'finish',
    busyLabel: 'Finishing',
    onContinue: () => void finish(),
    body: (
      <>
        <Card label="Notifications">
          <div className="ob-row ob-acct" role="listitem">
            <span className="ob-tile" aria-hidden="true"><Icon name="bell" size={14} /></span>
            <span className="ob-body">
              <span className="ob-name">Notifications</span>
              <span className="ob-detail">{notify === 'denied' ? 'Banners are off for Kernel. Turn them on in System Settings, Notifications.' : 'A banner when an agent asks for approval, finishes a task or hits a limit.'}</span>
            </span>
            {notify === 'allowed' ? <span className="ob-done"><Icon name="check" size={14} />Allowed</span>
              : notify === 'denied' ? <Button size="sm" onClick={() => void call('system.openExternal', { url: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension' }).catch((e) => actions.ui.toast({ title: 'Could not open System Settings', sub: cleanError(e) }))}>Open System Settings</Button>
              : <Button size="sm" busy={busy === 'allow'} busyLabel="Asking" onClick={() => void allow()}>Allow</Button>}
          </div>
        </Card>
        {sends && (
          <Card label="Usage data" className="ob-settings">
            <div role="radiogroup" aria-label="Share usage data with Kernel?" className="ob-asks">
              <span className="ob-ask-q">Share usage data with Kernel?</span>
              {ASKS.map((a) => (
                <label key={a.id} className="ob-row ob-ask" data-on={answer === a.id || undefined}>
                  <input type="radio" name="ob-telemetry" className="sr-only" checked={answer === a.id} onChange={() => setPick(a.id)} />
                  <span className="ob-radio" aria-hidden="true" />
                  <span className="ob-body"><span className="ob-name">{a.name}</span><span className="ob-detail">{a.what}</span></span>
                </label>
              ))}
            </div>
          </Card>
        )}
      </>
    )
  }
}
