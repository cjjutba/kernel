import type { Chat, ChatItem, Effort, Provider, Workspace } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'
import { isSentItem } from '@shared/approvalAnswer'
import { effortFor } from '@shared/effort'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'
import { chatProvider, providerOf } from '@shared/providers'
import type { PushEvent } from '@shared/ipc'
import { sessionEnv } from '../services/sessions'
import { shellId } from '../services/pty'
import { askCodexTitle, askTitle, titleText } from '../services/titles'
import { claudeExecutable } from '../services/providers/binary'
import { resolvePreset, terminalCommand, terminalPresets, terminalTitle } from '../services/terminalPresets'
import { LEAD_CHAT, NEW_CHAT, NEW_TAB } from './shared'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

const COPY = 'fork:'

/** The finished-turn counts at which Kernel names an auto-named chat again from the whole conversation (KERNEL-202). */
const RENAME_AT = [1, 3, 10, 30]

/** The SDK found no session by that id in the folder it looked in. */
const notFound = (e: unknown) => /not found/i.test((e as Error)?.message ?? '')

/** Chat tabs, their names, forks and big terminals (KERNEL-329). */
export class Chats extends Feature {
  /** Chats with a turn running. Read from `chat.running` so the quit prompt can count agents (KERNEL-214). */
  private readonly runningChats = new Set<string>()

  /**
   * Send now in a project a limit paused sends the message anyway. If the limit is real, Claude Code answers with it and
   * the project stays paused; if it lifted, the answer's rate_limit_event lifts it in Kernel too.
   */
  private async sendNow(chatId: string, id: string) {
    const ws = this.mustWs(this.mustChat(chatId).workspaceId)
    // A brief held for a merge goes now, without waiting (KERNEL-259), and the teammate still hears when it merges (KERNEL-689).
    // One held because setup failed still waits for Run again.
    // The pressed message doesn't jump the brief: the brief and everything queued with it go in the chat's first turn, in order (KERNEL-393).
    if (ws.status === 'ready' && ws.waitsFor?.held) {
      await this.k.waits.releaseWait(ws.id, { now: true, keep: true })
      return this.sessions.queued(chatId)
    }
    const project = this.store.project(ws.projectId)
    return this.sessions.sendNow(chatId, id, { pastPause: project?.pausedBy === 'limit' })
  }

  /**
   * Agents with a turn running: workspaces, not chats, so a Lead with two busy chats is one (KERNEL-214). A turn that only
   * waits on a plan card isn't work: the card survives the quit (KERNEL-827).
   */
  workingAgents(): number {
    const workspaces = [...this.runningChats].filter((id) => !this.approvals.waitsOnPlan(id)).map((id) => this.store.chat(id)?.workspaceId).filter(Boolean)
    return new Set(workspaces).size
  }

  /** A name the user types is theirs: Kernel never changes it again (KERNEL-202). */
  private renameChat(chatId: string, title: string): Chat {
    const t = title.trim()
    if (!t) throw new Error('Give the chat a name.')
    return this.saveChat({ ...this.mustChat(chatId), title: t, autoTitle: undefined })
  }

  /** When Kernel last looked for a session title, by chat, so a busy turn reads the transcript at most every few seconds. */
  private titleChecked = new Map<string, number>()
  /** Chats with a naming request in flight. One at a time per chat. */
  private naming = new Set<string>()
  /** The session a chat had when /clear emptied it. Its title belongs to the old conversation, so Kernel doesn't take it. */
  private clearedSession = new Map<string, string>()
  /** How many times /clear reset each chat's name, so an answer about the old conversation that arrives after one is dropped. */
  private nameResets = new Map<string, number>()
  /**
   * Naming requests in a row that brought back no name, by chat. Each one starts a Claude Code process, and one that fails
   * once (a provider without the Haiku id, no bundled CLI) tends to keep failing, so the retries stop (`nameChat`).
   */
  private nameMisses = new Map<string, number>()
  /** Chats whose naming failure is in the main log already, so a chat that keeps failing logs it once (KERNEL-624). */
  private nameFailLogged = new Set<string>()

