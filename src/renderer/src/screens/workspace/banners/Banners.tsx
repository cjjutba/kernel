import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Chat, ScriptLine, Workspace } from '@shared/types'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { call } from '../../../api'
import { isLeadWorkspace, leadOf } from '../../../lead'
import { actions, getState, go, loadWorkspace, useStore } from '../../../store'
import { archiveChatFromSidebar } from '../archiveChat'
import { archiveByHand } from '../byHand'
import { Button, Icon, IconButton, useBusy, type IconName } from '../../../ui'
import { useSwipeDismiss } from '../../../ui/useSwipeDismiss'
import { attempt } from '../MessageActions'
import { commandComposer, focusComposerWhenOpen } from '../composer/bus'
import { bannerFor, type BannerAction, type BannerId, type BannerView } from './model'
import { chatProvider } from '@shared/providers'
import { useCodexInUse } from '../composer/providerModels'
import { dismissLimitBanner, useLimitDismissed } from './limitDismissed'
import { retryNow } from './retryNow'
import './banners.css'

/** What a banner button says while its call runs. Actions that only move focus or open a screen have none. */
const BUSY_LABEL: Partial<Record<BannerAction, string>> = {
  notify: 'Setting up', switch: 'Switching', newChat: 'Starting', compact: 'Compacting', retryNow: 'Retrying',
  tryAgain: 'Checking', terminal: 'Opening', signIn: 'Signing in', reconnect: 'Reconnecting', archive: 'Archiving', switchAccount: 'Switching', switchBack: 'Switching', signInAccount: 'Signing in'
}

/**
 * The banner this workspace shows right now, from the store. Ticks once a second while a retry counts down, and redraws at
 * local midnight so a reset time read as "tomorrow" becomes "at 4:00 AM". Midnight changes only the wording, never a status.
 */
export function useBanner(ws: Workspace | undefined, chat: Chat | undefined, agentName: string, running: boolean): BannerView | null {
  const usage = useStore((s) => s.usage)
  const account = useStore((s) => s.account)
  const accounts = useStore((s) => s.accounts)
  const codexInUse = useCodexInUse(chat ? chatProvider(chat) : undefined)
  const online = useStore((s) => s.system.online)
  const hooks = useStore((s) => s.system.hooks)
  const retry = useStore((s) => (chat ? s.retry[chat.id] : undefined))
  // The near-limit hold leaves the Lead alone, and its banner names the Lead (KERNEL-224).
  const isLead = useStore((s) => !!ws && isLeadWorkspace(ws, ws.projectId, leadOf(s.agents, ws.projectId)?.id))
  const leadName = useStore((s) => (ws ? leadOf(s.agents, ws.projectId)?.name : undefined))
  const pauseNearLimit = useStore((s) => s.settings?.usage.pauseNearLimit)
  const warnBeforeWeekly = useStore((s) => s.settings?.usage.warnBeforeWeekly)
  const switchAtLimit = useStore((s) => s.settings?.accounts.switchAtLimit[chat ? chatProvider(chat) : 'claude'])
  const keepChats = useStore((s) => s.settings?.accounts.keepChatsOnAccount)
  const dismissed = useLimitDismissed()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!retry) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [retry])
  const [, setDay] = useState(0)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const arm = () => {
      const midnight = new Date().setHours(24, 0, 0, 0)
      t = setTimeout(() => { setDay((d) => d + 1); arm() }, midnight - Date.now())
    }
    arm()
    return () => clearTimeout(t)
  }, [])
  if (!ws) return null
  return bannerFor({ ws, chat, agentName, running, usage, account, accounts, codexInUse, online, hooks, retry, isLead, leadName, dismissed, switchAtLimit, keepChats, usageSettings: { pauseNearLimit, warnBeforeWeekly }, now: retry ? now : Date.now() })
}

/**
 * The failure banner above the composer (WorkspaceSessionLimit.png and the eight screens after it). Each action is a
 * real recovery path: Notify me, Switch model, Compact, Sign in, Run again and Reconnect all call main.
 */
