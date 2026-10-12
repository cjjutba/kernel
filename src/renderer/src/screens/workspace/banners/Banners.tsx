import { useEffect, useMemo, useState } from 'react'
import type { Chat, ScriptLine, Workspace } from '@shared/types'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { call } from '../../../api'
import { isLeadWorkspace, leadOf } from '../../../lead'
import { actions, getState, go, loadWorkspace, useStore } from '../../../store'
import { archiveChatFromSidebar } from '../archiveChat'
import { archiveByHand } from '../byHand'
import { Banner, Button, useBusy } from '../../../ui'
import { attempt } from '../MessageActions'
import { commandComposer, focusComposerWhenOpen } from '../composer/bus'
import { bannerFor, setupCommand, type BannerAction, type BannerView } from './model'
import { chatProvider } from '@shared/providers'
import { useCodexInUse } from '../composer/providerModels'
import { dismissLimitBanner, useLimitDismissed } from './limitDismissed'
import './banners.css'

/** What a banner button says while its call runs. Actions that only move focus or open a screen have none. */
const BUSY_LABEL: Partial<Record<BannerAction, string>> = {
  notify: 'Setting up', switch: 'Switching', newChat: 'Starting', compact: 'Compacting', retryNow: 'Retrying',
  tryAgain: 'Checking', terminal: 'Opening', signIn: 'Signing in', runAgain: 'Starting', reconnect: 'Reconnecting', archive: 'Archiving', switchAccount: 'Switching', switchBack: 'Switching', signInAccount: 'Signing in'
}

/** The banner this workspace shows right now, from the store. Ticks once a second while a retry counts down. */
export function useBanner(ws: Workspace | undefined, chat: Chat | undefined, agentName: string, running: boolean, skipsSetup = false): BannerView | null {
  const usage = useStore((s) => s.usage)
  const account = useStore((s) => s.account)
  const accounts = useStore((s) => s.accounts)
  const codexInUse = useCodexInUse(chat ? chatProvider(chat) : undefined)
  const online = useStore((s) => s.system.online)
  const hooks = useStore((s) => s.system.hooks)
  const retry = useStore((s) => (chat ? s.retry[chat.id] : undefined))
  // Only a failed setup reads the script log, and only for the command that failed. Selecting that string, not the log, keeps a
  // noisy script from rendering the workspace for every line it prints.
  const setupCmd = useStore((s) => (ws?.status === 'failed' ? setupCommand(s.scripts[ws.id]) : undefined))
  const scripts = useMemo<ScriptLine[] | undefined>(() => (setupCmd ? [{ kind: 'setup', line: `$ ${setupCmd}`, stream: 'stdout' }] : undefined), [setupCmd])
  const setupCode = useStore((s) => (ws ? s.scriptExit[ws.id]?.setup : undefined))
  // The near-limit hold leaves the Lead alone, and its banner names the Lead (KERNEL-224).
  const isLead = useStore((s) => !!ws && isLeadWorkspace(ws, ws.roomId, leadOf(s.agents, ws.roomId)?.id))
  const leadName = useStore((s) => (ws ? leadOf(s.agents, ws.roomId)?.name : undefined))
  const pauseNearLimit = useStore((s) => s.settings?.usage.pauseNearLimit)
  const warnBeforeWeekly = useStore((s) => s.settings?.usage.warnBeforeWeekly)
  const switchAtLimit = useStore((s) => s.settings?.accounts.switchAtLimit[chat ? chatProvider(chat) : 'claude'])
  const dismissed = useLimitDismissed()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!retry) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [retry])
  if (!ws) return null
  return bannerFor({ ws, chat, agentName, running, usage, account, accounts, codexInUse, online, hooks, retry, scripts, setupCode, isLead, leadName, skipsSetup, dismissed, switchAtLimit, usageSettings: { pauseNearLimit, warnBeforeWeekly }, now: retry ? now : Date.now() })
}

/**
 * The failure banner above the composer (WorkspaceSessionLimit.png and the eight screens after it). Each action is a
 * real recovery path: Notify me, Switch model, Compact, Sign in, Run again and Reconnect all call main.
 */