  /** The naming request on each provider. Tests swap them for stubs. */
  askClaude: typeof askTitle = askTitle
  askCodex: typeof askCodexTitle = askCodexTitle

  /**
   * A name for a conversation (KERNEL-624): Haiku on the active Claude account, or when that brings back no answer, Codex's
   * small model on the active Codex account. The chat's own provider doesn't matter, so naming never needs Claude.
   * Undefined when the answer is no usable name. Throws with each provider's reason when neither answered.
   */
  async titleFor(text: string, o: { cwd: string; current?: string }): Promise<string | undefined> {
    const p = this.k.providers
    let claude: string
    try {
      return await this.askClaude(text, { ...o, env: p.claudeEnv(), bin: claudeExecutable(this.settings.providers?.claude) })
    } catch (e) { claude = (e as Error)?.message ?? String(e) }
    const bin = p.binary('codex').path
    if (!bin) throw new Error(`Claude: ${claude}. Codex: Kernel could not find Codex.`)
    try {
      return await this.askCodex(text, { ...o, bin, home: p.codexHome(), apiKey: p.apiKey('codex') })
    } catch (e) { throw new Error(`Claude: ${claude}. Codex: ${(e as Error)?.message ?? String(e)}`) }
  }

  /** Kernel picks this chat's name. A chat still called "New chat" from before KERNEL-202 counts too. */
  private autoNamed(c: Chat) { return c.kind !== 'terminal' && (!!c.autoTitle || c.title === NEW_CHAT) }
  /** An auto-named chat that has no real name yet: "New chat", a Lead tab's "New tab" (KERNEL-337), or the Lead's first "Lead". */
  private unnamed(c: Chat) { return c.title === NEW_CHAT || (!!c.autoTitle && (c.title === NEW_TAB || c.title === LEAD_CHAT)) }

  /** Saves a name Kernel picked. The first tab of a Lead chat names the chat too (KERNEL-337). */
  private autoName(chat: Chat) {
    this.saveChat(chat)
    this.k.lead.tabNamed(chat)
  }

