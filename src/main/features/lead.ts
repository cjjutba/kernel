import type { AgentDef, Chat, ChatPart, Effort, ModelId, Workspace } from '@shared/types'
import { newId } from '../db'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { saveAgent } from '../services/agents'
import { parsePlanSteps } from '../services/approvals'
import { NUDGE_LIMIT } from '../services/nudges'
import { firstLine } from '../services/text'
import { isNudge } from '../services/sessions'
import { kernelMcpServer, queuedNote, type KernelToolDeps } from '../services/kernelMcp'
import { currentBranch, folderGone } from '../services/worktrees'
import { Feature } from './feature'
import { LEAD_CHAT, messageOf, NEW_CHAT } from './shared'

/** The room's Lead: its workspace, chats and tools, `message_agent`, and where teammates' updates go (KERNEL-329). */
export class Lead extends Feature {
  /**
   * A quick question to the room's Lead. It always gets a new Lead chat tab, so it never queues behind whatever the first tab
   * is doing or lands in a tab with a brief being typed (KERNEL-145, D-133). The answer arrives there like any turn; the popover
   * reads it from there.
   */
  async askLead(roomId: string, text: string): Promise<{ chatId: string }> {
    const chat = await this.startLeadChat(roomId, { prompt: text, plan: false })
    return { chatId: chat.id }
  }

  /**
   * "Let Rowan sort it": the Lead gets both workspaces and the file, and the card leaves the floor.
   * The overlap itself clears on its own once the agents stop touching the same file.
   */
  async sortOverlap(overlapId: string): Promise<void> {
    const o = this.k.overlaps.get(overlapId)
    if (!o) throw new Error('That overlap is gone already.')
    const agents = await this.k.agents(o.roomId)
    const parts = o.parties.map((p) => `${agents.find((a) => a.id === p.agentId)?.name ?? p.agentId} in ${this.store.workspace(p.workspaceId)?.name ?? p.workspaceId} (${p.lines})`)
    // The Lead chat that handed off the newest of the workspaces hears about it (KERNEL-105), and learns which other chats are involved.
    const owners = o.parties.map((p) => this.store.workspace(p.workspaceId)).filter((w): w is Workspace => !!w).sort((a, b) => b.createdAt - a.createdAt)
    const chat = (owners.length ? this.leadUpdateTarget(o.roomId, owners[0].leadChatId)?.chat : undefined) ?? await this.leadChat(o.roomId)
    const others = [...new Set(owners.map((w) => w.leadChatId).filter((id): id is string => !!id && id !== chat.id))].map((id) => this.store.chat(id)?.title).filter(Boolean)
    const elsewhere = others.length ? ` Part of this work was handed off in another Lead chat: ${others.map((t) => `"${t}"`).join(', ')}.` : ''
    const text = `${parts.join(' and ')} both changed ${o.path} in different worktrees, so merging both will conflict. Decide who keeps the change, tell the others, and sort it out before either merges.${elsewhere}`
    await this.sessions.send(chat.id, [{ type: 'text', text }])
    this.k.overlaps.resolve(overlapId)
    // A note, not a brief: a brief to the Lead would restart the briefing sequence on the floor.
    const lead = agents.find((a) => a.id === this.store.workspace(chat.workspaceId)?.agentId)
    bus.activity({ kind: 'note', roomId: o.roomId, workspaceId: chat.workspaceId, agentId: lead?.id, actor: 'you', text: `asked ${lead?.name ?? 'the Lead'} to sort out the overlap in`, object: o.path.split('/').pop(), quote: text })
  }

  /** The Lead lives in a room-level workspace on the main checkout, made the first time it is needed. */
  private async leadWorkspace(roomId: string): Promise<{ ws: Workspace; lead: AgentDef }> {
    const agents = await this.k.agents(roomId)
    const lead = agents.find((a) => a.lead)
    if (!lead) throw new Error('No lead agent. Mark one agent with "lead: true".')
    let ws = this.store.workspaces(roomId).find((w) => w.agentId === lead.id && w.mode === 'current' && w.status !== 'archived')
    if (!ws) {
      const room = this.mustRoom(roomId)
      const branch = await currentBranch(room.path)
      ws = await this.k.workspaces.withPort((port) => this.saveWs({ id: newId(), roomId, name: 'lead', branch, baseRef: room.defaultBranch, path: room.path, mode: 'current', agentId: lead.id, port, status: 'ready', prState: 'none', createdAt: Date.now() }))
    }
    return { ws, lead }
  }

