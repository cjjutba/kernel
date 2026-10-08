import { useEffect, useState } from 'react'
import type { Chat, Workspace } from '@shared/types'
import { call } from '../../../api'
import { actions, go, loadWorkspace, useStore } from '../../../store'
import { Banner, Button } from '../../../ui'
import { attempt } from '../MessageActions'
import { commandComposer } from '../composer/bus'
import { bannerFor, type BannerAction, type BannerView } from './model'
import './banners.css'

const NO_LINES: never[] = []

/** The banner this workspace shows right now, from the store. Ticks once a second while a retry counts down. */
export function useBanner(ws: Workspace | undefined, chat: Chat | undefined, agentName: string, running: boolean): BannerView | null {
  const usage = useStore((s) => s.usage)
  const account = useStore((s) => s.account)
  const online = useStore((s) => s.system.online)
  const hooks = useStore((s) => s.system.hooks)
  const retry = useStore((s) => (chat ? s.retry[chat.id] : undefined))
  const scripts = useStore((s) => (ws ? s.scripts[ws.id] ?? NO_LINES : NO_LINES))
  const setupCode = useStore((s) => (ws ? s.scriptExit[ws.id]?.setup : undefined))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!retry) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [retry])
  if (!ws) return null
  return bannerFor({ ws, chat, agentName, running, usage, account, online, hooks, retry, scripts, setupCode, now: retry ? now : Date.now() })
}

/**
 * The failure banner above the composer (WorkspaceSessionLimit.png and the eight screens after it). Each action is a
 * real recovery path: Notify me, Switch model, Compact, Sign in, Run again and Reconnect all call main.
 */
export function WorkspaceBanner({ view, ws, chat }: { view: BannerView; ws: Workspace; chat?: Chat }) {
  const [busy, setBusy] = useState<BannerAction | null>(null)
  // "Notify me" and "Wait" settle the banner without clearing it, as the canvas does. Keyed by banner, so a new one starts fresh.
  const [settled, setSettled] = useState<{ id: string; notified?: boolean } | null>(null)
  const mine = settled?.id === view.id ? settled : null
  // A failed setup opens its log, which is where the reason is.
  useEffect(() => { if (view.id === 'setup') actions.ui.setWorkspaceView({ bottom: 'setup' }) }, [view.id])
  // Signed out: coming back from a terminal where the user ran `claude /login` checks again at once. Main also checks every 10s.
  useEffect(() => {
    if (view.id !== 'signedOut') return
    const check = () => void call('account.get', undefined).then(actions.account.set).catch(() => undefined)
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [view.id])

  const run = (id: BannerAction, label: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    void attempt(label, fn).finally(() => setBusy(null))
  }

  const act = (id: BannerAction) => {
    switch (id) {
      case 'queue': return commandComposer('send')
      case 'notify': return run(id, 'Could not set the reminder', async () => {
        if (view.limit) await call('usage.notifyOnReset', { type: view.limit })
        setSettled({ id: view.id, notified: true })
      })
      case 'usage': return run(id, 'Could not open Terminal', () => call('app.openTerminal', { cwd: ws.path, command: 'claude /usage' }))
      case 'wait': return setSettled({ id: view.id })
      case 'switch': return chat && view.switchTo && run(id, 'Could not switch the model', async () => {
        await call('chats.configure', { chatId: chat.id, model: view.switchTo })
        await loadWorkspace(ws.id)
      })
      case 'newChat': return run(id, 'Could not start a new chat', async () => {
        const c = await call('chats.create', { workspaceId: ws.id, kind: 'chat' })
        await loadWorkspace(ws.id)
        actions.ui.setWorkspaceView({ tab: c.id, diff: undefined })
      })
      case 'compact': return chat && run(id, 'Could not compact', () => call('chats.compact', { chatId: chat.id }))
      case 'switchModel': return commandComposer('model')
      case 'retryNow': return chat && run(id, 'Could not retry', () => retryNow(chat.id))
      case 'tryAgain': return run(id, 'Could not check the network', async () => {
        const { online } = await call('app.checkOnline', undefined)
        actions.system.setOnline(online)
        if (!online) actions.ui.toast({ title: 'Still offline', sub: 'Kernel checks again every few seconds.' })
      })
      case 'terminal': return run(id, 'Could not open Terminal', () => call('app.openTerminal', { cwd: ws.path, command: 'claude /login' }))
      case 'signIn': return run(id, 'Could not sign in', async () => actions.account.set(await call('account.signIn', undefined)))
      case 'editScript': return go({ name: 'settings', page: 'scripts', roomId: ws.roomId })
      case 'runAgain': return run(id, 'Could not run setup', async () => {
        actions.ui.setWorkspaceView({ bottom: 'setup' })
        await call('scripts.run', { workspaceId: ws.id, kind: 'setup' })
      })
      case 'checkHooks': return actions.ui.openModal({ name: 'checkHooks' })
      case 'reconnect': return run(id, 'Could not restart the hook server', async () => actions.system.setHooks(await call('hooks.restart', {})))
    }
  }

  const sub = mine?.notified ? 'You will get a notification when it resets.' : view.sub
  const shown = mine ? [] : view.actions
  return (
    <Banner
      kind={view.kind} title={view.title}
      actions={shown.length ? <span className="wsb-actions">{shown.map((a) => (
        <Button key={a.id} variant={a.primary ? 'primary' : 'secondary'} className="wsb-btn" disabled={busy !== null} onClick={() => act(a.id)}>{busy === a.id && a.primary ? <span className="spin" aria-hidden="true" /> : null}{a.label}</Button>
      ))}</span> : undefined}
    >{sub}</Banner>
  )
}

/** Retry now: send the last message again at once. The waiting retry is interrupted and the copy goes first. */
async function retryNow(chatId: string) {
  const items = await call('chats.items', { chatId })
  const user = [...items].reverse().find((i) => i.kind === 'user')
  if (user?.kind !== 'user') return
  const { queued } = await call('chats.send', { chatId, parts: user.parts })
  if (!queued) return
  const queue = await call('chats.queue', { chatId })
  const copy = queue[queue.length - 1]
  if (copy) actions.chats.setQueue(chatId, await call('chats.sendNow', { chatId, id: copy.id }))
}