  /**
   * Names an auto-named chat (KERNEL-202, amends D-089). Until it has a name, it takes the title Claude Code writes into its
   * transcript a few seconds after the first prompt. The SDK sends no event for it, so Kernel looks on replies, at most every
   * few seconds, and at the end of each turn. At the end of a turn Kernel also asks Haiku for a name from the whole
   * conversation (`titleFor`) when the chat still has none, or when its count of finished turns reaches 1, 3, 10 or 30. A name the user
   * typed, even while a request is in flight, is never changed. A request that fails leaves the name. A refresh is tried once
   * more at the next turn end, then waits for the next point on the schedule. A chat with no name tries at each turn end and
   * stops after 3 misses in a row, until /clear or the next start.
   */
  async nameChat(ws: Workspace, chat: Chat, turnEnded = false) {
    if (!this.autoNamed(chat)) return
    const resets = this.nameResets.get(chat.id) ?? 0
    if (this.unnamed(chat) && chat.sessionId && chat.sessionId !== this.clearedSession.get(chat.id)) {
      const last = this.titleChecked.get(chat.id) ?? 0
      if (turnEnded || Date.now() - last >= 3000) {
        this.titleChecked.set(chat.id, Date.now())
        // A Lead chat whose folder moved keeps its transcript in the old folder's project, which only a search of every
        // project finds (KERNEL-424).
        const info = await this.k.sessionInfo(chat.sessionId, { dir: ws.path }).catch(() => undefined) ?? await this.k.sessionInfo(chat.sessionId).catch(() => undefined)
        const title = info?.customTitle?.trim().slice(0, 60)
        if (this.stopped || resets !== (this.nameResets.get(chat.id) ?? 0)) return
        const now = this.store.chat(chat.id)
        if (title && now && this.autoNamed(now) && this.unnamed(now)) {
          this.titleChecked.delete(chat.id)
          this.nameMisses.delete(chat.id)
          this.autoName({ ...now, title, autoTitle: now.autoTitle ?? { turns: 0 } })
        }
      }
    }
    if (!turnEnded || this.naming.has(chat.id) || resets !== (this.nameResets.get(chat.id) ?? 0)) return
    const before = this.store.chat(chat.id)
    if (!before || before.closed || !this.autoNamed(before)) return
    const unnamed = this.unnamed(before)
    const done = before.autoTitle?.turns ?? 0
    // A named chat past the last point on the schedule is settled. A "New chat" that missed 3 times waits for /clear or a restart.
    if (unnamed ? (this.nameMisses.get(chat.id) ?? 0) >= 3 : done >= RENAME_AT[RENAME_AT.length - 1]) return
    const items = this.store.items(chat.id)
    const turns = items.filter((i) => i.kind === 'result').length
    if (!turns || !(unnamed || RENAME_AT.some((at) => at > done && at <= turns))) return
    this.naming.add(chat.id)
    try {
      const title = await this.titleFor(titleText(items), { cwd: ws.path, current: unnamed ? undefined : before.title }).catch((e) => {
        if (!this.stopped && !this.nameFailLogged.has(chat.id)) {
          this.nameFailLogged.add(chat.id)
          console.warn(`[chats] could not name chat ${chat.id}: ${(e as Error)?.message ?? e}`)
        }
        return undefined
      })
      if (this.stopped || resets !== (this.nameResets.get(chat.id) ?? 0)) return
      const now = this.store.chat(chat.id)
      if (!now || !this.autoNamed(now) || now.title !== before.title) return
      if (title) {
        this.nameMisses.delete(chat.id)
        this.autoName({ ...now, title, autoTitle: { turns } })
        return
      }
      const misses = (this.nameMisses.get(chat.id) ?? 0) + 1
      // A refresh of a chat that has a name gets one retry, then waits for the next point on the schedule.
      if (unnamed || misses < 2) { this.nameMisses.set(chat.id, misses); return }
      this.nameMisses.delete(chat.id)
      this.saveChat({ ...now, autoTitle: { turns } })
    } finally {
      this.naming.delete(chat.id)
    }
  }

  /**
   * /clear starts a new conversation, so an auto name goes back to "New chat", or "New tab" for a Lead tab, and the schedule
   * starts over. The Lead chat keeps its name (KERNEL-337). Other resets keep it.
   */
  resetName(chat: Chat, trigger?: string) {
    if (trigger && trigger !== 'clear') return
    const now = this.store.chat(chat.id)
    if (!now || !this.autoNamed(now)) return
    if (now.sessionId) this.clearedSession.set(chat.id, now.sessionId)
    this.nameResets.set(chat.id, (this.nameResets.get(chat.id) ?? 0) + 1)
    this.nameMisses.delete(chat.id)
    this.titleChecked.delete(chat.id)
    this.saveChat({ ...now, title: now.threadId ? NEW_TAB : NEW_CHAT, autoTitle: { turns: 0 } })
  }

  /**
   * A turn ended in the chat, so it is unread until the renderer shows it and calls `markRead` (KERNEL-507). Main doesn't
   * know which chat is on screen, so every finished turn marks its chat, the one on screen too.
   */
  markUnread(chat: Chat) {
    const now = this.store.chat(chat.id)
    if (now) this.saveChat({ ...now, unreadAt: Date.now() })
  }

  /** The chat is on screen. A chat that is already read is left alone, with no push. */
  markRead(chatId: string) {
    const chat = this.mustChat(chatId)
    if (chat.unreadAt !== undefined) this.saveChat({ ...chat, unreadAt: undefined })
  }

