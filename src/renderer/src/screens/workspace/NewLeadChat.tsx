import { useEffect, useRef, useState } from 'react'
import type { ChatPart, Effort, ModelId } from '@shared/types'
import { MODELS } from '@shared/types'
import { effortFor } from '@shared/effort'
import { call, cleanError } from '../../api'
import { actions, loadWorkspace, useStore } from '../../store'
import { leadOf, openLeadChat } from '../../lead'
import { leadNewKey } from '../../components/sidebar/slots'
import { Button, Icon, IconButton, useBusy } from '../../ui'
import { briefParts, leadMessage } from '../new-workspace/brief'
import { ChatWelcome, LEAD_SUGGESTIONS } from './ChatWelcome'
import { focusComposerWhenOpen, onComposerFocusAsked, takeComposerFocus } from './composer/bus'
import { DraftInput, useDraft } from './composer/draft'
import { newChatDraftOf, saveDraft } from './composer/draftStore'
import { ModelPicker } from './composer/ModelPicker'
import { effortLabel, rememberEffort, useDefaultEffort, useEffortMemory } from './composer/modelPrefs'
import { PlusMenu, type PlusPanel } from './composer/PlusMenu'
import './composer/composer.css'

/**
 * New chat with Rowan when the room has no open chat (NewChat.png, KERNEL-366). The welcome, a composer and the suggestions. Sending calls
 * `lead.start`, as the New chat dialog does, so the chat, its own worktree and its sidebar row begin with the first message (KERNEL-405). The box
 * shares the dialog's room's own draft, so typed text survives leaving the screen and never shows in another room. `focusIn` is the workspace
 * whose focus requests it takes, for the shared Lead workspace from before, else the room's New chat key.
 */
export function NewLeadChat({ roomId, focusIn }: { roomId: string; focusIn?: string }) {
  const settings = useStore((s) => s.settings)
  const lead = useStore((s) => leadOf(s.agents, roomId))
  const name = lead?.name ?? 'Rowan'
  const [model, setModel] = useState<ModelId>(settings?.models.lead ?? 'claude-opus-5-5')
  const memory = useEffortMemory()
  const fallback = useDefaultEffort(lead?.effort)
  const [effort, setEffort] = useState<Effort>(() => effortFor(model, memory, fallback))
  const [plan, setPlan] = useState(settings?.models.leadPlanMode ?? false)
  const [menu, setMenu] = useState<'model' | PlusPanel>(null)
  const draftKey = newChatDraftOf(roomId)
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

  /** Sends `picked` (a suggestion), or what is typed. A failed start keeps the typed text. */
  const start = (picked?: ChatPart[]) => {
    const parts = picked ?? d.message()
    if (!parts.length) { d.focus(); return }
    void run('send', async () => {
      let chat
      try { chat = await call('lead.start', { roomId, ...leadMessage(briefParts(parts, null, [])), model, effort, plan }) }
      catch (e) { actions.ui.toast({ title: 'Could not send', sub: cleanError(e) }); return }
      if (!picked) saveDraft(draftKey, [], '')
      // The message is sent. Landing on it is best effort, since the engine pushes the same workspace and chat.
      try { await loadWorkspace(chat.workspaceId) } catch { /* the push brings it */ }
      actions.chats.upsert(chat)
      focusComposerWhenOpen(chat.id)
      await openLeadChat(roomId, chat.id)
    })
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start() }
    else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); setPlan((p) => !p) }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); filePick.current?.click() }
    else if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); setMenu('linkIssue') }
  }

  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model
  const hasDraft = !d.empty
  return (
    <ChatWelcome title={`New chat with ${name}`} sub="Its own worktree and branch, from the latest main." suggestions={LEAD_SUGGESTIONS} onPick={(text) => { if (!busy) start([{ type: 'text', text }]) }}>
      <div className="chat-empty-box">
        <div className="composer cmp" data-plan={plan || undefined} {...d.drop}>
          <DraftInput d={d} aria-label={`Message ${name}`} disabled={busy} placeholder={`Ask ${name} to plan work, check on the team, or run /skills`} onKeyDown={onKey} />
          <div className="row cmp-foot">
            <span className="cmp-agent"><span className="cmp-name">{name}</span><span className="muted cmp-role">{lead?.role}</span></span>
            <span ref={modelAnchor} style={{ position: 'relative' }}>
              <Button variant="ghost" className="cmp-model" disabled={busy} aria-haspopup="dialog" aria-expanded={menu === 'model'} onClick={() => setMenu(menu === 'model' ? null : 'model')}>{modelLabel}<span className="muted" style={{ fontWeight: 400 }}>{effortLabel(effort)}</span><Icon name="chevron" size={11} stroke={1.9} /></Button>
              {menu === 'model' && <ModelPicker anchorRef={modelAnchor} model={model} effort={effort} fallback={fallback} onClose={() => setMenu(null)} onModel={(m, x) => { setMenu(null); setModel(m); setEffort(x) }} onEffort={(x) => { rememberEffort(model, x); setEffort(x) }} />}
            </span>
            <span className="grow" />
            <span ref={plusAnchor} style={{ position: 'relative' }}>
              <PlusMenu panel={menu === 'model' ? null : menu} onPanel={setMenu} anchorRef={plusAnchor} roomId={roomId} plan={plan} onPlan={() => { setPlan((p) => !p); setMenu(null) }}
                onAttach={() => filePick.current?.click()} onInsert={(parts) => { for (const p of parts) d.insert(p); d.focus() }} />
            </span>
            <IconButton className="send" icon="up" size={14} label="Send" busy={busy} busyLabel="Sending" data-ready={hasDraft} onClick={() => start()} />
          </div>
        </div>
        <input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>
    </ChatWelcome>
  )
}
