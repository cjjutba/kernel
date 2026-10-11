import { existsSync } from 'node:fs'
import type { AgentDef, Approval, Chat, ChatPart, Effort, ModelId, Thread, Workspace } from '@shared/types'
import { isLeadWorkspace } from '@shared/leadWorkspace'
import { newId } from '../db'
import { bus } from '../bus'
import { saveAgent } from '../services/agents'
import { parsePlanSteps } from '../services/approvals'
import { NUDGE_LIMIT } from '../services/nudges'
import { revisedPlanFile, savePlan } from '../services/plans'
import { firstLine } from '../services/text'
import { isNudge } from '../services/sessions'
import { kernelMcpServer, type KernelToolDeps, queuedNote } from '../services/kernelMcp'
import type { From } from '../services/leadUpdates'
import { currentBranch, folderGone } from '../services/worktrees'
import { LEAD_CHAT, messageOf, NEW_CHAT, NEW_TAB } from './shared'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** The room's Lead: its workspace and chats, its tools, and where teammates' updates go (KERNEL-329). */
export class Lead extends Feature {
  /**
   * A quick question to the room's Lead. It always gets a new Lead tab, so it never queues behind whatever another tab is
   * doing or lands in a tab with a brief being typed (KERNEL-145, D-133). The tab joins the Lead chat `threadId`, or starts
   * one (KERNEL-337). The answer arrives there like any turn; the popover reads it from there.
   */
  async askLead(roomId: string, text: string, threadId?: string): Promise<{ chatId: string }> {
    const chat = await this.startLeadChat(roomId, { prompt: text, plan: false }, threadId)
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

  /** The Lead lives in a room-level workspace on the main checkout, made the first time it is needed. */
  private async leadWorkspace(roomId: string): Promise<{ ws: Workspace; lead: AgentDef }> {
    const agents = await this.k.team.agents(roomId)
    const lead = agents.find((a) => a.lead)
    if (!lead) throw new Error('No lead agent. Mark one agent with "lead: true".')
    let ws = this.store.workspaces(roomId).find((w) => isLeadWorkspace(w, lead.id))
    if (!ws) {
      const room = this.mustRoom(roomId)
      const branch = await currentBranch(room.path)
      ws = await this.k.workspaces.withPort((port) => this.saveWs({ id: newId(), roomId, name: 'lead', branch, baseRef: room.defaultBranch, path: room.path, mode: 'current', agentId: lead.id, lead: true, port, status: 'ready', prState: 'none', createdAt: Date.now() }))
    }
    return { ws, lead }
  }

  /** The Lead's first open chat. Floor briefs go there. With no open tab, a new Lead chat (KERNEL-337). */
  async leadChat(roomId: string): Promise<Chat> {
    const { ws, lead } = await this.leadWorkspace(roomId)
    return this.chatTabs(ws.id).find((c) => c.kind !== 'terminal') ?? this.leadTab(ws, LEAD_CHAT, { model: this.k.team.modelFor(lead), effort: lead.effort ?? this.settings.models.effort, plan: this.settings.models.leadPlanMode })
  }

  /**
   * A message to the Lead in a tab of its own (KERNEL-148). It always adds a tab, like the tab row's +: an unused tab may
   * hold a draft the engine can't see, since the composer keeps it (D-133, KERNEL-242). The tab starts a new Lead chat
   * unless `threadId` names one (KERNEL-337). The first message names the tab.
   */
  async startLeadChat(roomId: string, o: { prompt: string; parts?: ChatPart[]; model?: ModelId; effort?: Effort; plan?: boolean }, threadId?: string): Promise<Chat> {
    const { ws, lead } = await this.leadWorkspace(roomId)
    const pick = { model: o.model ?? this.k.team.modelFor(lead), effort: o.effort ?? lead.effort ?? this.settings.models.effort, plan: o.plan ?? this.settings.models.leadPlanMode }
    const chat = this.saveChat(this.leadTab(ws, NEW_TAB, pick, threadId))
    this.userSpoke(chat.id)
    await this.sessions.send(chat.id, messageOf(o.prompt, o.parts))
    return chat
  }

  /**
   * A new tab in the Lead's workspace (KERNEL-337): in the Lead chat `threadId`, which opens again if it was closed, else in
   * a new Lead chat titled like the tab. Saved, not pushed, like `newChat`.
   */
  leadTab(ws: Workspace, title: string, o: { model: ModelId; effort: Effort; plan: boolean }, threadId?: string): Chat {
    let thread = threadId ? this.store.thread(threadId) : undefined
    if (threadId && thread?.roomId !== ws.roomId) throw new Error('That chat no longer exists.')
    if (thread?.closedAt) thread = this.pushThread({ ...thread, closedAt: undefined })
    return this.newChat(ws.id, title, { ...o, threadId: (thread ?? this.pushThread({ id: newId(), roomId: ws.roomId, title, createdAt: Date.now() })).id })
  }

  private pushThread(t: Thread): Thread {
    this.store.saveThread(t)
    bus.push({ type: 'thread', thread: t })
    return t
  }

  /** Kernel named a Lead tab. The first tab of a Lead chat names the chat too, until the user names the chat (KERNEL-337). */
  tabNamed(chat: Chat) {
    const t = chat.threadId ? this.store.thread(chat.threadId) : undefined
    if (!t || t.renamed || t.title === chat.title || this.store.threadTabs(chat.id)[0]?.id !== chat.id) return
    this.pushThread({ ...t, title: chat.title })
  }

  /** A tab closed. Closing the last open tab of a Lead chat closes the chat, which keeps its title (KERNEL-337). */
  tabClosed(chat: Chat) {
    const t = chat.threadId ? this.store.thread(chat.threadId) : undefined
    if (!t || t.closedAt || this.store.threadTabs(chat.id).some((c) => !c.closed)) return
    this.pushThread({ ...t, closedAt: Date.now() })
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
        return { ...ws, setupFailed: code === null ? 'it was stopped' : code === undefined ? 'it did not pass' : `exit code ${code}` }
      },
      messageWorkspace: (workspaceId, text) => this.messageWorkspace(roomId, workspaceId, text, chat.id),
      askUser: async (o) => {
        // The card goes in the chat Rowan is blocked in, wherever that is, and shows in the Inbox too.
        const agents = await this.k.team.agents(roomId)
        const reuse = o.kind === 'plan' ? revisedPlanFile(this.store.approvals({ roomId }), chat.id) : undefined
        const { approval, decision } = this.approvals.request({
          kind: o.kind, source: 'sdk', roomId, workspaceId: chat.workspaceId, chatId: chat.id, agentId: lead.id, title: o.title, detail: o.detail, options: o.options,
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
   * runs goes after the brief.
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
    if (held) { held.later.push(parts); this.k.setup.saveSetups(); return { ok: true, sent: false, note: `${name}'s workspace is still setting up, so the message waits behind the brief.` } }
    let chat = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    const opened = !chat
    if (!chat) chat = this.saveChat(this.newChat(ws.id, NEW_CHAT, { model: agent ? this.k.team.modelFor(agent) : this.settings.models.engineers, effort: agent?.effort ?? this.settings.models.effort, plan: false }))
    const { queued, why } = await this.sessions.send(chat.id, parts, { from: 'lead' })
    if (!queued) return { ok: true, sent: true, note: opened ? `Opened a new chat in ${name}'s workspace and sent it.` : 'Sent.' }
    const note = why === 'running' ? `${name} is mid-turn, so the message goes out when that turn ends.`
      : why === 'merge' ? `${name} waits for ${this.k.waits.waitLabelOf(this.mustWs(ws.id))} to merge, so this goes out after the brief. To start ${name} now, call wait_for_merge with an empty list.`
      : why === 'setup' && ws.status === 'trust' ? `${name}'s workspace waits for the user to trust this room's scripts, so the message waits behind the brief.`
      : why === 'setup' ? (this.k.setup.settingUp.has(ws.id) ? `${name}'s workspace is setting up again, so the message waits behind the brief.` : `Setup failed in ${name}'s workspace, so the message waits until the user clicks Run again.`)
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

  /** The room's Lead chat if the Lead has been briefed. Unlike `leadChat`, never creates one. */
  private existingLeadChat(roomId: string): Chat | undefined {
    const lead = this.agentsSync(roomId).find((a) => a.lead)
    const ws = lead && this.store.workspaces(roomId).find((w) => isLeadWorkspace(w, lead.id))
    return ws ? this.chatTabs(ws.id).find((c) => c.kind !== 'terminal') : undefined
  }

  /** A chat tab still on the strip, in a workspace that isn't archived. */
  private isOpenChat(chat: Chat) {
    return !chat.closed && chat.kind !== 'terminal' && this.store.workspace(chat.workspaceId)?.status !== 'archived'
  }

  /**
   * Where teammate updates about work handed off in the tab `owner` go (KERNEL-105, KERNEL-337): that tab while it's open,
   * else the newest open tab of its Lead chat (forks included, since a fork stays in the chat), else its newest open fork
   * from before Lead chats had tabs, else the room's first open Lead tab. `from` names where the work came from when it
   * moves: the tab inside its own chat, the Lead chat otherwise. Work no Lead tab handed off goes to the first open Lead
   * tab. Never creates a tab.
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

  /** The ids of every tab in `chat`'s Lead chat, closed ones too, and its own. */
  private threadTabIds(chat: Chat) { return new Set(this.store.threadTabs(chat.id).map((c) => c.id).concat(chat.id)) }

  /** Startup's one-time fixes to data from older versions, after the agents load. */
  backfill() {
    this.markLeadWorkspaces()
    this.backfillLeadChats()
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
      'lead.open': async ({ roomId }) => this.mustWs((await this.leadChat(roomId)).workspaceId),
      'lead.start': async ({ roomId, ...o }) => this.startLeadChat(roomId, o),
      'threads.list': async ({ roomId }) => this.store.threads(roomId),
      'threads.rename': async ({ threadId, title }) => this.renameThread(threadId, title)
    } satisfies Partial<Handlers>
  }
}