  /** Open chats still called "New chat" or "New tab" after a finished turn, as /clear left them before KERNEL-202. Named one at a time. */
  async nameStuckChats() {
    for (const ws of this.store.workspaces().filter((w) => w.status !== 'archived')) {
      for (const chat of this.chatTabs(ws.id)) {
        if (this.stopped) return
        if (chat.kind === 'terminal' || (chat.title !== NEW_CHAT && chat.title !== NEW_TAB) || !chat.sessionId) continue
        if (!this.store.items(chat.id).some((i) => i.kind === 'result')) continue
        await this.nameChat(ws, chat, true).catch(() => undefined)
      }
    }
  }

  /**
   * The tab leaves the strip, its transcript stays. A big terminal's process ends. Closing the last open tab of a chat with
   * The Lead archives the chat with its workspace, the way its row's Archive does, and the window asks first when that would stop
   * something (KERNEL-405). In a teammate's workspace the last open tab is replaced by a fresh chat. The shared Lead workspace
   * from before is left with none, since only the user starts a chat with the Lead (KERNEL-365).
   */
  async closeChat(chatId: string): Promise<void> {
    const chat = this.mustChat(chatId)
    const ws = this.mustWs(chat.workspaceId)
    const last = chat.kind !== 'terminal' && !chat.closed && !this.chatTabs(ws.id).some((c) => c.id !== chat.id && c.kind !== 'terminal')
    if (last && isLeadChatWorkspace(ws) && ws.status !== 'archived') return this.k.lead.archiveLeadChat(ws.threadId!)
    // Before `stop`, which would end a plan card without a reason. A card a restart left up has no session for `stop` to end
    // with at all (plan-cards-survive-restart).
    this.approvals.expireIds(this.approvals.waitingPlans(chatId, ws.projectId).map((a) => a.id), 'closed')
    // Closing the tab ends what its agent started too (KERNEL-810).
    this.sessions.stop(chatId, { tree: true })
    this.ptys.kill(chatId)
    this.saveChat({ ...chat, closed: true })
    if (this.chatTabs(chat.workspaceId).some((c) => c.kind !== 'terminal')) return
    if (this.isLeadWorkspace(ws)) return
    this.saveChat(this.newChat(chat.workspaceId, NEW_CHAT, { provider: chat.provider, model: chat.model, effort: this.openedEffort(chat.workspaceId, chat.model), plan: false }))
  }

  /**
   * The provider and model a new tab starts on: the workspace's first chat's, as before. "New chat on Codex" asks for the
   * other provider: the agent's pick when it is on that provider, else that provider's default model (KERNEL-406).
   */
  private async newTabModel(ws: Workspace, provider?: Provider, model?: string): Promise<{ provider: Provider; model: string }> {
    const first = this.store.chats(ws.id)[0]
    const agent = this.agentsSync(ws.projectId).find((a) => a.id === ws.agentId)
    const pick = agent ? this.k.team.pickFor(agent) : this.settings.models.roles.engineers
    if (!provider) return first ? { provider: chatProvider(first), model: first.model } : { provider: pick.provider, model: pick.model }
    if (model) return { provider, model }
    if (first && chatProvider(first) === provider) return { provider, model: first.model }
    if (pick.provider === provider) return { provider, model: pick.model }
    const models = await this.k.providers.models(provider).catch(() => [])
    const fallback = models.find((m) => m.isDefault) ?? models[0]
    if (!fallback) throw new Error(`Kernel couldn't read ${provider === 'codex' ? "Codex's" : "Claude's"} models. Check Settings, Accounts.`)
    return { provider, model: fallback.id }
  }

  /**
   * The effort of a chat the user opens: the one they last picked for its model, else the workspace agent's, else Settings, Models (D-130).
   * The Lead's hand-offs and its first chat skip the memory, so they follow the agent file.
   */
  private openedEffort(workspaceId: string, model: string): Effort {
    const ws = this.mustWs(workspaceId)
    const agent = this.agentsSync(ws.projectId).find((a) => a.id === ws.agentId)
    return effortFor(model, this.settings.models.effortByModel, agent ? this.k.team.pickFor(agent).effort : this.settings.models.roles.engineers.effort)
  }

