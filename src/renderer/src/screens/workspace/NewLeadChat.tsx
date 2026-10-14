import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { modelLabelOf, useCodexInUse, useProviderModels } from './composer/providerModels'
import type { ChatPart, IssueTakenFinding, NewChatPicks, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { bypassConfirmed } from '../../bypassConfirm'
import { useModeAvailability } from '../../permissionModes'
import { providerOf } from '@shared/providers'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { leadOf } from '../../lead'
import { leadNewKey } from '../../components/sidebar/slots'
import { Button, Icon, IconButton, useBusy } from '../../ui'
import { briefParts, pickedLines } from '../new-workspace/brief'
import { startChat } from '../new-workspace/start'
import { takenFindings } from '../new-workspace/taken'
import { issueTracker } from './issueKey'
import { onComposerFocusAsked, takeComposerFocus } from './composer/bus'
import { BranchPicker, useBaseBranch } from './composer/BranchPicker'
import { DraftInput, useDraft } from './composer/draft'
import { ComposerShell } from './composer/ComposerShell'
import { moveDraft, newChatDraftOf, type DraftPicks } from './composer/draftStore'
import { ModeButton } from './composer/ModeMenu'
import { ModelPicker } from './composer/ModelPicker'
import { cyclePatch, cycleRun, modePatch, nextMode, offLine, shownMode, type ComposerMode, type CycleRun } from './composer/modes'
import { effortLabel, useLeadBox } from './composer/modelPrefs'
import { PlusMenu, type PlusPanel } from './composer/PlusMenu'
import { sendsOn, useSendWith } from './composer/sendKey'
import { WhereLocalBranch, WhereRow } from './composer/WhereRow'
import { ModePicker, RoomPicker } from './composer/WherePickers'
import { stripRemote } from '../settings/remote'
import { RoomStatus } from './RoomStatus'
import { UpNext } from './UpNext'

/**
 * The New chat page, the one way to start a chat (KERNEL-788): the title, what the room is doing, a composer and the tracker's
 * issues up next. Sending calls `lead.start`, so the chat, its own worktree and its sidebar row begin with the first message
 * (KERNEL-405), on a new branch from the one the composer names. The box keeps the room's own draft, so typed text survives
 * leaving the page and never shows in another room. `focusIn` is the workspace whose focus requests it takes, for the shared Lead
 * workspace from before, else the room's New chat key.
 * A chat that starts from an issue first asks whether someone else is on it (KERNEL-500). `source` arrives as a chip in the box,
 * and `picks` is what the box had chosen when that warning sent the user back.
 */
export function NewLeadChat({ roomId: routeRoom, focusIn, source, picks }: { roomId: string; focusIn?: string; source?: WorkspaceSource; picks?: NewChatPicks }) {
  // The room picked under the box. It starts as the route's, and follows the route when that moves to another room.
  const [roomId, setRoomId] = useState(routeRoom)
  useEffect(() => { setRoomId(routeRoom) }, [routeRoom])
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const name = lead?.name ?? 'Kernel'
  const codexInUse = useCodexInUse()
  const codexModels = useProviderModels('codex')
  const draftKey = newChatDraftOf(roomId)
  // Model, effort and plan mode are the Lead's until picked here, and a pick stays with the room's draft (KERNEL-544).
  const { model, effort, plan, mode, fallback, pickModel, pickEffort, savePick } = useLeadBox(draftKey, lead, picks && { model: picks.model, effort: picks.effort, plan: picks.plan })
  const [menu, setMenu] = useState<'model' | 'branch' | 'mode' | 'room' | 'place' | PlusPanel>(null)
  const plusPanel: PlusPanel = menu === 'plus' || menu === 'linkIssue' || menu === 'linkPr' || menu === 'linkWorkspaces' ? menu : null
  const rooms = useStore((s) => s.rooms)
  // Worktree or Local starts from Settings' workspace mode. Kernel's own chat is a worktree either way (KERNEL-405), so Local only tells Kernel how teammates run.
  const appPlace = useStore((s) => s.settings?.workspace.mode)
  const [placePick, setPlacePick] = useState<WorkspaceMode | undefined>(picks?.mode)
  const place: WorkspaceMode = placePick ?? appPlace ?? 'worktree'
  // The branch picked per room, empty for the default. It lasts until the chat starts.
  const [bases, setBases] = useState<Record<string, string>>(picks?.baseRef ? { [routeRoom]: picks.baseRef } : {})
  const picked = bases[roomId] ?? ''
  const base = useBaseBranch(roomId, picked)
  // Fixtures put text in the box for a shot.
  const forced = useStore((s) => s.ui.workspace.composer)
  const d = useDraft(forced, draftKey)
  const [sending, run] = useBusy()
  const busy = sending !== null
  const filePick = useRef<HTMLInputElement>(null)
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const fits = useFits(topRef, titleRef)
  const provider = providerOf(model)
  const availability = useModeAvailability()
  const roomMode = useStore((s) => s.rooms.find((r) => r.id === roomId)?.permissionMode)
  const appMode = useStore((s) => s.settings?.permissions.mode)
  const shown = shownMode(plan, undefined, mode ?? roomMode ?? appMode ?? 'default')
  const cycle = useRef<CycleRun | null>(null)

  // The sidebar's Lead row, ⌘⇧L, + and ⌘T ask for the caret in the workspace's composer. This box is it while no chat is open.
  const focusAsked = () => { if (takeComposerFocus({ id: '', workspaceId: focusIn ?? leadNewKey(roomId) })) d.focus() }
  useEffect(() => { focusAsked() }, [])
  useEffect(() => onComposerFocusAsked(focusAsked))

  // A source arrives as a chip in the box, once: a chip already there, from the draft or an earlier visit, is the same one.
  const sourceKey = source ? JSON.stringify(source) : ''
  useEffect(() => {
    if (source?.kind !== 'issue' || d.parts.some((p) => p.type === 'issue' && p.name === source.id)) return
    d.insert({ type: 'issue', name: source.id, title: source.title, url: source.url, source: issueTracker(source) })
    d.focus()
  }, [sourceKey])

  // Kernel fetches the room's remote now, so the fetch a send needs is done or under way by then. Nothing waits on it.
  useEffect(() => { void call('lead.prefetch', { roomId }).catch(() => undefined) }, [roomId])

  // The issue in the box starts its check at once and keeps the answer, so a send finds it answered (KERNEL-543). Another issue or room drops it.
  const chip = d.parts.find((p): p is Extract<ChatPart, { type: 'issue' }> => p.type === 'issue')
  const issueKey = chip ? `${roomId}:${chip.name}` : ''
  const taken = useRef<{ key: string; found: Promise<IssueTakenFinding[]> } | null>(null)
  useEffect(() => {
    if (!chip) { taken.current = null; return }
    if (taken.current?.key !== issueKey) taken.current = { key: issueKey, found: takenFindings((req) => call('issues.taken', req), roomId, chip.name) }
  }, [issueKey])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [checking, setChecking] = useState(false)

  /**
   * Whether the issue check held the chat back: it opens the warning, which sends the chat on or brings the page back. Anything the
   * check can't answer, or the user leaving the page meanwhile, leaves nothing held (KERNEL-500).
   */
  const someoneIsOn = async (issue: Extract<ChatPart, { type: 'issue' }>, parts: ChatPart[]) => {
    setChecking(true)
    let found
    // The check started when the chip arrived, and a send waits only for what is left of it.
    const asked = taken.current?.key === `${roomId}:${issue.name}` ? taken.current.found : takenFindings((req) => call('issues.taken', req), roomId, issue.name)
    try { found = await asked }
    finally { setChecking(false) }
    if (!alive.current) return true
    if (!found.length) return false
    if (getState().ui.modal) return true
    const held: WorkspaceSource = { kind: 'issue', id: issue.name, title: issue.title, ...(issue.url ? { url: issue.url } : {}), tracker: issue.source }
    actions.ui.openModal({ name: 'confirm', kind: 'issueTaken', issue: issue.name, findings: found, held: { roomId, source: held, parts, picks: { mode: place, model, effort, plan, baseRef: picked } } })
    return true
  }

  /** Sends what is typed. A picked branch goes as the base, and as a line for the Lead. A failed start keeps the text. */
  const start = () => {
    const typed = d.message()
    if (!typed.length) { d.focus(); return }
    const parts = briefParts(typed, null, pickedLines({ mode: place, target: base.target, fallback: base.fallback, picked: '' }))
    void run('send', async () => {
      const issue = typed.find((p): p is Extract<ChatPart, { type: 'issue' }> => p.type === 'issue')
      if (issue && (await someoneIsOn(issue, parts))) return
      const failed = await startChat({ roomId, parts, model, effort, plan, mode, baseRef: picked && place === 'worktree' ? picked : '' })
      if (failed) { actions.ui.toast({ title: 'Could not send', sub: failed }); return }
      setBases((b) => ({ ...b, [roomId]: '' }))
    })
  }

  /** Up next's Plan: the issue goes in the box as a chip, plan mode turns on, and nothing sends until you do. */
  const planIssue = (part: ChatPart) => {
    d.insert(part)
    if (!plan) pickMode('plan')
    d.focus()
  }

  /** As in a chat: Plan sets `plan` and leaves the picked mode, every other mode sets `mode` and clears plan. Bypass permissions asks once first. */
  const setMode = (next: ComposerMode, patch: (m: ComposerMode) => DraftPicks = modePatch) => {
    if (next === shown.picked) return
    if (next === 'bypassPermissions' && !bypassConfirmed()) { cycle.current = null; setMenu(null); return actions.ui.openModal({ name: 'confirm', kind: 'bypass', draftKey }) }
    savePick(patch(next))
  }
  const pickMode = (next: ComposerMode) => { cycle.current = null; setMode(next) }
  const cycleMode = () => {
    const { before } = (cycle.current = cycleRun(cycle.current, draftKey, mode))
    setMode(nextMode(shown.picked, (m) => !offLine(m, provider, availability)), (m) => cyclePatch(before, m))
  }

  const sendWith = useSendWith()
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (sendsOn(e, sendWith)) { e.preventDefault(); start(); return }
    if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return }
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) cycle.current = null
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click() }
    if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); setMenu('linkIssue') }
  }

  /** Another room: the typed text moves to that room's box, and its status, Up next, model and branch follow. */
  const pickRoom = (id: string) => {
    if (id === roomId) return
    moveDraft(draftKey, newChatDraftOf(id))
    setRoomId(id)
    // The route follows, so the breadcrumb and the sidebar selection name the room the chat will start in. It replaces the entry, so Back still leaves the page.
    const at = getState().ui.route
    if (at.name === 'leadNew') actions.ui.go({ ...at, roomId: id }, { history: 'replace' })
    d.focus()
  }

  const modelLabel = modelLabelOf(model, codexModels)
  const hasDraft = !d.empty
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  return (
    <div className="lead-new">
      <div ref={topRef} className="lead-top">
        <div ref={titleRef} className="lead-title" style={{ visibility: fits ? undefined : 'hidden' }} aria-hidden={fits ? undefined : true}>
          <h2>New chat</h2>
          <RoomStatus roomId={roomId} />
        </div>
      </div>
      <div className="lead-up"><UpNext roomId={roomId} lead={name} onPlan={planIssue} /></div>
      <ComposerShell
        box={{ 'data-plan': plan ? 'true' : undefined, ...d.drop }}
        input={<DraftInput d={d} aria-label={`Message ${name}`} disabled={busy} placeholder={`Brief ${name} on what to build next`} onKeyDown={onKey} />}
        foot={<>
          <span ref={modelAnchor} style={{ position: 'relative' }}>
            <Button variant="ghost" className="cmp-model" disabled={busy} aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{modelLabel}<span className="muted" style={{ fontWeight: 400 }}>{effortLabel(effort)}</span><Icon name="chevron" size={12} /></Button>
            {menu === 'model' && <ModelPicker anchorRef={modelAnchor} provider={providerOf(model)} grouped={codexInUse} model={model} effort={effort} fallback={fallback} onClose={() => setMenu(null)} onModel={(m, x) => { setMenu(null); pickModel(m, x) }} onEffort={pickEffort} />}
          </span>
          <ModeButton provider={providerOf(model)} availability={availability} shown={shown} open={menu === 'mode'} onOpen={(o) => setMenu(o ? 'mode' : null)} onPick={(m) => { setMenu(null); pickMode(m); d.focus() }} onCycle={cycleMode} />
          <span className="grow" />
          <span ref={plusAnchor} style={{ position: 'relative' }}>
            <PlusMenu panel={plusPanel} onPanel={setMenu} anchorRef={plusAnchor} roomId={roomId}
              onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
          </span>
          <IconButton className="send" icon="up" size={14} label="Send" busy={busy} busyPattern="arrow-right" busyLabel={checking ? 'Checking' : 'Sending'} data-ready={hasDraft} onClick={() => start()} />
        </>}
        hidden={<input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />}
        where={<WhereRow room={room} mode={place}
          roomPicker={<RoomPicker rooms={rooms} room={room} open={menu === 'room'} disabled={busy} onToggle={() => setMenu(menu === 'room' ? null : 'room')} onClose={() => setMenu((m) => (m === 'room' ? null : m))} onPick={pickRoom} onNewRoom={() => actions.ui.openModal({ name: 'newRoom' })} />}
          modePicker={<ModePicker mode={place} open={menu === 'place'} disabled={busy} onToggle={() => setMenu(menu === 'place' ? null : 'place')} onClose={() => setMenu((m) => (m === 'place' ? null : m))} onPick={setPlacePick} />}
          branch={place === 'current'
            ? <WhereLocalBranch branch={stripRemote(base.fallback, base.remote)} />
            : <BranchPicker roomId={roomId} picked={picked} open={menu === 'branch'} disabled={busy} onToggle={() => setMenu(menu === 'branch' ? null : 'branch')} onClose={() => setMenu((m) => (m === 'branch' ? null : m))}
              onPick={(ref) => setBases((b) => ({ ...b, [roomId]: ref }))} />
          } />}
      />
    </div>
  )
}

/** Whether the title block fits the space between the header and Up next. It hides, rather than clips, when the box has grown into its room. */
function useFits(topRef: React.RefObject<HTMLElement | null>, titleRef: React.RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const top = topRef.current
    const title = titleRef.current
    if (!top || !title) return
    const measure = () => setFits(top.clientHeight >= title.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(top)
    ro.observe(title)
    return () => ro.disconnect()
  }, [])
  return fits
}
