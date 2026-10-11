import type { PushEvent } from '@shared/ipc'
import type { Chat, ChatItem, Effort, ModelId, Workspace } from '@shared/types'
import { isKernelUpdate } from '@shared/teamUpdate'
import { effortFor } from '@shared/effort'
import type { Handlers } from '../kernel'
import { sessionEnv } from '../services/sessions'
import { titleText } from '../services/titles'
import { resolvePreset, terminalCommand, terminalPresets, terminalTitle } from '../services/terminalPresets'
import { Feature } from './feature'
import { LEAD_CHAT, NEW_CHAT } from './shared'

const COPY = 'fork:'

/** The finished-turn counts at which Kernel names an auto-named chat again from the whole conversation (KERNEL-202). */
const RENAME_AT = [1, 3, 10, 30]

/** Chat tabs: their names, forks, big terminals and Send now (KERNEL-329). */
export class Chats extends Feature {
  /** Chats with a turn running. Read from `chat.running` so the quit prompt can count agents (KERNEL-214). */
  private runningChats = new Set<string>()

  /** The `chat.running` reaction in the push listener. */
  onRunning(e: Extract<PushEvent, { type: 'chat.running' }>) {
    if (e.running) this.runningChats.add(e.chatId)
    else this.runningChats.delete(e.chatId)
  }

  /**
   * Send now in a room a limit paused sends the message anyway. If the limit is real, Claude Code answers with it and
   * the room stays paused; if it lifted, the answer's rate_limit_event lifts it in Kernel too.
   */
  private async sendNow(chatId: string, id: string) {
    const ws = this.mustWs(this.mustChat(chatId).workspaceId)
    // A brief held for a merge goes now, without waiting (KERNEL-259). One held because setup failed still waits for Run again.
    if (ws.status === 'ready' && ws.waitsFor?.held) {
      await this.sessions.sendNow(chatId, id)
      await this.k.waits.releaseWait(ws.id, { now: true })
      return this.sessions.queued(chatId)
    }
    const room = this.store.room(ws.roomId)
    return this.sessions.sendNow(chatId, id, { pastPause: room?.pausedBy === 'limit' })
  }

