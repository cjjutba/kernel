import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDef, Approval, Chat, ChatItem, ChatArchivePreview, ChatPart, Effort, LeadMode, PermissionMode, Provider, QueuedMessage, ReviewKind, Project, Thread, Workspace } from '@shared/types'
import { buildsHere, LEAD_MODES, leadModeName, leadModeOf, newChatLeadMode } from '@shared/leadMode'
import { isLeadChatWorkspace, leadChatWorkspaceOf } from '@shared/leadWorkspace'
import { providerOf } from '@shared/providers'
import { isSentItem } from '@shared/approvalAnswer'
import { lensOf } from '@shared/merge'
import { newId } from '../db'
import { bus } from '../bus'
import { renderAgentFile } from '../services/agents'
import { parsePlanSteps } from '../services/approvals'
import { NUDGE_LIMIT, nudgeKey } from '../services/nudges'
import { PLANS_DIR, revisedPlanFile, savePlan } from '../services/plans'
import { attachedFiles } from '../services/attachments'
import { dropCheckpoints } from '../services/checkpoints'
import { cleanupSwitch, loadRepoSettings } from '../services/settings'
import { gitStatus } from '../services/archive'
import { firstLine } from '../services/text'
import { isNudge } from '../services/sessions'
import { buildOpen, kernelMcpServer, type KernelToolDeps, queuedNote } from '../services/kernelMcp'
import { briefParts } from '../services/issueMcp'
import type { From } from '../services/leadUpdates'
import { branchType, fastForward, fetchOrigin, folderGone, freeBranch, freeWorktreePath, leadBase, leadBranch, moveWorktree, renameBranch, projectWorktreeRoot, slugify, taskBranch, worktreeFolder } from '../services/worktrees'
import { runningRuns } from '../services/scripts'
import { exec, git } from '../services/exec'
import { messageOf, NEW_CHAT, NEW_TAB } from './shared'
import type { Handlers } from '../kernel'
import type { Workspaces } from './workspaces'
import { Feature } from './feature'
import { prNoteOf, reviseNote } from './records'

/** Meta key for the line a Build here chat's next turn starts with after its PR merged, by workspace (KERNEL-990). */
const TURN_NOTES = 'leadTurnNotes'
/** Meta key for the mode each chat tab's running turn started in, when a switch came during it, so a quit keeps the divider (KERNEL-994). */
const SWITCHED_DURING = 'leadSwitchedDuring'

/** The project's Lead: its workspace and chats, its tools, and where teammates' updates go (KERNEL-329). */
export class Lead extends Feature {
  /**
   * "Let Kernel sort it": the Lead gets both workspaces and the file, and the overlap card is dismissed.
   * The overlap itself clears on its own once the agents stop touching the same file.
   */
  async sortOverlap(overlapId: string): Promise<void> {
    const o = this.overlaps.get(overlapId)
    if (!o) throw new Error('That overlap is gone already.')
    const agents = await this.k.team.agents(o.projectId)
    const parts = o.parties.map((p) => `${agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} in ${this.store.workspace(p.workspaceId)?.name ?? p.workspaceId} (${p.lines})`)
    // The Lead chat that handed off the newest of the workspaces hears about it (KERNEL-105), and learns which other Lead chats are
    // involved, by their titles. Other tabs of its own Lead chat aren't another chat (KERNEL-337).
    const owners = o.parties.map((p) => this.store.workspace(p.workspaceId)).filter((w): w is Workspace => !!w).sort((a, b) => b.createdAt - a.createdAt)
    const chat = (owners.length ? this.leadUpdateTarget(o.projectId, owners[0].leadChatId)?.chat : undefined) ?? await this.leadChat(o.projectId)
    const threadOf = (w: Workspace) => w.threadId ?? (w.leadChatId ? this.store.chat(w.leadChatId)?.threadId : undefined)
    const others = [...new Set(owners.map(threadOf).filter((id): id is string => !!id && id !== chat.threadId))].map((id) => this.store.thread(id)?.title).filter(Boolean)
    const elsewhere = others.length ? ` Part of this work was handed off in another Lead chat: ${others.map((t) => `"${t}"`).join(', ')}.` : ''
    const text = `${parts.join(' and ')} both changed ${o.path} in different worktrees, so merging both will conflict. Decide who keeps the change, tell the others, and sort it out before either merges.${elsewhere}`
    await this.sessions.send(chat.id, [{ type: 'text', text }])
    this.overlaps.resolve(overlapId)
    // A note, not a brief: this isn't a new brief to the Lead.
    const lead = agents.find((a) => a.id === this.store.workspace(chat.workspaceId)?.agentId)
    bus.activity({ kind: 'note', projectId: o.projectId, workspaceId: chat.workspaceId, agentId: lead?.id, actor: 'you', text: `asked ${lead?.name ?? 'Kernel'} to sort out the overlap in`, object: o.path.split('/').pop(), quote: text })
  }

  /**
   * The project's Lead is now `leadId` (KERNEL-397), which is `kernel-lead` since KERNEL-692, so a project that a file led before
   * hands that file's chats to Kernel. The Lead's open workspaces go to it with their chats, so the chats with the Lead carry
   * on. Returns the first workspace that moved.
   */
  adoptLeadWorkspace(projectId: string, leadId: string): Workspace | undefined {
    const all = this.store.workspaces(projectId).filter((w) => w.lead && w.agentId !== leadId)
    // Archived ones too, so History still shows them as the Lead's.
    for (const w of all) if (w.status === 'archived') this.updateWs(w.id, { agentId: leadId }, { archived: true })
    const open = all.filter((w) => w.status !== 'archived')
    if (!open.length) return undefined
    const moved = open.map((ws) => this.updateWs(ws.id, { agentId: leadId }))
    bus.activity({ kind: 'note', projectId, workspaceId: moved[0].id, agentId: leadId, actor: 'kernel', text: 'handed the chats with the old lead file to', object: this.agentsSync(projectId).find((a) => a.id === leadId)?.name ?? leadId })
    return moved[0]
  }

  /** The project's Lead agent, or a throw that says how to get one. */
  private async leadOf(projectId: string): Promise<AgentDef> {
    const lead = (await this.k.team.agents(projectId)).find((a) => a.lead)
    if (!lead) throw new Error("Kernel can't lead in this build: its starter file is missing.")
    return lead
  }

  /** The workspaces of the project's open Lead chats, oldest chat first (KERNEL-405). */
  chatWorkspaces(projectId: string): Workspace[] {
    const born = (w: Workspace) => this.store.thread(w.threadId!)?.createdAt ?? w.createdAt
    return this.store.workspaces(projectId).filter((w) => isLeadChatWorkspace(w) && w.status !== 'archived').sort((a, b) => born(a) - born(b) || a.createdAt - b.createdAt)
  }

  /** The workspace of the project's newest open Lead chat, the one Kernel's own sends join (KERNEL-405). */
  newestChatWorkspace(projectId: string): Workspace | undefined { return this.chatWorkspaces(projectId).at(-1) }

  /**
   * A new Lead chat in its own workspace (KERNEL-405): the chat, its first tab, and a workspace with its branch and folder
   * picked. It returns then, before the network and git, and `buildChat` fetches, makes the worktree from the latest
   * `<remote>/<default>` or from `baseRef`, and runs setup (KERNEL-542). The first message waits in the tab's queue until the
   * worktree exists. Then it goes while setup runs, or, with "Wait for setup" on and a setup script that runs on create, waits
   * until files.copy and setup pass (KERNEL-490). What can fail without the network still throws before anything is saved: no
   * Lead, a base that isn't here and isn't on the remote, a branch name git won't take. A project with no commit keeps the Lead on the
   * checkout with no setup, as before KERNEL-355. A `mode` picked in New chat is the chat's own before its first turn (KERNEL-776), and so is a `leadMode` (KERNEL-805).
   */
  async newLeadChat(projectId: string, o: { prompt: string; parts?: ChatPart[]; clientId?: string; provider?: Provider; model?: string; effort?: Effort; plan?: boolean; baseRef?: string; mode?: PermissionMode; leadMode?: LeadMode }): Promise<Chat> {
    const lead = await this.leadOf(projectId)
    const role = this.k.team.pickFor(lead)
    // A model picked in New Lead chat runs on its own provider. Otherwise the Lead's pin or its role decides (KERNEL-406).
    const pick = { provider: o.model ? o.provider ?? providerOf(o.model) : role.provider, model: o.model ?? role.model, effort: o.effort ?? role.effort, plan: o.plan ?? this.settings.models.leadPlanMode }
    // Hand off or Build here, from the project's default, else the app's (KERNEL-770). Read before anything is saved.
    const project = this.store.project(projectId)
    const leadMode = o.leadMode ?? newChatLeadMode(this.settings, project ? await loadRepoSettings(project.path).catch(() => undefined) : undefined)
    const thread = this.pushThread({ id: newId(), projectId, title: NEW_TAB, createdAt: Date.now() })
    let cut: Awaited<ReturnType<Workspaces['cutWorkspace']>>
    try { cut = await this.k.workspaces.cutWorkspace(projectId, { prompt: o.prompt, parts: o.parts, ...pick, baseRef: o.baseRef, lead: { threadId: thread.id }, worktreeLater: true }) }
    catch (e) { this.store.deleteThread(thread.id); throw e }
    // Its branch and folder take their names from the chat's first title, once (KERNEL-424).
    const ws = this.updateWs(cut.ws.id, { leadMode, ...(cut.ws.mode === 'worktree' ? { naming: 'branch' as const } : {}) })
    // Through the composer's own path, so Bypass where policy or the workspace doesn't allow it still runs as Accept edits.
    const chat = o.mode ? await this.sessions.configure(this.saveChat(cut.chat).id, { mode: o.mode }) : this.saveChat(cut.chat)
    this.userSpoke(chat.id)
    const parts = messageOf(o.prompt, o.parts)
    if (ws.mode === 'current') {
      this.updateWs(ws.id, { status: 'ready' })
      if (parts.length) await this.sessions.send(chat.id, parts, { clientId: o.clientId })
      return chat
    }
    this.sessions.hold(chat.id, parts.length ? parts : undefined, { clientId: o.clientId })
    void this.buildChat(ws.id).catch((e) => {
      // A Kernel that stopped meanwhile has closed its database. The next launch finds the workspace in setup and fails it.
      if (this.stopped) return
      console.warn(`[lead] setting up ${ws.name} failed`, e)
      if (this.store.workspace(ws.id)?.status === 'setup') this.updateWs(ws.id, { status: 'failed' })
    })
    return chat
  }

