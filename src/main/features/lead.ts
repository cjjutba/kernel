import { existsSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDef, Approval, Chat, ChatArchivePreview, ChatPart, Effort, Provider, QueuedMessage, Room, Thread, Workspace } from '@shared/types'
import { isLeadChatWorkspace, leadChatWorkspaceOf } from '@shared/leadWorkspace'
import { providerOf } from '@shared/providers'
import { newId } from '../db'
import { bus } from '../bus'
import { saveAgent } from '../services/agents'
import { parsePlanSteps } from '../services/approvals'
import { NUDGE_LIMIT } from '../services/nudges'
import { PLANS_DIR, revisedPlanFile, savePlan } from '../services/plans'
import { dropCheckpoints } from '../services/checkpoints'
import { cleanupSwitch, loadRepoSettings } from '../services/settings'
import { gitStatus } from '../services/archive'
import { firstLine } from '../services/text'
import { isNudge } from '../services/sessions'
import { DEFAULT_OPEN_CAP, kernelMcpServer, type KernelToolDeps, queuedNote } from '../services/kernelMcp'
import type { From } from '../services/leadUpdates'
import { branchName, fastForward, fetchOrigin, folderGone, freeBranch, leadBase, renameBranch, shortSlug, slugify } from '../services/worktrees'
import { exec, git } from '../services/exec'
import { messageOf, NEW_CHAT, NEW_TAB } from './shared'
import type { Handlers } from '../kernel'
import type { Workspaces } from './workspaces'
import { Feature } from './feature'

/** The room's Lead: its workspace and chats, its tools, and where teammates' updates go (KERNEL-329). */
export class Lead extends Feature {
  /**
   * A quick question to the room's Lead. It always gets a new Lead tab, so it never queues behind whatever another tab is
   * doing or lands in a tab with a brief being typed (KERNEL-145, D-133). The tab joins the chat `threadId` while it is open,
   * else the room's newest open chat, and starts a new chat, with setup, only when none is open (KERNEL-337, KERNEL-405).
   * The answer arrives there like any turn; the popover reads it from there.
   */
  async askLead(roomId: string, text: string, threadId?: string): Promise<{ chatId: string }> {
    const ws = (threadId ? leadChatWorkspaceOf(this.store.workspaces(roomId), threadId) : undefined) ?? this.newestChatWorkspace(roomId)
    const chat = ws ? await this.tabIn(ws, { prompt: text, plan: false }) : await this.newLeadChat(roomId, { prompt: text, plan: false })
    return { chatId: chat.id }
  }

  /**
   * "Let Rowan sort it": the Lead gets both workspaces and the file, and the card leaves the floor.
   * The overlap itself clears on its own once the agents stop touching the same file.
   */
  async sortOverlap(overlapId: string): Promise<void> {
    const o = this.overlaps.get(overlapId)
    if (!o) throw new Error('That overlap is gone already.')
    const agents = await this.k.team.agents(o.roomId)
    const parts = o.parties.map((p) => `${agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} in ${this.store.workspace(p.workspaceId)?.name ?? p.workspaceId} (${p.lines})`)
    // The Lead chat that handed off the newest of the workspaces hears about it (KERNEL-105), and learns which other Lead chats are
    // involved, by their titles. Other tabs of its own Lead chat aren't another chat (KERNEL-337).
    const owners = o.parties.map((p) => this.store.workspace(p.workspaceId)).filter((w): w is Workspace => !!w).sort((a, b) => b.createdAt - a.createdAt)
    const chat = (owners.length ? this.leadUpdateTarget(o.roomId, owners[0].leadChatId)?.chat : undefined) ?? await this.leadChat(o.roomId)
    const threadOf = (w: Workspace) => w.threadId ?? (w.leadChatId ? this.store.chat(w.leadChatId)?.threadId : undefined)
    const others = [...new Set(owners.map(threadOf).filter((id): id is string => !!id && id !== chat.threadId))].map((id) => this.store.thread(id)?.title).filter(Boolean)
    const elsewhere = others.length ? ` Part of this work was handed off in another Lead chat: ${others.map((t) => `"${t}"`).join(', ')}.` : ''
    const text = `${parts.join(' and ')} both changed ${o.path} in different worktrees, so merging both will conflict. Decide who keeps the change, tell the others, and sort it out before either merges.${elsewhere}`
    await this.sessions.send(chat.id, [{ type: 'text', text }])
    this.overlaps.resolve(overlapId)
    // A note, not a brief: a brief to the Lead would restart the briefing sequence on the floor.
    const lead = agents.find((a) => a.id === this.store.workspace(chat.workspaceId)?.agentId)
    bus.activity({ kind: 'note', roomId: o.roomId, workspaceId: chat.workspaceId, agentId: lead?.id, actor: 'you', text: `asked ${lead?.name ?? 'the Lead'} to sort out the overlap in`, object: o.path.split('/').pop(), quote: text })
  }

  /**
   * The room's Lead is now `leadId`: a file marked Lead, `[team] lead`, or Kernel's own Rowan (KERNEL-397). The Lead's open
   * workspaces go to it with their chats, so the chats with the Lead carry on. Returns the first workspace that moved.
   */
  adoptLeadWorkspace(roomId: string, leadId: string): Workspace | undefined {
    const all = this.store.workspaces(roomId).filter((w) => w.lead && w.agentId !== leadId)
    // Archived ones too, so History still shows them as the Lead's.
    for (const w of all) if (w.status === 'archived') this.updateWs(w.id, { agentId: leadId }, { archived: true })
    const open = all.filter((w) => w.status !== 'archived')
    if (!open.length) return undefined
    const moved = open.map((ws) => this.updateWs(ws.id, { agentId: leadId }))
    bus.activity({ kind: 'note', roomId, workspaceId: moved[0].id, agentId: leadId, actor: 'kernel', text: "handed the Lead's chats to", object: this.agentsSync(roomId).find((a) => a.id === leadId)?.name ?? leadId })
    return moved[0]
  }

