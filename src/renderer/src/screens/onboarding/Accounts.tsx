import { useState } from 'react'
import type { AccountProfile, PreflightCheck, Provider } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go, useStore } from '../../store'
import { Button, Icon, ProviderMark, useBusy, type IconName } from '../../ui'
import { AddAccount } from '../settings/pages/AddAccount'
import { Card, Command, StateMark } from './parts'
import type { StepFrame } from './Onboarding'

/** A row with a tile in front, its name over a line, and what is on the right: a state word with a check, or a button. */
function Line({ mark, name, what, note, children, cmd }: { mark: IconName | Provider; name: string; what: string; note?: string; children?: React.ReactNode; cmd?: string }) {
  return (
    <div className="ob-row ob-acct" role="listitem">
      <span className="ob-tile" aria-hidden="true">{mark === 'claude' || mark === 'codex' ? <ProviderMark provider={mark} size={14} /> : <Icon name={mark} size={14} />}</span>
      <span className="ob-body">
        <span className="ob-name">{name}</span>
        <span className="ob-detail">{what}</span>
        {note && <span className="ob-detail ob-note"><Icon name="info" size={12} />{note}</span>}
        {cmd && <Command text={cmd} />}
      </span>
      {children}
    </div>
  )
}

const Done = ({ word }: { word: string }) => <span className="ob-done"><StateMark state="ok" />{word}</span>

const planLine = (a: AccountProfile) => `${a.plan ? `${a.plan.replace(/^Claude /, '')} plan. ` : ''}${a.cli || a.alsoCli ? 'Signed in with Claude Code.' : 'Signed in.'}`

/** Accounts (KERNEL-1088): Claude is required and checked, and the rest is optional and can wait for Settings, Accounts. Kernel never sees a password. */
export function useAccounts(): StepFrame {
  const accounts = useStore((s) => s.accounts)
  const checks = useStore((s) => s.system.preflight)
  const [sheet, setSheet] = useState<Provider | null>(null)
  const [busy, run] = useBusy<'check'>()
  const auth = checks?.find((c) => c.id === 'auth')
  const gh = checks?.find((c) => c.id === 'gh')
  const claude = accounts.filter((a) => a.provider === 'claude' && a.signedIn)
  const codex = accounts.some((a) => a.provider === 'codex' && a.signedIn)
  const recheck = () => run('check', async () => {
    try {
      actions.system.setPreflight(await call('preflight.run', undefined))
      actions.accounts.set(await call('accounts.list', undefined))
    } catch (e) { actions.ui.toast({ title: 'Could not check again', sub: cleanError(e) }) }
  })
  const cloud = auth?.ok && !claude.length ? auth : undefined
  const shown = (c: PreflightCheck) => c.title
  const closeSheet = () => { setSheet(null); void call('accounts.list', undefined).then(actions.accounts.set).catch(() => undefined) }
  return {
    title: 'Accounts',
    sub: 'Agents run on your own plans. Kernel uses the sign-ins already on this Mac and never sees a password.',
    canContinue: !!auth?.ok,
    onContinue: () => go({ name: 'onboarding', step: 'team' }, { history: 'replace' }),
    body: (
      <>
        <Card label="Claude">
          {cloud ? (
            <Line mark="providers" name={shown(cloud)} what={cloud.detail} note={cloud.note?.replaceAll('`', '')}>{cloud.meta && <Done word={cloud.meta} />}</Line>
          ) : claude.length ? claude.map((a, i) => (
            <Line key={a.id} mark="claude" name={claude.length > 1 ? a.label : 'Claude'} what={i > 0 ? `${a.plan ? `${a.plan.replace(/^Claude /, '')} plan. ` : ''}Kernel moves chats here when ${claude[0]!.label} hits its limit.` : planLine(a)}><Done word="Signed in" /></Line>
          )) : (
            <Line mark="claude" name="Claude" what="Agents run on your own Claude plan. Sign in from Terminal, then check again." cmd={auth?.fix?.command ?? 'claude auth login'}>
              <Button size="sm" busy={busy === 'check'} busyLabel="Checking" disabled={busy !== null} onClick={() => void recheck()}>Check again</Button>
            </Line>
          )}
        </Card>
        <p className="ob-cap">Optional. Add these later in Settings, Accounts.</p>
        <Card label="Optional accounts">
          {claude.length === 1 && <Line mark="user" name="A second Claude account" what="When one hits its limit, Kernel moves chats to the other."><Button size="sm" disabled={!!sheet} onClick={() => setSheet('claude')}>Add</Button></Line>}
          <Line mark="codex" name="ChatGPT, for Codex" what="Only needed if a role runs on Codex.">
            {codex ? <Done word="Signed in" /> : <Button size="sm" disabled={!!sheet} onClick={() => setSheet('codex')}>Sign in</Button>}
          </Line>
          <Line mark="branch" name="GitHub" what={gh?.ok ? gh.detail : 'Opens and merges pull requests. Sign in with the GitHub CLI.'} cmd={!gh?.ok ? gh?.fix?.command ?? 'gh auth login' : undefined}>
            {gh?.ok && <Done word="Connected" />}
          </Line>
        </Card>
        {sheet && <AddAccount provider={sheet} onClose={closeSheet} />}
      </>
    )
  }
}
