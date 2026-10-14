import type { ChangedFile, Chat, ChatItem, Workspace } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'
import { isSentItem } from '@shared/approvalAnswer'
import { newId } from '../db'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { checkpointTitle, clock, listCheckpoints, previewRevert, revertTo, snapshotWithFiles } from '../services/checkpoints'
import { Feature } from './feature'

/** The saves Kernel takes of a workspace after each turn, and going back to one (KERNEL-325). */
export class Checkpoints extends Feature {
  /** Checkpoints being taken, by workspace, so a worktree folder that moves waits for them (KERNEL-424). */
  private taking = new Map<string, Set<Promise<unknown>>>()
  /** Start checkpoints whose chat had no message yet when they were taken, by chat, linked at its first turn's end (KERNEL-764). */
  private starts = new Map<string, string>()

  /** Once the checkpoints being taken of the workspace are saved or failed. */
  async settled(workspaceId: string) {
    for (let now = this.taking.get(workspaceId); now?.size; now = this.taking.get(workspaceId)) await Promise.allSettled([...now])
  }

  /** Save the worktree after a turn, titled with the prompt that started the turn. */
  checkpoint(ws: Workspace, chat: Chat) {
    const run = this.take(ws, chat)
    const set = this.taking.get(ws.id) ?? new Set()
    this.taking.set(ws.id, set.add(run))
    void run.catch(() => undefined).finally(() => { set.delete(run); if (!set.size && this.taking.get(ws.id) === set) this.taking.delete(ws.id) })
    return run
  }

  private async take(ws: Workspace, chat: Chat) {
    const items = this.store.items(chat.id)
    // Found as the turn ends, since the chat's next turn may have ended too by the time the save is done (KERNEL-584).
    const result = turnResult(items)
    // A first turn that carried several messages is titled for the one that started it, the brief (KERNEL-393).
    const user = this.sessions.turnRow(chat.id) ?? [...items].reverse().find(isSentItem)
    // A turn Kernel's team update started is titled for what it is, not for the update's first line (KERNEL-116).
    const text = user?.kind !== 'user' ? '' : isKernelUpdate(user) ? 'Team update' : user.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'skill' ? `/${p.name}` : p.name)).join(' ')
    const { checkpoint: c, files } = await snapshotWithFiles(ws, { chatId: chat.id, title: text || chat.title })
    bus.push({ type: 'checkpoint', checkpoint: c })
    if (result) this.putTurn(chat.id, result.id, c.id, files)
    const start = this.starts.get(chat.id)
    if (start) this.linkStart(chat.id, start)
    return c
  }

  /**
   * The turn's checkpoint and the files it changed go on its result row, which keeps its place, so the reply shows them under it
   * and can revert to it (D-029, KERNEL-584, KERNEL-764). A turn that changed nothing gets the checkpoint alone.
   */
  private putTurn(chatId: string, resultId: string, checkpointId: string, files: ChangedFile[]) {
    // A chat cleared meanwhile has lost the row, and saving it would bring it back.
    const row = this.store.items(chatId).find((i) => i.id === resultId)
    if (row?.kind !== 'result') return
    this.putItem(chatId, { ...row, checkpointId, ...(files.length ? { files } : {}) })
  }

  /**
   * The start checkpoint goes on the chat's first message (KERNEL-764). A brief that hasn't gone out yet, as one held by a limit,
   * gets it when its turn ends.
   */
  linkStart(chatId: string, checkpointId: string) {
    const row = this.store.items(chatId).find((i) => i.kind === 'user')
    if (row?.kind !== 'user') { this.starts.set(chatId, checkpointId); return }
    this.starts.delete(chatId)
    if (!row.checkpointId) this.putItem(chatId, { ...row, checkpointId })
  }

  private putItem(chatId: string, item: ChatItem) {
    this.store.saveItem(chatId, item)
    bus.push({ type: 'chat.item', chatId, item })
  }

  /**
   * The note a chat's next turn starts with after its files were reverted, taken so it goes once (KERNEL-764). Kept in the store,
   * so a restart in between still sends it.
   */
  turnNote(chatId: string): string | undefined {
    const notes = this.store.meta<Record<string, string>>(REVERT_NOTES) ?? {}
    const note = notes[chatId]
    if (note === undefined) return undefined
    delete notes[chatId]
    this.store.saveMeta(REVERT_NOTES, notes)
    return note
  }

  /** Restore a workspace's files to a checkpoint. Later changes go to a backup branch, and the chat gets a note saying so. */
  private async revertCheckpoint(workspaceId: string, checkpointId: string): Promise<{ backupBranch: string }> {
    const ws = this.mustWs(workspaceId)
    // Current-branch workspaces share the checkout with the Lead and each other, so any agent working in the same folder blocks a revert.
    const sharing = this.store.workspaces().filter((w) => w.path === ws.path && w.status !== 'archived')
    if (sharing.some((w) => this.store.chats(w.id).some((c) => this.sessions.isRunning(c.id)))) throw new Error('An agent is still working in this workspace. Stop it, then revert.')
    const r = await revertTo(ws, checkpointId)
    bus.push({ type: 'checkpoint', checkpoint: r.checkpoint })
    const time = clock(r.checkpoint.ts)
    // Every agent working in the folder has the old files in mind, so each chat's next turn is told, once.
    const told = sharing.flatMap((w) => this.store.chats(w.id)).filter((c) => c.kind !== 'terminal')
    const notes = this.store.meta<Record<string, string>>(REVERT_NOTES) ?? {}
    for (const c of told) notes[c.id] = revertNote(time)
    this.store.saveMeta(REVERT_NOTES, notes)
    const tabs = this.chatTabs(ws.id).filter((c) => c.kind !== 'terminal')
    const chat = tabs.find((c) => c.id === r.checkpoint.chatId) ?? tabs[0]
    const what = r.checkpoint.start ? 'the start of the chat' : `${time}, "${checkpointTitle(r.checkpoint.title)}"`
    if (chat) {
      const item: ChatItem = { kind: 'note', id: newId(), ts: Date.now(), text: `Reverted files to ${what}. Later changes are saved on ${r.backupBranch}.` }
      this.store.saveItem(chat.id, item)
      bus.push({ type: 'chat.item', chatId: chat.id, item })
    }
    bus.activity({ kind: 'checkpoint.reverted', actor: 'you', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: `reverted files to ${time} in`, object: ws.name, data: { backupBranch: r.backupBranch } })
    return { backupBranch: r.backupBranch }
  }

  handlers() {
    return {
      // A Lead chat whose worktree isn't made yet has none (KERNEL-542).
      'checkpoints.list': async ({ workspaceId }) => { const ws = this.mustWs(workspaceId); return ws.worktreePending ? [] : listCheckpoints(ws) },
      'checkpoints.preview': async ({ workspaceId, checkpointId }) => previewRevert(this.mustWs(workspaceId), checkpointId),
      'checkpoints.revert': async ({ workspaceId, checkpointId }) => this.revertCheckpoint(workspaceId, checkpointId)
    } satisfies Partial<Handlers>
  }
}

const REVERT_NOTES = 'revertNotes'

/** What the agent reads at the start of its next turn after a revert (KERNEL-764). */
export const revertNote = (time: string) => `Files were reverted to ${time}. Re-read files before editing.`

/** The result row of the turn that just ended. A stopped turn writes none, so reaching its message or its Interrupted row first means there is none. */
function turnResult(items: ChatItem[]): (ChatItem & { kind: 'result' }) | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'result') return item
    if (item.kind === 'user' || item.kind === 'interrupted') return undefined
  }
}
