import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { modelLabelOf, useCodexInUse, useProviderModels } from './composer/providerModels'
import type { ChatPart } from '@shared/types'
import { bypassConfirmed } from '../../bypassConfirm'
import { useModeAvailability } from '../../permissionModes'
import { providerOf } from '@shared/providers'
import { call, cleanError } from '../../api'
import { actions, loadWorkspace, useStore } from '../../store'
import { leadOf, openLeadChat } from '../../lead'
import { leadNewKey } from '../../components/sidebar/slots'
import { Button, Icon, IconButton, useBusy } from '../../ui'
import { briefParts, leadMessage, pickedLines } from '../new-workspace/brief'
import { focusComposerWhenOpen, onComposerFocusAsked, takeComposerFocus } from './composer/bus'
import { BranchPicker, useBaseBranch } from './composer/BranchPicker'
import { DraftInput, useDraft } from './composer/draft'
import { ComposerShell } from './composer/ComposerShell'
import { clearDraft, newChatDraftOf, type DraftPicks } from './composer/draftStore'
import { ModeButton } from './composer/ModeMenu'
import { ModelPicker } from './composer/ModelPicker'
import { cyclePatch, cycleRun, modePatch, nextMode, offLine, shownMode, type ComposerMode, type CycleRun } from './composer/modes'
import { effortLabel, useLeadBox } from './composer/modelPrefs'
import { PlusMenu, type PlusPanel } from './composer/PlusMenu'
import { sendsOn, useSendWith } from './composer/sendKey'
import { WhereRow } from './composer/WhereRow'
import { RoomStatus } from './RoomStatus'
import { UpNext } from './UpNext'

/**
 * New chat when the room has no open chat (KERNEL-366): the title, what the room is doing, a composer and the tracker's
 * issues up next. Sending calls `lead.start`, as the New chat dialog does, so the chat, its own worktree and its sidebar row begin
 * with the first message (KERNEL-405), on a new branch from the one the composer names. The box shares the dialog's room's own draft,
 * so typed text survives leaving the screen and never shows in another room. `focusIn` is the workspace whose focus requests it
 * takes, for the shared Lead workspace from before, else the room's New chat key.
 */
export function NewLeadChat({ roomId, focusIn }: { roomId: string; focusIn?: string }) {
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const name = lead?.name ?? 'Kernel'
  const codexInUse = useCodexInUse()
  const codexModels = useProviderModels('codex')
  const draftKey = newChatDraftOf(roomId)
  // Model, effort and plan mode are the Lead's until picked here, and a pick stays with the room's draft (KERNEL-544).
  const { model, effort, plan, mode, fallback, pickModel, pickEffort, savePick } = useLeadBox(draftKey, lead)
  const [menu, setMenu] = useState<'model' | 'branch' | 'mode' | PlusPanel>(null)
  // The branch picked per room, empty for the default. It lasts until the chat starts.
  const [bases, setBases] = useState<Record<string, string>>({})
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

  /** Sends what is typed. A picked branch goes as the base, and as a line for the Lead, as New workspace sends it. A failed start keeps the text. */
  const start = () => {
    const typed = d.message()
    if (!typed.length) { d.focus(); return }
    const parts = briefParts(typed, null, picked ? pickedLines({ mode: 'worktree', target: base.target, fallback: base.fallback, picked: '' }) : [])
    void run('send', async () => {
      let chat
      try { chat = await call('lead.start', { roomId, ...leadMessage(parts), model, effort, plan, ...(mode ? { mode } : {}), ...(picked ? { baseRef: picked } : {}) }) }
      catch (e) { actions.ui.toast({ title: 'Could not send', sub: cleanError(e) }); return }
      clearDraft(draftKey)
      setBases((b) => ({ ...b, [roomId]: '' }))
      // The message is sent. Landing on it is best effort, since the engine pushes the same workspace and chat.
      try { await loadWorkspace(chat.workspaceId) } catch { /* the push brings it */ }
      actions.chats.upsert(chat)
      focusComposerWhenOpen(chat.id)
      await openLeadChat(roomId, chat.id)
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
            <PlusMenu panel={menu === 'model' || menu === 'branch' || menu === 'mode' ? null : menu} onPanel={setMenu} anchorRef={plusAnchor} roomId={roomId}
              onMode={() => setMenu('mode')} onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
          </span>
          <IconButton className="send" icon="up" size={14} label="Send" busy={busy} busyPattern="arrow-right" busyLabel="Sending" data-ready={hasDraft} onClick={() => start()} />
        </>}
        hidden={<input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />}
        where={<WhereRow room={room} mode="worktree" branch={
          <BranchPicker roomId={roomId} lead={name} picked={picked} open={menu === 'branch'} disabled={busy} onToggle={() => setMenu(menu === 'branch' ? null : 'branch')} onClose={() => setMenu((m) => (m === 'branch' ? null : m))}
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