export function WorkspaceBanner({ view, ws, chat }: { view: BannerView; ws: Workspace; chat?: Chat }) {
  const [busy, track] = useBusy<BannerAction>()
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

  const run = (id: BannerAction, label: string, fn: () => Promise<unknown>) => void track(id, () => attempt(label, fn))

  const act = (id: BannerAction) => {
    switch (id) {
      case 'queue': return commandComposer('send')
      case 'notify': return run(id, 'Could not set the reminder', async () => {
        if (view.limit) await call('usage.notifyOnReset', { type: view.limit })
        setSettled({ id: view.id, notified: true })
      })
      case 'usage': return go({ name: 'settings', page: 'account' })
      case 'wait': return setSettled({ id: view.id })
      case 'switch': return chat && view.switchTo && run(id, 'Could not switch the model', async () => {
        await call('chats.configure', { chatId: chat.id, model: view.switchTo })
        await loadWorkspace(ws.id)
      })
      case 'newChat': return run(id, 'Could not open a tab', async () => {
        // In a Lead chat the tab joins that chat, like + and ⌘T (KERNEL-338).
        const c = await call('chats.create', { workspaceId: ws.id, kind: 'chat', ...(chat?.threadId ? { threadId: chat.threadId } : {}) })
        await loadWorkspace(ws.id)
        focusComposerWhenOpen(c.id)
        actions.ui.openTab(ws.id, c.id)
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
      case 'switchAccount': return view.switchAccount && run(id, 'Could not switch accounts', async () => {
        actions.accounts.set(await call('accounts.switch', { provider: view.switchAccount!.provider, accountId: view.switchAccount!.accountId, reason: 'banner' }))
        if (view.dismissKey) dismissLimitBanner(view.dismissKey)
      })
      // Back to the account the user came from, or the first other one that offers every model agents use. A plain switch, not the banner's at-a-limit one (KERNEL-619).
      case 'switchBack': return view.switchAccount && run(id, 'Could not switch accounts', async () => {
        actions.accounts.set(await call('accounts.switch', { provider: view.switchAccount!.provider, accountId: view.switchAccount!.accountId }))
        if (view.dismissKey) dismissLimitBanner(view.dismissKey)
      })
      case 'models': return go({ name: 'settings', page: 'models' })
      // The provider's own login signs in right here. An added account asks for a code and keeps its name, which its row in Settings, Providers does.
      case 'signInAccount': return view.signIn && (view.signIn.cli
        ? run(id, 'Could not sign in', async () => {
          await call('providers.signIn', { provider: view.signIn!.provider, accountId: view.signIn!.accountId })
          actions.accounts.set(await call('accounts.list', undefined))
          if (view.signIn!.provider === 'claude') actions.account.set(await call('account.get', undefined))
        })
        : go({ name: 'settings', page: 'providers', tab: view.signIn.provider }))
      case 'providers': return go({ name: 'settings', page: 'providers', tab: 'codex' })
      case 'editScript': return go({ name: 'settings', page: 'room', roomId: ws.roomId, section: 'scripts' })
      case 'runAgain': return run(id, 'Could not run setup', async () => {
        actions.ui.setWorkspaceView({ bottom: 'setup' })
        await call('scripts.run', { workspaceId: ws.id, kind: 'setup' })
      })
      case 'review': return actions.ui.openModal({ name: 'confirm', kind: 'trust', roomId: ws.roomId })
      case 'checkHooks': return actions.ui.openModal({ name: 'checkHooks' })
      case 'reconnect': return run(id, 'Could not restart the hook server', async () => actions.system.setHooks(await call('hooks.restart', {})))
      // A chat with Rowan archives with the workspaces it started, the way its row does (KERNEL-405).
      case 'archive': return run(id, `Could not archive ${ws.name}`, async () => {
        const thread = isLeadChatWorkspace(ws) ? getState().threads[ws.threadId!] : undefined
        if (thread) return archiveChatFromSidebar(thread)
        await archiveByHand({ workspaceId: ws.id })
      })
    }
  }

  const sub = mine?.notified ? 'You will get a notification when it resets.' : view.sub
  const shown = mine ? [] : view.actions
  return (
    <Banner
      key={view.dismissKey ?? view.id} kind={view.kind} title={view.title} onDismiss={view.dismissKey ? () => dismissLimitBanner(view.dismissKey!) : undefined}
      actions={shown.length ? <span className="wsb-actions">{shown.map((a) => (
        <Button key={a.id} variant={a.primary ? 'primary' : 'secondary'} className="wsb-btn" busy={busy === a.id} busyLabel={BUSY_LABEL[a.id]} disabled={busy !== null} onClick={() => act(a.id)}>{a.label}</Button>
      ))}</span> : undefined}
    >{sub}</Banner>
  )
}

/**
 * Retry now: send the last message again at once. The waiting retry is interrupted and the copy goes first. The engine
 * sends it with its sender, so a Kernel update sent again is still Kernel's, not the user's (KERNEL-127).
 */
async function retryNow(chatId: string) {
  const items = await call('chats.items', { chatId })
  const user = [...items].reverse().find((i) => i.kind === 'user')
  if (user?.kind !== 'user') return
  await call('chats.retry', { chatId, itemId: user.id, now: true })
  actions.chats.setQueue(chatId, await call('chats.queue', { chatId }))
}