  /** The Lead's first open chat. Floor briefs go there. */
  async leadChat(roomId: string): Promise<Chat> {
    const { ws, lead } = await this.leadWorkspace(roomId)
    return this.chatTabs(ws.id).find((c) => c.kind !== 'terminal') ?? this.newChat(ws.id, LEAD_CHAT, { model: this.k.team.modelFor(lead), effort: lead.effort ?? this.settings.models.effort, plan: this.settings.models.leadPlanMode })
  }

  /**
   * A message to the Lead in a chat of its own (KERNEL-148). It always adds a tab, like the tab row's +: an unused tab may
   * hold a draft the engine can't see, since the composer keeps it (D-133, KERNEL-242). The first message names the chat.
   */
  async startLeadChat(roomId: string, o: { prompt: string; parts?: ChatPart[]; model?: ModelId; effort?: Effort; plan?: boolean }): Promise<Chat> {
    const { ws, lead } = await this.leadWorkspace(roomId)
    const pick = { model: o.model ?? this.k.team.modelFor(lead), effort: o.effort ?? lead.effort ?? this.settings.models.effort, plan: o.plan ?? this.settings.models.leadPlanMode }
    const chat = this.saveChat(this.newChat(ws.id, NEW_CHAT, pick))
    this.userSpoke(chat.id)
    await this.sessions.send(chat.id, messageOf(o.prompt, o.parts))
    return chat
  }

  leadTools(roomId: string, lead: AgentDef, chat: Chat) {
    return kernelMcpServer(this.leadToolDeps(roomId, lead, chat))
  }

