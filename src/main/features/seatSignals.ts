import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { AnyHook, HookPayload } from '@shared/hookSchemas'
import type { Chat } from '@shared/types'
import { bus } from '../bus'
import { savePlan } from '../services/plans'
import { Feature } from './feature'

/** What ask_user says in a terminal seat, where the question is asked in the terminal and not on a card. */
export const ASK_IN_TERMINAL = 'Not asked here: you run in a terminal, so ask with the AskUserQuestion tool, which shows the question there. Kernel records the answer.'

/** The refusal of a tool that checks what the user said, while Kernel can't see it. */
export const NO_HOOKS_REFUSAL = "Not allowed: Kernel can't see what the user typed in this terminal, so it can't check their words. Hooks connect a terminal to Kernel. Ask the user to turn them on in Settings, Hooks, then to send their message again."

/** The tools that act on the user's own words, which a seat may call only while Kernel has seen those words (KERNEL-999). */
const GATED = new Set(['create_workspace', 'file_issue', 'start_build', 'merge_workspace', 'overrule_blockers'])

interface Said { text: string; at: number; open: boolean }

type Hook<N extends HookPayload['hook_event_name']> = Extract<HookPayload, { hook_event_name: N }>

/**
 * What a terminal seat's hooks tell Kernel (KERNEL-999): the user's words for the tools that check them, plan mode, working
 * and idle, the session, a plan approved in the TUI and the answer to a question asked there. The SDK gives a chat all of
 * these from its transcript. Nothing here is saved to disk but the chat's own fields, so a restart starts with no words
 * seen, and a tool that needs them refuses until the user writes again.
 */
export class SeatSignals extends Feature {
  private said = new Map<string, Said>()
  /** The ids ask_user was about, until the TUI's answer settles them. */
  private asking = new Map<string, string[]>()
  private running = new Set<string>()

  /** A hook from a seat's terminal. `chatId` is the one its command named, already checked by the hook server. */
  onHook(e: AnyHook, chatId: string) {
    const chat = this.store.chat(chatId)
    if (!chat || chat.kind !== 'terminal' || !chat.terminal?.role) return
    const now = this.follow(chat, e)
    switch (e.hook_event_name) {
      case 'UserPromptSubmit': {
        const prompt = (e as Hook<'UserPromptSubmit'>).prompt
        this.said.set(chatId, { text: prompt, at: Date.now(), open: true })
        this.k.openItems.userSent(chatId)
        this.setRunning(chatId, true)
        void this.name(now)
        break
      }
      case 'Stop':
      case 'SessionEnd': {
        const said = this.said.get(chatId)
        if (said) said.open = false
        this.setRunning(chatId, false)
        void this.name(now, true)
        break
      }
      case 'PostToolUse': {
        const tool = e as Hook<'PostToolUse'>
        if (tool.tool_name === 'ExitPlanMode') this.planApproved(now, tool)
        else if (tool.tool_name === 'AskUserQuestion') this.answered(chatId)
        break
      }
    }
  }

  /** The words the user typed in this seat's current turn. None once the turn has ended, so nothing old can be quoted. */
  userSaid(chatId: string): { text: string; at: number } | undefined {
    const s = this.said.get(chatId)
    return s?.open ? { text: s.text, at: s.at } : undefined
  }

  /** A seat's tools run in a turn the user started, which is the only kind its terminal has. False while no prompt has been seen. */
  userTurn(chatId: string): boolean { return !!this.said.get(chatId)?.open }

  /** Whether a seat's agent is in a turn, as its hooks last said. */
  working(chatId: string): boolean { return this.running.has(chatId) }

  /** A closed tab, an archived workspace or a stopped terminal: nothing of the seat is left. */
  forget(chatId: string) {
    this.said.delete(chatId)
    this.asking.delete(chatId)
    this.setRunning(chatId, false)
  }

  /** A seat's tools as the engine serves them: ask_user points at AskUserQuestion, and the tools that check words need hooks. */
  wrap(chatId: string, tools: SdkMcpToolDefinition<any>[]): SdkMcpToolDefinition<any>[] {
    return tools.map((t) => {
      if (t.name === 'ask_user') {
        return { ...t, handler: async (args: { about?: string[] }) => {
          this.asking.set(chatId, args?.about ?? [])
          return { content: [{ type: 'text' as const, text: ASK_IN_TERMINAL }] }
        } }
      }
      if (!GATED.has(t.name)) return t
      const run = t.handler
      return { ...t, handler: async (args: { review_of?: string }, extra: unknown) => {
        // A review is no hand-off of the user's work and needs no words from them.
        const open = t.name === 'create_workspace' && !!args?.review_of
        if (!open && !(this.userTurn(chatId) && await this.k.hooks.connected())) return { content: [{ type: 'text' as const, text: NO_HOOKS_REFUSAL }], isError: true }
        return run(args, extra)
      } }
    })
  }

  /** Plan mode, and the session and transcript the hook reports. Returns the chat as saved. */
  private follow(chat: Chat, e: AnyHook): Chat {
    const t = chat.terminal!
    const plan = e.permission_mode === undefined ? chat.plan : e.permission_mode === 'plan'
    const session = e.session_id !== t.sessionId || (e.transcript_path !== undefined && e.transcript_path !== t.transcriptPath)
    if (plan === chat.plan && !session) return chat
    // The first session of a tab named after its preset takes Claude Code's title for it, as a chat does (D-089).
    const named = !chat.autoTitle && /^Terminal \(/.test(chat.title) ? { autoTitle: { turns: 0 } } : {}
    const next = this.saveChat({ ...chat, plan, ...named, terminal: { ...t, sessionId: e.session_id, ...(e.transcript_path ? { transcriptPath: e.transcript_path } : {}) } })
    if (session) this.k.seats.sessionChanged(chat.id)
    return next
  }

  private name(chat: Chat, turnEnded = false) {
    const ws = this.store.workspace(chat.workspaceId)
    return ws ? this.k.chats.nameChat(ws, chat, turnEnded).catch(() => undefined) : undefined
  }

  private setRunning(chatId: string, on: boolean) {
    if (this.running.has(chatId) === on) return
    if (on) this.running.add(chatId)
    else this.running.delete(chatId)
    bus.push({ type: 'chat.running', chatId, running: on })
  }

  /** ExitPlanMode finished, which Claude Code runs only once the user accepted: the plan joins the chat's approved plans. */
  private planApproved(chat: Chat, e: Hook<'PostToolUse'>) {
    const ws = this.store.workspace(chat.workspaceId)
    const given = (e.tool_input as { plan?: unknown } | undefined)?.plan ?? (e.tool_response as { plan?: unknown } | undefined)?.plan
    const plan = typeof given === 'string' ? given.trim() : ''
    if (!ws || !plan) return
    const title = plan.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 120) ?? 'Plan'
    const { approval } = this.approvals.request({ kind: 'plan', source: 'hook', projectId: ws.projectId, workspaceId: ws.id, chatId: chat.id, agentId: ws.agentId, toolName: 'ExitPlanMode', title, detail: plan })
    this.approvals.decide(approval.id, { behavior: 'allow' })
    void savePlan(ws.path, plan).then((planFile) => { this.approvals.update(approval.id, { planFile }) }).catch(() => undefined)
  }

  /** The user answered AskUserQuestion in the terminal: what ask_user was about is settled, or the teammates they addressed. */
  private answered(chatId: string) {
    const about = this.asking.get(chatId) ?? []
    this.asking.delete(chatId)
    this.k.openItems.asked(chatId, about)
  }
}