  /**
   * Switches a chat with Kernel to Hand off or Build here (KERNEL-770). Each tab gets a divider, or its last one updates, and the chat's idle processes
   * end, so the next turn starts with the mode's prompt and tools. A running turn finishes in the mode it started in, and its
   * process restarts after it. That tab's divider waits for the turn to end, so it sits before the first reply in the new mode.
   */
  setMode(workspaceId: string, mode: LeadMode): Workspace {
    if (!LEAD_MODES.includes(mode)) throw new Error(`${String(mode)} is not a mode. Use handoff or build.`)
    const ws = this.store.workspace(workspaceId)
    if (!ws || !isLeadChatWorkspace(ws)) throw new Error('Only a chat with Kernel can switch between Hand off and Build here.')
    if (ws.status === 'archived') throw new Error('This chat is archived. Restore it from History first.')
    const was = leadModeOf(ws)
    if (was === mode) return ws
    const next = this.updateWs(ws.id, { leadMode: mode, buildGoAhead: undefined })
    for (const c of this.chatTabs(ws.id)) {
      if (c.kind === 'terminal') continue
      // The first switch during the turn keeps the mode the turn runs in.
      if (this.sessions.isRunning(c.id)) { if (!this.switchedDuring()[c.id]) this.markSwitchedDuring(c.id, was); continue }
      this.divide(c.id, mode)
    }
    this.noteSwitch(ws.id, was, mode)
    this.sessions.restartIdle([ws.id], 'mode')
    return next
  }

  /**
   * The first reply after a switch is told about it, once: the history it resumes holds replies written in the other mode
   * (KERNEL-994). The note waits in the store with the PR notes. A switch back before any message leaves none.
   */
  private noteSwitch(workspaceId: string, was: LeadMode, mode: LeadMode) {
    const notes = this.store.meta<Record<string, string>>(TURN_NOTES) ?? {}
    const ran = (notes[`${workspaceId}#ran`] as LeadMode | undefined) ?? was
    delete notes[`${workspaceId}#mode`]
    delete notes[`${workspaceId}#ran`]
    if (ran !== mode && this.chatTabs(workspaceId).some((c) => c.kind !== 'terminal' && this.store.items(c.id).some((i) => i.kind === 'user'))) {
      notes[`${workspaceId}#ran`] = ran
      notes[`${workspaceId}#mode`] = `The user switched this chat from ${leadModeName(ran)} to ${leadModeName(mode)}. Earlier replies were written in ${leadModeName(ran)}, so what they say you can or can't do may no longer hold. Follow ${leadModeName(mode)} from here.`
    }
    this.store.saveMeta(TURN_NOTES, notes)
  }

  /** Tabs whose chat switched mode during a running turn, with the mode that turn runs in, so the divider waits for its end. */
  private switchedDuring(): Record<string, LeadMode> { return this.modeSwitches }

  /** Read from the store at launch (`backfill`), not at a turn's end, which reads no database. */
  private modeSwitches: Record<string, LeadMode> = {}

  private markSwitchedDuring(chatId: string, ran: LeadMode | undefined) {
    if (ran) this.modeSwitches[chatId] = ran
    else delete this.modeSwitches[chatId]
    this.store.saveMeta(SWITCHED_DURING, this.modeSwitches)
  }

  /**
   * A chat's turn ended. A switch made during it leaves its divider now, for the chat's mode at this point, or none when that
   * is the mode the turn ran in.
   */
  turnEnded(chatId: string) {
    const ran = this.switchedDuring()[chatId]
    if (!ran) return
    this.markSwitchedDuring(chatId, undefined)
    const chat = this.store.chat(chatId)
    const ws = chat && this.store.workspace(chat.workspaceId)
    if (ws && leadModeOf(ws) === ran) this.sessions.clearStale(chatId, 'mode')
    if (!ws || ws.status === 'archived' || leadModeOf(ws) === ran) return
    this.divide(chatId, leadModeOf(ws))
  }

  /** A mode divider at the end of a tab. One that is already its last item updates in place, so switching back and forth leaves one (KERNEL-809). */
  private divide(chatId: string, mode: LeadMode) {
    const last = this.store.items(chatId).at(-1)
    this.place(chatId, { kind: 'leadMode', id: last?.kind === 'leadMode' ? last.id : newId(), ts: Date.now(), mode })
  }

  /** Puts an item in a chat's transcript. */
  private place(chatId: string, item: ChatItem) {
    this.store.saveItem(chatId, item)
    bus.push({ type: 'chat.item', chatId, item })
  }

  /**
   * What a new Lead chat does after `lead.start` answers (KERNEL-542): the worktree first (`Workspaces.makeWorktree`),
   * then its tabs, held until now, go, unless "Wait for setup" holds them through setup (KERNEL-490), then setup. A worktree git
   * won't make leaves the workspace failed with the tabs still held, and Run again comes back here.
   */
  async buildChat(id: string): Promise<Workspace> {
    const ws = await this.k.workspaces.makeWorktree(id)
    // An archive waits for the worktree, then removes it, so nothing starts in it meanwhile.
    const gone = () => this.stopped || this.k.archive.archivingNow(id)
    if (gone() || ws.worktreePending || ws.status !== 'setup') return ws
    const project = this.mustProject(ws.projectId)
    const repo = await loadRepoSettings(project.path)
    const chat = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    if (!chat || gone()) return this.mustWs(id)
    const wait = cleanupSwitch(repo, this.settings.workspace, 'leadWaitForSetup') && !!repo.scripts.setup?.trim() && this.settings.scripts.setupOnCreate
    if (!wait) {
      this.k.setup.releaseTabs(ws.id, chat.id)
      // A Team update that started this chat goes now, not after setup.
      this.leadUpdates.flush(ws.projectId)
    }
    const done = await this.k.workspaces.setUpWorkspace(ws, project, repo, chat)
    if (this.stopped) return done
    // A message that went before setup started the Lead before setup handed over its variables. Its sessions end once idle, and
    // the next message resumes each with them, as after a folder move (KERNEL-490).
    if (!wait && done.status === 'ready') this.sessions.restartIdle([ws.id])
    this.leadUpdates.flush(ws.projectId)
    return done
  }

  /** Fetches the project's remote without waiting, so the fetch Create needs is done or under way by then (KERNEL-542). */
  prefetch(projectId: string) {
    const project = this.store.project(projectId)
    if (!project) return
    void this.k.config.remoteFor(project.path).then(async (remote) => {
      if ((await exec('git', ['-C', project.path, 'remote', 'get-url', remote])).code === 0) await fetchOrigin(project.path, remote)
    }).catch(() => undefined)
  }

  /** Syncs of each chat's worktree, by workspace, so two never run git in it at once. */
  private syncing = new Map<string, Promise<void>>()
  /** The last refusal logged, by workspace: the target's sha and the reason, so each is logged once per sha. */
  private refused = new Map<string, string>()

  /**
   * Keeps each Lead chat on the latest main (KERNEL-181, KERNEL-405): a fast-forward of its branch to the base it started
   * from, only while that chat is idle, has nothing queued, and has no commits of its own and no tracked file changed. It never
   * merges or rebases. `fetch` fetches once first, after a merge, then syncs every open chat. `workspaceId` syncs only that chat.
   */
  async syncLead(projectId: string, o: { fetch?: boolean; workspaceId?: string } = {}): Promise<void> {
    const failed = (e: unknown) => { if (!this.k.stopped) console.warn("[lead] could not update the Lead's worktree", e) }
    // The fetch runs outside the queue, so a new tab's sync never waits on the network behind it.
    if (o.fetch) {
      const project = this.k.stopped ? undefined : this.store.project(projectId)
      if (!project) return
      // A fetch that fails is a failure, unless the project has no such remote to fetch from (KERNEL-990).
      const fetched = await this.k.config.remoteFor(project.path).then(async (remote) => {
        const r = await fetchOrigin(project.path, remote, { fresh: true })
        return r.ok || (await exec('git', ['-C', project.path, 'remote', 'get-url', remote])).code !== 0
      }).catch((e) => { failed(e); return false })
      if (!fetched) { this.offline(projectId, project.defaultBranch); return }
    }
    if (this.k.stopped) return
    const ids = o.workspaceId ? [o.workspaceId] : this.chatWorkspaces(projectId).map((w) => w.id)
    // A folder that waits to move to match its branch moves first, while the chat is idle (KERNEL-424).
    // A Build here chat whose PR merged starts its next branch before the sync (KERNEL-778).
    await Promise.all(ids.map((id) => this.inOrder(id, async () => { await this.moveNow(id); await this.freshNow(id); await this.syncNow(id) }).catch(failed)))
  }

  /** The merged Build here chats Kernel told it couldn't update to the latest base, by workspace and PR, so each is told once (KERNEL-990). */
  private told = new Set<string>()

  /** The fetch after a merge failed, so a merged Build here chat stays where it is and says so in a row (KERNEL-990). */
  private offline(projectId: string, base: string) {
    for (const ws of this.chatWorkspaces(projectId)) {
      if (!buildsHere(ws) || ws.prState !== 'merged' || ws.status !== 'ready' || ws.mode !== 'worktree' || ws.folderGone || ws.worktreePending) continue
      const key = `${ws.id} ${ws.prNumber ?? ws.branch}`
      if (this.told.has(key)) continue
      this.told.add(key)
      this.ending(ws.id, ws.prNumber, `Kernel couldn't update to the latest ${base}`)
    }
  }