  /**
   * A new chat that resumes from this one with the SDK's session fork. With `itemId` the fork ends at the nearest assistant message
   * at or before it (user messages carry no SDK uuid), and the transcript is copied up to there. `into` makes the workspace the new
   * chat goes in, for Fork into new workspace (KERNEL-346). It runs once the session has forked, so a fork that can't happen leaves
   * no workspace behind, and the forked session goes if it throws. The forked session stays in the source worktree's project
   * folder, where Claude Code finds it from the new worktree too, even once the source's folder is gone.
   */
  async forkChat(chatId: string, itemId?: string, into?: () => Promise<string>): Promise<Chat> {
    const chat = this.mustChat(chatId)
    if (chat.kind === 'terminal') throw new Error('A big terminal cannot be forked.')
    const ws = this.mustWs(chat.workspaceId)
    let items = this.store.items(chatId)
    let upTo: string | undefined
    if (itemId) {
      const at = items.findIndex((i) => i.id === itemId)
      if (at < 0) throw new Error('That message is not in this chat.')
      const keep = items.slice(0, at + 1)
      const anchor = [...keep].reverse().find((i) => i.kind !== 'user' && i.id.includes(':') && !i.id.startsWith(COPY))
      if (keep.some((i) => i.id.startsWith(COPY)) && !anchor) throw new Error('Fork the original chat to branch from an earlier message.')
      if (anchor) { items = items.slice(0, items.findIndex((i) => i.id === anchor.id) + 1); upTo = anchor.id.split(':')[0] } else items = []
    }
    let sessionId: string | undefined
    if (chatProvider(chat) === 'codex') {
      // Codex forks a thread through the end of a turn. Its turns end at their result rows (KERNEL-406).
      let lastTurnId: string | undefined
      if (itemId) {
        const keep = this.store.items(chatId).slice(0, this.store.items(chatId).findIndex((i) => i.id === itemId) + 1)
        const end = [...keep].reverse().find((i) => i.kind === 'result' && i.id.endsWith('-result') && !i.id.startsWith(COPY))
        items = end ? keep.slice(0, keep.indexOf(end) + 1) : []
        lastTurnId = end?.id.slice(0, -'-result'.length)
      }
      if (chat.sessionId && (!itemId || lastTurnId)) sessionId = await this.k.providers.forkCodex(chat.sessionId, ws.path, lastTurnId)
    } else if (chat.sessionId && (!itemId || upTo)) {
      // A Lead chat whose folder moved keeps its transcript in the old folder's project, so the SDK finds it only when it
      // searches every project (KERNEL-424).
      const o = { upToMessageId: upTo, title: `Fork of ${chat.title}` }
      sessionId = (await this.k.forkSession(chat.sessionId, { dir: ws.path, ...o }).catch((e) => (notFound(e) ? this.k.forkSession(chat.sessionId!, o) : Promise.reject(e)))).sessionId
    }
    const workspaceId = into ? await into().catch(async (e) => { if (sessionId) await this.k.deleteSession(sessionId, { dir: ws.path }).catch(() => this.k.deleteSession(sessionId!)).catch(() => undefined); throw e }) : chat.workspaceId
    // A fork of a Lead tab is another tab of its Lead chat (KERNEL-337), the one its workspace hosts (KERNEL-405). Fork into new
    // workspace refuses the Lead's workspace.
    const fork = this.saveChat({ ...this.newChat(workspaceId, `Fork of ${chat.title}`, { provider: chat.provider, model: chat.model, effort: chat.effort, plan: chat.plan, threadId: into ? chat.threadId : ws.threadId ?? chat.threadId }), sessionId, forkOf: { chatId, itemId: items[items.length - 1]?.id ?? '' } })
    for (const i of items) this.store.saveItem(fork.id, { ...i, id: `${COPY}${fork.id}:${i.id}` } as ChatItem)
    return fork
  }