  /** Agents with a turn running: workspaces, not chats, so a Lead with two busy chats is one (KERNEL-214). */
  workingAgents(): number {
    const workspaces = [...this.runningChats].map((id) => this.store.chat(id)?.workspaceId).filter(Boolean)
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

  /** Kernel picks this chat's name. A chat still called "New chat" from before KERNEL-202 counts too. */
  private autoNamed(c: Chat) { return c.kind !== 'terminal' && (!!c.autoTitle || c.title === NEW_CHAT) }
  /** An auto-named chat that has no real name yet. */
  private unnamed(c: Chat) { return c.title === NEW_CHAT || (!!c.autoTitle && c.title === LEAD_CHAT) }

  /**
   * Names an auto-named chat (KERNEL-202, amends D-089). Until it has a name, it takes the title Claude Code writes into its
   * transcript a few seconds after the first prompt. The SDK sends no event for it, so Kernel looks on replies, at most every
   * few seconds, and at the end of each turn. At the end of a turn Kernel also asks Haiku for a name from the whole
   * conversation when the chat still has none, or when its count of finished turns reaches 1, 3, 10 or 30. A name the user
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
        const title = (await this.k.sessionInfo(chat.sessionId, { dir: ws.path }).catch(() => undefined))?.customTitle?.trim().slice(0, 60)
        if (this.stopped || resets !== (this.nameResets.get(chat.id) ?? 0)) return
        const now = this.store.chat(chat.id)
        if (title && now && this.autoNamed(now) && this.unnamed(now)) {
          this.titleChecked.delete(chat.id)
          this.nameMisses.delete(chat.id)
          this.saveChat({ ...now, title, autoTitle: now.autoTitle ?? { turns: 0 } })
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
      const title = await this.k.titleFor(titleText(items), { cwd: ws.path, current: unnamed ? undefined : before.title }).catch(() => undefined)
      if (this.stopped || resets !== (this.nameResets.get(chat.id) ?? 0)) return
      const now = this.store.chat(chat.id)
      if (!now || !this.autoNamed(now) || now.title !== before.title) return
      if (title) {
        this.nameMisses.delete(chat.id)
        this.saveChat({ ...now, title, autoTitle: { turns } })
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

  /** /clear starts a new conversation, so an auto name goes back to "New chat" and the schedule starts over. Other resets keep it. */
  resetName(chat: Chat, trigger?: string) {
    if (trigger && trigger !== 'clear') return
    const now = this.store.chat(chat.id)
    if (!now || !this.autoNamed(now)) return
    if (now.sessionId) this.clearedSession.set(chat.id, now.sessionId)
    this.nameResets.set(chat.id, (this.nameResets.get(chat.id) ?? 0) + 1)
    this.nameMisses.delete(chat.id)
    this.titleChecked.delete(chat.id)
    this.saveChat({ ...now, title: NEW_CHAT, autoTitle: { turns: 0 } })
  }

  /** Open chats still called "New chat" after a finished turn, as /clear left them before KERNEL-202. Named one at a time. */
  async nameStuckChats() {
    for (const ws of this.store.workspaces().filter((w) => w.status !== 'archived')) {
      for (const chat of this.chatTabs(ws.id)) {
        if (this.stopped) return
        if (chat.kind === 'terminal' || chat.title !== NEW_CHAT || !chat.sessionId) continue
        if (!this.store.items(chat.id).some((i) => i.kind === 'result')) continue
        await this.nameChat(ws, chat, true).catch(() => undefined)
      }
    }
  }

  /** The tab leaves the strip, its transcript stays. A big terminal's process ends. The last open tab is replaced by a fresh chat. */
  closeChat(chatId: string) {
    const chat = this.mustChat(chatId)
    this.sessions.stop(chatId)
    this.k.ptys.kill(chatId)
    this.saveChat({ ...chat, closed: true })
    if (!this.chatTabs(chat.workspaceId).some((c) => c.kind !== 'terminal')) this.saveChat(this.newChat(chat.workspaceId, NEW_CHAT, { model: chat.model, effort: this.openedEffort(chat.workspaceId, chat.model), plan: false }))
  }

  /**
   * The effort of a chat the user opens: the one they last picked for its model, else the workspace agent's, else Settings, Models (D-130).
   * The Lead's hand-offs and its first chat skip the memory, so they follow the agent file.
   */
  private openedEffort(workspaceId: string, model: ModelId): Effort {
    const ws = this.mustWs(workspaceId)
    const agent = this.agentsSync(ws.roomId).find((a) => a.id === ws.agentId)
    return effortFor(model, this.settings.models.effortByModel, agent?.effort ?? this.settings.models.effort)
  }

  /**
   * A new chat that resumes from this one with the SDK's session fork. With `itemId` the fork ends at the nearest assistant message
   * at or before it (user messages carry no SDK uuid), and the transcript is copied up to there.
   */
  private async forkChat(chatId: string, itemId?: string): Promise<Chat> {
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
    if (chat.sessionId && (!itemId || upTo)) sessionId = (await this.k.forkSession(chat.sessionId, { dir: ws.path, upToMessageId: upTo, title: `Fork of ${chat.title}` })).sessionId
    const fork = this.saveChat({ ...this.newChat(chat.workspaceId, `Fork of ${chat.title}`, { model: chat.model, effort: chat.effort, plan: chat.plan }), sessionId, forkOf: { chatId, itemId: items[items.length - 1]?.id ?? '' } })
    for (const i of items) this.store.saveItem(fork.id, { ...i, id: `${COPY}${fork.id}:${i.id}` } as ChatItem)
    return fork
  }

  /** Starts the pty for a big terminal chat, or the workspace's plain shell (`shell:<workspaceId>`), the first time it is used. */
  private ensurePty(id: string, size?: { cols: number; rows: number }) {
    if (this.k.ptys.has(id)) return
    const plain = id.startsWith('shell:')
    const chat = plain ? undefined : this.mustChat(id)
    if (chat && (chat.kind !== 'terminal' || chat.closed)) throw new Error('That tab is not a terminal.')
    const ws = this.mustWs(plain ? id.slice('shell:'.length) : chat!.workspaceId)
    this.k.ptys.start(id, {
      cwd: ws.path,
      env: sessionEnv(this.k.envFor(ws), {}, { agentTeams: this.settings.models.agentTeams }),
      command: (plain ? null : terminalCommand(chat!)) ?? undefined,
      ...size
    })
  }

  /** The preset a new big terminal tab runs, resolved here so the renderer never names the command (KERNEL-248). */
  private async terminalFor(ws: Workspace, preset?: string) {
    const t = this.settings.terminal
    if (!t.enabled) throw new Error('Big terminal tabs are off. Turn them on in Settings, Big terminal.')
    return resolvePreset(await terminalPresets(t), t, ws.mode, preset)
  }

  handlers() {
    return {
      'chats.restart': async ({ chatId }) => { await this.sessions.restart(chatId); return { ok: true } },
      'chats.compact': async ({ chatId }) => { await this.sessions.compact(chatId); return { ok: true } },
      'chats.list': async ({ workspaceId }) => this.chatTabs(workspaceId),
      'chats.rename': async ({ chatId, title }) => this.renameChat(chatId, title),
      'chats.close': async ({ chatId }) => { this.closeChat(chatId); return { ok: true } },
      'chats.fork': async ({ chatId, itemId }) => this.forkChat(chatId, itemId),
      'terminal.write': async ({ chatId, data }) => { this.ensurePty(chatId); this.k.ptys.write(chatId, data); return { ok: true } },
      'terminal.resize': async ({ chatId, cols, rows }) => { this.ensurePty(chatId, { cols, rows }); this.k.ptys.resize(chatId, cols, rows); return { ok: true } },
      'terminal.replay': async ({ chatId }) => { this.k.ptys.replay(chatId); return { ok: true } },
      'chats.create': async ({ workspaceId, kind, preset }) => {
        const ws = this.mustWs(workspaceId)
        const term = kind === 'terminal' ? await this.terminalFor(ws, preset) : undefined
        // Right after a restart nothing may have read the team yet, and the agent's effort is the fallback.
        if (!this.k.team['agentCache'].has(ws.roomId)) await this.k.agents(ws.roomId)
        const model = this.store.chats(workspaceId)[0]?.model ?? this.settings.models.engineers
        return this.newChat(workspaceId, term ? terminalTitle(term.preset) : NEW_CHAT, { model, effort: this.openedEffort(workspaceId, model), plan: false, kind, terminal: term?.terminal })
      },
      'terminal.presets': async () => terminalPresets(this.settings.terminal),
      'chats.items': async ({ chatId }) => this.store.items(chatId),
      'commands.list': async () => this.sessions.commands(this.home),
      'chats.queue': async ({ chatId }) => this.sessions.queued(chatId),
      'chats.queueReason': async ({ chatId }) => this.sessions.queueReason(chatId) ?? null,
      'chats.live': async () => ({ running: this.sessions.runningIds(), retry: this.sessions.retries() }),
      'chats.unqueue': async ({ chatId, id }) => this.sessions.unqueue(chatId, id),
      'chats.sendNow': async ({ chatId, id }) => this.sendNow(chatId, id),
      'chats.retry': async ({ chatId, itemId, now }) => {
        // Sending their own message again is the user stepping in; a Kernel update sent again isn't.
        const items = this.store.items(chatId)
        const sent = items.slice(0, items.findIndex((i) => i.id === itemId) + 1).reverse().find((i) => i.kind === 'user')
        if (sent?.kind === 'user' && !sent.from && !isKernelUpdate(sent)) this.k.lead.userSpoke(chatId)
        const copy = await this.sessions.retry(chatId, itemId)
        // Retry now: the copy goes first and the running turn stops, past a limit's pause as Send now does.
        if (now && copy) await this.sendNow(chatId, copy.id)
        return { ok: true }
      },
      'chats.send': async ({ chatId, parts }) => { this.k.lead.userSpoke(chatId); return this.sessions.send(chatId, parts) },
      'chats.interrupt': async ({ chatId }) => { await this.sessions.interrupt(chatId); return { ok: true } },
      'chats.configure': async ({ chatId, ...patch }) => this.sessions.configure(chatId, patch)
    } satisfies Partial<Handlers>
  }
}