  /**
   * Commits on a merged Build here chat's branch that are neither in the PR, by its last head as GitHub read it or the commit a
   * local merge made, nor on the base. A squash or rebase merge puts other commits on the base, so the base alone can't tell.
   * A commit pushed to the branch after the merge isn't in the PR either, so the branch as pushed doesn't count.
   */
  private async unmerged(ws: Workspace, repo: string, base: string): Promise<number> {
    const has = async (ref: string) => (await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0
    const shipped = []
    for (const ref of [ws.prHead, ws.mergeCommit]) if (ref && await has(ref)) shipped.push(ref)
    return Number((await git(ws.path, 'rev-list', '--count', 'HEAD', '--not', base, ...shipped)).trim())
  }

  /** Build here chats Kernel told it kept on a merged PR's branch, by workspace, PR and reason, so each is told once. */
  private keptMerged = new Set<string>()

  /**
   * A Build here chat whose PR merged goes on from a new branch, cut from `<remote>/<default>` in the same worktree and named
   * the way `nameChatBranch` names a chat's first one, so its next PR is a new one (KERNEL-778). Only while the chat is idle.
   * The PR's number, state and reviews start over, and so does a linked issue. A worktree with uncommitted changes, or with
   * commits the PR didn't include, stays on the merged branch, and the chat hears why, once per PR and reason.
   */
  private async freshNow(id: string) {
    if (this.k.stopped) return
    const ws = this.store.workspace(id)
    const project = ws && this.store.project(ws.projectId)
    if (!ws || !project || project.archived || !buildsHere(ws) || ws.prState !== 'merged' || ws.status !== 'ready' || ws.mode !== 'worktree' || ws.folderGone || ws.worktreePending) return
    if (this.folderBusy(id) || await folderGone(ws.path).catch(() => true)) return
    const merged = ws.prNumber ? `PR #${ws.prNumber}` : 'The PR'
    const repo = await loadRepoSettings(project.path)
    const remote = await this.k.config.remoteFor(project.path, repo)
    const base = await leadBase(project.path, remote) ?? ws.baseRef
    // Work the merge left out stays where it is: uncommitted changes, and commits made after the PR's last head, which a new
    // branch from the base would drop from the worktree.
    const dirty = (await git(ws.path, 'status', '--porcelain', '--', '.', ':(exclude).kernel')).trim() !== ''
    const after = dirty ? 0 : await this.unmerged(ws, project.path, base)
    const why = dirty ? 'it has uncommitted changes' : after ? `it has ${after === 1 ? 'a commit' : `${after} commits`} the PR didn't include` : undefined
    if (why) {
      const key = `${id} ${ws.prNumber ?? ws.branch} ${why}`
      if (this.keptMerged.has(key)) return
      this.keptMerged.add(key)
      this.note(id, `Kernel kept this branch because ${why}. A new branch starts once nothing here is left out of the merge.`)
      return
    }
    const lead = this.agentsSync(project.id).find((a) => a.lead)
    const title = (ws.threadId && this.store.thread(ws.threadId)?.title) || ws.title || ws.name
    const wanted = leadBranch(repo.workspace.leadBranchPattern || this.settings.workspace.leadBranchPattern, title, lead?.name)
    const branch = await this.k.workspaces.withBranchLock(project.id, async () => {
      // The merged branch's own name is taken, even when GitHub deleted it on the remote (KERNEL-990).
      const free = await freeBranch(project.path, wanted, remote, new Set([...this.k.workspaces.pendingNames(project.id).branches, ws.branch]))
      // Read again after the wait: a turn may have started, or the chat been archived.
      const now = this.k.stopped ? undefined : this.store.workspace(id)
      if (!now || now.prState !== 'merged' || now.status !== 'ready' || this.folderBusy(id)) return undefined
      await git(ws.path, 'checkout', '-b', free, base)
      return free
    })
    if (!branch) return
    for (const key of this.keptMerged) if (key.startsWith(`${id} `)) this.keptMerged.delete(key)
    this.updateWs(id, {
      branch, baseRef: base, prState: 'none', prNumber: undefined, prUrl: undefined, prTitle: undefined, prHead: undefined, prBlocked: undefined,
      mergedAt: undefined, mergedWith: undefined, mergeCommit: undefined, reviews: undefined, reviewRound: undefined, reviewPending: undefined, overruled: undefined,
      ...(ws.source?.kind === 'issue' ? { source: undefined } : {}),
    })
    bus.push({ type: 'pr', workspaceId: id, state: 'none' })
    this.switched(id, ws.prNumber, merged, base)
    void this.k.workspaces.changes(id).catch(() => undefined)
  }

  /** Adds `ending` to the PR's merge row in place, or posts it as a row of its own, headed by `alone`, when there is none. */
  private ending(id: string, prNumber: number | undefined, ending: string, alone = 'The PR merged.') {
    const row = prNoteOf(this.store, id, 'merged', prNumber)
    if (!row) this.note(id, `${alone} ${ending}`, 'merged')
    else if (!row.item.text.includes(ending)) reviseNote(this.store, row.chatId, row.item, `${row.item.text} ${ending}`)
  }

  /**
   * The merge row gets its ending in place, since the new branch is the same news (KERNEL-990). Without a merge row, which a
   * merge seen before this version left, the ending is a row of its own. The chat's next turn starts with a line saying so.
   */
  private switched(id: string, prNumber: number | undefined, merged: string, base: string) {
    this.ending(id, prNumber, 'Next changes start on a new branch', `${merged} merged.`)
    const notes = this.store.meta<Record<string, string>>(TURN_NOTES) ?? {}
    notes[id] = `${merged} merged. This chat is now on a new branch from ${base}.`
    this.store.saveMeta(TURN_NOTES, notes)
  }

  /** The line the chat's next turn starts with after its PR merged, taken so it goes once. Kept in the store, so a restart in between still sends it. */
  turnNote(workspaceId: string): string | undefined {
    const notes = this.store.meta<Record<string, string>>(TURN_NOTES) ?? {}
    const line = [notes[workspaceId], notes[`${workspaceId}#mode`]].filter(Boolean).join('\n\n')
    if (!line) return undefined
    delete notes[workspaceId]
    delete notes[`${workspaceId}#mode`]
    delete notes[`${workspaceId}#ran`]
    this.store.saveMeta(TURN_NOTES, notes)
    return line
  }

  /** Runs `step` after the git work already queued for the chat's worktree, so two never run git in it at once. */
  private inOrder(id: string, step: () => Promise<void>): Promise<void> {
    const next = (this.syncing.get(id) ?? Promise.resolve()).then(step)
    const settled = next.catch(() => undefined)
    this.syncing.set(id, settled)
    void settled.finally(() => { if (this.syncing.get(id) === settled) this.syncing.delete(id) })
    return next
  }

  /**
   * Moves a Lead chat's worktree folder to match the branch its first title named, once (KERNEL-424): the branch's
   * folder name under the project's worktree root, `kernel-setup-script-tab-run-button-redundancy`, with the free-name suffix when
   * that is taken. Only while the chat is ready and nothing runs in its folder (`folderBusy`), after the turn's checkpoint is
   * saved. Its tabs wait through the move, so a message sent meanwhile goes out from the new folder. Idle processes end, and
   * the next message resumes each session by its id there, on Claude and on Codex. Running terminals start again there. A move
   * git refuses leaves the folder where it is, and Kernel doesn't try again.
   */
  private async moveNow(id: string) {
    const ws = this.k.stopped ? undefined : this.store.workspace(id)
    const project = ws && this.store.project(ws.projectId)
    if (!ws || !project || ws.naming !== 'folder' || ws.status !== 'ready' || ws.mode !== 'worktree' || ws.folderGone || ws.worktreePending || this.folderBusy(id)) return
    const root = projectWorktreeRoot(this.settings.worktreeRoot, project)
    if (join(root, worktreeFolder(ws.branch)) === ws.path) { this.updateWs(id, { naming: undefined }); return }
    const held: string[] = []
    try {
      await this.k.checkpoints.settled(id)
      // Two chats moving at once could pick the same free folder, as new workspaces could, so the pick and the move take the
      // project's lock (KERNEL-231).
      await this.k.workspaces.withBranchLock(project.id, async () => {
        await mkdir(root, { recursive: true })
        const to = await freeWorktreePath(project.path, root, ws.branch, this.k.workspaces.pendingNames(project.id).paths)
        // Read again after each wait: a turn may have started, or the chat been archived.
        const now = this.k.stopped ? undefined : this.store.workspace(id)
        if (!now || now.path !== ws.path || now.naming !== 'folder' || now.status !== 'ready' || this.folderBusy(id)) return
        for (const c of this.chatTabs(id)) if (c.kind !== 'terminal') { this.sessions.hold(c.id); held.push(c.id) }
        await moveWorktree(project.path, ws.path, to)
        this.updateWs(id, { path: to, naming: undefined })
        this.sessions.restartIdle([id])
        this.k.chats.restartTerminals(id)
        void this.k.workspaces.changes(id).catch(() => undefined)
      })
    } catch (e) {
      if (this.k.stopped) return
      console.warn(`[lead] could not move ${ws.path} to match ${ws.branch}`, e)
      this.updateWs(id, { naming: undefined })
    } finally {
      for (const c of held) this.sessions.release(c)
    }
  }

  /**
   * Something runs in the workspace's folder, or waits to: a turn, a background task, a queued or held message, setup run again,
   * a run script or a terminal command.
   */
  private folderBusy(id: string) {
    return this.k.setup.settingUp.has(id) || runningRuns(id).length > 0 || this.k.chats.busyTerminals(id)
      || this.store.chats(id).some((c) => this.sessions.isRunning(c.id) || this.sessions.hasTasks(c.id) || this.sessions.queued(c.id).length > 0 || this.sessions.isHeld(c.id))
  }

  private async syncNow(id: string) {
    // A stopped Kernel's database is closed, so a sync still in flight reads nothing more from it and logs nothing.
    if (this.k.stopped) return
    const ws = this.store.workspace(id)
    const project = ws && this.store.project(ws.projectId)
    const lead = ws && this.agentsSync(ws.projectId).find((a) => a.lead)
    // A chat still setting up, or one whose setup failed, isn't moved under its setup. One with no worktree yet has nothing to move.
    if (!ws || !project || project.archived || !lead || !ws.lead || ws.status !== 'ready' || ws.mode !== 'worktree' || ws.folderGone || ws.worktreePending) return
    // Read again after each step that waits on git: a turn can start while git runs, and the files mustn't move under it.
    const held = () => this.k.stopped || this.store.chats(ws.id).some((c) => this.sessions.isRunning(c.id) || this.sessions.queued(c.id).length > 0)
    if (held() || await folderGone(ws.path).catch(() => true)) return
    // The base it started from: `<remote>/<default>`, or the branch picked in New chat. One that's gone leaves it be.
    const target = ws.baseRef
    if ((await exec('git', ['-C', project.path, 'rev-parse', '--verify', '--quiet', `${target}^{commit}`])).code !== 0) return
    const count = async (range: string) => Number((await git(ws.path, 'rev-list', '--count', range)).trim())
    const behind = await count(`HEAD..${target}`)
    if (!behind) return
    const sha = (await git(project.path, 'rev-parse', target)).trim()
    const own = await count(`${target}..HEAD`)
    const changed = !own && (await git(ws.path, 'status', '--porcelain', '--untracked-files=no')).trim() !== ''
    if (held()) return
    const why = own ? `it has ${own === 1 ? 'a commit' : `${own} commits`} of its own` : changed ? 'tracked files have changes' : !(await fastForward(ws.path, target)) ? 'git refused the fast-forward' : undefined
    if (this.k.stopped) return
    if (why) {
      if (this.refused.get(id) === `${sha} ${why}`) return
      this.refused.set(id, `${sha} ${why}`)
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: lead.id, actor: 'kernel', text: `didn't update ${lead.name}'s worktree to ${target}:`, object: why, warn: true })
      return
    }
    this.refused.delete(id)
    bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: lead.id, actor: 'kernel', text: `updated ${lead.name}'s worktree to ${target}, ${behind === 1 ? '1 new commit' : `${behind} new commits`}` })
    void this.k.workspaces.changes(ws.id).catch(() => undefined)
  }

  /**
   * Moves the Lead chats from the project's one shared Lead workspace into a workspace each, once, at startup after the
   * agents load and before any chat carries on (KERNEL-405). Without a fetch: each chat starts from `<remote>/<default>` as
   * last fetched. An open chat gets a worktree on its own branch, and every tab of it, closed ones too, moves there with the
   * plans its chats wrote. Its chats resume by their session ids from the new folder (KERNEL-348). Setup runs with the chat
   * held. Then the shared record is archived and its worktree folder goes, without the archive script. A shared record on the
   * main checkout leaves the files alone. Closed chats stay with the old record. A project that fails tries again at the next
   * start, and a chat that already moved isn't moved twice.
   */
  private async moveLeadChats() {
    if (this.store.meta<boolean>('leadChatsMoved')) return
    let ok = true
    for (const old of this.store.workspaces().filter((w) => w.lead && !w.threadId && w.status !== 'archived')) {
      const project = this.store.project(old.projectId)
      if (!project || project.archived) continue
      try { await this.moveProjectChats(old, project) } catch (e) { ok = false; console.warn(`[lead] could not give ${project.name}'s chats with the Lead a workspace each, trying again at the next start`, e) }
    }
    if (ok) this.store.saveMeta('leadChatsMoved', true)
  }

  private async moveProjectChats(old: Workspace, project: Project) {
    const lead = this.agentsSync(project.id).find((a) => a.lead)
    // A project with no commit to start from keeps its chats where they are, on the checkout.
    if (!lead || !(await leadBase(project.path, await this.k.config.remoteFor(project.path)))) return
    const tabs = this.store.chats(old.id)
    const open = this.store.threads(project.id).filter((t) => !t.closedAt && tabs.some((c) => c.threadId === t.id && !c.closed && c.kind !== 'terminal'))
    for (const t of open) {
      // A start cut short after this chat moved already finds its workspace.
      if (this.store.workspaces(project.id).some((w) => isLeadChatWorkspace(w) && w.threadId === t.id)) continue
      const own = tabs.filter((c) => c.threadId === t.id)
      const first = own.find((c) => !c.closed && c.kind !== 'terminal')!
      const { ws, repo } = await this.k.workspaces.cutWorkspace(project.id, { prompt: t.title === NEW_TAB ? '' : t.title, model: first.model, effort: first.effort, plan: first.plan, lead: { threadId: t.id }, noFetch: true })
      // The tab `cutWorkspace` opened gives way to the chat's own.
      const made = this.store.chats(ws.id)
      this.store.deleteChats(made.map((c) => c.id))
      for (const c of own) this.saveChat({ ...c, workspaceId: ws.id })
      await cp(join(old.path, PLANS_DIR), join(ws.path, PLANS_DIR), { recursive: true, force: false }).catch((e) => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e })
      // What waited in a tab when Kernel last quit waits for setup now, in order, then goes.
      const queues = this.store.meta<Record<string, QueuedMessage[]>>('queues') ?? {}
      for (const c of this.chatTabs(ws.id)) {
        if (c.kind === 'terminal') continue
        this.sessions.hold(c.id)
        for (const q of queues[c.id] ?? []) this.sessions.hold(c.id, q.parts, { ...(q.from ? { from: q.from } : {}), ...(q.update ? { update: q.update } : {}) })
      }
      const chat = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')!
      bus.activity({ kind: 'note', projectId: project.id, workspaceId: ws.id, agentId: lead.id, actor: 'kernel', text: `gave the chat "${t.title}" its own worktree:`, object: ws.branch })
      void this.k.workspaces.setUpWorkspace(this.mustWs(ws.id), project, repo, chat, { checkpoint: false }).catch((e) => {
        if (this.stopped) return
        console.warn(`[lead] setting up ${ws.name} failed`, e)
        if (this.store.workspace(ws.id)?.status === 'setup') this.updateWs(ws.id, { status: 'failed' })
      })
    }
    // The old record's open big terminals belonged to no chat. They close with it.
    for (const c of this.chatTabs(old.id)) if (c.kind === 'terminal') this.saveChat({ ...c, closed: true })
    // On the checkout nothing is removed. A worktree goes, with no archive script: it ran none of the project's scripts.
    await this.k.archive.archiveWorkspace(old.id, false, { removingProject: true, noScript: true })
    await this.k.archive.cleanedUp(old.id)
    // Its checkpoints were snapshots of a folder no chat works in any more, and History doesn't list it to delete them.
    await dropCheckpoints(project.path, old.id).catch(() => undefined)
  }

  /**
   * The newest open Lead chat's first tab, for Kernel's own sends: a brief, an overlap, a comment on a shared file.
   * With no chat open, a new one, with setup (KERNEL-405). Opening the project doesn't come here, so it starts no chat (KERNEL-365).
   */
  async leadChat(projectId: string): Promise<Chat> {
    const ws = this.newestChatWorkspace(projectId)
    const open = ws && this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    if (open) return open
    if (ws) return this.saveChat(this.leadTab(ws, NEW_TAB, this.leadPick(await this.leadOf(projectId))))
    return this.newLeadChat(projectId, { prompt: '' })
  }

  /** The model, effort and plan mode a Lead tab Kernel opens starts with. */
  private leadPick(lead: AgentDef) {
    return { ...this.k.team.pickFor(lead), plan: this.settings.models.leadPlanMode }
  }

  /**
   * A message to the Lead in a tab of its own (KERNEL-148). It always adds a tab, like the tab row's +: an unused tab may
   * hold a draft the engine can't see, since the composer keeps it (D-133, KERNEL-242). With `threadId` the tab joins that
   * chat while it is open, else it starts a new chat with its own workspace (KERNEL-405). The first message names the tab.
   */
  async startLeadChat(projectId: string, o: { prompt: string; parts?: ChatPart[]; provider?: Provider; model?: string; effort?: Effort; plan?: boolean; baseRef?: string }, threadId?: string): Promise<Chat> {
    const ws = threadId ? leadChatWorkspaceOf(this.store.workspaces(projectId), threadId) : undefined
    return ws ? this.tabIn(ws, o) : this.newLeadChat(projectId, o)
  }

  /** A new tab in the open chat `ws` hosts, with the message. A chat on the latest main as last fetched catches up first. */
  private async tabIn(ws: Workspace, o: { prompt: string; parts?: ChatPart[]; provider?: Provider; model?: string; effort?: Effort; plan?: boolean }): Promise<Chat> {
    const lead = await this.leadOf(ws.projectId)
    const role = this.k.team.pickFor(lead)
    // A model picked in New Lead chat runs on its own provider. Otherwise the Lead's pin or its role decides (KERNEL-406).
    const pick = { provider: o.model ? o.provider ?? providerOf(o.model) : role.provider, model: o.model ?? role.model, effort: o.effort ?? role.effort, plan: o.plan ?? this.settings.models.leadPlanMode }
    await this.syncLead(ws.projectId, { workspaceId: ws.id })
    const chat = this.saveChat(this.leadTab(this.mustWs(ws.id), NEW_TAB, pick))
    this.userSpoke(chat.id)
    await this.sessions.send(chat.id, messageOf(o.prompt, o.parts))
    return chat
  }

  /**
   * A new tab in a Lead chat (KERNEL-337), the one its workspace hosts (KERNEL-405). The old shared Lead workspace hosts
   * none, so there `threadId` names the chat, or the tab starts one. A tab opened while the chat's first message waits for
   * setup waits with it. Saved, not pushed, like `newChat`.
   */
  leadTab(ws: Workspace, title: string, o: { provider?: Provider; model: string; effort: Effort; plan: boolean; kind?: 'chat' | 'terminal'; terminal?: Chat['terminal'] }, threadId?: string): Chat {
    const id = ws.threadId ?? threadId
    const thread = id ? this.store.thread(id) : undefined
    if (id && thread?.projectId !== ws.projectId) throw new Error('That chat no longer exists.')
    const held = ws.status !== 'ready' && this.chatTabs(ws.id).some((c) => this.sessions.isHeld(c.id))
    const chat = this.newChat(ws.id, title, { ...o, threadId: (thread ?? this.pushThread({ id: newId(), projectId: ws.projectId, title, createdAt: Date.now() })).id })
    if (held && o.kind !== 'terminal') this.sessions.hold(chat.id)
    return chat
  }

  private pushThread(t: Thread): Thread {
    this.store.saveThread(t)
    bus.push({ type: 'thread', thread: t })
    return t
  }

  /**
   * Kernel named a Lead tab. The first tab of a Lead chat names the chat too, until the user names the chat (KERNEL-337). The
   * first tab's first name also names a new chat's branch and folder, once, whatever the user called the chat (KERNEL-424).
   */
  tabNamed(chat: Chat) {
    const t = chat.threadId ? this.store.thread(chat.threadId) : undefined
    if (!t || this.store.threadTabs(chat.id)[0]?.id !== chat.id) return
    const ws = this.store.workspace(chat.workspaceId)
    if (ws?.naming === 'branch' && isLeadChatWorkspace(ws) && ws.threadId === t.id) void this.nameChatBranch(ws.id, chat.title).catch((e) => { if (!this.stopped) console.warn(`[lead] could not rename ${ws.branch}`, e) })
    if (!t.renamed && t.title !== chat.title) this.retitle({ ...t, title: chat.title })
  }

  /**
   * Saves the chat's name, and the title of the workspace it hosts follows, which the breadcrumb reads. Its branch and folder
   * keep their names (KERNEL-424).
   */
  private retitle(t: Thread): Thread {
    this.pushThread(t)
    const ws = leadChatWorkspaceOf(this.store.workspaces(t.projectId), t.id)
    if (ws && ws.title !== t.title) this.updateWs(ws.id, { title: t.title })
    return t
  }

  /** Branch renames under way, by workspace, so two names arriving together run one after the other. */
  private renaming = new Map<string, Promise<void>>()

  /**
   * Names a new Lead chat's branch from the chat's first title, once (KERNEL-424): every word of it, cut to 60
   * characters, `kernel/setup-script-tab-run-button-redundancy`, with a free-name suffix when that is taken. The workspace's name
   * follows, and its folder moves to match once the chat is idle (`moveNow`). A branch that was pushed or has a PR keeps its
   * name and folder. Later names, Kernel's or the user's, name only the chat.
   */
  nameChatBranch(id: string, title: string): Promise<void> {
    const next = (this.renaming.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      // git renames the branch once it has made it. A worktree it couldn't make keeps the name for a later title (KERNEL-542).
      await this.k.workspaces.worktreeMade(id)
      const ws = this.store.workspace(id)
      if (!ws || this.stopped || ws.naming !== 'branch' || ws.status === 'archived' || ws.worktreePending) return
      if (ws.mode !== 'worktree' || ws.branch === 'HEAD' || ws.prNumber || ws.prState !== 'none') { this.updateWs(id, { naming: undefined }); return }
      const project = this.mustProject(ws.projectId)
      const repo = await loadRepoSettings(project.path)
      const lead = this.agentsSync(project.id).find((a) => a.lead)
      const wanted = leadBranch(repo.workspace.leadBranchPattern || this.settings.workspace.leadBranchPattern, title, lead?.name)
      const remote = await this.k.config.remoteFor(project.path, repo)
      if (await this.pushed(project.path, ws, remote)) { this.updateWs(id, { naming: undefined }); return }
      // Two Lead chats named at once could pick the same free name, so the pick and the rename take the project's lock (KERNEL-231).
      const to = wanted === ws.branch ? wanted : await this.k.workspaces.withBranchLock(project.id, async () => {
        const free = await freeBranch(project.path, wanted, remote, this.k.workspaces.pendingNames(project.id).branches)
        if (this.stopped || this.store.workspace(id)?.branch !== ws.branch) return undefined
        await renameBranch(ws.path, free)
        return free
      })
      if (!to) return
      this.updateWs(id, { branch: to, name: slugify(title), naming: 'folder' })
      // The folder moves now if the chat is idle, else when its turn ends.
      void this.syncLead(ws.projectId, { workspaceId: id })
    })
    this.renaming.set(id, next)
    void next.finally(() => { if (this.renaming.get(id) === next) this.renaming.delete(id) }).catch(() => undefined)
    return next
  }

  /**
   * Links a Build here chat's own work to a tracker issue (KERNEL-778), from the link_issue tool. Before
   * the first push, and with no PR, its branch takes a teammate's name for the issue, `feat/kernel-760-retry-button`, and its
   * folder follows once the chat is idle. After that only the link changes. The PR body names the key, so the issue closes on
   * merge.
   */
  linkIssue(id: string, issue: string): Promise<Workspace> {
    const next = (this.renaming.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const ws = this.store.workspace(id)
      if (!ws || ws.status === 'archived' || !isLeadChatWorkspace(ws)) throw new Error('That chat no longer exists.')
      if (!buildsHere(ws)) throw new Error('Only a chat in Build here links an issue. In Hand off, the teammate\'s workspace takes it.')
      const key = issue.trim()
      if (!key) throw new Error('Name the issue to link, for example KERNEL-760.')
      const project = this.mustProject(ws.projectId)
      const linked = await this.k.integrations.issueSource(project.id, key, ws.title ?? key)
      const repo = await loadRepoSettings(project.path)
      const remote = await this.k.config.remoteFor(project.path, repo)
      const wanted = taskBranch(repo.workspace.branchPattern ?? this.settings.workspace.branchPattern, linked.source.kind === 'issue' ? linked.source.title : key, linked.source.kind === 'issue' ? linked.source.id : key, branchType(linked.labels))
      const renamable = ws.mode === 'worktree' && ws.branch !== 'HEAD' && !ws.worktreePending && !ws.prNumber && ws.prState === 'none' && wanted !== ws.branch && !(await this.pushed(project.path, ws, remote))
      const to = renamable ? await this.k.workspaces.withBranchLock(project.id, async () => {
        const free = await freeBranch(project.path, wanted, remote, this.k.workspaces.pendingNames(project.id).branches)
        if (this.stopped || this.store.workspace(id)?.branch !== ws.branch) return undefined
        await renameBranch(ws.path, free)
        return free
      }) : undefined
      const saved = this.updateWs(id, { source: linked.source, ...(to ? { branch: to, naming: 'folder' as const } : {}) })
      // The folder moves now if the chat is idle, else when its turn ends.
      if (to) void this.syncLead(ws.projectId, { workspaceId: id })
      return saved
    })
    const queued = next.then(() => undefined)
    this.renaming.set(id, queued)
    void queued.finally(() => { if (this.renaming.get(id) === queued) this.renaming.delete(id) }).catch(() => undefined)
    return next
  }

  /** The chat's branch was pushed under its name, or tracks anything but the base it was cut from, which git sets as its upstream. */
  private async pushed(repo: string, ws: Workspace, remote: string) {
    const upstream = await exec('git', ['-C', repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${ws.branch}@{u}`])
    return (await exec('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${ws.branch}`])).code === 0
      || (upstream.code === 0 && upstream.stdout.trim() !== ws.baseRef)
  }

  private renameThread(threadId: string, title: string): Thread {
    const t = this.store.thread(threadId)
    if (!t) throw new Error('That chat no longer exists.')
    const name = title.trim()
    if (!name) throw new Error('Give the chat a name.')
    return this.retitle({ ...t, title: name, renamed: true })
  }

  /** The Lead chat a tab is in, for the "From" line: its thread's title, or the tab's when it has none. */
  private chatTitleOf(chat: Chat) { return (chat.threadId && this.store.thread(chat.threadId)?.title) || chat.title }

  /** The user's own latest message in a tab, not Kernel's, and when they sent it (KERNEL-678). */
  private userSaidIn(chatId: string): { text: string; at: number } | undefined {
    const last = this.store.items(chatId).reverse().find((i): i is ChatItem & { kind: 'user' } => isSentItem(i) && !i.from)
    return last && { text: last.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n'), at: last.ts }
  }

  /**
   * Whether a Build here chat may change files now (KERNEL-992), read from the saved go-ahead, the plans approved in the chat
   * and who started the turn, at each call, so a switch or a go-ahead mid-reply counts at once.
   */
  buildOpen(chatId: string): boolean {
    const chat = this.store.chat(chatId)
    const ws = chat && this.store.workspace(chat.workspaceId)
    if (!chat || !ws) return false
    return buildOpen({ planMode: !!chat.plan, userTurn: !this.sessions.kernelTurn(chatId), branch: ws.branch, goAhead: ws.buildGoAhead, userAt: this.userSaidIn(chatId)?.at ?? 0, planAts: this.threadPlans(ws.projectId, chat).map((a) => a.createdAt) })
  }

  /** Saves the go-ahead for this chat's branch, with the time of the message it came from (KERNEL-992). */
  recordGoAhead(chatId: string, quote: string) {
    const chat = this.store.chat(chatId)
    const ws = chat && this.store.workspace(chat.workspaceId)
    if (ws) this.updateWs(ws.id, { buildGoAhead: { quote, at: this.userSaidIn(chatId)?.at ?? Date.now(), branch: ws.branch } })
  }

  /** Plans approved in any tab of `chat`'s Lead chat, newest first (KERNEL-337). */
  private threadPlans(projectId: string, chat: Chat): Approval[] {
    const tabs = this.threadTabIds(chat)
    return this.store.approvals({ projectId }).filter((a) => a.kind === 'plan' && a.status === 'allowed' && !!a.chatId && tabs.has(a.chatId)).sort((a, b) => b.createdAt - a.createdAt)
  }

  leadTools(projectId: string, lead: AgentDef, chat: Chat) {
    return kernelMcpServer(this.leadToolDeps(projectId, lead, chat))
  }

  /** What the Lead's tools call, apart from the server so tests can run the tools against a real Kernel. */
  leadToolDeps(projectId: string, lead: AgentDef, chat: Chat): KernelToolDeps {
    return {
      projectId, lead,
      agents: () => this.k.team.agents(projectId),
      workspaces: () => this.store.workspaces(projectId),
      chatId: chat.id,
      // The Lead chat a tab is in names the work it handed off, and every tab of this one's counts as this tab's (KERNEL-337).
      chatTitle: (id) => { const c = this.store.chat(id); return c && this.chatTitleOf(c) },
      ownTab: (id) => this.threadTabIds(chat).has(id),
      plans: () => this.threadPlans(projectId, chat).map((a) => ({ tab: this.store.chat(a.chatId!)?.title ?? '', at: a.createdAt, plan: a.detail ?? '' })),
      // The saved chat, not `chat`: the toggle can change after the session starts (KERNEL-176).
      planMode: () => !!this.store.chat(chat.id)?.plan,
      // Read when the session starts, so a turn finishes in the mode it started in, and a switch restarts it (KERNEL-770).
      leadMode: leadModeOf(this.store.workspace(chat.workspaceId)),
      // The files changed in this chat's own worktree, which teammates won't start from (KERNEL-770). Kernel's own `.kernel`
      // folder, with the user's attachments and shared files, doesn't count.
      ownChanges: async () => {
        const own = this.store.workspace(chat.workspaceId)
        if (!own || own.mode !== 'worktree' || !existsSync(own.path)) return 0
        const out = await git(own.path, 'status', '--porcelain', '--', '.', ':(exclude).kernel').catch(() => '')
        return out.split('\n').filter((l) => l.trim()).length
      },
      suggestHandoff: (why) => this.place(chat.id, { kind: 'modeSuggestion', id: newId(), ts: Date.now(), mode: 'handoff', why }),
      linkIssue: async (issue) => {
        const before = this.mustWs(chat.workspaceId).branch
        const ws = await this.linkIssue(chat.workspaceId, issue)
        const source = ws.source?.kind === 'issue' ? ws.source : { id: issue, title: issue }
        return { id: source.id, title: source.title, ...(ws.branch !== before ? { branch: ws.branch } : {}) }
      },
      createWorkspace: async ({ issue, images, goAhead, ...o }) => {
        // Only plans approved in this Lead chat, in any of its tabs (KERNEL-337). Another chat's plan with a step for the same
        // agent is a different hand-off.
        const tabs = this.threadTabIds(chat)
        const approvalIds = new Set(this.store.approvals({ projectId }).filter((a) => a.kind === 'plan' && !!a.chatId && tabs.has(a.chatId)).map((a) => a.id))
        // The issue the task builds (D-140). Kernel names the branch from it unless the Lead named one (KERNEL-275).
        const linked = issue ? await this.k.integrations.issueSource(projectId, issue, o.title ?? firstLine(o.prompt)) : undefined
        const branch = o.branch
        // The brief carries the issue the tracker read, so the teammate needs no tracker MCP server for it (KERNEL-473).
        // The user's screenshots follow the brief, and the send saves them in the teammate's worktree (KERNEL-658).
        const parts = linked?.issue ? [...briefParts(o.prompt, linked.issue.read, linked.issue.kind), ...images ?? []] : images
        // A review is not a task of the plan, so it takes no plan step or task (KERNEL-130).
        const review = o.reviewOf ?? o.linkReviewOf
        const ws = await this.k.workspaces.createWorkspace(projectId, { ...o, ...(linked ? { source: linked.source, labels: linked.labels } : {}), ...(parts ? { parts } : {}), ...(branch ? { branch } : {}), mode: o.mode, leadChatId: chat.id, taskFor: review ? undefined : (w) => this.tasks.link(projectId, o.agentId, w.id, { approvalIds })?.id })
        if (!review) this.linkPlanStep(projectId, o.agentId, ws.id, chat)
        // The user's words that approved it, kept as the record of the go-ahead (KERNEL-678).
        if (goAhead) this.updateWs(ws.id, { goAhead })
        // The Lead named no wait, but the tracker says the issue is blocked by one a teammate is building (KERNEL-263).
        const blocked = !o.waitFor && linked?.blockedBy?.length ? await this.k.waits.waitOnBlockers(ws, linked.blockedBy).catch(() => undefined) : undefined
        if (ws.status !== 'failed') {
          // The brief may still wait in the teammate's chat, for a slot, a pause or the connection (KERNEL-272).
          const out = blocked ?? ws
          const brief = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
          const queued = brief && this.sessions.queueReason(brief.id)
          return queued ? { ...out, queued } : out
        }
        const code = this.k.setup.setupFailures.get(ws.id)
        return { ...ws, setupFailed: code === null ? 'it was stopped' : code === 'timeout' ? "it didn't finish in time" : code === undefined ? 'it did not pass' : `exit code ${code}` }
      },
      handoffBase: (baseRef) => this.k.workspaces.handoffBase(projectId, baseRef),
      // A branch on the remote, an open PR or another assignee says someone else may be on the issue (KERNEL-479).
      issueTaken: (key) => this.k.integrations.issueTaken(projectId, key),
      // file_issue writes to the project's own tracker, read on each call like the Issues screen's (KERNEL-462).
      tracker: () => this.k.integrations.trackerFor(projectId),
      // The project's `[agents] open_workspaces` when it sets one, else Settings, Models' agent limit. 0 from either is no cap,
      // with no hidden default (KERNEL-492, amends KERNEL-220).
      agentCap: async () => {
        const project = this.store.project(projectId)
        const own = project ? (await loadRepoSettings(project.path)).agents?.openWorkspaces : undefined
        return { cap: own ?? this.settings.models.agentLimit, own: own !== undefined, project: project?.name ?? 'this project' }
      },
      messageWorkspace: (workspaceId, text, images, review) => this.messageWorkspace(projectId, workspaceId, text, chat.id, images, review),
      reviewKinds: (workspaceId) => this.reviewKinds(workspaceId),
      // Only what the user attached in this chat's own workspace, read when the Lead calls (KERNEL-658). Any file goes,
      // and the teammate's send copies it into their worktree (KERNEL-907).
      attachedImages: async (paths) => {
        const own = this.store.workspace(chat.workspaceId)
        if (!own) throw new Error('this chat has no workspace to pass files from.')
        return attachedFiles(own.path, paths)
      },
      // An image a teammate in this project shared, at the version the Lead names (KERNEL-659).
      sharedImage: (id, version) => this.k.sharing.sharedImage(projectId, id, version),
      askUser: async (o, signal) => {
        // The card goes in the chat the Lead is blocked in, wherever that is, and shows in the Inbox too.
        const agents = await this.k.team.agents(projectId)
        const reuse = o.kind === 'plan' ? revisedPlanFile(this.store.approvals({ projectId }), chat.id) : undefined
        // A turn that stopped while the team was read shows no card: an abort that has already fired never fires again.
        if (signal?.aborted) return null
        // A new plan replaces one still waiting, as one a restart left up (plan-cards-survive-restart).
        if (o.kind === 'plan') this.approvals.expireIds(this.approvals.waitingPlans(chat.id, projectId).map((p) => p.id), 'replaced')
        // The turn stopping, as when the user writes in the message box instead, ends the card as expired (KERNEL-496).
        const { approval, decision } = this.approvals.request({
          kind: o.kind, source: 'sdk', projectId, workspaceId: chat.workspaceId, chatId: chat.id, agentId: lead.id, title: o.title, detail: o.detail, options: o.options, questions: o.questions,
          steps: o.steps && parsePlanSteps(o.steps, agents), agentFile: o.agentFile
        }, { signal })
        this.sessions.placeApproval(chat.id, approval.id)
        // Saved like ExitPlanMode's plan, so a chat can build from it after the card is gone (D-092, KERNEL-373).
        const ws = this.store.workspace(chat.workspaceId)
        // `update` skips an approval that is gone. The catch covers a store closed while the file was written, as on quit
        // (KERNEL-383).
        if (o.kind === 'plan' && o.detail?.trim() && ws && existsSync(ws.path)) {
          void savePlan(ws.path, o.detail, { reuse }).then((planFile) => { this.approvals.update(approval.id, { planFile }) }).catch(() => undefined)
        }
        // An answer is the user stepping in, so the loop guard starts over for this chat's work (KERNEL-125). It isn't a send, so
        // the chat keeps its place in the sidebar (KERNEL-498).
        return decision.then((d) => { if (d) this.steppedIn(chat.id); return d })
      },
      archiveWorkspace: (id) => this.k.archiveWorkspace(id),
      // The setting and the turn are read on each call: the switch can change, and each message starts a new turn (KERNEL-352).
      mergeWorkspace: (id) => this.k.prs.mergePr(id),
      leadMerge: () => this.settings.pr.leadMerge,
      overrule: (id, note) => this.k.reviews.overrule(id, { by: 'lead', note }),
      userTurn: () => !this.sessions.kernelTurn(chat.id),
      // The user's own latest message in this tab, not Kernel's, which a go_ahead quote has to come from (KERNEL-678).
      userSaid: () => this.userSaidIn(chat.id),
      buildOpen: () => this.buildOpen(chat.id),
      recordGoAhead: (quote) => this.recordGoAhead(chat.id, quote),
      setWait: (id, on) => this.k.waits.setWait(id, on),
      refreshPr: (id) => this.k.refreshPr(id, { settle: true }),
      isRunning: (id) => this.k.archive.working(id),
      // The sidebar's check before a one-click archive. A current-branch workspace removes no files, and neither does a
      // worktree whose folder is already gone (KERNEL-109).
      unsaved: (id) => this.k.archive.unsavedOf(id),
      planApproved: () => this.sessions.planApproved(chat.id),
      handedOff: () => this.sessions.handoffs.done(chat.id),
      acted: (a) => {
        if ('messaged' in a) this.k.openItems.messaged(chat.id, a.messaged)
        else if ('created' in a) this.k.openItems.created(chat.id, a.created)
        else this.k.openItems.asked(chat.id, a.asked)
      },
      openMarks: () => this.k.openItems.marks(chat.id),
      hireAgent: async (a, scope) => {
        const was = this.k.team.agentCache.get(projectId) ?? await this.k.team.agents(projectId)
        const { agent, pr } = await this.k.agentChanges.hire(projectId, { id: a.id, text: renderAgentFile(a) }, scope)
        if (pr) return pr
        this.k.team.announceTeam(projectId, await this.k.team.agents(projectId), was)
        return agent.file
      },
      // For the new agent card and create_agent's result (KERNEL-476).
      reach: (agent, o) => this.k.mcp.reach(projectId, agent, o),
      // The account the agent runs on, for create_workspace's and message_agent's sign-in line (KERNEL-939).
      signIns: (agent) => this.k.mcp.signInsFor(projectId, agent),
      // The same save as Settings, once the user presses Save on the card (KERNEL-683).
      saveProjectScripts: (patch) => this.k.config.setProject(projectId, patch)
    }
  }

  /**
   * The Lead's `message_agent` (KERNEL-118). It sends only into an open workspace of this project that has its folder and
   * isn't the Lead's own, opening a chat there when none is open, and says what really happened: sent, waiting for the
   * teammate's turn, for setup, for a paused project, for the connection or for a free slot. A message sent while setup
   * runs goes with the brief. In a review workspace that runs more than one kind of review, `review` names the kind whose
   * chat gets it, put back on the strip when the user closed it, and `agentId` is the agent that runs that chat. Kernel never
   * opens a chat with no kind there (feat-review-messages-reach-named).
   */
  private async messageWorkspace(projectId: string, workspaceId: string, text: string, leadChatId?: string, images: ChatPart[] = [], review?: string): Promise<{ ok: boolean; sent: boolean; note: string; agentId?: string }> {
    const refuse = (note: string) => ({ ok: false, sent: false, note })
    const ws = this.store.workspace(workspaceId)
    if (!ws || ws.projectId !== projectId) return refuse(`Not sent: there is no workspace ${workspaceId} in this project. Call list_workspaces for the ids.`)
    if (ws.status === 'archived') return refuse(`Not sent: ${ws.name} is archived. Ask the user to restore it from History, or hand the work out again with create_workspace.`)
    const agents = await this.k.team.agents(projectId)
    const agent = agents.find((a) => a.id === ws.agentId)
    if (agent?.lead) return refuse('Not sent: that is your own workspace.')
    if (ws.mode === 'worktree' && await folderGone(ws.path).catch(() => false)) return refuse(`Not sent: ${ws.name}'s folder is gone. Ask the user to archive it, or hand the work out again with create_workspace.`)
    // A review workspace Kernel started runs one chat per kind of review. The message goes to the kind the Lead names.
    const kinds = ws.reviewOf ? this.k.reviews.kindsOf(ws) : []
    const runs = kinds.map((k) => `"${k}"`).join(', ')
    const asked = review?.trim().toLowerCase()
    if (asked && kinds.length && !kinds.includes(asked as ReviewKind)) return refuse(`Not sent: this review workspace doesn't run a "${review}" review. It runs ${runs}. Pass one of those as review.`)
    if (asked && !kinds.length && !(ws.reviewOf && asked === 'code')) return refuse(`Not sent: ${ws.name} runs no "${review}" review. Leave review out for this workspace.`)
    if (!asked && kinds.length > 1) return refuse(`Not sent: this review workspace runs ${kinds.length} kinds of review, ${runs}, each in its own chat. Pass the one you mean as review.`)
    const kind = kinds.length ? (asked as ReviewKind | undefined) ?? kinds[0] : undefined
    const tab = kind ? this.k.reviews.kindChat(ws, kind) : undefined
    const runner = tab ? this.k.reviews.agentForChat(ws, tab) : undefined
    const name = runner?.name ?? agent?.name ?? ws.agentId
    // A request in a Lead turn Kernel started is automatic. After a few tries at one workspace, the user decides (KERNEL-125).
    // The turn is keyed by the message that started it, so several messages in one turn are one try. Each kind of review
    // counts on its own, so asking one doesn't use up the tries of another.
    const auto = !!leadChatId && this.sessions.kernelTurn(leadChatId)
    const key = kind ? nudgeKey(ws.id, kind) : ws.id
    // A limit or restart nudge carries the turn on, so the turn is still the message before it.
    const turn = auto ? [...this.store.items(leadChatId!)].reverse().find((i) => isSentItem(i) && !(i.from === 'kernel' && isNudge(i.parts)))?.id : undefined
    if (auto && this.nudges.spent(key, turn)) return refuse(`Not sent: Kernel has passed ${NUDGE_LIMIT} automatic requests to ${name} on this ${kind ? `${kind} review` : 'workspace'} and it still needs help. Tell the user what keeps failing and ask how to go on.`)
    if (auto) this.nudges.add(key, turn)
    const parts: ChatPart[] = [{ type: 'text', text }, ...images]
    const who = runner ? { agentId: runner.id } : {}
    const held = this.k.setup.setups.get(ws.id)
    // Setup holds the brief of the review workspace's first chat only. A kind's own chat holds its message itself.
    if (held && !tab) { held.later.push(parts); this.k.setup.saveSetups(); return { ok: true, sent: false, note: `${name}'s workspace is still setting up, so the message goes out with the brief.` } }
    let chat = tab ?? this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    const opened = !chat
    if (!chat) chat = this.saveChat(this.newChat(ws.id, NEW_CHAT, { ...(agent ? this.k.team.pickFor(agent) : this.settings.models.roles.engineers), plan: false }))
    if (held) { this.sessions.hold(chat.id, parts, { from: 'lead' }); return { ok: true, sent: false, note: `${name}'s workspace is still setting up, so the message goes out once setup passes.`, ...who } }
    const { queued, why } = await this.sessions.send(chat.id, parts, { from: 'lead' })
    if (!queued) return { ok: true, sent: true, note: opened ? `Opened a new chat in ${name}'s workspace and sent it.` : kind && kinds.length > 1 ? `Sent to the ${kind} review.` : 'Sent.', ...who }
    const note = why === 'running' ? `${name} is mid-turn, so the message goes out when that turn ends.`
      : why === 'merge' ? `${name} waits for ${this.k.waits.waitLabelOf(this.mustWs(ws.id))} to merge, so this goes out with the brief. To start ${name} now, call wait_for_merge with an empty list.`
      : why === 'setup' ? (this.k.setup.settingUp.has(ws.id) ? `${name}'s workspace is setting up again, so the message goes out with the brief.` : `Setup failed in ${name}'s workspace, so the message waits until the user clicks Run again.`)
      // The same words as create_workspace's brief (KERNEL-272).
      : queuedNote(why, { name }) ?? 'The message waits in the queue.'
    return { ok: true, sent: false, note: opened ? `Opened a new chat in ${name}'s workspace. ${note}` : note, ...who }
  }

  /**
   * The kinds of review a review workspace runs, with the agent that runs each and its latest verdict on the PR, for
   * list_workspaces (feat-review-messages-reach-named). Empty for any other workspace.
   */
  private reviewKinds(workspaceId: string): { kind: ReviewKind; agent: string; verdict?: 'approved' | 'blockers'; current?: boolean }[] {
    const rws = this.store.workspace(workspaceId)
    const of = rws?.reviewOf ? this.store.workspace(rws.reviewOf) : undefined
    if (!rws || !of) return []
    return this.k.reviews.kindsOf(rws).map((kind) => {
      const chat = this.store.chats(rws.id).find((c) => c.lens?.kind === kind)!
      const agent = this.k.reviews.agentForChat(rws, chat)
      const v = [...(of.reviews ?? [])].reverse().find((x) => x.workspaceId === rws.id && lensOf(x) === kind)
      return { kind, agent: agent?.name ?? chat.lens?.agent ?? rws.agentId, ...(v ? { verdict: v.verdict, current: !v.sha || !of.prHead || v.sha === of.prHead } : {}) }
    })
  }

  /**
   * Point the first unlinked step for this agent in the latest plan approved in `chat`'s Lead chat, in any of its tabs, at the
   * new workspace (the card's Open workspace link). Plans from the project's other Lead chats are left alone (KERNEL-105, KERNEL-337).
   */
  private linkPlanStep(projectId: string, agentId: string, workspaceId: string, chat: Chat) {
    const plan = this.threadPlans(projectId, chat).find((a) => a.steps?.some((s) => s.agentId === agentId && !s.workspaceId))
    if (!plan?.steps) return
    const at = plan.steps.findIndex((s) => s.agentId === agentId && !s.workspaceId)
    this.approvals.update(plan.id, { steps: plan.steps.map((s, i) => (i === at ? { ...s, workspaceId } : s)) })
  }

  /**
   * The user sent a message in a chat. The loop guard starts over, and a Lead chat records the send, which puts it on top
   * of the sidebar (KERNEL-498). Kernel's own messages call `sessions.send` or `sessions.post` directly and never come here.
   */
  userSpoke(chatId: string) {
    this.steppedIn(chatId)
    const chat = this.store.chat(chatId)
    const ws = chat && this.store.workspace(chat.workspaceId)
    const thread = ws && isLeadChatWorkspace(ws) ? this.store.thread(ws.threadId!) : undefined
    if (thread) this.pushThread({ ...thread, lastSentAt: Date.now() })
  }

  /**
   * The user wrote in a chat or answered its card, so the loop guard starts over (KERNEL-125): for that workspace, or, in a Lead
   * chat, for every workspace whose updates that chat gets, a closed chat's work included.
   */
  private steppedIn(chatId: string) {
    const chat = this.store.chat(chatId)
    const ws = chat && this.store.workspace(chat.workspaceId)
    if (!ws) return
    if (!this.isLeadWorkspace(ws)) { this.nudges.reset(ws.id); return }
    this.nudges.reset(...this.store.workspaces(ws.projectId).filter((w) => !this.isLeadWorkspace(w) && this.leadUpdateTarget(ws.projectId, w.leadChatId)?.chat.id === chatId).map((w) => w.id))
  }

  /** The newest open Lead chat's first open tab. Unlike `leadChat`, never creates one (KERNEL-405). */
  private existingLeadChat(projectId: string): Chat | undefined {
    for (const ws of this.chatWorkspaces(projectId).reverse()) {
      const tab = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
      if (tab) return tab
    }
    return undefined
  }

  /** A chat tab still on the strip, in a workspace that isn't archived. */
  private isOpenChat(chat: Chat) {
    return !chat.closed && chat.kind !== 'terminal' && this.store.workspace(chat.workspaceId)?.status !== 'archived'
  }

  /**
   * Where teammate updates about work handed off in the tab `owner` go (KERNEL-105, KERNEL-337): that tab while it's open,
   * else the newest open tab of its Lead chat (forks included, since a fork stays in the chat), else its newest open fork
   * from before Lead chats had tabs, else the project's newest open Lead chat, naming the archived chat (KERNEL-405).
   * `from` names where the work came from when it moves: the tab inside its own chat, the chat otherwise. Work no Lead tab
   * handed off goes to the newest open chat. Never creates a tab, and never restores an archived chat.
   */
  leadUpdateTarget(projectId: string, owner?: string): { chat: Chat; from?: From } | undefined {
    const was = owner ? this.store.chat(owner) : undefined
    if (was && this.isOpenChat(was)) return { chat: was }
    const sibling = was && this.store.threadTabs(was.id).filter((c) => c.id !== was.id && this.isOpenChat(c)).at(-1)
    if (sibling) return { chat: sibling, from: { title: was.title, tab: true } }
    const fork = was && this.store.chats(was.workspaceId).filter((c) => c.forkOf?.chatId === was.id && this.isOpenChat(c)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (fork) return { chat: fork }
    const first = this.existingLeadChat(projectId)
    return first && { chat: first, ...(was ? { from: { title: this.chatTitleOf(was) } } : {}) }
  }

  /**
   * The tab of the Build here chat whose own workspace `ws` is, which hears about its PR and its reviews the way a chat hears
   * about work it handed off (KERNEL-778): its first open tab, else its first tab. None for any other workspace, or once the
   * chat is back in Hand off.
   */
  buildTab(ws: Workspace): string | undefined {
    if (!buildsHere(ws) || !this.isLeadWorkspace(ws)) return undefined
    const tabs = this.store.chats(ws.id).filter((c) => c.kind !== 'terminal')
    return (tabs.find((c) => !c.closed) ?? tabs[0])?.id
  }

  /** New Lead chats Kernel is starting for a Team update, by project, so a second update waits for the same chat. */
  private opening = new Map<string, Promise<unknown>>()

  /**
   * A Team update that needs the Lead found no open Lead chat (KERNEL-365). An open chat with no open tab gets a new
   * tab, saved and pushed so the sidebar shows it. With no chat open, Kernel starts a new one, with setup, and the update
   * waits for it (`opening`): an archived chat is never restored for it (KERNEL-405). A project with no Lead has nobody to tell.
   */
  openUpdateTab(projectId: string, owner?: string): { chat: Chat; from?: From } | 'opening' | undefined {
    const found = this.leadUpdateTarget(projectId, owner)
    if (found) return found
    const lead = this.agentsSync(projectId).find((a) => a.lead)
    const project = this.store.project(projectId)
    if (!lead || !project || project.archived) return undefined
    const ws = this.newestChatWorkspace(projectId)
    if (ws) { this.saveChat(this.leadTab(ws, NEW_TAB, this.leadPick(lead))); return this.leadUpdateTarget(projectId, owner) }
    if (!this.opening.has(projectId)) {
      const made = this.newLeadChat(projectId, { prompt: '' }).then(() => { if (!this.stopped) this.leadUpdates.flush(projectId) })
        .catch((e) => { if (!this.stopped) console.warn('[lead] could not start a chat for a Team update', e) })
        .finally(() => this.opening.delete(projectId))
      this.opening.set(projectId, made)
    }
    return 'opening'
  }

  /**
   * Archives the Lead chat `threadId` (KERNEL-405): the open workspaces it handed off first, unless "Archive a chat's
   * workspaces" is off and they stay at project level, then its own. Each goes through the workspace archive, archive script
   * included. Its own sets the chat's `closedAt`. A chat with no workspace of its own, from before KERNEL-405, only closes.
   */
  async archiveLeadChat(threadId: string, o: { withWorkspaces?: boolean } = {}): Promise<void> {
    const t = this.store.thread(threadId)
    if (!t) throw new Error('That chat no longer exists.')
    const project = this.mustProject(t.projectId)
    const withWorkspaces = o.withWorkspaces ?? cleanupSwitch(await loadRepoSettings(project.path), this.settings.workspace, 'archiveChatWorkspaces')
    const open = this.store.workspaces(t.projectId).filter((w) => w.threadId === threadId && w.status !== 'archived')
    if (withWorkspaces) for (const w of open.filter((x) => !x.lead)) await this.k.archiveWorkspace(w.id)
    for (const w of open.filter((x) => x.lead)) await this.k.archiveWorkspace(w.id)
    const now = this.store.thread(threadId)
    if (now && !now.closedAt) this.pushThread({ ...now, closedAt: Date.now() })
  }

  /**
   * What archiving the chat would stop, per workspace, its own last (KERNEL-405): a running agent, an open PR Kernel stops
   * checking, uncommitted changes, or commits that never left this machine. The sidebar archives in one click when no row
   * has any, and asks otherwise.
   */
  async archivePreview(threadId: string): Promise<ChatArchivePreview> {
    const t = this.store.thread(threadId)
    if (!t) throw new Error('That chat no longer exists.')
    const project = this.mustProject(t.projectId)
    const withWorkspaces = cleanupSwitch(await loadRepoSettings(project.path), this.settings.workspace, 'archiveChatWorkspaces')
    const open = this.store.workspaces(t.projectId).filter((w) => w.threadId === threadId && w.status !== 'archived' && (w.lead || withWorkspaces))
    const rows = await Promise.all([...open.filter((w) => !w.lead), ...open.filter((w) => w.lead)].map(async (w) => {
      const pr = w.prNumber && !['none', 'merged', 'closed'].includes(w.prState) ? w.prNumber : undefined
      const base = { id: w.id, name: w.name, own: !!w.lead, running: this.k.archive.working(w.id), ...(pr ? { pr } : {}) }
      // A current-branch workspace removes no files, and neither does a worktree whose folder is already gone (KERNEL-109).
      // Nor does one whose worktree isn't made yet (KERNEL-542).
      if (w.mode !== 'worktree' || w.folderGone || w.worktreePending || await folderGone(w.path).catch(() => false)) return { ...base, dirty: 0, unpushed: 0 }
      try {
        const git = await gitStatus(w.path, w.branch, w.baseRef, await this.k.config.remoteOfWs(w))
        return { ...base, dirty: git.dirty.files, unpushed: git.ahead }
      } catch { return { ...base, dirty: 0, unpushed: 0, unknown: true } }
    }))
    return { threadId, title: t.title, workspaces: rows }
  }

  /** The ids of every tab in `chat`'s Lead chat, closed ones too, and its own. */
  private threadTabIds(chat: Chat) { return new Set(this.store.threadTabs(chat.id).map((c) => c.id).concat(chat.id)) }

  /** Startup's fixes to data from older versions, after the agents load and before any chat carries on. */
  async backfill() {
    this.modeSwitches = this.store.meta<Record<string, LeadMode>>(SWITCHED_DURING) ?? {}
    this.markLeadWorkspaces()
    this.backfillLeadChats()
    await this.moveLeadChats()
  }

  /**
   * Workspaces the Lead created before Kernel saved `leadChatId` (KERNEL-105). Only a Lead chat has the kernel tools, so
   * each finished `create_workspace` in a chat ("Created <id> on <branch> ...") names a workspace that chat handed off.
   * Runs once, after `markLeadWorkspaces`; a workspace it can't place reports to the project's first Lead chat, as before.
   */
  private backfillLeadChats() {
    if (this.store.meta<boolean>('leadChatBackfill')) return
    for (const lead of this.store.workspaces().filter((w) => w.lead)) {
      for (const chat of this.store.chats(lead.id)) {
        for (const item of this.store.items(chat.id)) {
          if (item.kind !== 'tool' || item.name !== 'mcp__kernel__create_workspace' || item.status !== 'done') continue
          const id = /^Created (\S+) on /.exec(item.output ?? '')?.[1]
          const ws = id ? this.store.workspace(id) : undefined
          if (ws && ws.projectId === lead.projectId && !ws.leadChatId) this.store.saveWorkspace({ ...ws, leadChatId: chat.id, ...(chat.threadId ? { threadId: chat.threadId } : {}) })
        }
      }
    }
    this.store.saveMeta('leadChatBackfill', true)
  }

  /**
   * Marks the Lead workspaces made before Kernel saved `lead` (KERNEL-353). They were the Lead agent's workspaces on the main
   * checkout, or, in a project whose agents didn't load, the current-branch workspaces named `lead`. Archived ones too, so History
   * still knows them. Runs once, after the agents load.
   */
  private markLeadWorkspaces() {
    if (this.store.meta<boolean>('leadWorkspaceBackfill')) return
    for (const ws of this.store.workspaces()) {
      if (ws.lead || ws.mode !== 'current') continue
      const agents = this.agentsSync(ws.projectId)
      if (agents.length ? agents.find((a) => a.lead)?.id === ws.agentId : ws.name === 'lead') this.store.saveWorkspace({ ...ws, lead: true })
    }
    this.store.saveMeta('leadWorkspaceBackfill', true)
  }

  handlers() {
    return {
      'projects.overlaps': async ({ projectId }) => this.overlaps.check(projectId),
      'projects.resolveOverlap': async ({ overlapId }) => { await this.sortOverlap(overlapId); return { ok: true } },
      'projects.brief': async ({ projectId, text, parts, agentId }) => {
        let chat: Chat
        if (agentId) {
          const ws = this.store.workspaces(projectId).find((w) => w.agentId === agentId && w.status !== 'archived')
          if (!ws) throw new Error('That agent has no open workspace. Brief Kernel instead.')
          const first = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
          if (!first) throw new Error('That agent has no open chat. Open a new chat in its workspace, or brief Kernel instead.')
          chat = first
        } else chat = await this.leadChat(projectId)
        const message = messageOf(text, parts)
        this.userSpoke(chat.id)
        await this.sessions.send(chat.id, message)
        // The activity line for the brief, with the brief quoted under it.
        const to = this.store.workspace(chat.workspaceId)?.agentId
        const name = (await this.k.team.agents(projectId)).find((a) => a.id === to)?.name ?? 'Kernel'
        const quote = parts ? message.map((p) => (p.type === 'text' ? p.text : p.name)).join(' ').replace(/\s+/g, ' ').trim() : text
        bus.activity({ kind: 'brief', projectId, workspaceId: chat.workspaceId, agentId: to, actor: 'you', text: agentId ? `messaged ${name}` : `briefed ${name}`, quote })
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      // Opening the project shows its newest Lead chat, and none when no chat is open: it starts none (KERNEL-365, KERNEL-405).
      'lead.open': async ({ projectId }) => { await this.leadOf(projectId); return this.newestChatWorkspace(projectId) ?? null },
      'lead.start': async ({ projectId, ...o }) => this.newLeadChat(projectId, o),
      'lead.prefetch': async ({ projectId }) => { this.prefetch(projectId); return { ok: true } },
      'lead.setMode': async ({ workspaceId, mode }) => this.setMode(workspaceId, mode),
      'threads.list': async ({ projectId }) => this.store.threads(projectId),
      'threads.rename': async ({ threadId, title }) => this.renameThread(threadId, title),
      'threads.archivePreview': async ({ threadId }) => this.archivePreview(threadId),
      'threads.archive': async ({ threadId }) => { await this.archiveLeadChat(threadId); return { ok: true } }
    } satisfies Partial<Handlers>
  }
}