  /** Starts the pty for a big terminal chat, or the workspace's plain shell (`shell:<workspaceId>`), the first time it is used. */
  private ensurePty(id: string, size?: { cols: number; rows: number }) {
    if (this.ptys.has(id)) return
    // A Lead chat's folder isn't there until its worktree is made. The shell starts on the first keystroke or resize after (KERNEL-542).
    const wsId = id.startsWith('shell:') ? id.slice('shell:'.length) : this.store.chat(id)?.workspaceId
    if (wsId && this.store.workspace(wsId)?.worktreePending) return
    this.ptys.start(id, { ...this.ptyOptions(id), ...size })
  }

  /** Where a terminal starts, with what, and the command it types: its workspace's folder as it is now. */
  private ptyOptions(id: string) {
    const plain = id.startsWith('shell:')
    const chat = plain ? undefined : this.mustChat(id)
    if (chat && (chat.kind !== 'terminal' || chat.closed)) throw new Error('That tab is not a terminal.')
    const ws = this.mustWs(plain ? id.slice('shell:'.length) : chat!.workspaceId)
    return {
      cwd: ws.path,
      env: sessionEnv(this.k.env.envFor(ws), {}, { agentTeams: this.settings.models.agentTeams }),
      command: (plain ? null : terminalCommand(chat!)) ?? undefined
    }
  }

  /** The workspace's terminals that run a command now, which a folder move waits for (KERNEL-424). */
  busyTerminals(workspaceId: string): boolean {
    return this.terminalIds(workspaceId).some((id) => this.ptys.busy(id))
  }

  /** The workspace's running terminals start again in its folder as it is now, after the folder moved (KERNEL-424). */
  restartTerminals(workspaceId: string) {
    for (const id of this.terminalIds(workspaceId)) if (this.ptys.has(id)) this.ptys.restart(id, this.ptyOptions(id))
  }

  /** The ids of the workspace's terminals: its open big terminal tabs and its plain shell. */
  private terminalIds(workspaceId: string) {
    return [...this.chatTabs(workspaceId).filter((c) => c.kind === 'terminal').map((c) => c.id), shellId(workspaceId)]
  }

  /** The preset a new big terminal tab runs, resolved here so the renderer never names the command (KERNEL-248). */
  private async terminalFor(ws: Workspace, preset?: string) {
    const t = this.settings.terminal
    if (!t.enabled) throw new Error('Big terminal tabs are off. Turn them on in Settings, Big terminal.')
    return resolvePreset(await terminalPresets(t), t, ws.mode, preset)
  }