export function WorkspaceBanner({ view, ws, chat }: { view: BannerView; ws: Workspace; chat?: Chat }) {
  const [busy, track] = useBusy<BannerAction>()
  const switching = useStore((s) => s.ui.switching ?? null)
  const switchingHere = switching !== null && switching.provider === view.switchAccount?.provider && switching.accountId === view.switchAccount.accountId
  // "Notify me" and "Wait" settle the banner without clearing it, as the canvas does. Keyed by banner, so a new one starts fresh.
  const [settled, setSettled] = useState<{ id: string; notified?: boolean } | null>(null)
  const mine = settled?.id === view.id ? settled : null
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
      case 'usage': return go({ name: 'settings', page: 'accounts' })
      case 'dismiss': return view.dismissKey && dismissLimitBanner(view.dismissKey)
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
        const key = view.dismissKey
        await actions.accounts.requestSwitch(view.switchAccount!.provider, view.switchAccount!.accountId, { reason: 'banner', onSwitched: () => { if (key) dismissLimitBanner(key) } })
      })
      // Back to the account the user came from, or the first other one that offers every model agents use. A plain switch, not the banner's at-a-limit one (KERNEL-619).
      case 'switchBack': return view.switchAccount && run(id, 'Could not switch accounts', async () => {
        const key = view.dismissKey
        await actions.accounts.requestSwitch(view.switchAccount!.provider, view.switchAccount!.accountId, { onSwitched: () => { if (key) dismissLimitBanner(key) } })
      })
      case 'models': return go({ name: 'settings', page: 'models' })
      // The provider's own login signs in right here. An added account asks for a code and keeps its name, which its row in Settings, Providers does.
      case 'signInAccount': return view.signIn && (view.signIn.cli
        ? run(id, 'Could not sign in', async () => {
          await call('providers.signIn', { provider: view.signIn!.provider, accountId: view.signIn!.accountId })
          actions.accounts.set(await call('accounts.list', undefined))
          if (view.signIn!.provider === 'claude') actions.account.set(await call('account.get', undefined))
        })
        : go({ name: 'settings', page: 'accounts', tab: view.signIn.provider }))
      case 'providers': return go({ name: 'settings', page: 'accounts', tab: chat ? chatProvider(chat) : 'claude' })
      case 'checkHooks': return actions.ui.openModal({ name: 'checkHooks' })
      case 'reconnect': return run(id, 'Could not restart the hook server', async () => actions.system.setHooks(await call('hooks.restart', {})))
      // A Lead chat archives with the workspaces it started, the way its row does (KERNEL-405).
      case 'archive': return run(id, `Could not archive ${ws.name}`, async () => {
        const thread = isLeadChatWorkspace(ws) ? getState().threads[ws.threadId!] : undefined
        if (thread) return archiveChatFromSidebar(thread)
        await archiveByHand({ workspaceId: ws.id })
      })
    }
  }

  const sub = mine?.notified ? 'You will get a notification when it resets.' : view.sub
  const shown = mine ? [] : view.actions
  const dismiss = view.dismissKey ? () => dismissLimitBanner(view.dismissKey!) : undefined
  return (
    <LimitBanner
      key={view.dismissKey ?? view.id} view={view} title={view.title} onDismiss={dismiss}
      actions={shown.length ? <span className="wsb-actions">{shown.map((a) => (
        <Button key={a.id} variant={a.primary ? 'primary' : 'secondary'} className="wsb-btn" busy={busy === a.id || (switchingHere && (a.id === 'switchAccount' || a.id === 'switchBack'))} busyLabel={BUSY_LABEL[a.id]} disabled={busy !== null || (switching !== null && (a.id === 'switchAccount' || a.id === 'switchBack'))} onClick={() => act(a.id)}>{a.label}</Button>
      ))}</span> : undefined}
    >{sub}</LimitBanner>
  )
}

/** The glyph in front of a banner: what it is about, never a status color. */
const GLYPH: Partial<Record<BannerId, IconName>> = {
  session: 'gauge', weekly: 'calendarX', model: 'burst', accountNearLimit: 'gauge', nearLimit: 'gauge', weeklyWarn: 'calendarClock', switchWarning: 'warning', context: 'circleGauge'
}

/**
 * The banner above the composer (Pen 14.4 and 14.7): a `surface` card with a 28px glyph tile, a title, one line under it and the choice as buttons. A limit that stops work and has nowhere to go
 * wears the red `del-fill` on its glyph, one with a choice offered the amber `needs-fill`, and everything else the quiet ink. It is never a red background. A banner with a `dismissKey` closes with
 * a drag or swipe to the right, as a toast does.
 */
function LimitBanner({ view, title, children, actions, onDismiss }: { view: BannerView; title: string; children?: ReactNode; actions?: ReactNode; onDismiss?: () => void }) {
  const { ref, leaving, leave, handlers } = useSwipeDismiss<HTMLDivElement>(onDismiss)
  const hard = view.id === 'session' || view.id === 'weekly'
  const tone = hard ? (view.switchAccount || view.signIn ? 'needs' : 'del') : undefined
  return (
    <div role="alert" className="banner lb" data-kind={view.kind} data-dismissible={onDismiss ? '' : undefined} data-leaving={leaving || undefined} ref={ref} {...handlers}>
      <span className="lb-glyph" data-tone={tone} aria-hidden="true"><Icon name={GLYPH[view.id] ?? 'warning'} size={14} /></span>
      <div className="grow"><div className="banner-title">{title}</div>{children && <div className="lb-sub">{children}</div>}</div>
      {actions}
      {onDismiss && <IconButton className="banner-close" icon="close" label="Dismiss" size={12} onClick={leave} />}
    </div>
  )
}

/**
 * Provider, network and Mac errors are a toast, raised when the condition starts (Pen 14.7), and again when a chat shows it afresh. Its `key` names the condition, so a chat tab that
 * changes under the same condition doesn't raise it twice, and neither does a render that runs an effect twice. The composer's placeholder says why a message can't go, so the toast can leave.
 */
export function useProblemToast(view: BannerView | null | undefined) {
  const key = view?.toast?.key
  // A condition that changes while its toast is still up (the account loads, then the accounts) replaces it, so one problem never shows two toasts.
  const shown = useRef<string | undefined>(undefined)
  useEffect(() => {
    const t = view?.toast
    if (!t) return
    if (getState().ui.toasts.some((x) => x.title === t.title && x.sub === t.sub)) return
    if (shown.current) actions.ui.dismissToast(shown.current)
    const [action, other] = [...t.actions].reverse()
    shown.current = actions.ui.toast({ title: t.title, sub: t.sub, glyph: 'error', ...(action ? { action } : {}), ...(other ? { other } : {}) })
  }, [key])
}
