import type { ChangedFile, Chat, ChatItem, Workspace } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'
import { newId } from '../db'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { checkpointTitle, clock, listCheckpoints, revertTo, snapshotWithFiles } from '../services/checkpoints'
import { Feature } from './feature'

/** The saves Kernel takes of a workspace after each turn, and going back to one (KERNEL-325). */
export class Checkpoints extends Feature {
  /** Checkpoints being taken, by workspace, so a worktree folder that moves waits for them (KERNEL-424). */
  private taking = new Map<string, Set<Promise<unknown>>>()

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
    const user = this.sessions.turnRow(chat.id) ?? [...items].reverse().find((i) => i.kind === 'user')
    // A turn Kernel's team update started is titled for what it is, not for the update's first line (KERNEL-116).
    const text = user?.kind !== 'user' ? '' : isKernelUpdate(user) ? 'Team update' : user.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'skill' ? `/${p.name}` : p.name)).join(' ')
    const { checkpoint: c, files } = await snapshotWithFiles(ws, { chatId: chat.id, title: text || chat.title })
    bus.push({ type: 'checkpoint', checkpoint: c })
    if (result && files.length) this.putFiles(chat.id, result.id, files)
    return c
  }

  /** The files a turn changed go on its result row, which keeps its place, so the reply shows them under it (D-029, KERNEL-584). */
  private putFiles(chatId: string, resultId: string, files: ChangedFile[]) {
    // A chat cleared meanwhile has lost the row, and saving it would bring it back.
    const row = this.store.items(chatId).find((i) => i.id === resultId)
    if (row?.kind !== 'result') return
    const item: ChatItem = { ...row, files }
    this.store.saveItem(chatId, item)
    bus.push({ type: 'chat.item', chatId, item })
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
      // A chat with Rowan whose worktree isn't made yet has none (KERNEL-542).
      'checkpoints.list': async ({ workspaceId }) => { const ws = this.mustWs(workspaceId); return ws.worktreePending ? [] : listCheckpoints(ws) },
      'checkpoints.revert': async ({ workspaceId, checkpointId }) => this.revertCheckpoint(workspaceId, checkpointId)
    } satisfies Partial<Handlers>
  }
}

/** The result row of the turn that just ended. A stopped turn writes none, so reaching its message or its Interrupted row first means there is none. */
function turnResult(items: ChatItem[]): (ChatItem & { kind: 'result' }) | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'result') return item
    if (item.kind === 'user' || item.kind === 'interrupted') return undefined
  }
}