  /** The room's Lead agent, or a throw that says how to get one. */
  private async leadOf(roomId: string): Promise<AgentDef> {
    const lead = (await this.k.team.agents(roomId)).find((a) => a.lead)
    if (!lead) throw new Error('No Lead in this room. Mark one agent with "lead: true", or pick one in Settings, Agents.')
    return lead
  }

  /** The workspaces of the room's open chats with Rowan, oldest chat first (KERNEL-405). */
  chatWorkspaces(roomId: string): Workspace[] {
    const born = (w: Workspace) => this.store.thread(w.threadId!)?.createdAt ?? w.createdAt
    return this.store.workspaces(roomId).filter((w) => isLeadChatWorkspace(w) && w.status !== 'archived').sort((a, b) => born(a) - born(b) || a.createdAt - b.createdAt)
  }

  /** The workspace of the room's newest open chat with Rowan, the one Ask Rowan and Kernel's own sends join (KERNEL-405). */
  newestChatWorkspace(roomId: string): Workspace | undefined { return this.chatWorkspaces(roomId).at(-1) }

  /**
   * A new chat with Rowan in its own workspace (KERNEL-405): the chat, a worktree on its own branch from the latest
   * `<remote>/<default>` after a fetch, or from `baseRef`, and its first tab. The first message waits in the tab's queue until
   * files.copy and setup pass, unless "Wait for setup" is off. Returns at once with the tab, and setup runs on its own, like a
   * fork's. A room with no commit keeps Rowan on the checkout with no setup, as before KERNEL-355.
   */
  async newLeadChat(roomId: string, o: { prompt: string; parts?: ChatPart[]; provider?: Provider; model?: string; effort?: Effort; plan?: boolean; baseRef?: string }): Promise<Chat> {
    const lead = await this.leadOf(roomId)
    const role = this.k.team.pickFor(lead)
    // A model picked in New Lead chat runs on its own provider. Otherwise the Lead's pin or its role decides (KERNEL-406).
    const pick = { provider: o.model ? o.provider ?? providerOf(o.model) : role.provider, model: o.model ?? role.model, effort: o.effort ?? role.effort, plan: o.plan ?? this.settings.models.leadPlanMode }
    const thread = this.pushThread({ id: newId(), roomId, title: NEW_TAB, createdAt: Date.now() })
    let cut: Awaited<ReturnType<Workspaces['cutWorkspace']>>
    try { cut = await this.k.workspaces.cutWorkspace(roomId, { prompt: o.prompt, parts: o.parts, ...pick, baseRef: o.baseRef, lead: { threadId: thread.id } }) }
    catch (e) { this.store.deleteThread(thread.id); throw e }
    const { ws, room, repo } = cut
    const chat = this.saveChat(cut.chat)
    this.userSpoke(chat.id)
    const parts = messageOf(o.prompt, o.parts)
    if (ws.mode === 'current') {
      this.updateWs(ws.id, { status: 'ready' })
      if (parts.length) await this.sessions.send(chat.id, parts)
      return chat
    }
    if (cleanupSwitch(repo, this.settings.workspace, 'leadWaitForSetup')) this.sessions.hold(chat.id, parts.length ? parts : undefined)
    else if (parts.length) await this.sessions.send(chat.id, parts)
    void this.k.workspaces.setUpWorkspace(ws, room, repo, chat).then(() => { if (!this.stopped) this.leadUpdates.flush(roomId) }, (e) => {
      // A Kernel that stopped meanwhile has closed its database. The next launch finds the workspace in setup and fails it.
      if (this.stopped) return
      console.warn(`[lead] setting up ${ws.name} failed`, e)
      if (this.store.workspace(ws.id)?.status === 'setup') this.updateWs(ws.id, { status: 'failed' })
    })
    return chat
  }

  /** Syncs of each chat's worktree, by workspace, so two never run git in it at once. */
  private syncing = new Map<string, Promise<void>>()
  /** The last refusal logged, by workspace: the target's sha and the reason, so each is logged once per sha. */
  private refused = new Map<string, string>()

  /**
   * Keeps each chat with Rowan on the latest main (KERNEL-181, KERNEL-405): a fast-forward of its branch to the base it started
   * from, only while that chat is idle, has nothing queued, and has no commits of its own and no tracked file changed. It never
   * merges or rebases. `fetch` fetches once first, after a merge, then syncs every open chat. `workspaceId` syncs only that chat.
   */
  async syncLead(roomId: string, o: { fetch?: boolean; workspaceId?: string } = {}): Promise<void> {
    const failed = (e: unknown) => { if (!this.k.stopped) console.warn("[lead] could not update the Lead's worktree", e) }
    // The fetch runs outside the queue, so a new tab's sync never waits on the network behind it.
    if (o.fetch) {
      const room = this.k.stopped ? undefined : this.store.room(roomId)
      if (!room) return
      const fetched = await this.k.config.remoteFor(room.path).then((remote) => fetchOrigin(room.path, remote, { fresh: true })).then(() => true, (e) => { failed(e); return false })
      if (!fetched) return
    }
    if (this.k.stopped) return
    const ids = o.workspaceId ? [o.workspaceId] : this.chatWorkspaces(roomId).map((w) => w.id)
    await Promise.all(ids.map((id) => {
      const next = (this.syncing.get(id) ?? Promise.resolve()).then(() => this.syncNow(id)).catch(failed)
      this.syncing.set(id, next)
      void next.finally(() => { if (this.syncing.get(id) === next) this.syncing.delete(id) })
      return next
    }))
  }

