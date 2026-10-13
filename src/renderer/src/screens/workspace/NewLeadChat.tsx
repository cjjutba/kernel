import { useEffect, useRef, useState } from 'react'
import { modelLabelOf, useCodexInUse, useProviderModels } from './composer/providerModels'
import type { ChatPart } from '@shared/types'
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
import { clearDraft, newChatDraftOf } from './composer/draftStore'
import { ModelPicker } from './composer/ModelPicker'
import { effortLabel, useLeadBox } from './composer/modelPrefs'
import { PlusMenu, type PlusPanel } from './composer/PlusMenu'
import { sendsOn, useSendWith } from './composer/sendKey'
import { RoomStatus } from './RoomStatus'
import { UpNext } from './UpNext'
import './composer/composer.css'

/**
 * New chat with Rowan when the room has no open chat (KERNEL-366): the title, what the room is doing, a composer and the tracker's
 * issues up next. Sending calls `lead.start`, as the New chat dialog does, so the chat, its own worktree and its sidebar row begin
 * with the first message (KERNEL-405), on a new branch from the one the composer names. The box shares the dialog's room's own draft,
 * so typed text survives leaving the screen and never shows in another room. `focusIn` is the workspace whose focus requests it
 * takes, for the shared Lead workspace from before, else the room's New chat key.
 */
export function NewLeadChat({ roomId, focusIn }: { roomId: string; focusIn?: string }) {
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const name = lead?.name ?? 'Rowan'
  const codexInUse = useCodexInUse()
  const codexModels = useProviderModels('codex')
  const draftKey = newChatDraftOf(roomId)
  // Model, effort and plan mode are the Lead's until picked here, and a pick stays with the room's draft (KERNEL-544).
  const { model, effort, plan, fallback, pickModel, pickEffort, togglePlan } = useLeadBox(draftKey, lead)
  const [menu, setMenu] = useState<'model' | 'branch' | PlusPanel>(null)
  // The branch picked per room, empty for the default. It lasts until the chat starts.
  const [bases, setBases] = useState<Record<string, string>>({})
  const picked = bases[roomId] ?? ''
  const base = useBaseBranch(roomId, picked)
  const d = useDraft(undefined, draftKey)
  const [sending, run] = useBusy()
  const busy = sending !== null
  const filePick = useRef<HTMLInputElement>(null)
  const modelAnchor = useRef<HTMLSpanElement>(null)
  const plusAnchor = useRef<HTMLSpanElement>(null)

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
      try { chat = await call('lead.start', { roomId, ...leadMessage(parts), model, effort, plan, ...(picked ? { baseRef: picked } : {}) }) }
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
    if (!plan) togglePlan()
    d.focus()
  }

  const sendWith = useSendWith()
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (sendsOn(e, sendWith)) { e.preventDefault(); start() }
    else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); togglePlan() }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click() }
    else if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); setMenu('linkIssue') }
  }

  const modelLabel = modelLabelOf(model, codexModels)
  const hasDraft = !d.empty
  return (
    <div className="chat-empty lead-new">
      <h2>New chat with {name}</h2>
      <RoomStatus roomId={roomId} />
      <div className="chat-empty-box">
        <div className="composer cmp" data-plan={plan || undefined} {...d.drop}>
          <DraftInput d={d} aria-label={`Message ${name}`} disabled={busy} placeholder={`Brief ${name} on what to build next`} onKeyDown={onKey} />
          <div className="row cmp-foot">
            <span className="cmp-agent"><span className="cmp-name">{name}</span><span className="muted cmp-role">{lead?.role}</span></span>
            <span ref={modelAnchor} className="relative">
              <Button variant="ghost" className="cmp-model" disabled={busy} aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{modelLabel}<span className="muted fw-regular">{effortLabel(effort)}</span><Icon name="chevron" size={12} /></Button>
              {menu === 'model' && <ModelPicker anchorRef={modelAnchor} provider={providerOf(model)} grouped={codexInUse} model={model} effort={effort} fallback={fallback} onClose={() => setMenu(null)} onModel={(m, x) => { setMenu(null); pickModel(m, x) }} onEffort={pickEffort} />}
            </span>
            <BranchPicker roomId={roomId} lead={name} picked={picked} open={menu === 'branch'} disabled={busy} onToggle={() => setMenu(menu === 'branch' ? null : 'branch')} onClose={() => setMenu((m) => (m === 'branch' ? null : m))}
              onPick={(ref) => setBases((b) => ({ ...b, [roomId]: ref }))} />
            <span className="grow" />
            <span ref={plusAnchor} className="relative">
              <PlusMenu panel={menu === 'model' || menu === 'branch' ? null : menu} onPanel={setMenu} anchorRef={plusAnchor} roomId={roomId} plan={plan} onPlan={() => { togglePlan(); setMenu(null) }}
                onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
            </span>
            <IconButton className="send" icon="up" size={14} label="Send" busy={busy} busyLabel="Sending" data-ready={hasDraft} onClick={() => start()} />
          </div>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
      <UpNext roomId={roomId} lead={name} onPlan={planIssue} />
    </div>
  )
}