  /** What the Lead's tools call, apart from the server so tests can run the tools against a real Kernel. */
  leadToolDeps(roomId: string, lead: AgentDef, chat: Chat): KernelToolDeps {
    return {
      roomId, lead,
      agents: () => this.k.agents(roomId),
      workspaces: () => this.store.workspaces(roomId),
      chatId: chat.id,
      chatTitle: (id) => this.store.chat(id)?.title,
      // The saved chat, not `chat`: the toggle can change after the session starts (KERNEL-176).
      planMode: () => !!this.store.chat(chat.id)?.plan,
      createWorkspace: async ({ issue, ...o }) => {
        // Only plans approved in this chat. Another Lead chat's plan with a step for the same agent is a different hand-off.
        const approvalIds = new Set(this.store.approvals({ roomId }).filter((a) => a.kind === 'plan' && a.chatId === chat.id).map((a) => a.id))
        // The issue the task builds (D-140). Kernel names the branch from it unless the Lead named one (KERNEL-275).
        const linked = issue ? await this.k.integrations.issueSource(issue, o.title ?? firstLine(o.prompt)) : undefined
        const branch = o.branch
        // A review is not a task of the plan, so it takes no plan step or Board task (KERNEL-130).
        const review = o.reviewOf ?? o.linkReviewOf
        const ws = await this.k.createWorkspace(roomId, { ...o, ...(linked ? { source: linked.source, labels: linked.labels } : {}), ...(branch ? { branch } : {}), mode: o.mode, leadChatId: chat.id, taskFor: review ? undefined : (w) => this.tasks.link(roomId, o.agentId, w.id, { approvalIds })?.id })
        if (!review) this.linkPlanStep(roomId, o.agentId, ws.id, chat.id)
        // Rowan named no wait, but Linear says the issue is blocked by one a teammate is building (KERNEL-263).
        const blocked = !o.waitFor && linked?.blockedBy?.length ? await this.k.waits.waitOnBlockers(ws, linked.blockedBy).catch(() => undefined) : undefined
        if (ws.status !== 'failed') {
          // The brief may still wait in the teammate's chat, for a slot, a pause or the connection (KERNEL-272).
          const out = blocked ?? ws
          const brief = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
          const queued = brief && this.sessions.queueReason(brief.id)
          return queued ? { ...out, queued } : out
        }
        const code = this.k.setup['setupFailures'].get(ws.id)
        return { ...ws, setupFailed: code === null ? 'it was stopped' : code === undefined ? 'it did not pass' : `exit code ${code}` }
      },
      messageWorkspace: (workspaceId, text) => this.messageWorkspace(roomId, workspaceId, text, chat.id),
      askUser: async (o) => {
        // The card goes in the chat Rowan is blocked in, wherever that is, and shows in the Inbox too.
        const agents = await this.k.agents(roomId)
        const { approval, decision } = this.approvals.request({
          kind: o.kind, source: 'sdk', roomId, workspaceId: chat.workspaceId, chatId: chat.id, agentId: lead.id, title: o.title, detail: o.detail, options: o.options,
          steps: o.steps && parsePlanSteps(o.steps, agents), agentFile: o.agentFile
        })
        this.sessions.placeApproval(chat.id, approval.id)
        // An answer is the user stepping in, so the loop guard starts over for this chat's work (KERNEL-125).
        return decision.then((d) => { if (d) this.userSpoke(chat.id); return d })
      },
      archiveWorkspace: (id) => this.k.archiveWorkspace(id),
      setWait: (id, on) => this.k.setWait(id, on),
      refreshPr: (id) => this.k.refreshPr(id, { settle: true }),
      isRunning: (id) => this.k.archive.working(id),
      // The sidebar's check before a one-click archive. A current-branch workspace removes no files, and neither does a
      // worktree whose folder is already gone (KERNEL-109).
      unsaved: (id) => this.k.archive.unsavedOf(id),
      planApproved: () => this.sessions.handoffs.approved(chat.id),
      handedOff: () => this.sessions.handoffs.done(chat.id),
      hireAgent: async (a) => {
        const was = this.k.team['agentCache'].get(roomId) ?? await this.k.agents(roomId)
        const file = await saveAgent(this.mustRoom(roomId).path, a)
        this.k.team['announceTeam'](roomId, await this.k.agents(roomId), was)
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
    const agent = (await this.k.agents(roomId)).find((a) => a.id === ws.agentId)
    if (agent?.lead) return refuse('Not sent: that is your own workspace.')
    if (ws.mode === 'worktree' && await folderGone(ws.path).catch(() => false)) return refuse(`Not sent: ${ws.name}'s folder is gone. Ask the user to archive it, or hand the work out again with create_workspace.`)
    const name = agent?.name ?? ws.agentId
    // A request in a Lead turn Kernel started is automatic. After a few tries at one workspace, the user decides (KERNEL-125).
    // The turn is keyed by the message that started it, so several messages in one turn are one try.
    const auto = !!leadChatId && this.sessions.kernelTurn(leadChatId)
    // A limit or restart nudge carries the turn on, so the turn is still the message before it.
    const turn = auto ? [...this.store.items(leadChatId!)].reverse().find((i) => i.kind === 'user' && !(i.from === 'kernel' && isNudge(i.parts)))?.id : undefined
    if (auto && this.k['nudges'].spent(ws.id, turn)) return refuse(`Not sent: Kernel has passed ${NUDGE_LIMIT} automatic requests to ${name} on this workspace and it still needs help. Tell the user what keeps failing and ask how to go on.`)
    if (auto) this.k['nudges'].add(ws.id, turn)
    const parts: ChatPart[] = [{ type: 'text', text }]
    const held = this.k.setup['setups'].get(ws.id)
    if (held) { held.later.push(parts); this.k.setup['saveSetups'](); return { ok: true, sent: false, note: `${name}'s workspace is still setting up, so the message waits behind the brief.` } }
    let chat = this.chatTabs(ws.id).find((c) => c.kind !== 'terminal')
    const opened = !chat
    if (!chat) chat = this.saveChat(this.newChat(ws.id, NEW_CHAT, { model: agent ? this.k.team.modelFor(agent) : this.settings.models.engineers, effort: agent?.effort ?? this.settings.models.effort, plan: false }))
    const { queued, why } = await this.sessions.send(chat.id, parts, { from: 'lead' })
    if (!queued) return { ok: true, sent: true, note: opened ? `Opened a new chat in ${name}'s workspace and sent it.` : 'Sent.' }
    const waiting = this.store.workspace(ws.id)
    const note = why === 'running' ? `${name} is mid-turn, so the message goes out when that turn ends.`
      : why === 'setup' && ws.status === 'trust' ? `${name}'s workspace waits for the user to trust this room's scripts, so the message waits behind the brief.`
      : why === 'setup' && waiting?.status === 'ready' && waiting.waitsFor?.held ? `${name} waits for ${this.k.waits.waitLabelOf(waiting)} to merge, so this goes out after the brief. To start ${name} now, call wait_for_merge with an empty list.`
      : why === 'setup' ? (this.k.setup['settingUp'].has(ws.id) ? `${name}'s workspace is setting up again, so the message waits behind the brief.` : `Setup failed in ${name}'s workspace, so the message waits until the user clicks Run again.`)
      // The same words as create_workspace's brief (KERNEL-272).
      : queuedNote(why, { name }) ?? 'The message waits in the queue.'
    return { ok: true, sent: false, note: opened ? `Opened a new chat in ${name}'s workspace. ${note}` : note }
  }

  /**
   * Point the first unlinked step for this agent in the latest plan approved in `chatId` at the new workspace (the card's
   * Open workspace link). Plans from the room's other Lead chats are left alone (KERNEL-105).
   */
  private linkPlanStep(roomId: string, agentId: string, workspaceId: string, chatId: string) {
    const plan = this.store.approvals({ roomId }).filter((a) => a.kind === 'plan' && a.status === 'allowed' && a.chatId === chatId && a.steps?.some((s) => s.agentId === agentId && !s.workspaceId)).sort((a, b) => b.createdAt - a.createdAt)[0]
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
    if (!this.isLeadWorkspace(ws)) { this.k['nudges'].reset(ws.id); return }
    this.k['nudges'].reset(...this.store.workspaces(ws.roomId).filter((w) => !this.isLeadWorkspace(w) && this.leadUpdateTarget(ws.roomId, w.leadChatId)?.chat.id === chatId).map((w) => w.id))
  }

  /** The room's Lead chat if the Lead has been briefed. Unlike `leadChat`, never creates one. */
  private existingLeadChat(roomId: string): Chat | undefined {
    const lead = this.agentsSync(roomId).find((a) => a.lead)
    const ws = lead && this.store.workspaces(roomId).find((w) => w.agentId === lead.id && w.mode === 'current' && w.status !== 'archived')
    return ws ? this.chatTabs(ws.id).find((c) => c.kind !== 'terminal') : undefined
  }

  /** A chat tab still on the strip, in a workspace that isn't archived. */
  private isOpenChat(chat: Chat) {
    return !chat.closed && chat.kind !== 'terminal' && this.store.workspace(chat.workspaceId)?.status !== 'archived'
  }

  /**
   * Where teammate updates about work handed off in `owner` go (KERNEL-105): that chat while it's open, else its newest
   * open fork, else the room's first open Lead chat, with `closed` set so the update can say where the work came from.
   * Work no Lead chat handed off goes to the first open Lead chat. Never creates a chat.
   */
  leadUpdateTarget(roomId: string, owner?: string): { chat: Chat; closed?: Chat } | undefined {
    const was = owner ? this.store.chat(owner) : undefined
    if (was && this.isOpenChat(was)) return { chat: was }
    const fork = was && this.store.chats(was.workspaceId).filter((c) => c.forkOf?.chatId === was.id && this.isOpenChat(c)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (fork) return { chat: fork }
    const first = this.existingLeadChat(roomId)
    return first && { chat: first, closed: was }
  }

  /**
   * Workspaces the Lead created before Kernel saved `leadChatId` (KERNEL-105). Only a Lead chat has the kernel tools, so
   * each finished `create_workspace` in a chat ("Created <id> on <branch> ...") names a workspace that chat handed off.
   * Runs once; a workspace it can't place reports to the room's first Lead chat, as before.
   */
  backfillLeadChats() {
    if (this.store.meta<boolean>('leadChatBackfill')) return
    for (const lead of this.store.workspaces().filter((w) => w.mode === 'current')) {
      for (const chat of this.store.chats(lead.id)) {
        for (const item of this.store.items(chat.id)) {
          if (item.kind !== 'tool' || item.name !== 'mcp__kernel__create_workspace' || item.status !== 'done') continue
          const id = /^Created (\S+) on /.exec(item.output ?? '')?.[1]
          const ws = id ? this.store.workspace(id) : undefined
          if (ws && ws.roomId === lead.roomId && !ws.leadChatId) this.store.saveWorkspace({ ...ws, leadChatId: chat.id })
        }
      }
    }
    this.store.saveMeta('leadChatBackfill', true)
  }

  handlers() {
    return {
      'rooms.overlaps': async ({ roomId }) => this.k.overlaps.check(roomId),
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
        const name = (await this.k.agents(roomId)).find((a) => a.id === to)?.name ?? 'the Lead'
        const quote = parts ? message.map((p) => (p.type === 'text' ? p.text : p.name)).join(' ').replace(/\s+/g, ' ').trim() : text
        bus.activity({ kind: 'brief', roomId, workspaceId: chat.workspaceId, agentId: to, actor: 'you', text: agentId ? `messaged ${name}` : `briefed ${name}`, quote })
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      'lead.ask': async ({ roomId, text }) => this.askLead(roomId, text),
      'lead.open': async ({ roomId }) => this.mustWs((await this.leadChat(roomId)).workspaceId),
      'lead.start': async ({ roomId, ...o }) => this.startLeadChat(roomId, o)
    } satisfies Partial<Handlers>
  }
}