  private async syncNow(id: string) {
    // A stopped Kernel's database is closed, so a sync still in flight reads nothing more from it and logs nothing.
    if (this.k.stopped) return
    const ws = this.store.workspace(id)
    const room = ws && this.store.room(ws.roomId)
    const lead = ws && this.agentsSync(ws.roomId).find((a) => a.lead)
    // A chat still setting up, or one whose setup failed, isn't moved under its setup.
    if (!ws || !room || room.archived || !lead || !ws.lead || ws.status !== 'ready' || ws.mode !== 'worktree' || ws.folderGone) return
    // Read again after each step that waits on git: a turn can start while git runs, and the files mustn't move under it.
    const held = () => this.k.stopped || this.store.chats(ws.id).some((c) => this.sessions.isRunning(c.id) || this.sessions.queued(c.id).length > 0)
    if (held() || await folderGone(ws.path).catch(() => true)) return
    // The base it started from: `<remote>/<default>`, or the branch picked in New chat. One that's gone leaves it be.
    const target = ws.baseRef
    if ((await exec('git', ['-C', room.path, 'rev-parse', '--verify', '--quiet', `${target}^{commit}`])).code !== 0) return
    const count = async (range: string) => Number((await git(ws.path, 'rev-list', '--count', range)).trim())
    const behind = await count(`HEAD..${target}`)
    if (!behind) return
    const sha = (await git(room.path, 'rev-parse', target)).trim()
    const own = await count(`${target}..HEAD`)
    const changed = !own && (await git(ws.path, 'status', '--porcelain', '--untracked-files=no')).trim() !== ''
    if (held()) return
    const why = own ? `it has ${own === 1 ? 'a commit' : `${own} commits`} of its own` : changed ? 'tracked files have changes' : !(await fastForward(ws.path, target)) ? 'git refused the fast-forward' : undefined
    if (this.k.stopped) return
    if (why) {
      if (this.refused.get(id) === `${sha} ${why}`) return
      this.refused.set(id, `${sha} ${why}`)
      bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: ws.id, agentId: lead.id, actor: 'kernel', text: `didn't update ${lead.name}'s worktree to ${target}:`, object: why, warn: true })
      return
    }
    this.refused.delete(id)
    bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: ws.id, agentId: lead.id, actor: 'kernel', text: `updated ${lead.name}'s worktree to ${target}, ${behind === 1 ? '1 new commit' : `${behind} new commits`}` })
    void this.k.workspaces.changes(ws.id).catch(() => undefined)
  }

  /**
   * Moves the chats with Rowan from the room's one shared Lead workspace into a workspace each, once, at startup after the
   * agents load and before any chat carries on (KERNEL-405). Without a fetch: each chat starts from `<remote>/<default>` as
   * last fetched. An open chat gets a worktree on its own branch, and every tab of it, closed ones too, moves there with the
   * plans its chats wrote. Its chats resume by their session ids from the new folder (KERNEL-348). Setup runs with the chat
   * held. Then the shared record is archived and its worktree folder goes, without the archive script. A shared record on the
   * main checkout leaves the files alone. Closed chats stay with the old record. A room that fails tries again at the next
   * start, and a chat that already moved isn't moved twice.
   */
  private async moveLeadChats() {
    if (this.store.meta<boolean>('leadChatsMoved')) return
    let ok = true
    for (const old of this.store.workspaces().filter((w) => w.lead && !w.threadId && w.status !== 'archived')) {
      const room = this.store.room(old.roomId)
      if (!room || room.archived) continue
      try { await this.moveRoomChats(old, room) } catch (e) { ok = false; console.warn(`[lead] could not give ${room.name}'s chats with the Lead a workspace each, trying again at the next start`, e) }
    }
    if (ok) this.store.saveMeta('leadChatsMoved', true)
  }

  private async moveRoomChats(old: Workspace, room: Room) {
    const lead = this.agentsSync(room.id).find((a) => a.lead)
    // A room with no commit to start from keeps its chats where they are, on the checkout.
    if (!lead || !(await leadBase(room.path, await this.k.config.remoteFor(room.path)))) return
    const tabs = this.store.chats(old.id)
    const open = this.store.threads(room.id).filter((t) => !t.closedAt && tabs.some((c) => c.threadId === t.id && !c.closed && c.kind !== 'terminal'))
    for (const t of open) {
      // A start cut short after this chat moved already finds its workspace.
      if (this.store.workspaces(room.id).some((w) => isLeadChatWorkspace(w) && w.threadId === t.id)) continue
      const own = tabs.filter((c) => c.threadId === t.id)
      const first = own.find((c) => !c.closed && c.kind !== 'terminal')!
      const { ws, repo } = await this.k.workspaces.cutWorkspace(room.id, { prompt: t.title === NEW_TAB ? '' : t.title, model: first.model, effort: first.effort, plan: first.plan, lead: { threadId: t.id }, noFetch: true })
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
      bus.activity({ kind: 'note', roomId: room.id, workspaceId: ws.id, agentId: lead.id, actor: 'kernel', text: `gave the chat "${t.title}" its own worktree:`, object: ws.branch })
      void this.k.workspaces.setUpWorkspace(this.mustWs(ws.id), room, repo, chat, { checkpoint: false }).catch((e) => {
        if (this.stopped) return
        console.warn(`[lead] setting up ${ws.name} failed`, e)
        if (this.store.workspace(ws.id)?.status === 'setup') this.updateWs(ws.id, { status: 'failed' })
      })
    }
    // The old record's open big terminals belonged to no chat. They close with it.
    for (const c of this.chatTabs(old.id)) if (c.kind === 'terminal') this.saveChat({ ...c, closed: true })
    // On the checkout nothing is removed. A worktree goes, with no archive script: it ran none of the room's scripts.
    await this.k.archive.archiveWorkspace(old.id, false, { removingRoom: true, noScript: true })
    // Its checkpoints were snapshots of a folder no chat works in any more, and History doesn't list it to delete them.
    await dropCheckpoints(room.path, old.id).catch(() => undefined)
  }

  /**
   * The newest open chat with Rowan's first tab, for Kernel's own sends: floor briefs, an overlap, a comment on a shared file.
   * With no chat open, a new one, with setup (KERNEL-405). Opening the room doesn't come here, so it starts no chat (KERNEL-365).
   */
  async leadChat(roomId: string): Promise<Chat> {
    const ws = this.newestChatWorkspace(roomId)
    const open = ws && this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    if (open) return open
    if (ws) return this.saveChat(this.leadTab(ws, NEW_TAB, this.leadPick(await this.leadOf(roomId))))
    return this.newLeadChat(roomId, { prompt: '' })
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
  async startLeadChat(roomId: string, o: { prompt: string; parts?: ChatPart[]; provider?: Provider; model?: string; effort?: Effort; plan?: boolean; baseRef?: string }, threadId?: string): Promise<Chat> {
    const ws = threadId ? leadChatWorkspaceOf(this.store.workspaces(roomId), threadId) : undefined
    return ws ? this.tabIn(ws, o) : this.newLeadChat(roomId, o)
  }

  /** A new tab in the open chat `ws` hosts, with the message. A chat on the latest main as last fetched catches up first. */
  private async tabIn(ws: Workspace, o: { prompt: string; parts?: ChatPart[]; provider?: Provider; model?: string; effort?: Effort; plan?: boolean }): Promise<Chat> {
    const lead = await this.leadOf(ws.roomId)
    const role = this.k.team.pickFor(lead)
    // A model picked in New Lead chat runs on its own provider. Otherwise the Lead's pin or its role decides (KERNEL-406).
    const pick = { provider: o.model ? o.provider ?? providerOf(o.model) : role.provider, model: o.model ?? role.model, effort: o.effort ?? role.effort, plan: o.plan ?? this.settings.models.leadPlanMode }
    await this.syncLead(ws.roomId, { workspaceId: ws.id })
    const chat = this.saveChat(this.leadTab(this.mustWs(ws.id), NEW_TAB, pick))
    this.userSpoke(chat.id)
    await this.sessions.send(chat.id, messageOf(o.prompt, o.parts))
    return chat
  }

  /**
   * A new tab in a chat with Rowan (KERNEL-337), the one its workspace hosts (KERNEL-405). The old shared Lead workspace hosts
   * none, so there `threadId` names the chat, or the tab starts one. A tab opened while the chat's first message waits for
   * setup or trust waits with it. Saved, not pushed, like `newChat`.
   */
  leadTab(ws: Workspace, title: string, o: { provider?: Provider; model: string; effort: Effort; plan: boolean }, threadId?: string): Chat {
    const id = ws.threadId ?? threadId
    const thread = id ? this.store.thread(id) : undefined
    if (id && thread?.roomId !== ws.roomId) throw new Error('That chat no longer exists.')
    const held = ws.status !== 'ready' && this.chatTabs(ws.id).some((c) => this.sessions.isHeld(c.id))
    const chat = this.newChat(ws.id, title, { ...o, threadId: (thread ?? this.pushThread({ id: newId(), roomId: ws.roomId, title, createdAt: Date.now() })).id })
    if (held) this.sessions.hold(chat.id)
    return chat
  }

  private pushThread(t: Thread): Thread {
    this.store.saveThread(t)
    bus.push({ type: 'thread', thread: t })
    return t
  }

  /**
   * Kernel named a Lead tab. The first tab of a Lead chat names the chat too, until the user names the chat (KERNEL-337), and
   * the chat's branch follows the name while it was never pushed and has no PR (KERNEL-405).
   */
  tabNamed(chat: Chat) {
    const t = chat.threadId ? this.store.thread(chat.threadId) : undefined
    if (!t || t.renamed || t.title === chat.title || this.store.threadTabs(chat.id)[0]?.id !== chat.id) return
    this.pushThread({ ...t, title: chat.title })
    const ws = this.store.workspace(chat.workspaceId)
    if (ws && isLeadChatWorkspace(ws) && ws.threadId === t.id) void this.renameChatBranch(ws.id, chat.title).catch((e) => { if (!this.stopped) console.warn(`[lead] could not rename ${ws.branch}`, e) })
  }

  /** Branch renames under way, by workspace, so two names arriving together run one after the other. */
  private renaming = new Map<string, Promise<void>>()

  /**
   * Names a chat with Rowan's branch from the chat's title, `rowan/plan-wave-3` (KERNEL-405), as long as it was never pushed and
   * has no PR: a branch on GitHub or behind a PR keeps its name. The workspace's name follows.
   */
  renameChatBranch(id: string, title: string): Promise<void> {
    const next = (this.renaming.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const ws = this.store.workspace(id)
      if (!ws || this.stopped || ws.status === 'archived' || ws.mode !== 'worktree' || ws.branch === 'HEAD' || ws.prNumber || ws.prState !== 'none') return
      const room = this.mustRoom(ws.roomId)
      const repo = await loadRepoSettings(room.path)
      const lead = this.agentsSync(room.id).find((a) => a.lead)
      const wanted = branchName(repo.workspace.leadBranchPattern || this.settings.workspace.leadBranchPattern, { slug: shortSlug(title), lead: lead?.name })
      if (wanted === ws.branch) return
      // Pushed under its name, or tracking anything but the base it was cut from, which git sets as its upstream.
      const remote = await this.k.config.remoteFor(room.path, repo)
      const upstream = await exec('git', ['-C', room.path, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${ws.branch}@{u}`])
      const pushed = (await exec('git', ['-C', room.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${ws.branch}`])).code === 0
        || (upstream.code === 0 && upstream.stdout.trim() !== ws.baseRef)
      if (pushed) return
      // Two chats with Rowan named at once could pick the same free name, so the pick and the rename take the room's lock (KERNEL-231).
      const to = await this.k.workspaces.withBranchLock(room.id, async () => {
        const free = await freeBranch(room.path, wanted)
        if (this.stopped || this.store.workspace(id)?.branch !== ws.branch) return undefined
        await renameBranch(ws.path, free)
        return free
      })
      if (!to) return
      this.updateWs(id, { branch: to, name: slugify(title) })
    })
    this.renaming.set(id, next)
    void next.finally(() => { if (this.renaming.get(id) === next) this.renaming.delete(id) }).catch(() => undefined)
    return next
  }

  private renameThread(threadId: string, title: string): Thread {
    const t = this.store.thread(threadId)
    if (!t) throw new Error('That chat no longer exists.')
    const name = title.trim()
    if (!name) throw new Error('Give the chat a name.')
    return this.pushThread({ ...t, title: name, renamed: true })
  }

  /** The Lead chat a tab is in, for the "From" line: its thread's title, or the tab's when it has none. */
  private chatTitleOf(chat: Chat) { return (chat.threadId && this.store.thread(chat.threadId)?.title) || chat.title }

  /** Plans approved in any tab of `chat`'s Lead chat, newest first (KERNEL-337). */
  private threadPlans(roomId: string, chat: Chat): Approval[] {
    const tabs = this.threadTabIds(chat)
    return this.store.approvals({ roomId }).filter((a) => a.kind === 'plan' && a.status === 'allowed' && !!a.chatId && tabs.has(a.chatId)).sort((a, b) => b.createdAt - a.createdAt)
  }

  leadTools(roomId: string, lead: AgentDef, chat: Chat) {
    return kernelMcpServer(this.leadToolDeps(roomId, lead, chat))
  }

  /** What the Lead's tools call, apart from the server so tests can run the tools against a real Kernel. */
  leadToolDeps(roomId: string, lead: AgentDef, chat: Chat): KernelToolDeps {
    return {
      roomId, lead,
      agents: () => this.k.team.agents(roomId),
      workspaces: () => this.store.workspaces(roomId),
      chatId: chat.id,
      // The Lead chat a tab is in names the work it handed off, and every tab of this one's counts as this tab's (KERNEL-337).
      chatTitle: (id) => { const c = this.store.chat(id); return c && this.chatTitleOf(c) },
      ownTab: (id) => this.threadTabIds(chat).has(id),
      plans: () => this.threadPlans(roomId, chat).map((a) => ({ tab: this.store.chat(a.chatId!)?.title ?? '', at: a.createdAt, plan: a.detail ?? '' })),
      // The saved chat, not `chat`: the toggle can change after the session starts (KERNEL-176).
      planMode: () => !!this.store.chat(chat.id)?.plan,
      createWorkspace: async ({ issue, ...o }) => {
        // Only plans approved in this Lead chat, in any of its tabs (KERNEL-337). Another chat's plan with a step for the same
        // agent is a different hand-off.
        const tabs = this.threadTabIds(chat)
        const approvalIds = new Set(this.store.approvals({ roomId }).filter((a) => a.kind === 'plan' && !!a.chatId && tabs.has(a.chatId)).map((a) => a.id))
        // The issue the task builds (D-140). Kernel names the branch from it unless the Lead named one (KERNEL-275).
        const linked = issue ? await this.k.integrations.issueSource(issue, o.title ?? firstLine(o.prompt)) : undefined
        const branch = o.branch
        // A review is not a task of the plan, so it takes no plan step or Board task (KERNEL-130).
        const review = o.reviewOf ?? o.linkReviewOf
        const ws = await this.k.workspaces.createWorkspace(roomId, { ...o, ...(linked ? { source: linked.source, labels: linked.labels } : {}), ...(branch ? { branch } : {}), mode: o.mode, leadChatId: chat.id, taskFor: review ? undefined : (w) => this.tasks.link(roomId, o.agentId, w.id, { approvalIds })?.id })
        if (!review) this.linkPlanStep(roomId, o.agentId, ws.id, chat)
        // Rowan named no wait, but Linear says the issue is blocked by one a teammate is building (KERNEL-263).
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
      // Settings, Models' agent limit, or three when it is 0 (KERNEL-220).
      agentCap: () => this.settings.models.agentLimit || DEFAULT_OPEN_CAP,
      messageWorkspace: (workspaceId, text) => this.messageWorkspace(roomId, workspaceId, text, chat.id),
      askUser: async (o) => {
        // The card goes in the chat Rowan is blocked in, wherever that is, and shows in the Inbox too.
        const agents = await this.k.team.agents(roomId)
        const reuse = o.kind === 'plan' ? revisedPlanFile(this.store.approvals({ roomId }), chat.id) : undefined
        const { approval, decision } = this.approvals.request({
          kind: o.kind, source: 'sdk', roomId, workspaceId: chat.workspaceId, chatId: chat.id, agentId: lead.id, title: o.title, detail: o.detail, options: o.options, questions: o.questions,
          steps: o.steps && parsePlanSteps(o.steps, agents), agentFile: o.agentFile
        })
        this.sessions.placeApproval(chat.id, approval.id)
        // Saved like ExitPlanMode's plan, so a chat can build from it after the card is gone (D-092, KERNEL-373).
        const ws = this.store.workspace(chat.workspaceId)
        // `update` skips an approval that is gone. The catch covers a store closed while the file was written, as on quit
        // (KERNEL-383).
        if (o.kind === 'plan' && o.detail?.trim() && ws && existsSync(ws.path)) {
          void savePlan(ws.path, o.detail, { fallback: o.title, reuse }).then((planFile) => { this.approvals.update(approval.id, { planFile }) }).catch(() => undefined)
        }
        // An answer is the user stepping in, so the loop guard starts over for this chat's work (KERNEL-125).
        return decision.then((d) => { if (d) this.userSpoke(chat.id); return d })
      },
      archiveWorkspace: (id) => this.k.archiveWorkspace(id),
      // The setting and the turn are read on each call: the switch can change, and each message starts a new turn (KERNEL-352).
      mergeWorkspace: (id) => this.k.prs.mergePr(id),
      leadMerge: () => this.settings.pr.leadMerge,
      userTurn: () => !this.sessions.kernelTurn(chat.id),
      setWait: (id, on) => this.k.waits.setWait(id, on),
      refreshPr: (id) => this.k.refreshPr(id, { settle: true }),
      isRunning: (id) => this.k.archive.working(id),
      // The sidebar's check before a one-click archive. A current-branch workspace removes no files, and neither does a
      // worktree whose folder is already gone (KERNEL-109).
      unsaved: (id) => this.k.archive.unsavedOf(id),
      planApproved: () => this.sessions.planApproved(chat.id),
      handedOff: () => this.sessions.handoffs.done(chat.id),
      hireAgent: async (a) => {
        const was = this.k.team.agentCache.get(roomId) ?? await this.k.team.agents(roomId)
        const file = await saveAgent(this.mustRoom(roomId).path, a)
        this.k.team.announceTeam(roomId, await this.k.team.agents(roomId), was)
        return file
      }
    }
  }

  /**
   * The Lead's `message_agent` (KERNEL-118). It sends only into an open workspace of this room that has its folder and
   * isn't the Lead's own, opening a chat there when none is open, and says what really happened: sent, waiting for the
   * teammate's turn, for setup, for a paused room, for the connection or for a free slot. A message sent while setup
   * runs goes with the brief.
   */
  private async messageWorkspace(roomId: string, workspaceId: string, text: string, leadChatId?: string): Promise<{ ok: boolean; sent: boolean; note: string }> {
    const refuse = (note: string) => ({ ok: false, sent: false, note })
    const ws = this.store.workspace(workspaceId)
    if (!ws || ws.roomId !== roomId) return refuse(`Not sent: there is no workspace ${workspaceId} in this room. Call list_workspaces for the ids.`)
    if (ws.status === 'archived') return refuse(`Not sent: ${ws.name} is archived. Ask the user to restore it from History, or hand the work out again with create_workspace.`)
    const agent = (await this.k.team.agents(roomId)).find((a) => a.id === ws.agentId)
    if (agent?.lead) return refuse('Not sent: that is your own workspace.')
    if (ws.mode === 'worktree' && await folderGone(ws.path).catch(() => false)) return refuse(`Not sent: ${ws.name}'s folder is gone. Ask the user to archive it, or hand the work out again with create_workspace.`)
    const name = agent?.name ?? ws.agentId
    // A request in a Lead turn Kernel started is automatic. After a few tries at one workspace, the user decides (KERNEL-125).
    // The turn is keyed by the message that started it, so several messages in one turn are one try.
    const auto = !!leadChatId && this.sessions.kernelTurn(leadChatId)
    // A limit or restart nudge carries the turn on, so the turn is still the message before it.
    const turn = auto ? [...this.store.items(leadChatId!)].reverse().find((i) => i.kind === 'user' && !(i.from === 'kernel' && isNudge(i.parts)))?.id : undefined
    if (auto && this.nudges.spent(ws.id, turn)) return refuse(`Not sent: Kernel has passed ${NUDGE_LIMIT} automatic requests to ${name} on this workspace and it still needs help. Tell the user what keeps failing and ask how to go on.`)
    if (auto) this.nudges.add(ws.id, turn)
    const parts: ChatPart[] = [{ type: 'text', text }]
    const held = this.k.setup.setups.get(ws.id)
    if (held) { held.later.push(parts); this.k.setup.saveSetups(); return { ok: true, sent: false, note: `${name}'s workspace is still setting up, so the message goes out with the brief.` } }
    let chat = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    const opened = !chat
    if (!chat) chat = this.saveChat(this.newChat(ws.id, NEW_CHAT, { ...(agent ? this.k.team.pickFor(agent) : this.settings.models.roles.engineers), plan: false }))
    const { queued, why } = await this.sessions.send(chat.id, parts, { from: 'lead' })
    if (!queued) return { ok: true, sent: true, note: opened ? `Opened a new chat in ${name}'s workspace and sent it.` : 'Sent.' }
    const note = why === 'running' ? `${name} is mid-turn, so the message goes out when that turn ends.`
      : why === 'merge' ? `${name} waits for ${this.k.waits.waitLabelOf(this.mustWs(ws.id))} to merge, so this goes out with the brief. To start ${name} now, call wait_for_merge with an empty list.`
      : why === 'setup' && ws.status === 'trust' ? `${name}'s workspace waits for the user to trust this room's scripts, so the message goes out with the brief.`
      : why === 'setup' ? (this.k.setup.settingUp.has(ws.id) ? `${name}'s workspace is setting up again, so the message goes out with the brief.` : `Setup failed in ${name}'s workspace, so the message waits until the user clicks Run again.`)
      // The same words as create_workspace's brief (KERNEL-272).
      : queuedNote(why, { name }) ?? 'The message waits in the queue.'
    return { ok: true, sent: false, note: opened ? `Opened a new chat in ${name}'s workspace. ${note}` : note }
  }

  /**
   * Point the first unlinked step for this agent in the latest plan approved in `chat`'s Lead chat, in any of its tabs, at the
   * new workspace (the card's Open workspace link). Plans from the room's other Lead chats are left alone (KERNEL-105, KERNEL-337).
   */
  private linkPlanStep(roomId: string, agentId: string, workspaceId: string, chat: Chat) {
    const plan = this.threadPlans(roomId, chat).find((a) => a.steps?.some((s) => s.agentId === agentId && !s.workspaceId))
    if (!plan?.steps) return
    const at = plan.steps.findIndex((s) => s.agentId === agentId && !s.workspaceId)
    this.approvals.update(plan.id, { steps: plan.steps.map((s, i) => (i === at ? { ...s, workspaceId } : s)) })
  }

  /**
   * The user wrote in a chat, so the loop guard starts over (KERNEL-125): for that workspace, or, in a Lead chat, for every
   * workspace whose updates that chat gets, a closed chat's work included.
   */
  userSpoke(chatId: string) {
    const chat = this.store.chat(chatId)
    const ws = chat && this.store.workspace(chat.workspaceId)
    if (!ws) return
    if (!this.isLeadWorkspace(ws)) { this.nudges.reset(ws.id); return }
    this.nudges.reset(...this.store.workspaces(ws.roomId).filter((w) => !this.isLeadWorkspace(w) && this.leadUpdateTarget(ws.roomId, w.leadChatId)?.chat.id === chatId).map((w) => w.id))
  }

  /** The newest open chat with Rowan's first open tab. Unlike `leadChat`, never creates one (KERNEL-405). */
  private existingLeadChat(roomId: string): Chat | undefined {
    for (const ws of this.chatWorkspaces(roomId).reverse()) {
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
   * from before Lead chats had tabs, else the room's newest open chat with Rowan, naming the archived chat (KERNEL-405).
   * `from` names where the work came from when it moves: the tab inside its own chat, the chat otherwise. Work no Lead tab
   * handed off goes to the newest open chat. Never creates a tab, and never restores an archived chat.
   */
  leadUpdateTarget(roomId: string, owner?: string): { chat: Chat; from?: From } | undefined {
    const was = owner ? this.store.chat(owner) : undefined
    if (was && this.isOpenChat(was)) return { chat: was }
    const sibling = was && this.store.threadTabs(was.id).filter((c) => c.id !== was.id && this.isOpenChat(c)).at(-1)
    if (sibling) return { chat: sibling, from: { title: was.title, tab: true } }
    const fork = was && this.store.chats(was.workspaceId).filter((c) => c.forkOf?.chatId === was.id && this.isOpenChat(c)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (fork) return { chat: fork }
    const first = this.existingLeadChat(roomId)
    return first && { chat: first, ...(was ? { from: { title: this.chatTitleOf(was) } } : {}) }
  }

  /** New chats with Rowan Kernel is starting for a Team update, by room, so a second update waits for the same chat. */
  private opening = new Map<string, Promise<unknown>>()

  /**
   * A Team update that needs the Lead found no open chat with Rowan (KERNEL-365). An open chat with no open tab gets a new
   * tab, saved and pushed so the sidebar shows it. With no chat open, Kernel starts a new one, with setup, and the update
   * waits for it (`opening`): an archived chat is never restored for it (KERNEL-405). A room with no Lead has nobody to tell.
   */
  openUpdateTab(roomId: string, owner?: string): { chat: Chat; from?: From } | 'opening' | undefined {
    const found = this.leadUpdateTarget(roomId, owner)
    if (found) return found
    const lead = this.agentsSync(roomId).find((a) => a.lead)
    const room = this.store.room(roomId)
    if (!lead || !room || room.archived) return undefined
    const ws = this.newestChatWorkspace(roomId)
    if (ws) { this.saveChat(this.leadTab(ws, NEW_TAB, this.leadPick(lead))); return this.leadUpdateTarget(roomId, owner) }
    if (!this.opening.has(roomId)) {
      const made = this.newLeadChat(roomId, { prompt: '' }).then(() => { if (!this.stopped) this.leadUpdates.flush(roomId) })
        .catch((e) => { if (!this.stopped) console.warn('[lead] could not start a chat for a Team update', e) })
        .finally(() => this.opening.delete(roomId))
      this.opening.set(roomId, made)
    }
    return 'opening'
  }

  /**
   * Archives the chat with Rowan `threadId` (KERNEL-405): the open workspaces it handed off first, unless "Archive a chat's
   * workspaces" is off and they stay at room level, then its own. Each goes through the workspace archive, archive script
   * included. Its own sets the chat's `closedAt`. A chat with no workspace of its own, from before KERNEL-405, only closes.
   */
  async archiveLeadChat(threadId: string, o: { withWorkspaces?: boolean } = {}): Promise<void> {
    const t = this.store.thread(threadId)
    if (!t) throw new Error('That chat no longer exists.')
    const room = this.mustRoom(t.roomId)
    const withWorkspaces = o.withWorkspaces ?? cleanupSwitch(await loadRepoSettings(room.path), this.settings.workspace, 'archiveChatWorkspaces')
    const open = this.store.workspaces(t.roomId).filter((w) => w.threadId === threadId && w.status !== 'archived')
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
    const room = this.mustRoom(t.roomId)
    const withWorkspaces = cleanupSwitch(await loadRepoSettings(room.path), this.settings.workspace, 'archiveChatWorkspaces')
    const open = this.store.workspaces(t.roomId).filter((w) => w.threadId === threadId && w.status !== 'archived' && (w.lead || withWorkspaces))
    const rows = await Promise.all([...open.filter((w) => !w.lead), ...open.filter((w) => w.lead)].map(async (w) => {
      const pr = w.prNumber && !['none', 'merged', 'closed'].includes(w.prState) ? w.prNumber : undefined
      const base = { id: w.id, name: w.name, own: !!w.lead, running: this.k.archive.working(w.id), ...(pr ? { pr } : {}) }
      // A current-branch workspace removes no files, and neither does a worktree whose folder is already gone (KERNEL-109).
      if (w.mode !== 'worktree' || w.folderGone || await folderGone(w.path).catch(() => false)) return { ...base, dirty: 0, unpushed: 0 }
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
    this.markLeadWorkspaces()
    this.backfillLeadChats()
    await this.moveLeadChats()
  }

  /**
   * Workspaces the Lead created before Kernel saved `leadChatId` (KERNEL-105). Only a Lead chat has the kernel tools, so
   * each finished `create_workspace` in a chat ("Created <id> on <branch> ...") names a workspace that chat handed off.
   * Runs once, after `markLeadWorkspaces`; a workspace it can't place reports to the room's first Lead chat, as before.
   */
  private backfillLeadChats() {
    if (this.store.meta<boolean>('leadChatBackfill')) return
    for (const lead of this.store.workspaces().filter((w) => w.lead)) {
      for (const chat of this.store.chats(lead.id)) {
        for (const item of this.store.items(chat.id)) {
          if (item.kind !== 'tool' || item.name !== 'mcp__kernel__create_workspace' || item.status !== 'done') continue
          const id = /^Created (\S+) on /.exec(item.output ?? '')?.[1]
          const ws = id ? this.store.workspace(id) : undefined
          if (ws && ws.roomId === lead.roomId && !ws.leadChatId) this.store.saveWorkspace({ ...ws, leadChatId: chat.id, ...(chat.threadId ? { threadId: chat.threadId } : {}) })
        }
      }
    }
    this.store.saveMeta('leadChatBackfill', true)
  }

  /**
   * Marks the Lead workspaces made before Kernel saved `lead` (KERNEL-353). They were the Lead agent's workspaces on the main
   * checkout, or, in a room whose agents didn't load, the current-branch workspaces named `lead`. Archived ones too, so History
   * still knows them. Runs once, after the agents load.
   */
  private markLeadWorkspaces() {
    if (this.store.meta<boolean>('leadWorkspaceBackfill')) return
    for (const ws of this.store.workspaces()) {
      if (ws.lead || ws.mode !== 'current') continue
      const agents = this.agentsSync(ws.roomId)
      if (agents.length ? agents.find((a) => a.lead)?.id === ws.agentId : ws.name === 'lead') this.store.saveWorkspace({ ...ws, lead: true })
    }
    this.store.saveMeta('leadWorkspaceBackfill', true)
  }

  handlers() {
    return {
      'rooms.overlaps': async ({ roomId }) => this.overlaps.check(roomId),
      'rooms.resolveOverlap': async ({ overlapId }) => { await this.sortOverlap(overlapId); return { ok: true } },
      'rooms.brief': async ({ roomId, text, parts, agentId }) => {
        let chat: Chat
        if (agentId) {
          const ws = this.store.workspaces(roomId).find((w) => w.agentId === agentId && w.status !== 'archived')
          if (!ws) throw new Error('That agent has no open workspace. Brief the Lead instead.')
          const first = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
          if (!first) throw new Error('That agent has no open chat. Open a new chat in its workspace, or brief the Lead instead.')
          chat = first
        } else chat = await this.leadChat(roomId)
        const message = messageOf(text, parts)
        this.userSpoke(chat.id)
        await this.sessions.send(chat.id, message)
        // The log line under the brief, and the start of the briefing sequence on the floor (FloorSent.png).
        const to = this.store.workspace(chat.workspaceId)?.agentId
        const name = (await this.k.team.agents(roomId)).find((a) => a.id === to)?.name ?? 'the Lead'
        const quote = parts ? message.map((p) => (p.type === 'text' ? p.text : p.name)).join(' ').replace(/\s+/g, ' ').trim() : text
        bus.activity({ kind: 'brief', roomId, workspaceId: chat.workspaceId, agentId: to, actor: 'you', text: agentId ? `messaged ${name}` : `briefed ${name}`, quote })
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      'lead.ask': async ({ roomId, text, threadId }) => this.askLead(roomId, text, threadId),
      // Opening the room shows its newest chat with Rowan, and none when no chat is open: it starts none (KERNEL-365, KERNEL-405).
      'lead.open': async ({ roomId }) => { await this.leadOf(roomId); return this.newestChatWorkspace(roomId) ?? null },
      'lead.start': async ({ roomId, ...o }) => this.newLeadChat(roomId, o),
      'threads.list': async ({ roomId }) => this.store.threads(roomId),
      'threads.rename': async ({ threadId, title }) => this.renameThread(threadId, title),
      'threads.archivePreview': async ({ threadId }) => this.archivePreview(threadId),
      'threads.archive': async ({ threadId }) => { await this.archiveLeadChat(threadId); return { ok: true } }
    } satisfies Partial<Handlers>
  }
}
