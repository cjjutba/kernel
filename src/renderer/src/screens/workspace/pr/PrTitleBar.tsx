import type { Workspace } from '@shared/types'
import { isLeadChatWorkspace, onSharedFolder } from '@shared/leadWorkspace'
import { leadModeOf } from '@shared/leadMode'
import { call } from '../../../api'
import { Button, Icon, Spinner } from '../../../ui'
import { attempt } from '../MessageActions'
import { busyLabel, type PrAction } from './model'
import { reviewStages, type PrButton, type PrButtonId } from './prStage'
import { usePrActions, usePrFacts } from './usePr'
import './pr.css'

/** The action each button starts, so the one pressed spins and says its word. */
const STARTS: Partial<Record<PrButtonId, PrAction>> = { create: 'create', ready: 'ready', fix: 'resolve', review: 'resolve', resolve: 'resolve', merge: 'merge', update: 'update', reopen: 'reopen' }

/** The one action of a pull request, in the title bar and at the head of the Pull request tab. It spins in its word while it runs, and the rest of the pull request waits. */
export function PrActionButton({ button: b, run }: { button: PrButton; run: ReturnType<typeof usePrActions> }) {
  const pressed = run.busy
  const starts = STARTS[b.id]
  const busy = b.busy ?? (pressed && starts && busyLabel[starts] === pressed ? b.label : undefined)
  return <Button variant={b.tone === 'merge' ? 'merge' : b.tone === 'ink' ? 'primary' : 'secondary'} busy={!!busy} busyLabel={busy} disabled={!!pressed && !busy} data-tip={b.tip} onClick={() => run.press(b.id)}>{b.label}</Button>
}

/**
 * Where the pull request stands while the Session rail is hidden (Pen 10.3, 10.10): an icon, its number, a few words and the one action that matters now. The rail holds
 * every state and every button, so this is the same stage in one line. A branch with no pull request says so beside Create PR, and a merged one says Merged and nothing else.
 */
export function PrTitleBar({ ws }: { ws: Workspace }) {
  const facts = usePrFacts(ws)
  const { title } = reviewStages(ws, facts, true)
  const run = usePrActions(ws, { key: title?.button?.id, archivable: ws.prState === 'merged' || ws.prState === 'closed' })
  // A Lead chat on the shared folder has no working copy to open a pull request from yet, and says when it will (KERNEL-405).
  if (onSharedFolder(ws)) {
    const reason = ws.leadMode === 'build' ? 'Create PR is off until this chat has its working copy, made when you send your next message.' : 'Create PR is off until this chat switches to Build here and has a working copy of its own.'
    return <span className="pr-t" data-tone="idle" role="group" aria-label="Pull request"><span className="pr-t-words">No pull request yet</span><Button variant="secondary" disabled data-tip={reason}>Create PR</Button></span>
  }
  // A chat with Kernel in Build here stays open after its pull request merges, and its next change starts a new branch from main (KERNEL-780).
  if (ws.prState === 'merged' && isLeadChatWorkspace(ws) && leadModeOf(ws) === 'build') {
    return <span className="pr-t" data-tone="merged" role="group" aria-label="Pull request"><span className="pr-t-ico"><Icon name="merged" size={14} /></span><span className="pr-t-words">PR #{ws.prNumber} merged</span><span className="pr-t-num">The next change starts a new branch from main.</span></span>
  }
  if (!title) return null
  const url = ws.prUrl
  // No number yet: the words stand alone beside the action, as a branch with nothing to open says it.
  const lead = ws.prNumber ? (
    <>
      <span className="pr-t-ico">{title.spin ? <Spinner label={null} pattern="checker" /> : <Icon name={title.glyph === 'close' ? 'close' : title.glyph} size={14} />}</span>
      {url
        ? <button type="button" className="pr-t-num mono" aria-label={`Open PR ${ws.prNumber} on GitHub`} onClick={() => void attempt('Could not open GitHub', () => call('system.openExternal', { url }))}>#{ws.prNumber}</button>
        : <span className="pr-t-num mono">#{ws.prNumber}</span>}
    </>
  ) : title.spin ? <span className="pr-t-ico"><Spinner label={null} pattern="checker" /></span> : null
  return (
    <span className="pr-t" data-tone={title.tone} role="group" aria-label="Pull request">
      {lead}
      <span className="pr-t-words">{title.words}</span>
      {title.button && <PrActionButton button={title.button} run={run} />}
    </span>
  )
}