  /**
   * The chat.running reaction in Kernel's push listener. A turn waiting on an approval or a question is still running, so
   * its agent still counts as working. No database read here: the count looks the chats up when the quit asks for it.
   */
  onRunning(e: Extract<PushEvent, { type: 'chat.running' }>) {
    if (e.running) this.runningChats.add(e.chatId)
    else this.runningChats.delete(e.chatId)
  }
  handlers() {
    return {
      'chats.restart': async ({ chatId }) => { await this.sessions.restart(chatId); return { ok: true } },
      'chats.compact': async ({ chatId }) => { await this.sessions.compact(chatId); return { ok: true } },
      'chats.list': async ({ workspaceId }) => this.chatTabs(workspaceId),
      'chats.rename': async ({ chatId, title }) => this.renameChat(chatId, title),
      'chats.close': async ({ chatId }) => { await this.closeChat(chatId); return { ok: true } },
      'chats.markRead': async ({ chatId }) => { this.markRead(chatId); return { ok: true } },
      'chats.fork': async ({ chatId, itemId }) => this.forkChat(chatId, itemId),
      'terminal.write': async ({ chatId, data }) => { this.ensurePty(chatId); this.ptys.write(chatId, data); return { ok: true } },
      'terminal.resize': async ({ chatId, cols, rows }) => { this.ensurePty(chatId, { cols, rows }); this.ptys.resize(chatId, cols, rows); return { ok: true } },
      'terminal.replay': async ({ chatId }) => { this.ptys.replay(chatId); return { ok: true } },
      'chats.create': async ({ workspaceId, kind, preset, threadId, provider, model: asked, effort }) => {
        const ws = this.mustWs(workspaceId)
        const term = kind === 'terminal' ? await this.terminalFor(ws, preset) : undefined
        // Right after a restart nothing may have read the team yet, and the agent's effort is the fallback.
        if (!this.k.team.agentCache.has(ws.projectId)) await this.k.team.agents(ws.projectId)
        const on = await this.newTabModel(ws, provider, asked)
        const pick = { provider: on.provider, model: on.model, effort: effort ?? this.openedEffort(workspaceId, on.model), plan: false }
        // A Lead tab joins the chat its workspace hosts (KERNEL-405), or in the shared Lead workspace from before, the Lead chat
        // `threadId` (KERNEL-337). A big terminal belongs to no Lead chat.
        if (!term && this.isLeadWorkspace(ws)) return this.k.lead.leadTab(ws, NEW_TAB, pick, threadId)
        return this.newChat(workspaceId, term ? terminalTitle(term.preset) : NEW_CHAT, { ...pick, kind, terminal: term?.terminal })
      },
      'terminal.presets': async () => terminalPresets(this.settings.terminal),
      'chats.items': async ({ chatId }) => this.store.items(chatId),
      'commands.list': async () => this.sessions.commands(this.home),
      'chats.queue': async ({ chatId }) => this.sessions.queued(chatId),
      'chats.queueReason': async ({ chatId }) => this.sessions.queueReason(chatId) ?? null,
      'chats.runMode': async ({ chatId }) => this.sessions.runMode(chatId),
      'chats.live': async () => ({ running: this.sessions.runningIds(), retry: this.sessions.retries() }),
      'chats.unqueue': async ({ chatId, id }) => this.sessions.unqueue(chatId, id),
      'chats.sendNow': async ({ chatId, id }) => this.sendNow(chatId, id),
      'chats.retry': async ({ chatId, itemId, now }) => {
        // Sending their own message again is the user stepping in; a Kernel update sent again isn't.
        const items = this.store.items(chatId)
        const sent = items.slice(0, items.findIndex((i) => i.id === itemId) + 1).reverse().find(isSentItem)
        if (sent && !sent.from && !isKernelUpdate(sent)) this.k.lead.userSpoke(chatId)
        const copy = await this.sessions.retry(chatId, itemId)
        // Retry now: the copy goes first and the running turn stops, past a limit's pause as Send now does.
        if (now && copy) await this.sendNow(chatId, copy.id)
        return { ok: true }
      },
      'chats.send': async ({ chatId, parts }) => { this.k.lead.userSpoke(chatId); return this.sessions.send(chatId, parts) },
      'chats.interrupt': async ({ chatId }) => { await this.sessions.interrupt(chatId); return { ok: true } },
      'chats.configure': async ({ chatId, ...patch }) => {
        const chat = this.mustChat(chatId)
        // A model on the other provider can't take over a conversation, which lives in one CLI's transcript. A chat that
        // hasn't started moves to it; one that has gets a new tab on that provider instead (KERNEL-406).
        if (patch.model && providerOf(patch.model) !== chatProvider(chat)) {
          if (chat.sessionId) throw new Error(`This chat runs on ${chatProvider(chat) === 'codex' ? 'Codex' : 'Claude Code'}. Start a new chat to use ${patch.model}.`)
          this.saveChat({ ...chat, provider: providerOf(patch.model) })
        }
        return this.sessions.configure(chatId, patch)
      }
    } satisfies Partial<Handlers>
  }
}
