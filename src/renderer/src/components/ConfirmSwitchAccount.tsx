import { useEffect, useId } from 'react'
import type { MovePreview, Provider } from '@shared/types'
import { accountLabel, dollars, kTokens } from '../accountChats'
import { cleanError } from '../api'
import { actions, useStore } from '../store'
import { Button, Modal, useBusy } from '../ui'
import './confirmSwitchAccount.css'

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * Before a switch makes long chats read their history again on another account (SwitchAccountConfirm.png, KERNEL-845). Keeping
 * chats on their account is the default, so the primary button is the safe one. Every switch entry point opens it through
 * `actions.accounts.requestSwitch`.
 */
export function ConfirmSwitchAccount({ provider, accountId, preview, reason, onSwitched }: { provider: Provider; accountId: string; preview: MovePreview; reason?: 'banner'; onSwitched?: () => void }) {
  const id = useId()
  const accounts = useStore((s) => s.accounts)
  const policyKeeps = useStore((s) => s.settings?.accounts.keepChatsOnAccount ?? true)
  // From the limit banner the account being left can't run the chats, so Kernel moves them whatever the policy says.
  const atLimit = reason === 'banner'
  const keeps = policyKeeps && !atLimit
  const [busy, run] = useBusy<'keep' | 'all'>()
  // The modal focuses its first button once it mounts, which is Cancel. Keeping chats is the default, so it takes the focus after.
  useEffect(() => { queueMicrotask(() => document.getElementById(`${id}k`)?.focus()) }, [id])
  const chats = preview.chats.filter((c) => c.coldReason)
  const from = accountLabel(accounts, provider, preview.from)
  const to = accountLabel(accounts, provider, accountId)
  const tokens = chats.reduce((n, c) => n + c.tokens, 0)
  const priced = chats.filter((c) => c.price !== undefined)
  const price = priced.reduce((n, c) => n + (c.price ?? 0), 0)
  const go = (move: 'keep' | 'all') => run(move, async () => {
    try {
      await actions.accounts.confirmSwitch(provider, accountId, move, reason, onSwitched)
      actions.ui.closeModal()
    } catch (e) { actions.ui.toast({ title: 'Could not switch accounts', sub: cleanError(e) }) }
  })
  return (
    <Modal
      title={`Switch to ${to}?`} onClose={actions.ui.closeModal} width={520} top={160} bare role="alertdialog" labelledBy={`${id}t`} describedBy={`${id}b`}
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" size="lg" data-dismiss disabled={busy !== null}>Cancel</Button>
          <Button variant={keeps ? 'secondary' : 'primary'} size="lg" id={keeps ? undefined : `${id}k`} busy={busy === 'all'} busyLabel="Moving" disabled={busy !== null} onClick={() => void go('all')}>Move all chats now</Button>
          {keeps && <Button variant="primary" size="lg" id={`${id}k`} busy={busy === 'keep'} busyLabel="Switching" busyPattern="wave-back" disabled={busy !== null} onClick={() => void go('keep')}>Keep chats on {from}</Button>}
        </>
      }
    >
      <div className="confirm-body">
        <h2 id={`${id}t`}>Switch to {to}?</h2>
        <p id={`${id}b`}>
          {chats.length} {plural(chats.length, 'chat will', 'chats will')} re-read {plural(chats.length, 'its', 'their')} history on {to}, about {kTokens(tokens)} tokens.
          {' '}{keeps
            ? `Keeping ${plural(chats.length, 'it', 'them')} on ${from} reads nothing again, and only new chats start on ${to}.`
            : atLimit ? `${from} hit its limit and can't run ${plural(chats.length, 'it', 'them')}, so ${plural(chats.length, 'it moves', 'they move')} and follow${plural(chats.length, 's', '')} the policy in Settings, Accounts.` : 'Keep chats on their account is off in Settings, Accounts, so every chat moves.'}
        </p>
        {priced.length > 0 && <p className="ssa-price">On this API key, reading {plural(priced.length, 'it', 'them')} once costs about {dollars(price)}.</p>}
        <ul className="ssa-list" aria-label="Chats that would move">
          {chats.map((c) => (
            <li key={c.chatId} className="ssa-chat">
              <span className="ssa-title ellipsis">{c.title}</span>
              <span className="ssa-size">{c.estimated ? 'about ' : ''}{kTokens(c.tokens)} tokens{c.price !== undefined ? ` · ${dollars(c.price)}` : ''}</span>
              <span className="ssa-where ellipsis">{c.workspace}</span>
              {(c.running || !c.fits) && (
                <span className="ssa-note">{[c.running ? `Finishes its turn on ${from} first` : '', !c.fits ? `Too big for ${to}, summarized first` : ''].filter(Boolean).join('. ')}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
