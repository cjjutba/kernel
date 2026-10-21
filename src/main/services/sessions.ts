import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelInfo, Options, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { AccountAuth, Approval, UnlistedTools, AgentDef, AgentStatus, BuiltinCommand, Chat, ChatItem, ChatPart, ChatRunMode, CodexPersonality, CompactWindow, Decision, LastTurn, Provider, MessageFrom, QueuedMessage, QueueReason, RateLimit, Role, TeamUpdate, Workspace } from '@shared/types'
import type { Retry } from '@shared/ipc'
import { linkText } from '@shared/links'
import { nearLimit } from '@shared/usage'
import { isKernelUpdate } from '@shared/teamUpdate'
import { answerItemId, answerParts, isSentItem } from '@shared/approvalAnswer'
import type { Store } from '../db'
import { bus } from '../bus'
import type { Approvals } from './approvals'
import { blockingLimit, isRejected, limitedModels, WINDOW_MODEL, type Failure } from './health'
import { forProvider, LEAD_RULE, planApproval } from './handoff'
import { mentionNote, mentionsOf } from './mentions'
import { missingServers, type MissingServer } from './agentTools'
import type { McpReport } from './mcp'
import { revisedPlanFile, savePlan } from './plans'
import { hasUnsaved, withAttachments } from './attachments'
import type { AppSettings } from './settings'
import { buildEnv, kernelVars } from './env'
import { endAll } from './processes'
import { ClaudeRunner, claudeCommands, claudeModels, TOOL_STOPPED } from './providers/claude'
import { claudeExecutable } from './providers/binary'
import { chatMode, type ChatAvailability, type RunMode } from './permissions'
import { limitKey, liftedBy, mergeLimit, type LimitPatch } from './providers/limits'
import { CodexRunner } from './providers/codex/runner'
import { chatProvider, limitProvider } from '@shared/providers'
import type { Ask, Proc, Runner, RunnerHost, TurnUsage } from './providers/types'

// Moved behind the provider seam (KERNEL-406). Exported here too for what imports them from Sessions.
export { askedQuestions, packagedClaude, InputQueue, toUserMessage, sessionEnv, limitsFromEvent, limitsFromUsage, HOLD_TIMEOUT_SEC, TOOL_STOPPED } from './providers/claude'
export { limitKey, mergeLimit, type LimitPatch } from './providers/limits'

interface Live {
  /** The chat's process on its provider (KERNEL-406). */
  runner: Runner
  running: boolean; interrupted: boolean
  /** The Lead mode the process started in, which its prompt and Kernel's tools follow (KERNEL-994). */
  /** Background tasks (shells, subagents, monitors) the process is running, from its latest background_tasks_changed. */
  tasks: Set<string>
  /** Cards this process put up (`placeApproval`). A Stop or Send now, or the process ending, ends those still waiting (KERNEL-563). */
  cards: Set<string>
  /** The pids of the processes this chat started, each the leader of its own process group, which `stop` can end (KERNEL-810). */
  groups: Set<number>
  /** Set by sendNow: the interrupted turn is followed by the queue. A plain Stop is not. */
  sendNext?: boolean
  /** An api_retry is counting down. The next reply or result clears the banner. Kept for a window that loads meanwhile (KERNEL-340). */
  retry?: Retry
  /** Claude Code answered this turn with a usage limit, so the turn ended early. */
  limited?: boolean
  /** This turn was /clear. Its result row is left out, so the cleared chat starts empty. */
  cleared?: boolean
  /** Called once when the running turn ends. Set by `shutdown`, which waits for interrupted turns. */
  whenIdle?: () => void
  /**
   * Kernel's quit interrupted this turn. Claude Code answers a running tool with its own rejection text, which reads as the
   * user refusing it, so the row says Kernel quit instead (KERNEL-396).
   */
  quit?: boolean
  /** This turn carries on a chat a quit cut off (KERNEL-215): the nudge, or what was queued before it. */
  carrying?: boolean
  /** This turn hit a sign-out or a dropped connection. */
  failed?: 'auth' | 'network'
  /** The account the process runs on, which its usage windows belong to. Undefined is the CLI's own login (KERNEL-406). */
  account?: string
  /** What the running turn read and cached, as its runner reported it just before it ended (KERNEL-842). */
  usage?: TurnUsage
  /** That account is an API key account: it has no usage windows, and the key should pay for it (KERNEL-523). */
  onKey?: boolean
  /** A Claude process started allowed to take Bypass permissions, which it keeps for life (KERNEL-447). Undefined on Codex. */
  bypass?: boolean
  /**
   * A Codex thread started in Bypass permissions, so with the MCP servers its tools line leaves out, which it keeps until its
   * process restarts (bypass-allows-unlisted-mcp). Undefined on Claude.
   */
  threadBypass?: boolean
  /** The note saying Bypass permissions waits for this turn, so turning it on again updates it and off again corrects it (KERNEL-809). */
  bypassNote?: { id: string; waits: boolean }
  /** The mode Kernel last started or switched the process in, which a Claude process keeps while Bypass permissions waits (KERNEL-572). */
  mode: RunMode
  /** The message that started the running turn, and its row, which a fresh session sends again when the resumed one is gone. */
  sent?: ChatPart[]
  sentItem?: ChatItem & { kind: 'user' }
  /** A compaction runs on the process in place of a turn (`compactOn`), and this hears how it ended (KERNEL-844). */
  compacting?: (ok: boolean) => void
  /** The running turn re-reads the chat's history cold, on another account or model, so it takes one of COLD_AT_ONCE (KERNEL-844). */
  cold?: boolean
}

/** A process as started: the binary, and its first argument (a script path when the SDK runs node or bun). */
interface Spawned { command: string; arg?: string }
interface SavedPid extends Spawned { pid: number }

/**
 * What Kernel knows about a chat's turns that outlives its process, so an idle stop changes no answer (KERNEL-183). Only
 * `stop()` forgets it.
 */
interface Turns {
  /** Who sent the message that started the running turn, or the last one: Kernel, the Lead, or the user when unset (KERNEL-116). */
  from?: MessageFrom
  /**
   * The hook event that refused a step, while the agent has not moved on. A new message ends it. After PreToolUse, so does a
   * later tool call that succeeds. After the hooks that refuse to let the agent finish (Stop and the task hooks), so does a turn
   * that ends successfully. A turn that ends any other way keeps it, since the agent gave up.
   * Known limit: with parallel tool calls, another call in the same message that succeeds ends a PreToolUse block at once.
   */
  blocked?: string
  /**
   * Codex plans waiting on the user after their turn ended, which an idle stop leaves waiting. The user's next message ends
   * them, and so do `stop()` and a crash. Kernel's messages leave them (KERNEL-563).
   */
  plans?: Set<string>
}

/** How many chats a usage limit cut off restart at once when it lifts. Each next one starts when one ends its turn (KERNEL-220). */
export const RESUME_AT_ONCE = 2

/** A restart keeps a rejection with no reset time this long after it began, a 5-hour window's length (KERNEL-1030). */
export const PROVISIONAL_KEPT_MS = 5 * 60 * 60_000

/**
 * How many chats re-read their history cold at once, as after a switch: the rest wait, smallest first, so a switch doesn't
 * spend a window on every chat's history in the same minutes. The Lead's chats never wait (KERNEL-844).
 */
export const COLD_AT_ONCE = 2

/**
 * What Claude's /compact keeps when Kernel summarizes a chat before it moves to another account (KERNEL-844). Codex compacts
 * its thread with no instructions.
 */
export const COMPACT_INSTRUCTIONS = 'Keep the task and what is left of it, every file you read or changed, the decisions made and why, and the open questions, so you can carry on from this summary alone.'

/** The note when a turn found the chat too long for its model's context window, so Kernel summarizes it and tries once more (KERNEL-844). */
export const TOO_LONG_NOTE = 'This chat was too long for the model, so Kernel summarized it and is sending the message again.'

/**
 * What a chat's next turn does about running on another account than its last one (KERNEL-844): run as it is (`continue`),
 * wait for the user to choose (`ask`), or `summarize` first on account `on` (`cli` for the CLI's own login), with a note.
 */
export type MovePlan = { do: 'continue' } | { do: 'ask' } | { do: 'summarize'; on: string; note?: string }

/** How long a chat with nothing to do keeps its Claude Code process before Kernel stops it. The next message resumes it (KERNEL-183). */
export const IDLE_STOP_MS = 10 * 60_000

export interface SessionDeps {
  store: Store
  approvals: Approvals
  settings: () => AppSettings
  /** The agent a workspace runs. With `chat`, the one that chat runs, which a review chat picks by its kind (KERNEL-549). */
  agentFor: (ws: Workspace, chat?: Chat) => AgentDef | undefined
  /** The project's team as Kernel last read it, for the agents a Lead message mentions (KERNEL-745). Undefined when unread. */
  teamOf?: (projectId: string) => AgentDef[] | undefined
  /**
   * What a Lead chat owes until the Lead acts on it (`features/openItems.ts`, KERNEL-749): a message's mentions open items,
   * the user's own message closes the tab's mentions, and the Stop hook reads the reminder. Left out, nothing is held.
   */
  openItems?: { mentioned: (chat: Chat, mentioned: { agentId: string; name: string }[]) => void; userSent: (chatId: string) => void; atStop: (chatId: string) => string | undefined }
  /** The role Settings, Models reads for a chat in this workspace run by `agent` (`Team.roleFor`). Without it a chat has no compact window of its own. */
  roleFor?: (ws: Workspace, agent: AgentDef | undefined) => Role
  /** In-process MCP servers this agent may use (Kernel's own tools for the lead). */
  mcpFor: (ws: Workspace, agent: AgentDef | undefined, chat: Chat) => Options['mcpServers']
  /**
   * What a Codex chat runs (KERNEL-406): the executable, the CODEX_HOME of `account`, the one the chat runs on (KERNEL-843),
   * and on an API key account its key (KERNEL-523), the personality, and Kernel's own tools with their instructions, which Codex gets as dynamic tools. Without
   * it a Codex chat can't start.
   */
  codexFor?: (ws: Workspace, agent: AgentDef | undefined, chat: Chat, account?: string) => { bin?: string; home?: string; apiKey?: string; personality: CodexPersonality; tools: SdkMcpToolDefinition<any>[]; instructions?: string }
  /** The skills and MCP servers switched off for the workspace's project in Settings, Skills and MCP (KERNEL-226). */
  disabledFor?: (ws: Workspace) => { skills: string[]; mcp: string[] } | undefined
  /** The project's `[mcp.aliases]`, which the agent file's tools line reads through (KERNEL-464). */
  aliasesFor?: (ws: Workspace) => Record<string, string> | undefined
  /** The project's `[agents]` table for the workspace's agent: `unlisted_tools` and its `allow` servers (KERNEL-537). */
  accessFor?: (ws: Workspace) => { unlisted: UnlistedTools; allow: string[] } | undefined
  /** The project's reference folders that are there now, which a chat may read but not edit (KERNEL-748, KERNEL-790). */
  referencesFor?: (ws: Workspace) => string[] | undefined
  /**
   * A session reported how its MCP servers are doing, on `account`, undefined for the CLI's own login (KERNEL-939). Returns
   * every report the project holds for that provider since, which may name servers this session's report doesn't yet, such
   * as claude.ai connectors that join late (KERNEL-464).
   */
  onMcp?: (ws: Workspace, provider: Provider, servers: McpReport[], account: string | undefined) => McpReport[]
  /** Kernel's own rule for this workspace, appended to the agent's prompt, such as a reviewer's (KERNEL-130). */
  rulesFor?: (ws: Workspace, agent: AgentDef | undefined, chat?: Chat) => string | undefined
  /** Bash rules the user allowed for the whole project. */
  projectAllow: (projectId: string) => string[]
  /**
   * What the chat can run now (KERNEL-447): Auto for its provider and model, and Bypass permissions under admin policy.
   * `wants` is the mode the chat asks for, so a read only starts when it matters. Without it, Bypass is allowed and Auto isn't.
   */
  availability?: (chat: Chat, ws: Workspace, wants: RunMode) => ChatAvailability
  /**
   * The account a provider runs on now, undefined for the CLI's own login (KERNEL-406). With `chat`, the account that chat's
   * next turn runs on, which can be the one holding its cache rather than the one in use (`Placement.accountFor`, KERNEL-843).
   */
  accountFor?: (provider: Provider, chat?: Chat) => string | undefined
  /**
   * What a Claude process adds to its environment for `account`, undefined for the CLI's own login: an added login's folder as
   * CLAUDE_CONFIG_DIR, readied first (KERNEL-567), a legacy token, or its API key (KERNEL-406, KERNEL-523, KERNEL-843).
   */
  claudeEnv?: (account: string | undefined) => Record<string, string>
  /** A turn of the chat is about to start, on whichever account (KERNEL-843). */
  startedOn?: (chat: Chat) => void
  /** The accounts `usage()` asks when its caller names none: every one the providers can read, live processes only (KERNEL-567). */
  usageReads?: () => UsageRead[]
  /** The other accounts on the same login as `accountId` (undefined is the CLI's own), which share its windows (KERNEL-1030). */
  sameLoginAccounts?: (provider: Provider, accountId: string | undefined) => (string | undefined)[]
  /** Reads the account's usage now, whatever was read lately (KERNEL-1030). */
  readUsageNow?: (provider: Provider, accountId: string | undefined) => void
  /** How an account signs in (KERNEL-523). Without it every account is a subscription one. */
  authOf?: (provider: Provider, accountId: string | undefined) => AccountAuth
  /**
   * The note a chat gets after its first turn on another account than its last one, `from` that account (`cli` for the CLI's
   * own login): "Moved to Personal and re-read 310k tokens", from the turn's `lastTurn`, and why when a limit moved it
   * (KERNEL-568, KERNEL-842). Without it the chat says nothing.
   */
  moveNote?: (chat: Chat, from: string, summary?: { pre?: number; post?: number }) => string | undefined
  /**
   * What the chat's next turn does about moving from its last account to `to`, by Settings, Account and the chat's own
   * choice (`Moves.plan`, KERNEL-844). Without it every move just runs.
   */
  movePlan?: (chat: Chat, to: string) => MovePlan | undefined
  /** A long chat started or stopped waiting for the user to choose how it moves (`ask`), for the project's Inbox item (KERNEL-844). */
  onMoveHold?: (chat: Chat, held: boolean) => void
  /**
   * The chat's size in tokens when its next turn re-reads its history cold, on another account or model, else undefined
   * (`Placement.coldSize`, KERNEL-844). Without it nothing is staggered.
   */
  coldSize?: (chat: Chat) => number | undefined
  /** The email of a provider's account as Kernel last read it, undefined `accountId` for the CLI's own login (KERNEL-842). */
  emailOf?: (provider: Provider, accountId: string | undefined) => string | undefined
  /**
   * A note the agent reads at the start of the chat's next turn, taken as the turn starts so it goes once, as after its files
   * were reverted (KERNEL-764). The chat's row doesn't show it.
   */
  turnNote?: (chat: Chat) => string | undefined
  /** The workspace's variables from `Kernel.envFor` (KERNEL-247). Without it a session gets the Mac's and Kernel's own. */
  envFor?: (ws: Workspace) => Record<string, string>
  allowInProject: (projectId: string, rule: string) => void
  /** Rules the user allowed for the project's MCP and web tools (`Project.allowTools`), and saving one (KERNEL-454). Without them none apply. */
  projectTools?: (projectId: string) => string[]
  allowToolInProject?: (projectId: string, rule: string) => void
  /** The agent sent a message, its subagents' included. Kernel looks for the session's title then. */
  onReply?: (ws: Workspace, chat: Chat) => void
  /** A message went into the chat, before its turn starts. Kernel names a chat that has no name from the first one (KERNEL-1024). */
  onSent?: (ws: Workspace, chat: Chat, parts: ChatPart[]) => void
  /** Claude's API answered: a message with no `error`, or a `success` result without `is_error`. The network works, whatever DNS says (KERNEL-231). */
  onReached?: () => void
  /** Claude Code started a fresh conversation in the chat. `trigger` is the SDK's: 'clear' for /clear, absent from older emitters (KERNEL-202). */
  onReset?: (ws: Workspace, chat: Chat, trigger?: string) => void
  /**
   * A turn ended. `ok` is false for an error; `interrupted` is true when the user stopped it; `by` sent the message that started
   * it; `account` is the one it ran on, undefined for the CLI's own login. `limit`: a usage limit cut it off, so the chat waits
   * to carry on (KERNEL-777). `refused`: it was a carry-on that a limit refused again within seconds, which is no news unless
   * `stuck`: the third strike, after which `carryOn` stops (KERNEL-1031).
   */
  /** Whether a chat with Kernel may change files now, read at each step (`Lead.buildOpen`, KERNEL-992). Left out, it always may. */
  buildOpen?: (chatId: string) => boolean
  /** The user approved a plan in a chat with Kernel, which counts as the go-ahead (KERNEL-992). */
  onTurnDone?: (ws: Workspace, chat: Chat, turn: { ok: boolean; interrupted: boolean; by: TurnBy; account?: string; limit?: true; refused?: true; stuck?: true }) => void
  /**
   * A chat a usage limit or a quit cut off answered its carry-on cleanly: its queue went, or Kernel's nudge did, and the
   * API replied. A refused carry-on never gets here. After a limit, the chat runs on the account its provider uses now
   * (KERNEL-777, KERNEL-1031).
   */
  onCarriedOn?: (chatId: string, reason: CutOffReason) => void
  /**
   * The session's process ended without being stopped. `midTurn` is true when a turn was running, so the agent's work
   * stopped halfway; an idle process that went away harms nothing, since the next message starts a new one. Stop,
   * archive and quit don't call this. A chat a quit or a crash of Kernel cut off mid-turn is reported at the next launch,
   * with `resumed` true, since it carries on by itself (KERNEL-215).
   */
  onExit?: (ws: Workspace, chat: Chat, reason: string, midTurn: boolean, resumed: boolean) => void
  /**
   * A session hit something the banners show: a sign-out, a dropped connection. Kernel checks it and tells the renderer.
   * `account` is the one the session's process started on, undefined for the CLI's own login, which a switch since may have
   * left (feat-make-claude-account-credentials-and).
   */
  onFailure?: (failure: Failure, ws: Workspace, provider: Provider, account: string | undefined) => void
  /** Usage windows changed. Kernel pauses projects on an account-wide rejection and schedules the reset. */
  onLimits?: (limits: RateLimit[]) => void
  /** The chats a limit or a quit stopped changed. Kernel saves them, so they still carry on after a restart. */
  onCutOff?: (cutOff: Record<string, CutOffEntry>) => void
  /** What held chats are holding changed. Kernel saves it, so a brief survives a restart (KERNEL-128). */
  onHeld?: (held: Record<string, QueuedMessage[]>) => void
  /**
   * A hold on every chat of a project or a provider lifted: a resume, back online or signed in, the launch checks done, a
   * chat's setup hold released, or a slot opened (`drainWaiting`). A chat `post` refused may take Kernel's message now
   * (KERNEL-637, KERNEL-651).
   */
  onFreed?: () => void
}

/**
 * One account whose usage windows `usage()` reads (KERNEL-567). Undefined `accountId` is the provider's CLI login. `read` reads
 * it without a live process and merges what it got. Without it, only a live process on the account is asked.
 */
export interface UsageRead { provider: Provider; accountId?: string; read?: (merge: (p: LimitPatch[]) => void) => Promise<void> }

/** Who sent a message the user didn't type, the Team update card it carries (KERNEL-116), and the plan approval it answers. */
/** `clientId` is the id the window drew the message under (KERNEL-894), which its queued message and its row take. */
export interface Sender { from?: MessageFrom; update?: TeamUpdate; approvalId?: string; clientId?: string }

/** Who started a turn. */
export type TurnBy = MessageFrom | 'user'

/**
 * Why `post` refuses Kernel's message now (KERNEL-637): the chat runs a turn (`busy`), has messages queued, its session died
 * mid-turn, it is held (`held`: its workspace isn't made yet, its folder is gone, or its brief waits for a merge) or waits for a
 * launch check, its project is paused, it is offline or signed out, it waits for the user to
 * choose how it moves to another account, it is held near a usage limit, over the agent limit or behind cold re-reads, or
 * Kernel is closing.
 */
export type PostHold = 'busy' | 'queued' | 'crashed' | 'held' | 'launching' | 'paused' | 'offline' | 'move' | 'limit' | 'capacity' | 'moving' | 'folder' | 'closing'

/** What stopped a chat mid-turn that carries on by itself: a usage limit, or Kernel quitting or closing (KERNEL-215). */
export type CutOffReason = 'limit' | 'quit'

/** A chat on the carry-on list: why, on which account a limit stopped it ('cli' is the CLI's own login), and when (KERNEL-1031). */
export interface CutOffEntry { reason: CutOffReason; account?: string; at: number }

/** A carry-on that a limit refuses again within this long, on the same account, is a strike for the chat (KERNEL-1031). */
export const REFUSED_WITHIN_MS = 10_000

/** After this many strikes `carryOn` sends the chat no more nudges until something changes (KERNEL-1031). */
export const MAX_STRIKES = 3

/** Moved to the shared contract (KERNEL-271). Exported here too for what imports it from Sessions. */
export type { QueueReason }

/** The sender fields to store on a chat item or queue entry, leaving out the ones that aren't set. */
const sender = (o: Sender): Sender => ({ ...(o.from ? { from: o.from } : {}), ...(o.update ? { update: o.update } : {}), ...(o.approvalId ? { approvalId: o.approvalId } : {}) })

/** A message as it waits in a chat's queue: under the window's id when it gave one, so the row it becomes keeps it. */
const queuedOf = (chatId: string, parts: ChatPart[], o: Sender): QueuedMessage =>
  ({ id: o.clientId ?? randomUUID(), chatId, parts, ts: Date.now(), ...sender(o), ...(o.clientId ? { clientId: o.clientId } : {}) })

/** What `steer` did: `steered` when the running turn took the message, else it went as an ordinary send or stayed queued. */
export interface SteerResult { steered: boolean; queued: boolean; why?: QueueReason; item?: ChatItem; queue: QueuedMessage[] }

/** The workspace is ready and the brief waits for PRs to merge (KERNEL-259). Any other held chat waits for its workspace to be made (KERNEL-1086). */
const heldForMerge = (ws?: Workspace) => ws?.status === 'ready' && !!ws.waitsFor?.held

/** What a chat says once about a server its agent file lists that the session can't use (KERNEL-397, KERNEL-464). */
export function mcpNote(m: MissingServer): string {
  const lists = `This agent's file lists ${m.entry}, but`
  switch (m.status) {
    case 'failed': return `${lists} the MCP server ${m.name} failed to connect.`
    case 'needs-auth': return `${lists} the MCP server ${m.name} needs you to sign in. Sign in with /mcp in Claude Code.`
    case 'disabled': return `${lists} the MCP server ${m.name} is switched off in Claude Code. Turn it on with /mcp.`
    case 'off': return `${lists} the MCP server ${m.name} is switched off in this project. Turn it on in Settings, Skills and MCP.`
    default: return `${lists} no MCP server named ${m.server} is connected.${m.suggestion ? ` Did you mean mcp__${m.suggestion}?` : ''}`
  }
}

/** Why a chat's process needs replacing: its mode, Bypass, agent or account changed, or the compact window did (KERNEL-994). */
export type StaleReason = 'bypass' | 'agent' | 'account' | 'compact'

export class Sessions {
  private live = new Map<string, Live>()
  /** Per chat, whether or not its process is running. */
  private turns = new Map<string, Turns>()
  /** Idle clocks of live chats between turns. One that runs out stops the process (KERNEL-183). */
  private idle = new Map<string, ReturnType<typeof setTimeout>>()
  /** Chats whose process needs replacing after a change during a turn or a background task, by why. It ends once nothing runs (KERNEL-397), or before the next message goes to it (KERNEL-994). */
  private stale = new Map<string, Set<StaleReason>>()
  /** Each chat's mode as the renderer last got it, from `runMode` or a `chat.runMode` push, so a change goes out once (KERNEL-572). */
  private shownModes = new Map<string, string>()
  /** Lead chats with an approved plan and nothing handed off yet (KERNEL-67). The Lead tools end one when they create a workspace. */
  private queues = new Map<string, QueuedMessage[]>()
  /** What each held queue last told the renderer it waits for. Computed, never saved with a held brief (KERNEL-271). */
  private reasons = new Map<string, QueueReason | undefined>()
  /** Chats whose turn started on another account than their last turn's, by that account, until a turn ends there (KERNEL-842). */
  private moves = new Map<string, string>()
  /** Long chats that wait for the user to choose how they move, by the account they would move to (KERNEL-844). */
  private moveHolds = new Map<string, string>()
  /**
   * Chats summarized for a move, by the account they move to, until their next turn starts (KERNEL-844). A turn that starts
   * with another target drops it and decides again, so two quick switches move a chat once.
   */
  private compacted = new Map<string, string>()
  /**
   * The note of a summary for a move, by chat, until the move is noted: its id, and the compaction's own note and sizes once
   * it ended. The move's note replaces it under the same id, so a move shows one note (KERNEL-1026).
   */
  private summaries = new Map<string, { id: string; ts: number; compaction?: ChatItem; sizes?: { pre: number; post?: number } }>()
  /** Chats whose turn was too long for the model and that Kernel summarized and sent again, until a turn ends well (KERNEL-844). */
  private shrunk = new Set<string>()
  /** Chats whose queue or reason changed in the current step, sent together by `flushQueues`. */
  private unsent = new Set<string>()
  private managedIds = new Set<string>()
  private limits = new Map<string, RateLimit>()
  private billing = new Map<string, string>()
  /** Chats whose agent file's MCP servers were checked against a session's (once per chat). */
  private mcpChecked = new Set<string>()
  /** Projects the user (or a limit) paused. Their agents finish the step they are on, then wait at the next tool call. */
  private paused = new Map<string, { open: Promise<void>; release: () => void }>()
  /**
   * Holds on every project at once: offline, or a provider signed out. Each reason holds one provider's chats, or every chat
   * when it names none, with the same rules as a pause, while it stands (KERNEL-406). `gates` are what a held provider's
   * tool calls wait on.
   */
  private holds = new Map<string, Provider | undefined>()
  private gates = new Map<Provider, { open: Promise<void>; release: () => void }>()
  /**
   * Chats whose first prompt waits for the workspace to be made (its worktree, and the local files a brief needs), or for the PRs
   * it waits for to merge (KERNEL-259). Never for the setup script, which runs alongside the agent (KERNEL-1086).
   */
  private waiting = new Set<string>()
  /** Chats a usage limit or a quit stopped mid-turn. They carry on by themselves once nothing holds them (`carryOn`). */
  private cutOff = new Map<string, CutOffEntry>()
  /** Carry-ons of limit-stopped chats in flight: when and on which account each went, so a refusal within seconds is a strike (KERNEL-1031). */
  private carrying = new Map<string, { reason: CutOffReason; account: string; at: number }>()
  /** Carry-ons a limit refused again within seconds, in a row, by chat (KERNEL-1031). */
  private strikes = new Map<string, number>()
  /** Chats at MAX_STRIKES, with where they are stuck: their target account and model, and how many windows had lifted there. */
  private stuck = new Map<string, { account: string; model: string; lifted: number }>()
  /** How many rejected windows lifted, by `provider:account`, which releases a stuck chat (KERNEL-1031). */
  private lifts = new Map<string, number>()
  /** The nudge row and result row a refused carry-on left, which the next carry-on reuses instead of adding a pair (KERNEL-1031). */
  private refusedRows = new Map<string, string>()
  /** Chats `carryOn` restarted after a usage limit and that haven't finished a turn since, so a lifted limit doesn't restart them all at once (KERNEL-220). */
  private resuming = new Set<string>()
  /** Chats with a running turn, saved under `working` at every turn start and end, so a crash leaves the right list (KERNEL-215). */
  private working = new Set<string>()
  /** Kernel is quitting: the journal is frozen and nothing new goes out (`shutdown`). */
  private closing = false
  /** Kernel's launch checks are running (`holdCarryOn`). Chats in `cutOff` wait for them. Nothing else does. */
  private launching = false
  /** Claude Code processes Kernel started that haven't exited, by pid, with what each was started as. Saved under `claudePids`. */
  private pids = new Map<number, Spawned>()
  /** Chats whose session died mid-turn. `post` leaves them alone until the user sends or restarts (KERNEL-124). */
  private crashed = new Set<string>()
  /** Chats Kernel gave a fresh session because the old one was gone, until a turn there ends well (KERNEL-286). */
  private renewed = new Set<string>()
  /** A Claude chat's approved plan note, until ExitPlanMode's PostToolUse hook hands it to the agent (`afterPlan`). */
  private approvedPlans = new Map<string, string>()
  private setupNotes = new Map<string, string>()
  /** Claude Code's own slash commands. They come with the CLI, so one read lasts the whole run. */
  private builtins?: Promise<BuiltinCommand[]>
  constructor(private d: SessionDeps) {}

  /**
   * What Kernel saved before it last quit: the usage windows, the chats a limit stopped, and the queues of chats held for
   * setup (KERNEL-128). A rejection without a reset time is dropped, since nothing could tell when it ends, so it no longer
   * holds anything. A held queue comes back only while its workspace's setup still has to pass, or while a ready workspace's
   * brief waits for a PR to merge (KERNEL-259). One still in setup is left to Kernel's `recoverSetups`, which holds it once.
   * Before KERNEL-215 `cutOff` was a list of chats a limit stopped, and before KERNEL-1031 a reason by chat, which still load.
   *
   * Then what Sessions saved itself (KERNEL-215): every other chat's queue, and the chats whose turn was running when
   * Kernel quit or closed unexpectedly (`clean` says which). Each of those that is still open gets its stuck tool rows
   * closed and a note, and carries on by itself through `carryOn`, after what was queued. Everything goes through the same
   * gate as a limit: a pause, an offline or signed-out hold, a limit and the agent limit all make it wait.
   */
  restore(limits: RateLimit[], cutOff: string[] | Record<string, CutOffReason | CutOffEntry>, held: Record<string, QueuedMessage[]> = {}, o: { clean?: boolean } = {}) {
    const now = Date.now()
    for (const l of limits) this.limits.set(limitKey(l), l.status === 'rejected' && !l.resetsAt && !(l.rejectedAt !== undefined && now - l.rejectedAt < PROVISIONAL_KEPT_MS) ? { ...l, status: 'allowed' } : l)
    const saved: [string, CutOffReason | CutOffEntry | undefined][] = Array.isArray(cutOff) ? cutOff.map((id) => [id, 'limit']) : Object.entries(cutOff ?? {})
    for (const [id, v] of saved) {
      const entry = typeof v === 'string' ? { reason: v, at: now } : v
      if (entry?.reason === 'limit' || entry?.reason === 'quit') this.cutOff.set(id, { reason: entry.reason, ...(entry.account ? { account: entry.account } : {}), at: typeof entry.at === 'number' ? entry.at : now })
    }
    // Chats whose setup failed before Kernel quit still hold their brief, and what was sent after it, for Run again.
    for (const [id, queue] of Object.entries(held)) {
      const chat = this.d.store.chat(id)
      const ws = chat && this.d.store.workspace(chat.workspaceId)
      const waiting = heldForMerge(ws)
      if ((ws?.status !== 'failed' && !waiting) || !Array.isArray(queue)) continue
      this.waiting.add(id)
      this.setQueue(id, queue)
    }
    // Entries left out above, as an archived workspace's, drop out of what Kernel saves.
    this.saveHeld()
    for (const [id, queue] of Object.entries(this.d.store.meta<Record<string, QueuedMessage[]>>(QUEUES) ?? {})) {
      if (this.waiting.has(id) || !this.open(id) || !Array.isArray(queue) || !queue.length) continue
      this.queues.set(id, queue)
      this.pushQueue(id)
    }
    for (const id of this.d.store.meta<string[]>(WORKING) ?? []) this.relaunched(id, o.clean === true)
    this.endStrandedTools()
    this.saveWorking()
    this.saveQueues()
    this.d.onCutOff?.(Object.fromEntries(this.cutOff))
    // Queues that waited for a slot or a hold go out now if nothing holds them any more, and the cut-off chats carry on.
    for (const id of [...this.queues.keys()]) if (!this.cutOff.has(id)) this.drain(id)
    this.pushLimits()
  }

  /**
   * No process outlives a start, so a tool row still marked running belongs to a turn that is gone. `relaunched` closes the
   * rows of the chats the journal lists. This closes the rest: a chat the journal dropped when its Stop came just before a
   * force quit, and a closed or archived chat. They fail with no note and no carry on, since nothing was working. A row for a
   * plan card that still waits shows done, as in `relaunched`.
   */
  private endStrandedTools() {
    for (const id of this.d.store.chatsWithRunningTools()) {
      const chat = this.d.store.chat(id)
      const ws = chat && this.d.store.workspace(chat.workspaceId)
      if (!chat || !ws) continue
      const plan = this.d.approvals.waitingPlans(id, ws.projectId).length > 0
      for (const it of this.d.store.items(id)) {
        if (it.kind !== 'tool' || it.status !== 'running') continue
        this.item(chat, plan && isPlanTool(it.name) ? { ...it, status: 'done' } : { ...it, status: 'failed', output: TOOL_STOPPED })
      }
    }
  }

  /** The chat is open and its workspace isn't archived. */
  private open(chatId: string): boolean {
    const chat = this.d.store.chat(chatId)
    const ws = chat && this.d.store.workspace(chat.workspaceId)
    return !!chat && !chat.closed && !!ws && ws.status !== 'archived'
  }

  /**
   * A chat whose turn was running when Kernel quit or closed: its tool rows still marked running fail, a note says what
   * happened, and it waits in `cutOff` to carry on. A queue it had keeps its order, and the nudge follows it.
   */
  private relaunched(chatId: string, clean: boolean) {
    if (this.waiting.has(chatId) || !this.open(chatId)) return
    const chat = this.mustChat(chatId)
    const ws = this.mustWorkspace(chat.workspaceId)
    // A chat that was waiting on its plan card wasn't working, so it gets no note, and the tool that put the card up
    // finished: the plan is in the card.
    const plan = this.d.approvals.waitingPlans(chatId, ws.projectId).length > 0
    for (const it of this.d.store.items(chatId)) {
      if (it.kind !== 'tool' || it.status !== 'running') continue
      this.item(chat, plan && isPlanTool(it.name) ? { ...it, status: 'done' } : { ...it, status: 'failed', output: TOOL_STOPPED })
    }
    const note = this.d.approvals.waitedOnUser(chatId) ? (clean ? QUIT_WAIT_NOTE : CRASH_WAIT_NOTE) : clean ? QUIT_NOTE : CRASH_NOTE
    if (!plan) this.item(chat, { kind: 'note', id: randomUUID(), ts: Date.now(), text: note })
    const queue = this.queued(chatId)
    // A chat that was waiting on its plan card waits for the card again: no nudge, and nothing carries it on but what was
    // queued, which still goes first (plan-cards-survive-restart).
    if (plan) {
      if (queue.length) this.cutOff.set(chatId, { reason: 'quit', at: Date.now() })
      return
    }
    if (queue.length && !queue.some((q) => q.from === 'kernel' && isNudge(q.parts))) {
      this.queues.set(chatId, [...queue, { id: randomUUID(), chatId, parts: [{ type: 'text', text: RELAUNCH_NUDGE }], ts: Date.now(), from: 'kernel' }])
      this.pushQueue(chatId)
    }
    this.cutOff.set(chatId, { reason: 'quit', at: Date.now() })
    // A teammate that carries on rides along in the Lead's next update instead of waking it (KERNEL-215).
    this.d.onExit?.(ws, chat, clean ? QUIT_REASON : CRASH_REASON, true, true)
  }

  /**
   * Hold every project, the way a pause holds one: agents finish their step and wait, sends queue. With `provider`, only that
   * provider's chats wait, as when it is signed out (KERNEL-406).
   */
  holdAll(reason: string, o: { provider?: Provider } = {}) {
    if (this.holds.has(reason)) return
    this.holds.set(reason, o.provider)
    for (const p of PROVIDER_IDS) {
      if (this.gates.has(p) || !this.holding(p)) continue
      let release!: () => void
      const open = new Promise<void>((resolve) => { release = resolve })
      this.gates.set(p, { open, release })
    }
    this.pushReasons()
  }

  /** Drop one reason for the hold. A provider nothing holds any more goes on, and what queued for it meanwhile is sent. */
  releaseAll(reason: string) {
    if (!this.holds.delete(reason)) return
    const freed = PROVIDER_IDS.filter((p) => this.gates.has(p) && !this.holding(p))
    if (!freed.length) return
    for (const p of freed) { this.gates.get(p)!.release(); this.gates.delete(p) }
    // A cut-off chat's queue goes through `carryOn`, which restarts those a limit stopped two at a time.
    for (const chatId of [...this.queues.keys()]) {
      const chat = this.d.store.chat(chatId)
      if (chat && freed.includes(chatProvider(chat)) && !this.live.get(chatId)?.running && !this.cutOff.has(chatId)) this.drain(chatId)
    }
    this.carryOn()
    this.pushReasons()
    this.d.onFreed?.()
  }

  /** The reasons holding `provider`'s chats, or every reason when it names none. */
  heldFor(provider?: Provider): string[] { return [...this.holds].filter(([, p]) => !provider || !p || p === provider).map(([r]) => r) }

  /** Something holds this provider's chats: offline, or the provider signed out. */
  private holding(provider: Provider): boolean { return [...this.holds.values()].some((p) => !p || p === provider) }

  /**
   * The provider's account changed (KERNEL-406). A process runs on the account it started with, so an idle one ends now and
   * a busy one when its turn ends. The next message resumes the conversation on the account its chat runs on then. One a
   * usage limit cut off ends now even with background tasks: on that account they can't do anything. With `moved`, only the
   * processes of chats whose account changed end, and with `account` only those on that account, undefined for the CLI's
   * own login (KERNEL-843).
   */
  restartProvider(provider: Provider, o: { moved?: boolean; account?: string; reason?: StaleReason } = {}) {
    for (const [id, live] of [...this.live]) {
      const chat = this.d.store.chat(id)
      if (!chat || chatProvider(chat) !== provider) continue
      if (o.moved && live.account === this.d.accountFor?.(provider, chat)) continue
      if ('account' in o && live.account !== o.account) continue
      if (live.running || (live.tasks.size && this.cutOff.get(id)?.reason !== 'limit')) this.markStale(id, o.reason ?? 'account')
      else this.end(id, live)
    }
    // Auto depends on the account's models, which Kernel reads again for this one.
    this.pushModes()
  }

  /**
   * An account is being removed (KERNEL-941): its folder and login are about to go, so no process may keep running on it. A
   * turn running there stops, and the chat carries on with a nudge on the account it runs on now. Idle processes end. Resolves
   * once none is left on the account, ending what still runs after `budgetMs`, such as background tasks.
   */
  async leaveAccount(provider: Provider, account: string, budgetMs = 10_000): Promise<void> {
    const on = () => [...this.live].filter(([id, l]) => {
      const chat = this.d.store.chat(id)
      return l.account === account && (!chat || chatProvider(chat) === provider)
    })
    for (const [id, live] of on()) {
      if (!live.running) continue
      await this.interrupt(id, true).catch(() => undefined)
      await this.send(id, [{ type: 'text', text: ACCOUNT_LEFT }], { from: 'kernel' }).catch(() => undefined)
    }
    this.restartProvider(provider, { account })
    const until = Date.now() + budgetMs
    while (on().length && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    for (const [id, live] of on()) {
      this.end(id, live)
      // A turn that never ended leaves the chat marked running, and what waited behind it goes now, on the account in use.
      const chat = this.d.store.chat(id)
      if (live.running && chat) this.setRunning(chat, this.mustWorkspace(chat.workspaceId), live, false)
      this.drain(id)
    }
  }

  /**
   * Kernel checks the network and the sign-in at launch before agents carry on (KERNEL-215). Until `releaseCarryOn`, chats
   * a quit or a limit cut off wait, queue included. Ordinary sends and every other queue go out as usual.
   */
  holdCarryOn() { this.launching = true }

  /** The launch checks are done. What waited carries on, unless a hold they found (offline, signed out) still stands. */
  releaseCarryOn() {
    if (!this.launching) return
    this.launching = false
    this.drainWaiting()
  }

  /**
   * Put a message in the chat's queue without sending it, until `release`. Used for the first prompt while setup fails. With no
   * message the chat only waits, as a forked workspace's does through its setup (KERNEL-346). `at` puts the message at that
   * place in the queue instead of last, as Kernel's word on a released wait goes right behind the brief (KERNEL-973).
   */
  hold(chatId: string, parts?: ChatPart[], o: Sender = {}, at?: number) {
    this.waiting.add(chatId)
    const queue = this.queued(chatId)
    if (!parts || this.known(chatId, o.clientId)) { this.setQueue(chatId, queue); return }
    const i = at ?? queue.length
    this.setQueue(chatId, [...queue.slice(0, i), queuedOf(chatId, parts, o), ...queue.slice(i)])
  }

  /** The chat is held for its workspace's setup or a merge (`hold`), whatever its queue holds. */
  isHeld(chatId: string): boolean { return this.waiting.has(chatId) }

  release(chatId: string) {
    this.waiting.delete(chatId)
    this.saveHeld()
    this.saveQueues()
    if (!this.live.get(chatId)?.running) this.drain(chatId)
    this.pushReasons()
    this.d.onFreed?.()
  }

  /** Hands Kernel what every held chat is holding, to save. */
  private saveHeld() {
    if (!this.d.onHeld) return
    const held: Record<string, QueuedMessage[]> = {}
    for (const id of this.waiting) held[id] = this.queued(id)
    this.d.onHeld(held)
  }

  /**
   * Mark a usage window as reset (its resetsAt passed) and tell the renderer. A window that was only close to its limit resets
   * too, so what it held goes out (KERNEL-220). One already at 0 changes nothing. `key` is its `limitKey`: a Claude window's type.
   */
  resetLimit(key: string) {
    const l = this.limits.get(key)
    if (!l || (l.status === 'allowed' && !l.utilization)) return
    const { rejectedAt: _at, provisional: _p, ...rest } = l
    if (l.status === 'rejected') this.lifted(l)
    console.info(`[limits] lifted ${key}: reset timer`)
    this.limits.set(key, { ...rest, status: 'allowed', utilization: 0 })
    this.pushLimits()
  }

  /**
   * /compact in the chat: the agent summarises the conversation and frees context. On Claude it queues behind a running
   * turn. Codex compacts its thread through its own call (KERNEL-406).
   */
  async compact(chatId: string): Promise<{ queued: boolean; why?: QueueReason }> {
    const chat = this.mustChat(chatId)
    if (chatProvider(chat) !== 'codex') return this.send(chatId, [{ type: 'text', text: '/compact' }])
    const live = this.live.get(chatId) ?? this.start(chat, this.mustWorkspace(chat.workspaceId))
    await (live.runner as CodexRunner).compact()
    return { queued: false }
  }

  isPaused(projectId: string) { return this.paused.has(projectId) }

  /**
   * Freeze a project after its agents' current steps. Nothing is interrupted: a running turn carries on until its next tool call,
   * where it waits. New sends are held in each chat's queue and go out, in order, on resume.
   */
  pause(projectId: string) {
    if (this.paused.has(projectId)) return
    let release!: () => void
    const open = new Promise<void>((resolve) => { release = resolve })
    this.paused.set(projectId, { open, release })
    this.pushReasons()
  }

  /** Let the project's agents go on and send what was held while it was paused. */
  resume(projectId: string) {
    const gate = this.paused.get(projectId)
    if (!gate) return
    this.paused.delete(projectId)
    gate.release()
    for (const ws of this.d.store.workspaces(projectId)) for (const c of this.d.store.chats(ws.id)) if (!this.live.get(c.id)?.running && !this.cutOff.has(c.id)) this.drain(c.id)
    this.carryOn()
    this.pushReasons()
    this.d.onFreed?.()
  }

  private pausedChat(chat: Chat) {
    if (this.holding(chatProvider(chat)) || this.waiting.has(chat.id)) return true
    const ws = this.d.store.workspace(chat.workspaceId)
    return !!ws && this.paused.has(ws.projectId)
  }

  /** Session ids started by Kernel. The hook server ignores these because in-process hooks already report them. */
  isManaged(sessionId: string) { return this.managedIds.has(sessionId) }
  isRunning(chatId: string) { return this.live.get(chatId)?.running ?? false }

  /** The chat's process still runs background tasks it started: shells, subagents or monitors. */
  hasTasks(chatId: string) { return (this.live.get(chatId)?.tasks.size ?? 0) > 0 }
  /** The chats with a turn running, for a window that loads while they work (KERNEL-340). */
  runningIds(): string[] { return [...this.live].filter(([, l]) => l.running).map(([id]) => id) }
  /** The chats whose session is retrying an overloaded API, with the countdown their banner shows (KERNEL-340). */
  retries(): Record<string, Retry> { return Object.fromEntries([...this.live].flatMap(([id, l]) => (l.retry ? [[id, l.retry]] : []))) }
  /** apiKeySource from the chat's init message. 'none' means the Claude plan pays. */
  billingOf(chatId: string) { return this.billing.get(chatId) }

  /**
   * 5-hour and weekly windows, read on demand for each account in `reads`, every one the providers can read by default
   * (KERNEL-567). A live process on the account answers its usage call. Without one, the account's own `read` runs when it
   * has one: a short Claude session in its folder, or Codex's account read in its home. A read that fails keeps the last
   * numbers. Providers leaves out the accounts nothing can read: a legacy token account's numbers come from its turns'
   * rate_limit_event (KERNEL-406), and an API key account has no windows (KERNEL-523).
   */
  async usage(reads: UsageRead[] = this.d.usageReads?.() ?? []): Promise<RateLimit[]> {
    const open = [...this.live.values()].filter((l) => !l.runner.closed && !l.onKey)
    await Promise.all(reads.map(async (r) => {
      const live = open.find((l) => (l.runner instanceof ClaudeRunner ? 'claude' : 'codex') === r.provider && l.account === r.accountId)
      if (live) return live.runner.usage()
      // Tagged as a live process's windows are, so each keeps its account and `limitKey` stays per account.
      await r.read?.((p) => this.mergeLimits(r.accountId ? p.map((l) => ({ ...l, accountId: r.accountId })) : p)).catch(() => undefined)
    }))
    return [...this.limits.values()]
  }

  /**
   * Claude Code's own slash commands, for the composer's / menu. A live session answers; without one, Claude Code starts on
   * the active account with no prompt, no settings and no transcript, lists them and stops, which sends no message. A failed
   * read is tried again next time.
   */
  commands(cwd: string): Promise<BuiltinCommand[]> {
    this.builtins ??= this.readCommands(cwd).catch((err) => { this.builtins = undefined; throw err })
    return this.builtins
  }

  private async readCommands(cwd: string): Promise<BuiltinCommand[]> {
    const live = [...this.live.values()].find((l) => !l.runner.closed && l.runner instanceof ClaudeRunner)
    if (live) return (live.runner as ClaudeRunner).commandList()
    return claudeCommands(cwd, { env: this.d.claudeEnv?.(this.d.accountFor?.('claude')) ?? {}, bin: claudeExecutable(this.d.settings().providers?.claude) })
  }

  /**
   * Claude Code's models on the active account, with what each one supports, for Auto (KERNEL-447). A live session on that
   * account answers; without one, Claude Code starts with no prompt, no settings and no transcript, answers and stops.
   */
  claudeModels(cwd: string): Promise<ModelInfo[]> {
    const account = this.d.accountFor?.('claude')
    const live = [...this.live.values()].find((l) => !l.runner.closed && l.runner instanceof ClaudeRunner && l.account === account)
    if (live) return (live.runner as ClaudeRunner).models()
    return claudeModels(cwd, { env: this.d.claudeEnv?.(account) ?? {}, bin: claudeExecutable(this.d.settings().providers?.claude) })
  }

  /**
   * The mode the chat runs in (`effectiveMode`), and `bypass`: its own choice is Bypass permissions, plan mode aside, which
   * a Claude process needs from its start to take it (KERNEL-447). `shown` is `chatMode`'s answer, for the renderer.
   */
  private modes(chat: Chat, ws: Workspace): { mode: RunMode; bypass: boolean; shown: ChatRunMode } {
    const project = this.d.store.project(ws.projectId)
    const agent = this.d.agentFor(ws)
    const settings = this.d.settings()
    const at = (avail: ChatAvailability, plan = chat.plan) => chatMode({ ...chat, plan }, ws, project, settings, avail, agent)
    const avail = this.d.availability?.(chat, ws, at({ auto: true, bypass: true }, false).mode) ?? { auto: false, bypass: true }
    const shown = at(avail)
    return { mode: shown.mode, bypass: at(avail, false).mode === 'bypassPermissions', shown }
  }

  /**
   * What the chat runs in, what was picked for it and why they differ, for the composer (KERNEL-572). A Claude process that
   * started without Bypass permissions keeps its last mode until its turn ends (`moveTo`), and says so. Counts as what the
   * renderer last got, so `pushModes` sends only what changes after it.
   */
  runMode(chatId: string): ChatRunMode {
    const chat = this.mustChat(chatId)
    const shown = this.shownMode(chat, this.mustWorkspace(chat.workspaceId))
    this.shownModes.set(chatId, JSON.stringify(shown))
    return shown
  }

  private shownMode(chat: Chat, ws: Workspace): ChatRunMode {
    const { shown } = this.modes(chat, ws)
    const live = this.live.get(chat.id)
    return shown.mode === 'bypassPermissions' && live?.bypass === false ? { ...shown, mode: live.mode, why: 'turnRunning' } : shown
  }

  /**
   * Tells the renderer the mode of each chat whose mode changed since it last heard (KERNEL-572). Without ids, every chat in a
   * workspace that isn't archived, with a process or not. Big terminals have no composer and are left out.
   */
  private pushModes(chatIds?: string[]) {
    if (this.closing) return
    const chats = chatIds ? chatIds.flatMap((id) => this.d.store.chat(id) ?? [])
      : this.d.store.workspaces().filter((w) => w.status !== 'archived').flatMap((w) => this.d.store.chats(w.id))
    for (const chat of chats) {
      const ws = this.d.store.workspace(chat.workspaceId)
      if (chat.kind === 'terminal' || !ws) continue
      const mode = this.shownMode(chat, ws)
      const key = JSON.stringify(mode)
      if (this.shownModes.get(chat.id) === key) continue
      this.shownModes.set(chat.id, key)
      bus.push({ type: 'chat.runMode', chatId: chat.id, mode })
    }
  }

  /**
   * Puts every live chat in the mode it should run in now: Settings, a project or the chat changed it, or Kernel learned what a
   * provider can run (KERNEL-447). Then every chat's mode goes to the renderer, live or not (KERNEL-572).
   */
  applyModes() {
    for (const [id, live] of [...this.live]) {
      const chat = this.d.store.chat(id)
      const ws = chat && this.d.store.workspace(chat.workspaceId)
      if (chat && ws) void this.moveTo(chat, ws, live)
    }
    this.pushModes()
  }

  /**
   * A Claude process takes Bypass permissions only if it started allowed to, and keeps that permission for life. So a change
   * across that line restarts it: an idle one ends now and a busy one when its turn and background tasks end, and the next
   * message resumes the conversation in the new mode. Meanwhile it runs in the stricter mode of the two. A Codex thread
   * keeps the MCP servers it started with, which Bypass permissions widens, so crossing into or out of Bypass restarts it the
   * same way. Its approvals follow the new mode at once (bypass-allows-unlisted-mcp).
   */
  private moveTo(chat: Chat, ws: Workspace, live: Live): Promise<void> {
    const { mode, bypass } = this.modes(chat, ws)
    const restart = (live.bypass !== undefined && live.bypass !== bypass) || (live.threadBypass !== undefined && live.threadBypass !== (mode === 'bypassPermissions'))
    const waits = restart && live.bypass !== undefined && mode === 'bypassPermissions'
    if (!waits) live.mode = mode
    const switched = waits ? Promise.resolve() : live.runner.setMode(mode)
    // Turned off again before the turn ended: the process keeps its mode, so the note stops promising Bypass (KERNEL-809).
    if (live.bypassNote?.waits && !bypass) this.bypassNote(chat, live, false)
    if (!restart) return switched
    if (live.running || live.tasks.size) {
      this.markStale(chat.id, 'bypass')
      if (live.bypass !== undefined && bypass && !live.bypassNote?.waits) this.bypassNote(chat, live, true)
    } else this.end(chat.id, live)
    return switched
  }

  /** Puts the turn's Bypass note in the transcript, or updates it in place when the turn has one (KERNEL-809). */
  private bypassNote(chat: Chat, live: Live, waits: boolean) {
    live.bypassNote = { id: live.bypassNote?.id ?? randomUUID(), waits }
    this.item(chat, { kind: 'note', id: live.bypassNote.id, ts: Date.now(), text: waits ? BYPASS_WAITS : BYPASS_OFF_AGAIN })
  }

  /**
   * Starts a turn, or holds the message when one is running. A held message shows in the composer
   * (edit or remove it until it goes) and is sent, in order, when the turn ends. `why` says what it waits for.
   * `from` marks a message the user didn't type, and it stays on the message while it waits (KERNEL-116).
   */
  async send(chatId: string, parts: ChatPart[], o: Sender = {}): Promise<{ queued: boolean; why?: QueueReason; item?: ChatItem }> {
    const chat = this.mustChat(chatId)
    this.mustHaveFolder(chat)
    // A double send: the window's id is already in the chat, so the message stays as it is (KERNEL-894).
    const known = this.known(chatId, o.clientId)
    if (known) return known
    // The user is redirecting the Lead, even when the message waits in the queue, so no hand-off reminder follows.
    if (o.from !== 'kernel') this.d.openItems?.userSent(chatId)
    // Kernel is quitting, as when an interrupted Lead turn messages a teammate: the message is saved and goes at the next launch.
    if (this.closing) {
      this.setQueue(chatId, [...this.queued(chatId), queuedOf(chatId, parts, o)])
      return { queued: true }
    }
    const why = this.waitsFor(chat.id, o)
    if (why) {
      this.setQueue(chatId, [...this.queued(chatId), queuedOf(chatId, parts, o)])
      return { queued: true, why }
    }
    const item = this.dispatch(chat, parts, o)
    return { queued: false, ...(item ? { item } : {}) }
  }

  /**
   * What the chat already holds under the window's id `clientId`: its row, or its queued message while it waits (KERNEL-894).
   * Nothing for a new id, or no id.
   */
  private known(chatId: string, clientId?: string): { queued: boolean; why?: QueueReason; item?: ChatItem } | undefined {
    if (!clientId) return undefined
    if (this.queued(chatId).some((q) => q.id === clientId)) return { queued: true, why: this.waitsFor(chatId) }
    const item = this.d.store.items(chatId).find((i) => i.id === clientId)
    return item ? { queued: false, item } : undefined
  }

  /**
   * Several messages for a chat that has not had a turn, such as a brief and the Lead's notes sent while setup ran (KERNEL-393).
   * They join the queue in order and go out together as its first turn when nothing blocks the chat, otherwise they wait like
   * `send`'s message does, and `why` says what for.
   */
  async sendAll(chatId: string, messages: (Sender & { parts: ChatPart[] })[]): Promise<{ queued: boolean; why?: QueueReason }> {
    this.mustHaveFolder(this.mustChat(chatId))
    // One message with nothing ahead of it is an ordinary send.
    if (messages.length === 1 && !this.queued(chatId).length) return this.send(chatId, messages[0].parts, sender(messages[0]))
    if (messages.some((m) => m.from !== 'kernel')) this.d.openItems?.userSent(chatId)
    this.setQueue(chatId, [...this.queued(chatId), ...messages.filter((m) => !this.known(chatId, m.clientId)).map((m) => queuedOf(chatId, m.parts, m))])
    if (this.closing) return { queued: true }
    const why = this.waitsFor(chatId)
    if (why) return { queued: true, why }
    this.drain(chatId)
    return { queued: false }
  }

  /**
   * A Lead chat whose worktree Kernel hasn't made yet has nowhere to run a turn either. Its tabs are held until it is, and
   * this keeps any other message waiting with them (KERNEL-542).
   */
  private unmade(chat: Chat) { return !!this.d.store.workspace(chat.workspaceId)?.worktreePending }

  /** A workspace whose folder was deleted outside Kernel has nowhere to run a turn, so nothing is sent or queued there (KERNEL-291). */
  private mustHaveFolder(chat: Chat) {
    const ws = this.d.store.workspace(chat.workspaceId)
    if (ws?.folderGone) throw new Error(`${ws.name}'s folder is gone, so nothing can run there. Archive it, then restore it from History to make the folder again.`)
  }

  /** The row that started the chat's running turn, or its last one. With a batched first turn it is the first message's, not the last row's. */
  turnRow(chatId: string): (ChatItem & { kind: 'user' }) | undefined { return this.live.get(chatId)?.sentItem }

  /** What a message sent now would wait for, or nothing when it can go at once. */
  waitsFor(chatId: string, next: { from?: MessageFrom; ts?: number } | undefined = this.queued(chatId)[0]): QueueReason | undefined {
    return this.waitsForNoFolder(chatId, next) ?? (this.folderBlocker(chatId, next) ? 'folder' : undefined)
  }

  /** `waitsFor` without the folder rule, which looks at the other chats' own holds and so can't ask the same of them. */
  private waitsForNoFolder(chatId: string, next: { from?: MessageFrom } | undefined): QueueReason | undefined {
    const chat = this.d.store.chat(chatId)
    if (!chat) return undefined
    if (this.live.get(chat.id)?.running) return 'running'
    if (this.waiting.has(chat.id)) return heldForMerge(this.d.store.workspace(chat.workspaceId)) ? 'merge' : 'worktree'
    if (this.unmade(chat)) return 'worktree'
    if (this.holding(chatProvider(chat))) return 'offline'
    if (this.pausedChat(chat)) return 'paused'
    if (this.moveHolds.has(chat.id)) return 'move'
    if (this.nearLimitHolds(chat.id) || this.accountLimitHolds(chat)) return 'limit'
    if (this.atCapacity(chat.id)) return 'capacity'
    if (this.coldHolds(chat.id, next)) return 'moving'
    return undefined
  }

  /** Whether the chat's turns can change files. Plan mode and a review's lens can't, and a terminal is no agent turn, so none of them wait for a folder or hold one. */
  private writes(chat: Chat) { return chat.kind !== 'terminal' && !chat.plan && !chat.lens }

  /** A folder's real path, so two paths to the same folder (a symlink, a trailing slash) count as one. A folder that is gone keeps its own path. */
  private realFolder(path: string): string {
    const known = this.realFolders.get(path)
    if (known) return known
    try {
      const real = realpathSync(path)
      this.realFolders.set(path, real)
      return real
    } catch { return path }
  }

  /**
   * Real paths by workspace path. A folder's real path does not change for a workspace's life, and a turn end checks every
   * chat against every other, so asking the disk each time was about n squared stat calls on the main thread. A path that
   * can't be resolved is not kept, so a folder made later is looked up again. Archiving drops the entry (`dropHeld`).
   */
  private realFolders = new Map<string, string>()

  /**
   * The chat that makes this one wait for its folder (one-writer-per-folder), or nothing. Turns that can write take turns in a
   * folder: another chat there that is running a turn holds it, and so does one whose message has waited longer and is free to go,
   * so the chat that waited first goes first. Chats that can't write (`writes`) neither wait nor hold anyone up. `next` is the message that would go, none for one sent now.
   */
  folderBlocker(chatId: string, next?: { ts?: number }): string | undefined {
    const chat = this.d.store.chat(chatId)
    const ws = chat && this.d.store.workspace(chat.workspaceId)
    if (!chat || !ws || !this.writes(chat)) return undefined
    const here = this.realFolder(ws.path)
    const same = (id: string) => {
      const other = id !== chatId ? this.d.store.chat(id) : undefined
      const w = other && this.d.store.workspace(other.workspaceId)
      return !!other && !!w && this.writes(other) && this.realFolder(w.path) === here ? other : undefined
    }
    for (const [id, l] of this.live) if (l.running && l.mode !== 'plan' && same(id)) return id
    const mine = next?.ts ?? Infinity
    for (const [id, queue] of this.queues) {
      const other = queue.length && !this.live.get(id)?.running ? same(id) : undefined
      // Only a chat that would go now holds a place: one that waits on a carry-on, a crash or another hold goes when that lifts.
      if (!other || !this.open(id) || this.cutOff.has(id) || this.crashed.has(id)) continue
      const ts = queue[0].ts
      if ((ts < mine || (ts === mine && id < chatId)) && !this.waitsForNoFolder(id, queue[0])) return id
    }
    return undefined
  }

  /**
   * Kernel's own message into an idle chat, such as the Lead's teammate updates (KERNEL-72). It starts a turn like a user
   * message, but it isn't the user redirecting, so a pending hand-off reminder stays. It sends nothing and returns false
   * when the chat is running, has messages queued, is paused, is held near a usage limit or is over the agent limit; the caller
   * keeps it for later.
   */
  post(chatId: string, parts: ChatPart[], o: { update?: TeamUpdate } = {}): boolean {
    const chat = this.mustChat(chatId)
    if (this.postHold(chatId)) return false
    this.dispatch(chat, parts, { from: 'kernel', update: o.update })
    return true
  }

  /** Why `post` would refuse Kernel's message into the chat now, or nothing when it would send it (KERNEL-637). */
  postHold(chatId: string): PostHold | undefined {
    const chat = this.d.store.chat(chatId)
    if (!chat || this.closing) return 'closing'
    if (this.live.get(chatId)?.running) return 'busy'
    if (this.queued(chatId).length) return 'queued'
    if (this.crashed.has(chatId)) return 'crashed'
    if (this.waiting.has(chatId) || this.d.store.workspace(chat.workspaceId)?.folderGone || this.unmade(chat)) return 'held'
    // A chat that carries on after a quit waits for the launch checks too, or an update would take its turn without them.
    if (this.launching && this.cutOff.has(chatId)) return 'launching'
    if (this.holding(chatProvider(chat))) return 'offline'
    if (this.pausedChat(chat)) return 'paused'
    if (this.moveHolds.has(chatId)) return 'move'
    if (this.nearLimitHolds(chatId) || this.accountLimitHolds(chat)) return 'limit'
    if (this.atCapacity(chatId)) return 'capacity'
    if (this.coldHolds(chatId)) return 'moving'
    if (this.folderBlocker(chatId)) return 'folder'
    return undefined
  }

  /**
   * Who started this chat's running turn, or its last one once it is idle: Kernel, the Lead, or the user (undefined). A
   * limit or restart nudge's turn counts as the turn it carries on.
   */
  turnFrom(chatId: string): MessageFrom | undefined { return this.turns.get(chatId)?.from }

  /** This chat's running turn, or its last one once it is idle, was started by Kernel. */
  kernelTurn(chatId: string): boolean { return this.turnFrom(chatId) === 'kernel' }

  queued(chatId: string): QueuedMessage[] { return this.queues.get(chatId) ?? [] }

  /** What the chat's queue waits for, or nothing when it is empty or its next message is about to go (KERNEL-271). */
  queueReason(chatId: string): QueueReason | undefined { return this.queued(chatId).length ? this.waitsFor(chatId) : undefined }

  unqueue(chatId: string, id: string): QueuedMessage[] {
    const rest = this.setQueue(chatId, this.queued(chatId).filter((q) => q.id !== id))
    // A chat that waited first for its folder no longer does, so the ones behind it may go.
    if (!rest.length) this.drainWaiting()
    return rest
  }

  /**
   * Move a queued message to the front and stop the running turn, so it goes out as soon as that turn ends. An idle chat
   * held only by the agent limit, or by a usage window close to its limit, sends it at once. `pastPause` sends it from an idle
   * chat even though its project is paused, which Kernel asks for when a limit paused it.
   */
  async sendNow(chatId: string, id: string, o: { pastPause?: boolean; clientId?: string } = {}): Promise<QueuedMessage[]> {
    const found = this.queued(chatId).find((q) => q.id === id)
    if (!found) return this.queued(chatId)
    // The row goes under the window's id (KERNEL-894), unless the chat already has it.
    const pick = o.clientId && o.clientId !== id && !this.known(chatId, o.clientId) ? { ...found, id: o.clientId, clientId: o.clientId } : found
    const rest = this.queued(chatId).filter((q) => q.id !== id)
    this.setQueue(chatId, [pick, ...rest])
    const live = this.live.get(chatId)
    const why = this.waitsFor(chatId)
    // Send now can go past the agent limit and a usage hold, but never into a folder another chat is writing in.
    if (this.closing || (!live?.running && this.folderBlocker(chatId, pick))) return this.queued(chatId)
    if (live?.running) { live.sendNext = true; await this.interrupt(chatId, true) }
    // Pressing Send now is the user choosing to go over the agent limit (KERNEL-271), or past the near-limit hold (KERNEL-220).
    else if (why === 'capacity' || why === 'moving' || why === 'limit' || (why === 'paused' && o.pastPause)) { this.setQueue(chatId, rest); this.dispatch(this.mustChat(chatId), pick.parts, pick) }
    else this.drain(chatId)
    return this.queued(chatId)
  }

  /**
   * Put a message into the running turn instead of after it (steer). Give `parts` for a message typed now, or `id` for a queued one.
   * The row it leaves in the chat is marked `steered`. Whatever can't steer goes the old way: a turn that ended makes it the
   * next message, a provider that can't steer interrupts the turn and sends it first, and a turn that refuses it leaves it
   * queued. Nothing is sent twice, since the queued message is held out of the queue while the runner decides.
   */
  async steer(chatId: string, o: { parts?: ChatPart[]; id?: string; clientId?: string; pastPause?: boolean } = {}): Promise<SteerResult> {
    const chat = this.mustChat(chatId)
    const found = o.id ? this.queued(chatId).find((q) => q.id === o.id) : undefined
    const sent = (r: { queued: boolean; why?: QueueReason; item?: ChatItem }): SteerResult => ({ steered: false, ...r, queue: this.queued(chatId) })
    if (o.id && !found) return sent({ queued: false })
    const live = this.live.get(chatId)
    if (!found) {
      this.mustHaveFolder(chat)
      const known = this.known(chatId, o.clientId)
      if (known) return sent(known)
    }
    const parts = found?.parts ?? o.parts ?? []
    // Not running: it is the next message. A provider that can't steer: Send now's interrupt, then the message.
    if (!live?.running || this.closing || live.interrupted || !live.runner.canSteer) {
      if (found) { await this.sendNow(chatId, found.id, { pastPause: o.pastPause, clientId: o.clientId }); return sent({ queued: false }) }
      const r = await this.send(chatId, parts, { clientId: o.clientId })
      if (r.queued && live?.running && !this.closing) {
        const id = o.clientId ?? this.queued(chatId).at(-1)?.id
        if (id) await this.sendNow(chatId, id)
        return sent({ queued: false })
      }
      return sent(r)
    }
    const ws = this.mustWorkspace(chat.workspaceId)
    const from = found ? sender(found) : {}
    if (from.from !== 'kernel') this.d.openItems?.userSent(chatId)
    // Held out of the queue while the runner decides, so the turn ending meanwhile can't send it a second time.
    if (found) this.setQueue(chatId, this.queued(chatId).filter((q) => q.id !== found.id))
    const id = found ? o.clientId && !this.known(chatId, o.clientId) ? o.clientId : found.id : o.clientId ?? randomUUID()
    const pressed = Date.now()
    const back = async (): Promise<SteerResult> => {
      // The turn took nothing. A queued message goes back first in line, and one typed now follows `send`'s rules.
      if (found) {
        this.setQueue(chatId, [found, ...this.queued(chatId)])
        if (!this.live.get(chatId)?.running) this.drain(chatId)
        return sent({ queued: true })
      }
      const r = await this.send(chatId, parts, { clientId: id })
      return sent(r)
    }
    let ready: ChatPart[]
    try { ready = hasUnsaved(parts) ? await withAttachments(ws.path, parts) : parts }
    catch (e) {
      if (found) this.setQueue(chatId, [found, ...this.queued(chatId)])
      throw e
    }
    // The turn can have ended, or the session been replaced, while the attachments were saved.
    if (this.live.get(chatId) !== live || !live.running || live.interrupted || this.closing) return back()
    const mine = this.withMentions(chat, ws, ready)
    let taken = false
    try { taken = await live.runner.steer(mine) } catch { taken = false }
    if (!taken) return back()
    const row: ChatItem & { kind: 'user' } = { kind: 'user', id, ts: pressed, parts, ...from, steered: true }
    this.item(chat, row)
    live.sent = [...(live.sent ?? []), ...mine]
    this.d.onSent?.(ws, chat, from.from === 'kernel' ? [] : parts)
    return { steered: true, queued: false, item: row, queue: this.queued(chatId) }
  }

  /**
   * Send the same message again: `itemId` itself when it is a user message, else the user message before it (a reply or a
   * turn's result). It keeps its sender, so a Kernel update sent again is still Kernel's and leaves a pending hand-off
   * reminder alone. Returns the copy when it waits in the queue, so Retry now can send it first.
   */
  async retry(chatId: string, itemId: string, clientId?: string): Promise<QueuedMessage | undefined> {
    const items = this.d.store.items(chatId)
    const at = items.findIndex((i) => i.id === itemId)
    if (at < 0) throw new Error('That message is no longer in this chat.')
    const user = items.slice(0, at + 1).reverse().find(isSentItem)
    if (!user) throw new Error('There is no message to send again.')
    // An update from before KERNEL-116 carries no marker, only its header.
    const from = user.from ?? (isKernelUpdate(user) ? 'kernel' : undefined)
    const { queued } = await this.send(chatId, user.parts, { from, update: user.update, clientId })
    return queued ? this.queued(chatId).find((q) => q.id === clientId) ?? this.queued(chatId).at(-1) : undefined
  }

  /**
   * Starts a turn with `parts`. `more` are the messages that waited for the same first turn (`drain`): each keeps its own row
   * and sender, right after the first, and Claude Code reads them all as one message, in order. The turn's row and sender
   * stay the first message's.
   */
  private dispatch(chat: Chat, parts: ChatPart[], o: Sender = {}, more: QueuedMessage[] = []): (ChatItem & { kind: 'user' }) | undefined {
    const ws = this.mustWorkspace(chat.workspaceId)
    if (this.moveFirst(chat, ws, parts, o, more)) return undefined
    // The move's decision can have used up the chat's choice (KERNEL-844).
    chat = this.d.store.chat(chat.id) ?? chat
    // A held message going out counts as the user taking over too. Kernel's own updates don't.
    if ([o, ...more].some((m) => m.from !== 'kernel')) { this.d.openItems?.userSent(chat.id); this.crashed.delete(chat.id) }
    // The user writing instead of answering ends a Codex plan still waiting after its turn (KERNEL-563).
    if ([o, ...more].some((m) => !m.from)) this.expireCards(this.turns.get(chat.id)?.plans)
    // A nudge picks up a turn a limit or a crash cut short, so the turn is still the one whoever started it started.
    // Read before the nudge is saved, which would be the last message.
    const by = o.from === 'kernel' && isNudge(parts) ? this.startedBy(chat.id) : o.from
    const carrying = this.cutOff.get(chat.id)?.reason === 'quit'
    // Whatever goes out next picks the chat up again, so it no longer waits for the limit.
    this.setCutOff(chat.id, false)
    if (!(o.from === 'kernel' && isNudge(parts))) this.refusedRows.delete(chat.id)
    // An idle process kept on another account, for its background tasks, ends here. The turn resumes the conversation on
    // the account the chat runs on now, the one `carryOn` checked for a limit, and the note says so.
    // So does one a change marked stale during its turn, which the queue would otherwise have reused (KERNEL-994).
    const kept = this.live.get(chat.id)
    const why = this.stale.get(chat.id)
    if (kept && !kept.running && (why || kept.account !== this.d.accountFor?.(chatProvider(chat), chat))) {
      this.end(chat.id, kept)
      // A move to another account says so on its own (`noteMove`).
      if (kept.tasks.size && (why ? [...why].some((r) => r !== 'account') : false)) this.item(chat, { kind: 'note', id: randomUUID(), ts: Date.now(), text: this.restartedNote() })
    }
    // Read before the chat's account moves, which `coldSize` compares against (KERNEL-844).
    const cold = this.d.coldSize?.(chat) !== undefined
    chat = this.noteAccount(chat)
    // A message the window drew keeps its id, so this row replaces the window's (KERNEL-894).
    const row: ChatItem & { kind: 'user' } = { kind: 'user', id: o.clientId ?? randomUUID(), ts: Date.now(), parts, ...sender(o) }
    this.item(chat, row)
    for (const m of more) this.item(chat, { kind: 'user', id: m.clientId ?? randomUUID(), ts: Date.now(), parts: m.parts, ...sender(m) })
    this.d.onSent?.(ws, chat, [...(o.from === 'kernel' ? [] : parts), ...more.filter((m) => m.from !== 'kernel').flatMap((m) => m.parts)])
    const live = this.live.get(chat.id) ?? this.start(chat, ws)
    live.sentItem = row
    live.cold = cold
    live.carrying = carrying
    live.failed = undefined
    const turns = this.turnsOf(chat.id)
    turns.from = by
    // A new message takes the agent past whatever a hook refused.
    turns.blocked = undefined
    const note = this.d.turnNote?.(chat)
    live.sent = [...(note ? [{ type: 'text' as const, text: note }] : []), ...this.withMentions(chat, ws, [...parts, ...more.flatMap((m) => m.parts)])]
    this.push(chat.id, ws, live)
    this.setRunning(chat, ws, live, true)
    return row
  }

  /** The line a restart that stopped background tasks leaves in the chat (KERNEL-994). */
  private restartedNote(): string {
    return 'Restarted. Background tasks started before the change stopped.'
  }

  private markStale(chatId: string, reason: StaleReason) {
    this.stale.set(chatId, new Set([...(this.stale.get(chatId) ?? []), reason]))
  }

  /**
   * A chat about to run its next turn on another account than its last one (KERNEL-844). Decided here, as the turn starts, so
   * two quick switches move it once. `movePlan` says what Settings, Account and the chat's own choice ask for: run as it is,
   * wait for the user to choose (the queue waits with `move`), or summarize first on the old or the new account. A chat
   * summarized for this target already goes. Returns true when the turn waits: its messages go back to the front of the queue
   * and go out once the user chose or the summary is done. A cut-off chat that waits on a summary carries on through it.
   */
  private moveFirst(chat: Chat, ws: Workspace, parts: ChatPart[], o: Sender, more: QueuedMessage[]): boolean {
    if (!this.d.movePlan || this.closing) return false
    const from = chat.ranOn
    const to = this.d.accountFor?.(chatProvider(chat), chat) ?? 'cli'
    const done = this.compacted.get(chat.id)
    this.compacted.delete(chat.id)
    if (!from || from === to || done === to) return false
    const plan = this.d.movePlan(chat, to)
    if (!plan || plan.do === 'continue') return false
    this.setQueue(chat.id, [queuedOf(chat.id, parts, o), ...more, ...this.queued(chat.id)])
    if (plan.do === 'ask') {
      this.moveHolds.set(chat.id, to)
      this.d.onMoveHold?.(chat, true)
      this.pushReasons()
      return true
    }
    this.compacted.set(chat.id, to)
    this.setCutOff(chat.id, false)
    void this.compactThen(chat, ws, plan.on, plan.note)
    return true
  }

  /**
   * The user chose how a chat held for a move goes (`chats.moveChoice`, KERNEL-844): it no longer waits, and its next turn
   * decides again with the choice on the chat. A chat a limit cut off carries on.
   */
  releaseMove(chatId: string) {
    if (!this.moveHolds.delete(chatId)) return
    const chat = this.d.store.chat(chatId)
    if (chat) this.d.onMoveHold?.(chat, false)
    if (this.cutOff.has(chatId)) this.carryOn()
    else if (!this.live.get(chatId)?.running) this.drain(chatId)
    this.pushReasons()
  }

  /** The chat waits for the user to choose how it moves to another account (KERNEL-844). */
  heldForMove(chatId: string): boolean { return this.moveHolds.has(chatId) }

  /**
   * Holds whose chat no longer moves where it waited to: a switch since put its account back, or another one, or the chat
   * closed. Each lets go, and the drain that follows decides again (KERNEL-844).
   */
  private recheckMoves() {
    for (const [id, to] of [...this.moveHolds]) {
      const chat = this.d.store.chat(id)
      if (chat && this.open(id) && (this.d.accountFor?.(chatProvider(chat), chat) ?? 'cli') === to) continue
      this.moveHolds.delete(id)
      if (chat) this.d.onMoveHold?.(chat, false)
    }
  }

  /**
   * Summarizes an idle chat on account `on` now (`cli` for the CLI's own login), as before a move ahead of a limit
   * (KERNEL-844). Never during a turn: a chat that runs, has messages waiting or anything holding it is left alone. Resolves
   * true once the summary is done.
   */
  async compactIdle(chatId: string, on: string): Promise<boolean> {
    const chat = this.d.store.chat(chatId)
    if (!chat || this.closing || !this.open(chatId) || this.queued(chatId).length || this.cutOff.has(chatId) || this.crashed.has(chatId) || this.waitsFor(chatId)) return false
    return this.compactThen(chat, this.mustWorkspace(chat.workspaceId), on)
  }

  /** `compactOn`, then the chat's turn is over: what waits for it goes out, and the slot it took frees (KERNEL-844). */
  private async compactThen(chat: Chat, ws: Workspace, on: string, note?: string): Promise<boolean> {
    if (note) {
      const row = { id: randomUUID(), ts: Date.now() }
      this.summaries.set(chat.id, row)
      this.item(chat, { kind: 'note', ...row, text: note })
    } else this.summaries.delete(chat.id)
    const r = await this.compactOn(chat, ws, on)
    if (r && this.live.get(chat.id) === r.live) this.setRunning(this.mustChat(chat.id), ws, r.live, false)
    if (!this.live.get(chat.id)?.running) this.drain(chat.id)
    this.drainWaiting()
    return !!r?.ok
  }

  /**
   * Summarizes the chat on account `on` (`cli` for the CLI's own login) and resolves once that is done, with its process, or
   * undefined when it couldn't start (KERNEL-844). Claude runs /compact with COMPACT_INSTRUCTIONS. Codex compacts its thread,
   * which takes no instructions. The chat shows as working meanwhile, so what is sent waits. On another account than the
   * chat's last, the summary is the chat's move: it reads the whole chat there, and the note after it says so. `inTurn`
   * compacts in the running turn's process, which stays running.
   */
  private async compactOn(chat: Chat, ws: Workspace, on: string, o: { inTurn?: boolean } = {}): Promise<{ live: Live; ok: boolean } | undefined> {
    const account = on === 'cli' ? undefined : on
    let live = this.live.get(chat.id)
    if (live?.running && !o.inTurn) return undefined
    if (live && live.account !== account && !o.inTurn) { this.end(chat.id, live); live = undefined }
    if (!live) live = this.start(chat, ws, { account })
    const cold = !o.inTurn && this.d.coldSize?.(chat) !== undefined && (chat.ranOn ?? 'cli') !== on
    if (chat.ranOn && chat.ranOn !== on) chat = this.noteAccount(chat)
    if (!o.inTurn) {
      live.sent = undefined
      live.sentItem = undefined
      this.setRunning(chat, ws, live, true)
      live.cold = cold
    }
    const current = live
    const ok = await new Promise<boolean>((resolve) => {
      current.compacting = resolve
      if (current.runner instanceof CodexRunner) void current.runner.compact().then(() => this.compactEnded(chat.id, current, true), () => this.compactEnded(chat.id, current, false))
      else current.runner.push([{ type: 'text', text: `/compact ${COMPACT_INSTRUCTIONS}` }])
    })
    return { live: current, ok }
  }

  /** The compaction on `live` ended, or its process did (`ok` false). Its numbers are the chat's last turn, and a move says what it read. */
  private compactEnded(chatId: string, live: Live, ok: boolean) {
    const done = live.compacting
    if (!done) return
    live.compacting = undefined
    live.interrupted = false
    live.sendNext = false
    const chat = ok ? this.d.store.chat(chatId) : undefined
    if (chat) {
      // A summary that ran on the old account has no move to note yet: it shows its compaction until the move's turn replaces it.
      const moved = this.noteMove(this.recordTurn(chat, live), true)
      const s = this.summaries.get(chatId)
      if (s?.compaction && !moved) this.item(chat, { ...s.compaction, id: s.id, ts: s.ts } as ChatItem)
    } else {
      live.usage = undefined
      this.summaries.delete(chatId)
    }
    done(ok)
  }

  /** After a turn on another account than the chat's last, the note saying where it moved and what that read (KERNEL-842). */
  private noteMove(chat: Chat, keep = false): boolean {
    const from = this.moves.get(chat.id)
    this.moves.delete(chat.id)
    const summary = this.summaries.get(chat.id)
    const moved = from !== undefined && from !== chat.ranOn ? this.d.moveNote?.(chat, from, summary ? { ...summary.sizes } : undefined) : undefined
    if (summary && (moved || !keep)) this.summaries.delete(chat.id)
    if (moved) this.item(chat, { kind: 'note', id: summary?.id ?? randomUUID(), ts: summary?.ts ?? Date.now(), text: moved })
    return !!moved
  }

  /**
   * The running turn found the chat too long for its model (KERNEL-844). Kernel summarizes it in the same process and sends
   * the turn's message again, once: a second refusal ends the turn as it came. A summary that fails ends it the same way.
   */
  private async retryShorter(chatId: string, ws: Workspace, live: Live, t: Parameters<RunnerHost['turnEnded']>[0]) {
    this.shrunk.add(chatId)
    const sent = live.sent!
    live.usage = undefined
    live.limited = false
    this.item(this.mustChat(chatId), { kind: 'note', id: randomUUID(), ts: Date.now(), text: TOO_LONG_NOTE })
    const r = await this.compactOn(this.mustChat(chatId), ws, live.account ?? 'cli', { inTurn: true })
    if (this.live.get(chatId) !== live || live.runner.closed || this.closing) return
    if (!r?.ok) { this.turnEnded(chatId, ws, live, t); return }
    live.sent = sent
    live.runner.push(sent)
  }

  /**
   * A Lead message that mentions teammates opens a mention for each, and the Lead reads who the user addressed after it
   * (KERNEL-745). The chat's row keeps the parts as they were.
   */
  private withMentions(chat: Chat, ws: Workspace, sent: ChatPart[]): ChatPart[] {
    if (!sent.some((p) => p.type === 'agent') || !this.isLeadChat(chat.id)) return sent
    const team = this.d.teamOf?.(ws.projectId)
    const note = mentionNote(sent, team)
    if (!note) return sent
    this.d.openItems?.mentioned(chat, mentionsOf(sent, team))
    return [...sent, { type: 'text', text: forProvider(note, chatProvider(chat)) }]
  }

  /**
   * The turn about to start runs on another account than the chat's last one, as after a switch (KERNEL-568). The turn runs
   * in the chat's live process when it has one, else on the account `accountFor` gives the chat (KERNEL-843). Once the turn ends, a note says
   * where it moved and what that read (`moveNote`, KERNEL-842). A move before that turn ended still counts from the account
   * the chat left. A chat's first turn says nothing.
   */
  private noteAccount(chat: Chat): Chat {
    const live = this.live.get(chat.id)
    const provider = chatProvider(chat)
    const on = (live ? live.account : this.d.accountFor?.(provider, chat)) ?? 'cli'
    this.d.startedOn?.(chat)
    // Read again: what a turn starting ends, such as a choice for a move, is gone from the saved chat (KERNEL-844).
    chat = this.d.store.chat(chat.id) ?? chat
    if (chat.ranOn === on) return chat
    if (chat.ranOn && !this.moves.has(chat.id)) this.moves.set(chat.id, chat.ranOn)
    const next = { ...chat, ranOn: on }
    this.d.store.saveChat(next)
    return next
  }

  /**
   * Sends the turn's message. Its images and attached files are saved to the workspace first, for the agent to open with its
   * own tools (KERNEL-545, KERNEL-907), and the message goes once they are. The rows keep their parts as sent, so the user's
   * bubble doesn't change. A session stopped or replaced meanwhile gets nothing: `renew` sends `live.sent` itself, as it
   * stood, and never saves again. When a file can't be saved the message isn't sent, and the turn ends with the reason.
   */
  private push(chatId: string, ws: Workspace, live: Live) {
    const sent = live.sent ?? []
    if (!hasUnsaved(sent)) { live.runner.push(sent); return }
    void withAttachments(ws.path, sent).then((saved) => {
      if (this.live.get(chatId) !== live) return
      live.sent = saved
      live.runner.push(saved)
    }, (e: Error) => {
      if (this.live.get(chatId) !== live) return
      live.sent = undefined
      this.turnEnded(chatId, ws, live, { id: randomUUID(), ok: false, durationMs: 0, error: `Not sent: ${e.message}` })
    })
  }

  private turnsOf(chatId: string): Turns {
    let turns = this.turns.get(chatId)
    if (!turns) this.turns.set(chatId, (turns = {}))
    return turns
  }

  /** Who sent the chat's last message that wasn't one of Kernel's nudges: the turn a nudge picks up. */
  private startedBy(chatId: string): MessageFrom | undefined {
    const items = this.d.store.items(chatId)
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (isSentItem(it) && !(it.from === 'kernel' && isNudge(it.parts))) return it.from
    }
    return undefined
  }

  /**
   * Send the oldest held message. The next one goes when this turn ends. A chat with no user message yet sends everything that
   * waited for its first turn together (`firstTurn`), so a note queued behind a brief that waited hours reaches the agent
   * before it starts. Read from the chat's rows, not a flag, so it holds after a restart and while the batch waits for a slot.
   */
  private drain(chatId: string) {
    const queue = this.queued(chatId)
    const [next] = queue
    const chat = this.d.store.chat(chatId)
    if (this.closing || (this.launching && this.cutOff.has(chatId)) || !next || !chat || this.unmade(chat) || this.pausedChat(chat) || this.moveHolds.has(chatId) || this.nearLimitHolds(chatId) || this.accountLimitHolds(chat) || this.atCapacity(chatId) || this.coldHolds(chatId, next) || this.folderBlocker(chatId, next)) return
    const batch = queue.length > 1 && !this.d.store.items(chatId).some((i) => i.kind === 'user') ? firstTurn(queue) : [next]
    this.setQueue(chatId, queue.slice(batch.length))
    this.dispatch(chat, next.parts, next, batch.slice(1))
  }

  /**
   * Settings changed. The lists and the timeout are read per tool call; the mode is moved on live sessions now, a changed
   * compact window restarts Claude's processes, and a higher limit starts waiting work. The usage switches count too, so the limits go out again for Kernel to act on them (KERNEL-220).
   */
  applySettings(before?: AppSettings) {
    const now = this.d.settings().permissions
    if (!before || before.permissions.mode !== now.mode || before.permissions.bypassOnlyInWorktrees !== now.bypassOnlyInWorktrees) this.applyModes()
    // A process keeps the compact window it started with, so a changed one restarts them as an account switch does:
    // an idle one now, a busy one when its turn ends (feat-compact-window-per-role-with-plan).
    const was = before?.models?.compact
    const compact = this.d.settings().models?.compact
    if (was && compact && (Object.keys(compact) as Role[]).some((r) => was[r] !== compact[r])) this.restartProvider('claude', { reason: 'compact' })
    this.pushLimits()
  }

  /**
   * Settings > Models: agents working at once, 0 for no limit. Read on every call, so a change applies to the next send. The Lead's chats
   * neither wait for a slot nor take one, so the Lead can plan in several chats while its teammates use the slots (D-094).
   */
  private atCapacity(chatId: string): boolean {
    const max = this.d.settings().models?.agentLimit
    if (!max || max < 1 || this.isLeadChat(chatId)) return false
    let running = 0
    for (const [id, l] of this.live) if (l.running && id !== chatId && !this.isLeadChat(id)) running++
    return running >= max
  }

  /**
   * The chat's next turn re-reads its history cold (`coldSize`) while COLD_AT_ONCE others do (KERNEL-844). It waits for one
   * to end, and the smallest waiting goes first (`coldLast`). The Lead's chats neither wait nor take a turn, as with the agent
   * limit, so the Lead can always answer the user. Neither does a chat whose next message is the user's or the Lead's, which
   * goes at once (KERNEL-1032): `next` is that message, and none means Kernel's own.
   */
  private coldHolds(chatId: string, next?: { from?: MessageFrom }): boolean {
    if (next && next.from !== 'kernel') return false
    const chat = this.d.coldSize && !this.isLeadChat(chatId) ? this.d.store.chat(chatId) : undefined
    if (!chat || this.d.coldSize!(chat) === undefined) return false
    let cold = 0
    for (const [id, l] of this.live) if (l.running && l.cold && id !== chatId && !this.isLeadChat(id)) cold++
    return cold >= COLD_AT_ONCE
  }

  /** `ids` with the chats whose next turn re-reads cold last, smallest first, in the order they otherwise keep (KERNEL-844). */
  private coldLast(ids: string[]): string[] {
    if (!this.d.coldSize) return ids
    const sizes = new Map(ids.map((id) => { const c = this.d.store.chat(id); return [id, c ? this.d.coldSize!(c) : undefined] as const }))
    const warm = ids.filter((id) => sizes.get(id) === undefined)
    return [...warm, ...ids.filter((id) => sizes.get(id) !== undefined).sort((a, b) => sizes.get(a)! - sizes.get(b)!)]
  }

  private isLeadChat(chatId: string): boolean {
    const chat = this.d.store.chat(chatId)
    const ws = chat && this.d.store.workspace(chat.workspaceId)
    return !!ws && !!this.d.agentFor(ws)?.lead
  }

  /**
   * Settings, Account: with "Pause new work when close to the limit" on, a teammate's chat starts no new turn while the 5-hour
   * window is at 90% or the weekly one at 95% (`nearLimit`). Turns that are running finish. The Lead's chats are never held,
   * so the Lead can still answer the user (D-094). What waits goes out when usage drops or the window resets (KERNEL-220).
   */
  private nearLimitHolds(chatId: string): boolean {
    if (!this.d.settings().usage?.pauseNearLimit || this.isLeadChat(chatId)) return false
    const chat = this.d.store.chat(chatId)
    return !!chat && !!nearLimit(this.limitsFor(chat))
  }

  /** A slot opened (a turn ended or the limit went up): start held messages of idle chats, oldest queue first, while there is project. */
  drainWaiting() {
    this.recheckMoves()
    for (const id of this.coldLast([...this.queues.keys()])) if (!this.live.get(id)?.running && !this.cutOff.has(id)) this.drain(id)
    this.carryOn()
    // A lower limit in Settings, Models holds queues that waited for nothing a moment ago.
    this.pushReasons()
    // A higher one frees space for Team updates that waited only for a slot (KERNEL-651).
    this.d.onFreed?.()
  }

  /**
   * Chats a usage limit or a quit stopped go on once nothing holds them: no limit on the account or on their model, no
   * pause, no offline or signed-out hold, and a free slot. What the user queued goes first; otherwise Kernel tells the
   * agent to pick up where it left off. After a quit, `restore` already put that nudge at the end of a queue.
   */
  private carryOn() {
    if (this.closing || this.launching) return
    // A chat that stopped running has finished the turn it was restarted for, so the next one may go.
    for (const id of this.resuming) if (!this.live.get(id)?.running) this.resuming.delete(id)
    for (const id of this.coldLast([...this.cutOff.keys()])) {
      const reason = this.cutOff.get(id)?.reason
      if (!reason) continue
      const chat = this.d.store.chat(id)
      if (!chat || !this.open(id)) { this.setCutOff(id, false); continue }
      if (reason === 'limit' && this.stuckHolds(chat)) continue
      if (this.live.get(id)?.running || this.pausedChat(chat) || this.moveHolds.has(id) || this.atCapacity(id) || this.coldHolds(id) || this.limitHolds(chat) || this.nearLimitHolds(id) || this.folderBlocker(id, this.queued(id)[0])) continue
      // A lifted limit restarts the chats it cut off two at a time. The next starts when one ends its turn, where `drainWaiting` comes back here (KERNEL-220).
      if (reason === 'limit') {
        if (this.resuming.size >= RESUME_AT_ONCE) continue
        this.resuming.add(id)
      }
      if (this.queued(id).length) this.drain(id)
      else this.dispatch(chat, [{ type: 'text', text: reason === 'quit' ? RELAUNCH_NUDGE : LIMIT_LIFTED }], { from: 'kernel', ...(reason === 'limit' && this.refusedRows.has(id) ? { clientId: this.refusedRows.get(id) } : {}) })
      // A send that started clears the cut-off. The carry-on is reported when the turn's first clean reply arrives (`carriedOn`, KERNEL-1031).
      if (!this.cutOff.has(id)) this.carrying.set(id, { reason, account: this.targetAccount(chat), at: Date.now() })
    }
  }

  /** The account the chat's next turn runs on, 'cli' for the CLI's own login. */
  private targetAccount(chat: Chat): string { return this.d.accountFor?.(chatProvider(chat), chat) ?? 'cli' }

  /**
   * A chat that took three refusals in a row gets no more nudges until a window on its target account lifts, or the user
   * switches its account or model, which also starts its count again (KERNEL-1031).
   */
  private stuckHolds(chat: Chat): boolean {
    const s = this.stuck.get(chat.id)
    if (!s) return false
    const account = this.targetAccount(chat)
    if (s.account !== account || s.model !== chat.model) { this.stuck.delete(chat.id); this.strikes.delete(chat.id); return false }
    if ((this.lifts.get(`${chatProvider(chat)}:${account}`) ?? 0) > s.lifted) { this.stuck.delete(chat.id); return false }
    return true
  }

  /** The carried turn's first clean reply: the chat is working again, which clears its strikes and its reusable rows. */
  private carriedOn(chatId: string) {
    this.strikes.delete(chatId)
    this.stuck.delete(chatId)
    this.refusedRows.delete(chatId)
    const c = this.carrying.get(chatId)
    if (!c) return
    this.carrying.delete(chatId)
    this.d.onCarriedOn?.(chatId, c.reason)
  }

  /**
   * A known usage limit stops this chat: one on the whole account, or on the chat's model. Only the windows of its provider,
   * on the account the chat runs on now, count (KERNEL-406, KERNEL-843), or on `live`'s account when given.
   */
  private limitHolds(chat: Chat, live?: Pick<Live, 'account'>) {
    const limits = this.limitsFor(chat, live)
    return !!blockingLimit(limits) || (limitedModels(limits) as string[]).includes(chat.model)
  }

  /**
   * A rejected 5-hour or weekly window on the account the chat runs on holds its next turn. A project pauses only when none of
   * its chats can run, so a chat on a limited account in a project that runs on waits here instead of starting a turn the
   * account refuses (KERNEL-941). A model's own limit doesn't hold: its banner offers another model.
   */
  private accountLimitHolds(chat: Chat) { return !!blockingLimit(this.limitsFor(chat)) }

  /** The usage windows that count for a chat: its own provider's, on the account it runs on (KERNEL-406, KERNEL-843), or on `live`'s account. */
  private limitsFor(chat: Chat, live?: Pick<Live, 'account'>) {
    const provider = chatProvider(chat)
    const account = live ? live.account : this.d.accountFor?.(provider, chat)
    return [...this.limits.values()].filter((l) => limitProvider(l) === provider && l.accountId === account)
  }

  /** A usage limit or a quit stopped this chat mid-turn and it waits to carry on. */
  private isCutOff(chatId: string) { return this.cutOff.has(chatId) }

  private setCutOff(chatId: string, entry: CutOffEntry | false) {
    if ((this.cutOff.get(chatId)?.reason ?? false) === (entry && entry.reason)) return
    if (entry) this.cutOff.set(chatId, entry)
    else this.cutOff.delete(chatId)
    this.d.onCutOff?.(Object.fromEntries(this.cutOff))
  }

  private setQueue(chatId: string, queue: QueuedMessage[]): QueuedMessage[] {
    if (queue.length) this.queues.set(chatId, queue)
    else this.queues.delete(chatId)
    // An idle chat's clock counts from its last change, so a message that waited and was removed buys it the full time.
    if (this.idle.has(chatId)) this.startIdle(chatId)
    this.pushQueue(chatId)
    // A held brief edited or removed in the composer is saved too, and so is every other queue, for a quit (KERNEL-215).
    if (this.waiting.has(chatId)) this.saveHeld()
    else this.saveQueues()
    return queue
  }

  /** Saves the queues of chats that aren't held (those go under `held`), so they survive a quit or a crash. */
  private saveQueues() {
    const queues: Record<string, QueuedMessage[]> = {}
    for (const [id, queue] of this.queues) if (!this.waiting.has(id)) queues[id] = queue
    this.d.store.saveMeta(QUEUES, queues)
  }

  /** `stopWorkspace` is stopping chats, and starts the ones left once they all are. */
  private stopping = 0

  private saveWorking() { this.d.store.saveMeta(WORKING, [...this.working]) }

  /**
   * Tell the renderer the chat's queue and what it waits for, once the current step is done. A held message going out
   * changes both the queue and the reason, and the renderer gets one event with where they ended up (KERNEL-271).
   */
  private pushQueue(chatId: string) {
    if (!this.unsent.size) queueMicrotask(() => this.flushQueues())
    this.unsent.add(chatId)
  }

  private flushQueues() {
    const ids = [...this.unsent]
    this.unsent.clear()
    for (const chatId of ids) {
      const queue = this.queued(chatId)
      const why = this.queueReason(chatId)
      if (queue.length) this.reasons.set(chatId, why)
      else this.reasons.delete(chatId)
      bus.push({ type: 'chat.queue', chatId, queue, ...(why ? { why } : {}) })
    }
  }

  /**
   * A turn started or ended, or a hold began or lifted: held queues whose reason changed tell the renderer. Kernel calls it
   * when a workspace changes too, since a held brief waits for its workspace or for a merge by its workspace's state (KERNEL-361).
   */
  pushReasons() {
    for (const chatId of this.queues.keys()) if (this.reasons.get(chatId) !== this.waitsFor(chatId)) this.pushQueue(chatId)
  }

  /** The turn's own result message ends it. Queued follow-ups still run afterwards, as in Claude Code. */
  async interrupt(chatId: string, sendNext = false) {
    const live = this.live.get(chatId)
    if (!live?.running) return
    // Stop is the user taking over. Send now isn't on its own: the message it sends first decides, so a Kernel update
    // sent again with Retry now leaves a pending hand-off reminder alone (KERNEL-116).
    if (!sendNext) this.d.openItems?.userSent(chatId)
    // A Stop while Send now is already interrupting wins: the queue is dropped.
    if (live.interrupted) { if (!sendNext) live.sendNext = false; return }
    live.interrupted = true
    await live.runner.interrupt()
    this.item(this.mustChat(chatId), { kind: 'interrupted', id: randomUUID(), ts: Date.now() })
  }

  async configure(chatId: string, patch: Partial<Pick<Chat, 'model' | 'effort' | 'plan' | 'mode'>>): Promise<Chat> {
    const chat = { ...this.mustChat(chatId), ...patch }
    this.d.store.saveChat(chat)
    // The composer follows changes Kernel makes too, like leaving plan mode when a plan is approved.
    bus.push({ type: 'chat', chat })
    const live = this.live.get(chatId)
    if (live) {
      if (patch.model) await live.runner.setModel(patch.model)
      // After the model, so a model switch keeps the effort picked with it (D-093).
      if (patch.effort) await live.runner.setEffort(patch.effort)
      // Plan mode and the chat's own mode decide the mode it runs in, and the model whether Auto can be it (KERNEL-447).
      if (patch.plan !== undefined || patch.mode !== undefined || patch.model) await this.moveTo(chat, this.mustWorkspace(chat.workspaceId), live)
    }
    this.pushModes([chatId])
    // "Switch to" on a model's limit: the new model picks up where the limit stopped the chat.
    if (patch.model) this.carryOn()
    return chat
  }

  /**
   * The user approved this chat's plan, from ExitPlanMode or the Lead's request_plan_approval. The chat leaves plan mode, so a
   * restart does not put it back (D-074). A Lead carries the plan out as its rule says, doing or handing off each step
   * (one-lead-chat), and a teammate builds it. The settled card says the plan was approved, so the chat gets no note. A message
   * Kernel sends carries `approvalId`, so the chat can show the user's answer.
   */
  async planApproved(chatId: string, o: { queue?: boolean; restarted?: boolean; approvalId?: string; owners?: string } = {}): Promise<string> {
    await this.configure(chatId, { plan: false }).catch(() => undefined)
    const chat = this.mustChat(chatId)
    const lead = this.isLeadChat(chatId)
    // The agent has its plan in context, so the note is short. After a restart it names the plan's file, or carries its
    // text when the file is gone (plan-cards-survive-restart).
    const ws = o.restarted ? this.d.store.workspace(chat.workspaceId) : undefined
    const plan = ws && this.d.store.approvals({ projectId: ws.projectId }).find((a) => a.chatId === chatId && a.kind === 'plan')
    const planFile = ws && plan?.planFile && existsSync(join(ws.path, plan.planFile)) ? plan.planFile : undefined
    const note = planApproval({ lead, planFile, plan: plan?.detail, restarted: o.restarted, queued: o.queue, owners: o.owners })
    const text = forProvider(note.text, chatProvider(chat))
    // A message is a turn of its own, so it goes only where no turn is waiting on the answer: Codex, and after a restart.
    if (o.queue) await this.send(chatId, [{ type: 'text', text }], { from: 'kernel', approvalId: o.approvalId })
    return text
  }

  /**
   * `tree` also ends what the process started: Close chat and archive. Its process group gets SIGTERM after the process is
   * closed, then SIGKILL 2 seconds later (KERNEL-810). Without it, as at an idle stop or a restart, a dev server an agent
   * started keeps running.
   */
  stop(chatId: string, o: { tree?: boolean } = {}) {
    const live = this.live.get(chatId)
    // A chat stopped while idle has no process but is stopped all the same.
    if (!live && !this.turns.has(chatId)) {
      // A held message of a chat that never ran goes with the chat, and the chats that waited behind it for the folder go on.
      if (this.queued(chatId).length && !this.waiting.has(chatId)) { this.setQueue(chatId, []); this.freeFolder() }
      return
    }
    // Stopped by Kernel or the user: a hook's refusal no longer holds anyone up. A running turn's end says so on its own;
    // an idle chat that gave up blocked has no turn left to end, so Team and the sidebar hear it here (Archive, Close chat).
    const shown = this.turns.get(chatId)?.blocked && !live?.running
    // A Codex plan waiting on the chat ends with it, as the process's cards do in `end` (KERNEL-563).
    this.expireCards(this.turns.get(chatId)?.plans)
    this.turns.delete(chatId)
    if (live) this.end(chatId, live)
    if (live && o.tree) void endAll([...live.groups].map((pid) => -pid))
    const held = this.queued(chatId).length > 0
    if (held) this.setQueue(chatId, [])
    this.compacted.delete(chatId)
    if (this.moveHolds.delete(chatId)) { const chat = this.d.store.chat(chatId); if (chat) this.d.onMoveHold?.(chat, false) }
    const ws = shown ? this.d.store.workspace(this.mustChat(chatId).workspaceId) : undefined
    if (ws) this.setStatus(ws, this.d.agentFor(ws), 'idle')
    // A chat that was writing in its folder lets the next one in.
    if (live?.running || held) this.freeFolder()
  }

  /** Close the process's input and abort it. `consume` sees the abort and reports nothing: no offline, no crash. */
  private end(chatId: string, live: Live) {
    this.stopIdle(chatId)
    this.stale.delete(chatId)
    live.runner.close()
    this.live.delete(chatId)
    this.compactEnded(chatId, live, false)
    // Nobody can answer what the process asked once it is gone (KERNEL-563).
    this.expireCards(live.cards)
    // A chat whose Bypass permissions waited for this process runs in it from the next message.
    this.pushModes([chatId])
  }

  /** End the cards among `ids` that still wait on the user, and forget them all. A quit leaves them to `expirePending` (KERNEL-563). */
  private expireCards(ids: Set<string> | undefined) {
    if (!ids?.size || this.closing) return
    this.d.approvals.expireIds(ids)
    ids.clear()
  }

  /**
   * Start the chat's idle clock over, between turns. When it runs out, the process stops unless something still needs it,
   * and the next message resumes the conversation from `chat.sessionId` (KERNEL-183). It changes no status and keeps
   * `turns`, so the chat looks and answers the same as before.
   */
  private startIdle(chatId: string) {
    this.stopIdle(chatId)
    const live = this.live.get(chatId)
    if (!live || live.running) return
    if (this.stale.has(chatId) && !live.tasks.size) { this.end(chatId, live); return }
    const clock = setTimeout(() => {
      this.idle.delete(chatId)
      if (this.live.get(chatId) !== live || live.running) return
      // Held for now: look again after another stretch, so a pause or a background task that ends starts no new wait.
      if (this.keepsProcess(chatId, live)) this.startIdle(chatId)
      else this.end(chatId, live)
    }, IDLE_STOP_MS)
    // An idle clock never keeps Kernel running.
    clock.unref?.()
    this.idle.set(chatId, clock)
  }

  private stopIdle(chatId: string) {
    clearTimeout(this.idle.get(chatId))
    this.idle.delete(chatId)
  }

  /**
   * Something still needs the idle chat's process: messages waiting to go, a held brief, a paused project or a
   * hold on every project, a usage limit it waits out, or a background task it runs.
   */
  private keepsProcess(chatId: string, live: Live): boolean {
    const chat = this.d.store.chat(chatId)
    return !!chat && (this.queued(chatId).length > 0 || this.pausedChat(chat) || this.isCutOff(chatId) || live.tasks.size > 0)
  }

  /** Start a new session for a chat whose session ended, resuming its conversation with a nudge to carry on. */
  async restart(chatId: string): Promise<void> {
    this.mustChat(chatId)
    this.crashed.delete(chatId)
    // Messages held while the session was down or the project was paused still go out, first, and the nudge follows them.
    const held = this.queued(chatId)
    this.stop(chatId)
    if (!held.length) { await this.send(chatId, [{ type: 'text', text: RESTART_NUDGE }], { from: 'kernel' }); return }
    this.setQueue(chatId, [...held, { id: randomUUID(), chatId, parts: [{ type: 'text', text: RESTART_NUDGE }], ts: Date.now(), from: 'kernel' }])
    this.drain(chatId)
  }

  stopWorkspace(workspaceId: string, o: { tree?: boolean } = {}) {
    // Its chats stop together, so one's folder never goes to another of them that is about to stop as well.
    this.stopping++
    try { for (const c of this.d.store.chats(workspaceId)) this.stop(c.id, o) } finally { this.stopping-- }
    this.freeFolder()
  }

  /** A chat that held a folder, or waited first for it, is gone, so the ones behind it start (one-writer-per-folder). */
  private freeFolder() { if (!this.closing && !this.stopping) this.drainWaiting() }

  /**
   * The agent behind these workspaces changed: its file, its tools, or who leads (KERNEL-397). A process only reads its
   * agent when it starts, so an idle one ends now and a busy one when its turn and background tasks end. The next message
   * resumes the conversation with the agent as it is now, and nothing waiting in the queue is lost.
   */
  restartIdle(workspaceIds: string[], reason: StaleReason = 'agent') {
    for (const id of workspaceIds) {
      for (const c of this.d.store.chats(id)) {
        const live = this.live.get(c.id)
        if (!live) continue
        if (live.running || live.tasks.size) this.markStale(c.id, reason)
        else this.end(c.id, live)
      }
    }
    // The agent file's mode may have changed with it.
    this.pushModes(workspaceIds.flatMap((id) => this.d.store.chats(id).map((c) => c.id)))
  }

  noteSetup(workspaceId: string, text: string) {
    for (const c of this.d.store.chats(workspaceId)) if (c.kind !== 'terminal') this.setupNotes.set(c.id, text)
  }

  /** The workspace is archived. Chats held for its setup let go of what they held, so a restore doesn't find them still waiting. */
  dropHeld(workspaceId: string) {
    const path = this.d.store.workspace(workspaceId)?.path
    if (path) this.realFolders.delete(path)
    for (const c of this.d.store.chats(workspaceId)) if (this.waiting.delete(c.id)) { this.setQueue(c.id, []); this.saveHeld() }
  }
  stopAll() { for (const id of [...this.live.keys()]) this.stop(id) }

  /**
   * Kernel is quitting (KERNEL-215). The journal of working chats freezes, so turns that end now stay in it and carry on
   * at the next launch. Every running turn is interrupted at once and gets `budgetMs` to end; then every process is
   * ended, the ones still working too. Queues are kept and saved, and nothing new goes out. Close chat and archive use
   * `stop`, which drops the queue as before.
   */
  async shutdown(budgetMs = QUIT_BUDGET_MS) {
    this.closing = true
    // A plan card the stopping turns leave keeps waiting for the next launch.
    this.d.approvals.quitting()
    const running = [...this.live.entries()].filter(([, l]) => l.running)
    // A Stop pressed just before the quit stands: that turn ends as a Stop, drops its queue and doesn't carry on.
    const stopping = (live: Live) => live.interrupted && !live.sendNext
    for (const [id, live] of running) if (stopping(live)) this.working.delete(id)
    this.saveWorking()
    let timer: ReturnType<typeof setTimeout> | undefined
    const ended = Promise.all(running.map(([, live]) => new Promise<void>((resolve) => {
      live.whenIdle = resolve
      if (stopping(live)) return
      // Like Send now, the turn ends without dropping the queue, and no interrupted row: the note at launch says it.
      live.interrupted = true
      live.sendNext = true
      live.quit = true
      void live.runner.interrupt()
    })))
    await Promise.race([ended, new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs) })])
    clearTimeout(timer)
    for (const [id, live] of [...this.live]) {
      this.end(id, live)
      // A process left mid-step would carry on alone, so it ends now, and so do the shells its tools started.
      live.runner.kill()
    }
  }

  /**
   * Claude Code processes from the last run that are still alive (KERNEL-215). A force quit or a crash leaves them running
   * the step they were on, in the same worktree a resumed session is about to use. Each saved pid that is still alive and
   * still the same binary gets SIGTERM, then SIGKILL if it hasn't gone within `waitMs`. Its process group gets the same, so
   * the shells, dev servers and test runs it started end with it (KERNEL-810). Returns the pids it ended.
   */
  async endLeftovers(waitMs = 2000): Promise<number[]> {
    const saved = this.d.store.meta<SavedPid[]>(PIDS) ?? []
    const left: SavedPid[] = []
    for (const p of Array.isArray(saved) ? saved : []) if (typeof p?.pid === 'number' && !this.pids.has(p.pid) && (await runs(p))) left.push(p)
    for (const p of left) { signal(p.pid, 'SIGTERM'); signal(-p.pid, 'SIGTERM') }
    const until = Date.now() + waitMs
    let alive = left
    // What the group started may outlive the process itself, so a process counts as gone once its group is.
    const stays = async (p: SavedPid) => (await runs(p)) || signal(-p.pid, 0)
    while (alive.length && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100))
      alive = (await Promise.all(alive.map(async (p) => ((await stays(p)) ? p : undefined)))).filter((p): p is SavedPid => !!p)
    }
    for (const p of alive) { if (await runs(p)) signal(p.pid, 'SIGKILL'); signal(-p.pid, 'SIGKILL') }
    // Only now, so a crash during the wait still finds them at the next launch.
    this.savePids()
    return left.map((p) => p.pid)
  }

  /** Kernel quit or closed while a turn ran, or a chat waits to carry on: what `restore` will start, so Kernel checks the account first. */
  wasWorking(): boolean { return (this.d.store.meta<string[]>(WORKING) ?? []).length > 0 }

  /**
   * Starts Claude Code the way the SDK's own spawn does, and records its pid until it exits, so a launch after a crash can
   * end it (`endLeftovers`). The SDK reads no stderr from a custom spawn, so Kernel keeps the end of it for the error note.
   * Each process leads its own process group. In Kernel's group, a Ctrl+C or a closed tab in the terminal that ran `pnpm dev`
   * reached every agent at once and ended its turn before the quit could save it to carry on (KERNEL-340).
   */
  private spawn(command: string, args: string[], o: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal }, proc: Proc): ChildProcess {
    const child = spawn(command, args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true })
    proc.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => { proc.stderr = (proc.stderr + d).slice(-STDERR_KEPT) })
    child.stderr?.on('error', () => undefined)
    const pid = child.pid
    if (pid) {
      this.pids.set(pid, { command, ...(args[0] ? { arg: args[0] } : {}) })
      this.savePids()
      child.once('exit', () => { if (this.pids.delete(pid)) this.savePids() })
    }
    return child
  }

  private savePids() {
    // Written from the exit of a process that outlives a stopped Kernel too, whose database is closed by then.
    try { this.d.store.saveMeta<SavedPid[]>(PIDS, [...this.pids].map(([pid, p]) => ({ pid, ...p }))) } catch { /* Kernel stopped */ }
  }

  /** Where a chat in `ws` run by `agent` compacts: its role's window in Settings, Models (feat-compact-window-per-role-with-plan). */
  private compactFor(ws: Workspace, agent: AgentDef | undefined): CompactWindow | undefined {
    const role = this.d.roleFor?.(ws, agent)
    return role && this.d.settings().models?.compact?.[role]
  }

  /** Starts the chat's process on the account its next turn runs on, or on `o.account`, undefined for the CLI's own login. */
  private start(chat: Chat, ws: Workspace, o: { account?: string } = {}): Live {
    const agent = this.d.agentFor(ws, chat)
    const root = this.d.store.project(ws.projectId)?.path
    const account = 'account' in o ? o.account : this.d.accountFor?.(chatProvider(chat), chat)
    const { mode, bypass } = this.modes(chat, ws)
    const live = { running: false, interrupted: false, tasks: new Set<string>(), cards: new Set<string>(), groups: new Set<number>(), account, onKey: this.d.authOf?.(chatProvider(chat), account) === 'apiKey', mode } as Live
    const host = this.hostFor(chat.id, ws, agent, live)
    const env = this.d.envFor?.(ws) ?? buildEnv({ base: process.env, kernel: kernelVars(ws, this.d.store.project(ws.projectId)) })
    const prompt = agentPrompt(agent, ws, this.d.rulesFor?.(ws, agent, chat))
    if (chatProvider(chat) === 'codex') {
      const c = this.d.codexFor?.(ws, agent, chat, account)
      live.threadBypass = mode === 'bypassPermissions'
      // Kernel's rules name its tools as Claude sees them, so Codex reads them under its own names.
      live.runner = new CodexRunner(host, { bin: c?.bin ?? '', home: c?.home, apiKey: c?.apiKey, env, prompt: forProvider([prompt, c?.instructions].filter(Boolean).join('\n\n'), 'codex'), tools: c?.tools ?? [], personality: c?.personality ?? 'pragmatic', disabled: this.d.disabledFor?.(ws)?.mcp, aliases: this.d.aliasesFor?.(ws), access: this.d.accessFor?.(ws), references: this.d.referencesFor?.(ws), bypass: live.threadBypass })
    } else {
      live.bypass = bypass
      live.runner = new ClaudeRunner(host, { mcpServers: this.d.mcpFor(ws, agent, chat), disabled: this.d.disabledFor?.(ws), prompt, env, credential: this.d.claudeEnv?.(account) ?? {}, compact: this.compactFor(ws, agent), root, aliases: this.d.aliasesFor?.(ws), access: this.d.accessFor?.(ws), references: this.d.referencesFor?.(ws), mode, bypass })
    }
    this.live.set(chat.id, live)
    live.runner.start()
    return live
  }

  /** What the chat's runner calls back into (KERNEL-406). Each method acts on this chat and this process. */
  private hostFor(chatId: string, ws: Workspace, agent: AgentDef | undefined, live: Live): RunnerHost {
    return {
      chatId, workspace: ws, agent,
      chat: () => this.mustChat(chatId),
      settings: () => this.d.settings(),
      mode: () => this.modes(this.mustChat(chatId), ws).mode,
      ...(agent?.lead && this.d.buildOpen ? { buildOpen: () => this.d.buildOpen!(chatId) } : {}),
      projectAllow: () => this.d.projectAllow(ws.projectId),
      allowInProject: (rule) => this.d.allowInProject(ws.projectId, rule),
      projectTools: () => this.d.projectTools?.(ws.projectId) ?? [],
      allowToolInProject: (rule) => this.d.allowToolInProject?.(ws.projectId, rule),
      held: () => this.paused.get(ws.projectId)?.open ?? this.gates.get(chatProvider(this.mustChat(chatId)))?.open,
      spawn: (command, args, o, proc) => {
        const child = this.spawn(command, args, o, proc)
        if (child.pid) live.groups.add(child.pid)
        return child
      },
      managed: (sessionId) => { this.managedIds.add(sessionId) },
      item: (item) => this.item(this.mustChat(chatId), item),
      compacted: (note, sizes) => {
        const s = this.summaries.get(chatId)
        if (!s || !live.compacting) return false
        s.compaction = note
        s.sizes = sizes
        return true
      },
      sessionStarted: (sessionId, o = {}) => {
        let chat = this.mustChat(chatId)
        this.managedIds.add(sessionId)
        if (chat.sessionId !== sessionId) { chat = { ...chat, sessionId }; this.d.store.saveChat(chat) }
        const source = o.billedBy
        if (source !== undefined) {
          // The key pays on an API key account, the plan on every other (D-018, KERNEL-523). Anything else gets a note.
          if (!this.billing.has(chatId) && source !== (live.onKey ? 'ANTHROPIC_API_KEY' : 'none')) {
            const by = source === 'none' ? 'your Claude plan' : source
            this.item(chat, { kind: 'note', id: randomUUID(), ts: Date.now(), text: `This session is billed through ${by}, not ${live.onKey ? 'the API key account you picked' : 'your Claude plan'}.` })
            bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, sessionId, text: `is billed through ${source === 'none' ? 'the Claude plan' : source}, not ${live.onKey ? 'the API key account' : 'the Claude plan'}` })
          }
          this.billing.set(chatId, source)
        }
        const servers = o.mcpServers
        const project = servers && (this.d.onMcp?.(ws, chatProvider(chat), servers, live.account) ?? [])
        if (servers && project && !this.mcpChecked.has(chatId)) {
          this.mcpChecked.add(chatId)
          // claude.ai's connectors can join after the first init, so the project's word on those counts too. The project's
          // switched-off servers never start, so the project's settings alone know them. Every other server is as this session has it.
          const late = project.filter((r) => r.source === 'claudeai' && !servers.some((s) => s.name === r.name))
          const off = (this.d.disabledFor?.(ws)?.mcp ?? []).map((name) => ({ name, enabled: false }))
          const text = missingServers(this.d.agentFor(ws)?.tools, [...late, ...servers, ...off], this.d.aliasesFor?.(ws)).map(mcpNote).join(' ')
          if (text) this.item(chat, { kind: 'note', id: randomUUID(), ts: Date.now(), text })
        }
        this.setRunning(chat, ws, live, true)
      },
      mcpStatus: (servers) => { this.d.onMcp?.(ws, chatProvider(this.mustChat(chatId)), servers, live.account) },
      blocked: (event, output) => this.blocked(ws, chatId, event, output),
      toolSucceeded: () => { if (this.turns.get(chatId)?.blocked === 'PreToolUse') this.unblock(this.mustChat(chatId), ws) },
      setTasks: (ids) => { live.tasks = new Set(ids) },
      retrying: (retry) => { live.retry = retry; bus.push({ type: 'retry', chatId, retry }) },
      clearRetry: () => this.clearRetry(chatId, live),
      reached: () => { this.d.onReached?.(); if (!live.limited) this.carriedOn(chatId) },
      replied: () => this.d.onReply?.(ws, this.mustChat(chatId)),
      failed: (failure, o = {}) => { live.failed = failure; if (o.notify) this.d.onFailure?.(failure, ws, chatProvider(this.mustChat(chatId)), live.account) },
      limited: (o = {}) => {
        if (!o.always && !live.running) return
        live.limited = true
        this.limitUnknown(this.mustChat(chatId), live)
      },
      // A window is the provider's and the account's the process runs on. Claude's on the CLI login stay as they always were.
      // An API key account has none, so nothing it reports holds a chat or pauses a project (KERNEL-523).
      mergeLimits: (patches) => { if (!live.onKey) this.mergeLimits(patches.map((p) => ({ ...p, ...(live.account ? { accountId: live.account } : {}) }))) },
      reset: (trigger) => {
        this.d.store.clearItems(chatId)
        if (trigger === 'clear') live.cleared = true
        bus.push({ type: 'chat.cleared', chatId })
        this.d.onReset?.(ws, this.mustChat(chatId), trigger)
      },
      setContext: (context, usage) => this.setContext(chatId, context, usage),
      turnUsage: (u) => { live.usage = u },
      turnEnded: (t) => this.turnEnded(chatId, ws, live, t),
      sessionGone: () => this.renew(this.mustChat(chatId), ws, live),
      ended: (reason, o = {}) => this.ended(chatId, ws, live, reason, o.error === true),
      // A stopped process can still deliver lines it had already written. Once a newer session owns the chat, or Kernel is
      // quitting and ended this process, they are dropped (KERNEL-396).
      stale: () => this.replaced(chatId, live) || (this.closing && live.runner.closed),
      get quitting() { return live.quit === true },
      get interrupted() { return live.interrupted },
      ask: (a, o) => this.ask(chatId, ws, agent, a, o),
      requestPlan: (plan, o) => this.requestPlan(chatId, ws, agent, plan, o),
      afterPlan: () => { const t = this.approvedPlans.get(chatId); this.approvedPlans.delete(chatId); return t },
      setupNote: () => { const t = this.setupNotes.get(chatId); this.setupNotes.delete(chatId); return t },
      // What the chat owes reminds once, until a new item opens (KERNEL-749).
      handoffAtStop: () => {
        const t = this.d.openItems?.atStop(chatId)
        return t ? forProvider(t, chatProvider(this.mustChat(chatId))) : undefined
      },
      followUp: (text) => { void this.send(chatId, [{ type: 'text', text }], { from: 'kernel' }).catch(() => undefined) }
    }
  }

  /**
   * The chat's process ended. `ended` is null when Kernel stopped it, else why it went away. A process that failed leaves a
   * note. Kernel is quitting and ended this process: the stream ends on its own time, often after Kernel has closed the
   * store, and nothing of it changes what carries on, since `shutdown` already froze the journal and kept the queue (KERNEL-396).
   */
  private ended(chatId: string, ws: Workspace, live: Live, ended: string | null, error: boolean) {
    if (error && ended !== null) this.item(this.mustChat(chatId), { kind: 'note', id: randomUUID(), ts: Date.now(), text: `Session stopped: ${ended}` })
    if (this.closing && live.runner.closed) return
    const replaced = this.replaced(chatId, live)
    // A compaction isn't the agent's work, so its process going away stops nothing halfway (KERNEL-844).
    const midTurn = live.running && !live.compacting
    if (this.live.get(chatId) === live) { this.live.delete(chatId); this.stopIdle(chatId); this.pushModes([chatId]) }
    this.compactEnded(chatId, live, false)
    // Nobody can answer what the process asked, and a crash ends a Codex plan waiting on the chat too. A newer session's
    // cards are its own (KERNEL-563).
    this.expireCards(live.cards)
    if (!replaced && ended !== null) this.expireCards(this.turns.get(chatId)?.plans)
    const chat = this.d.store.chat(chatId)
    if (chat && !replaced) this.setRunning(chat, ws, live, false)
    if (chat && !replaced) this.drainWaiting()
    if (chat && !replaced && ended !== null) {
      // A message that waited for this chat may have started a new session just now. Then it is working again.
      const resumed = !!this.live.get(chatId)?.running
      // Kernel's own messages wait until the user acts on a session that died mid-turn, so they can't loop a broken one.
      if (midTurn && !resumed) this.crashed.add(chatId)
      if (!resumed) this.offline(ws, ended)
      this.d.onExit?.(ws, chat, ended, midTurn, resumed)
    }
  }

  /**
   * Claude Code no longer has the conversation this process resumed: it pruned the transcript, or the user deleted
   * ~/.claude/projects (KERNEL-286). The chat forgets the id, so no later send resumes it. The running turn moves to a fresh
   * session with the chat's model, effort and plan mode, which gets the same message; the queue follows when it ends, as
   * usual. One of Kernel's nudges becomes the fresh-session nudge, in the transcript too, since the agent has nothing to
   * pick up. The turn never ends in between, so the journal, `turns` and a carry-on after a quit stay as they were, and
   * nobody hears of the old process. Returns false, and the turn ends the usual way, while Kernel quits (the next launch
   * tries again), when the fresh session this chat already got never finished a turn, so a broken setup can't loop, and
   * after a Stop or a Send now: Stop drops the queue, and Send now's message starts the fresh session itself.
   */
  private renew(chat: Chat, ws: Workspace, live: Live): boolean {
    if (this.closing || !live.sent) return false
    const fresh: Chat = { ...chat, sessionId: undefined }
    this.d.store.saveChat(fresh)
    if (this.renewed.has(chat.id)) return false
    this.renewed.add(chat.id)
    this.item(fresh, { kind: 'note', id: randomUUID(), ts: Date.now(), text: SESSION_GONE_NOTE })
    this.end(chat.id, live)
    if (live.interrupted) return false
    let sent = live.sent
    const row = live.sentItem
    const nudged = (m: { from?: MessageFrom; parts: ChatPart[] }) => m.from === 'kernel' && isNudge(m.parts)
    const parts: ChatPart[] = [{ type: 'text', text: freshNudge(this.brief(chat.id)) }]
    // The row keeps its place: the store saves it again where it was, before the note.
    if (row && nudged(row)) {
      this.item(fresh, { ...row, parts })
      sent = parts
    }
    // A nudge still waiting, as the one after a quit, would tell the agent to pick up where it left off too.
    const queue = this.queued(chat.id)
    if (queue.some(nudged)) this.setQueue(chat.id, queue.map((q) => (nudged(q) ? { ...q, parts } : q)))
    const next = this.start(fresh, ws)
    next.carrying = live.carrying
    next.sent = sent
    next.sentItem = row
    next.runner.push(sent)
    this.setRunning(fresh, ws, next, true)
    return true
  }

  /** The text of the chat's first message that isn't one of Kernel's nudges: the brief a fresh session starts from. */
  private brief(chatId: string): string | undefined {
    const first = this.d.store.items(chatId).find((i): i is ChatItem & { kind: 'user' } => isSentItem(i) && !(i.from === 'kernel' && isNudge(i.parts)))
    const text = first?.parts.flatMap((p) => (p.type === 'text' ? [p.text] : p.type === 'issue' || p.type === 'pr' || p.type === 'workspace' ? [linkText(p)] : [])).join('\n').trim()
    return text || undefined
  }

  /** True once a send right after stop() has started a newer session under this chat. */
  private replaced(chatId: string, live: Live) {
    const current = this.live.get(chatId)
    return !!current && current !== live
  }

  /** The running turn ended. Its result row, then what waits for the chat goes out, or Stop drops it. */
  private turnEnded(chatId: string, ws: Workspace, live: Live, t: Parameters<RunnerHost['turnEnded']>[0]) {
    // Claude's /compact for a move ends as a turn, which isn't the agent's (KERNEL-844).
    if (live.compacting) { this.compactEnded(chatId, live, t.ok); return }
    if (t.tooLong && live.sent && !live.interrupted && !this.shrunk.has(chatId) && !this.closing) { void this.retryShorter(chatId, ws, live, t); return }
    const chat = this.recordTurn(this.mustChat(chatId), live)
    const ok = t.ok
    const stopped = live.interrupted && !live.sendNext
    const limited = !!live.limited && !stopped
    const account = live.account ?? 'cli'
    const carry = this.carrying.get(chatId)
    this.carrying.delete(chatId)
    const refused = limited && carry?.reason === 'limit' && carry.account === account && Date.now() - carry.at < REFUSED_WITHIN_MS
    // A refused nudge keeps one result row between carry-ons, next to the one nudge row they reuse (KERNEL-1031).
    const nudge = refused && live.sentItem && live.sentItem.from === 'kernel' && isNudge(live.sentItem.parts) ? live.sentItem.id : undefined
    // An interrupted turn ends with error_during_execution; the interrupted row already says what happened.
    if ((ok || !live.interrupted) && !live.cleared) this.item(chat, { kind: 'result', id: nudge ? `${nudge}-result` : t.id, ts: Date.now(), durationMs: t.durationMs ?? 0, ok, error: ok ? undefined : t.error, ...(limited ? { limit: true as const } : {}) })
    if (nudge) this.refusedRows.set(chatId, nudge)
    this.noteMove(chat)
    this.clearRetry(chatId, live)
    void live.runner.context()
    const interrupted = live.interrupted
    // Stop and Send now end the cards the turn put up, on either provider. One answered first keeps its answer (KERNEL-563).
    if (interrupted) this.expireCards(live.cards)
    // Cut off by a limit Kernel knows about, so it can tell when to carry on. An unknown one would loop. The limit is the
    // account's the turn ran on, which a switch at the limit may already have left (KERNEL-568).
    // A turn a limit cut off always goes on the list: whether its window still looks closed now says nothing about the next
    // attempt, and a refusal that came back at once is counted so the carry-on stops (KERNEL-1031). An API key has no windows.
    let strikes = 0
    if (limited && !live.onKey) {
      if (refused) strikes = (this.strikes.get(chatId) ?? 0) + 1
      if (strikes) this.strikes.set(chatId, strikes)
      else this.strikes.delete(chatId)
      if (strikes >= MAX_STRIKES) this.stuck.set(chatId, { account: this.targetAccount(chat), model: chat.model, lifted: this.lifts.get(`${chatProvider(chat)}:${this.targetAccount(chat)}`) ?? 0 })
      this.setCutOff(chatId, { reason: 'limit', account, at: Date.now() })
    }
    const limit = limited && (refused ? strikes === MAX_STRIKES : this.limitHolds(chat, live))
    // A carry-on after a quit that failed on a sign-out or a dropped connection waits for that hold to lift and tries
    // again, as at launch. Without a hold in place nothing would ever lift, so it stays stopped like any failed turn.
    if (!ok && !stopped && live.carrying && live.failed && this.holding(chatProvider(chat))) this.setCutOff(chatId, { reason: 'quit', at: Date.now() })
    live.carrying = false
    live.failed = undefined
    live.interrupted = false
    live.sendNext = false
    // The hook that refused to let the agent finish has now let it finish.
    const turns = this.turnsOf(chatId)
    if (ok && turns.blocked !== 'PreToolUse') turns.blocked = undefined
    // A session that just finished a turn isn't broken, whoever sent it, as after Retry on a Kernel update (KERNEL-124).
    if (ok) { this.crashed.delete(chatId); this.renewed.delete(chatId); this.shrunk.delete(chatId) }
    live.limited = false
    live.cleared = false
    this.setRunning(chat, ws, live, false)
    // A turn a quit interrupted isn't over: it carries on at the next launch, which reports it then.
    if (!this.closing) this.turnDone(ws, chat, { ok, interrupted, by: turns.from ?? 'user', account: live.account, ...(limited ? { limit: true as const } : {}), ...(refused ? { refused: true as const } : {}), ...(limit && strikes === MAX_STRIKES ? { stuck: true as const } : {}) })
    // Stop means stop: held messages are dropped, not sent. Send now keeps them.
    if (stopped) this.setQueue(chatId, [])
    else this.drain(chatId)
    this.drainWaiting()
  }

  /** What follows a finished turn (`onTurnDone`). */
  turnDone(ws: Workspace, chat: Chat, turn: { ok: boolean; interrupted: boolean; by: TurnBy; account?: string; limit?: true; refused?: true; stuck?: true }) {
    this.d.onTurnDone?.(ws, chat, turn)
  }

  /**
   * Put a runner's request in front of the user and wait: a tool to allow, a question, or a plan. The agent shows as
   * needing the user meanwhile. Order: Never allow, the project's rules, Always ask and Bypass were the runner's to apply first.
   */
  private async ask(chatId: string, ws: Workspace, agent: AgentDef | undefined, a: Ask, o: { signal?: AbortSignal; timeoutMs?: number; afterTurn?: boolean; placed?: (id: string) => void }, plan?: string): Promise<Decision | undefined> {
    // A turn that stopped before its card went up shows none: an abort that has already fired never fires again (KERNEL-563).
    if (o.signal?.aborted) return undefined
    this.setStatus(ws, agent, 'needs')
    const asker = this.live.get(chatId)
    const reuse = plan !== undefined ? revisedPlanFile(this.d.store.approvals({ projectId: ws.projectId }), chatId) : undefined
    // A new plan replaces one still waiting, as one a restart left up.
    if (plan !== undefined) this.d.approvals.expireIds(this.d.approvals.waitingPlans(chatId, ws.projectId).map((p) => p.id), 'replaced')
    const { approval, decision } = this.d.approvals.request({
      kind: a.kind, source: 'sdk', projectId: ws.projectId, workspaceId: ws.id, chatId, agentId: agent?.id,
      toolName: a.toolName, input: a.input, title: a.title, detail: a.detail, options: a.options, questions: a.questions, ...(a.reason ? { reason: a.reason } : {})
    } as Parameters<Approvals['request']>[0], { signal: o.signal, timeoutMs: o.timeoutMs })
    this.placeApproval(chatId, approval.id, { afterTurn: o.afterTurn })
    o.placed?.(approval.id)
    if (plan?.trim() && existsSync(ws.path)) {
      void savePlan(ws.path, plan, { reuse }).then((planFile) => this.d.approvals.update(approval.id, { planFile }), () => undefined)
    }
    const result = await decision
    this.turns.get(chatId)?.plans?.delete(approval.id)
    // A card that ended with its process leaves the status that end set: idle, or offline after a crash (KERNEL-563).
    if (!result && asker && this.live.get(chatId) !== asker) return undefined
    // A Codex plan waits for approval after its turn ended, so the agent goes back to idle rather than working.
    if (!this.showBlocked(ws, chatId)) this.setStatus(ws, agent, this.live.get(chatId)?.running === false ? 'idle' : 'working')
    return result ?? undefined
  }

  /**
   * A plan for the user to approve, from either provider (KERNEL-406): Claude's ExitPlanMode, or a Codex plan-mode turn's
   * plan. Approval takes the chat out of plan mode and starts a Lead's hand-off (`planApproved`).
   */
  private async requestPlan(chatId: string, ws: Workspace, agent: AgentDef | undefined, plan: string, o: { signal?: AbortSignal; toolName?: string; input?: unknown }): Promise<Decision | undefined> {
    // A Codex plan comes after its turn ended (`CodexRunner.planned`), so it stays with the chat rather than a turn (KERNEL-563).
    const afterTurn = chatProvider(this.mustChat(chatId)) === 'codex'
    let approvalId: string | undefined
    const result = await this.ask(chatId, ws, agent, { kind: 'plan', toolName: o.toolName, input: o.input, title: `Plan for ${ws.name}`, detail: plan }, { signal: o.signal, afterTurn, placed: (id) => { approvalId = id } }, plan)
    // Claude reads the note with ExitPlanMode's answer (`afterPlan`). A Codex turn has already ended, so it gets a message.
    if (result?.behavior === 'allow') {
      const note = await this.planApproved(chatId, { queue: afterTurn, approvalId })
      if (!afterTurn) this.approvedPlans.set(chatId, note)
    }
    return result
  }

  private setRunning(chat: Chat, ws: Workspace, live: Live, running: boolean) {
    if (live.running === running) return
    live.running = running
    // Each turn gets its own Bypass note.
    if (running) live.bypassNote = undefined
    else live.cold = false
    if (!running) { live.whenIdle?.(); live.whenIdle = undefined }
    // The journal is written at every turn start and end, so a crash leaves the right list. A quit freezes it.
    if (!this.closing && this.working.has(chat.id) !== running) {
      if (running) this.working.add(chat.id)
      else this.working.delete(chat.id)
      this.saveWorking()
    }
    bus.push({ type: 'chat.running', chatId: chat.id, running })
    // A turn starting stops the idle clock, and one ending starts it.
    if (running) this.stopIdle(chat.id)
    else this.startIdle(chat.id)
    // This chat's queue now waits for something else, and a slot was taken or freed for the others.
    this.pushReasons()
    // An agent that gave up after a hook refused it still needs someone to look.
    if (!running && this.showBlocked(ws, chat.id)) return
    this.setStatus(ws, this.d.agentFor(ws), running ? (chat.plan ? 'planning' : 'working') : 'idle')
  }

  private mergeLimits(next: LimitPatch[], o: { copied?: boolean } = {}) {
    if (!next.length) return
    const rejected: RateLimit[] = []
    for (const l of next) {
      const key = limitKey(l)
      // Claude's per-model windows name their model. Codex's windows are the account's.
      const now = Date.now()
      const prev = this.limits.get(key)
      const merged = { ...mergeLimit(prev, limitProvider(l) === 'claude' ? { ...l, model: l.model ?? WINDOW_MODEL[l.type] } : l, now), readAt: now }
      this.limits.set(key, merged)
      if (prev?.status === 'rejected' && merged.status !== 'rejected') this.lifted(merged)
      if (prev?.status === 'rejected' && merged.status !== 'rejected') console.info(`[limits] lifted ${key}: ${liftedBy(prev, now)}`)
      if (merged.status === 'rejected' && merged.rejectedAt !== prev?.rejectedAt) {
        console.info(`[limits] rejected ${key}${merged.provisional ? ' (temporary)' : ''}${merged.resetsAt ? `, resets at ${new Date(merged.resetsAt * 1000).toISOString()}` : ''}`)
        rejected.push(merged)
      }
    }
    if (!o.copied) for (const l of rejected) this.copyRejection(l)
    this.pushLimits()
  }

  /** A rejected window lifted, which releases the chats on its account that took too many refusals (`stuckHolds`, KERNEL-1031). */
  private lifted(l: RateLimit) {
    const key = `${limitProvider(l)}:${l.accountId ?? 'cli'}`
    this.lifts.set(key, (this.lifts.get(key) ?? 0) + 1)
  }

  /** A rejection holds every account on the same login, which shares its windows, the CLI's own login included (KERNEL-1030). */
  private copyRejection(l: RateLimit) {
    const provider = limitProvider(l)
    for (const accountId of this.d.sameLoginAccounts?.(provider, l.accountId) ?? []) {
      const { accountId: _from, ...rest } = l
      const twin = limitKey({ type: l.type, provider, accountId })
      if (this.limits.get(twin)?.status === 'rejected') continue
      console.info(`[limits] copied rejection ${limitKey(l)} to ${twin}`)
      this.mergeLimits([{ ...rest, ...(accountId ? { accountId } : {}), status: 'rejected' }], { copied: true })
    }
  }

  /**
   * A turn stopped by a limit with no window that blocks its account: Kernel records a temporary rejected 5-hour window,
   * which lifts by the usual rule, and reads the account's usage once to learn the real one (KERNEL-1030).
   */
  private limitUnknown(chat: Chat, live: Live) {
    if (live.onKey || this.limitHolds(chat, live)) return
    const provider = chatProvider(chat)
    console.info(`[limits] temporary window for ${provider}:${live.account ?? 'cli'}`)
    this.mergeLimits([{ type: 'five_hour', status: 'rejected', provisional: true, provider, ...(live.account ? { accountId: live.account } : {}) }])
    this.d.readUsageNow?.(provider, live.account)
  }

  /** The accounts with a rejected account-wide window, as `provider:accountId` (an empty id is the CLI's own login). */
  rejectedAccounts(): Set<string> {
    return new Set([...this.limits.values()].filter((l) => isRejected(l)).map((l) => `${limitProvider(l)}:${l.accountId ?? ''}`))
  }

  private pushLimits() {
    const limits = [...this.limits.values()]
    bus.push({ type: 'usage', limits })
    this.d.onLimits?.(limits)
    // A model's own limit lifting pauses and resumes no project, so its chats carry on from here. So does what a usage window
    // close to its limit held: a drop in usage or a reset sends it, and a rise holds the queues again (KERNEL-220).
    this.drainWaiting()
  }

  private clearRetry(chatId: string, live: Live) {
    if (!live.retry) return
    live.retry = undefined
    bus.push({ type: 'retry', chatId, retry: null })
  }

  /**
   * Saves what the turn that just ended read and cached as the chat's `lastTurn` (KERNEL-842), on the account its process
   * runs on. A turn its runner reported nothing for keeps the last one. `context` falls back to /context's numbers.
   */
  private recordTurn(chat: Chat, live: Live): Chat {
    const u = live.usage
    live.usage = undefined
    if (!u) return chat
    const email = this.d.emailOf?.(chatProvider(chat), live.account)
    const context = u.context ?? chat.contextUsage?.used ?? u.input + u.cacheRead + u.cacheWrite
    const lastTurn: LastTurn = { at: Date.now(), account: live.account ?? 'cli', ...(email ? { email } : {}), model: chat.model, context, input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, ...(u.first ? { first: u.first } : {}) }
    const next = { ...chat, lastTurn }
    this.d.store.saveChat(next)
    bus.push({ type: 'chat', chat: next })
    return next
  }

  /** Context window use, saved on the chat for the composer and the banner. Nothing changes when the numbers are the same. */
  private setContext(chatId: string, context: number, contextUsage: Chat['contextUsage']) {
    const chat = this.d.store.chat(chatId)
    if (!chat) return
    if (chat.context === context && JSON.stringify(chat.contextUsage) === JSON.stringify(contextUsage)) return
    const next = { ...chat, context, contextUsage }
    this.d.store.saveChat(next)
    bus.push({ type: 'chat', chat: next })
  }

  /** A paused project shows everyone as paused, except an agent waiting on the user, blocked by a hook or offline. */
  private setStatus(ws: Workspace, agent: AgentDef | undefined, status: AgentStatus) {
    const shown = this.paused.has(ws.projectId) && !PAUSE_KEEPS.has(status) ? 'paused' : status
    if (agent) bus.push({ type: 'agent.status', projectId: ws.projectId, agentId: agent.id, status: shown })
  }

  /** The session ended without being stopped: the agent goes offline and the logs say where and why. */
  private offline(ws: Workspace, reason: string) {
    const detail = `Claude Code exited in ${ws.name}${reason ? ` (${reason.slice(0, 120)})` : ''}. The worktree and chat are saved.`
    this.setStatus(ws, this.d.agentFor(ws), 'offline')
    bus.activity({ kind: 'session.end', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, text: 'went offline in', object: ws.name, warn: true, data: { detail, crashed: true } })
  }

  /** A hook exited with code 2: it refused the step. The agent shows as blocked with the hook's own words. */
  private blocked(ws: Workspace, chatId: string, event: string, output: string) {
    this.turnsOf(chatId).blocked = event
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4)
    this.showBlocked(ws, chatId)
    bus.activity({
      kind: 'agent.status', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, text: 'was blocked on', object: ws.name, warn: true,
      data: { status: 'blocked', detail: `The ${event} hook refused the last step. Read its output, then fix it or ask the agent to.`, output: lines.length ? lines : undefined }
    })
  }

  /**
   * Shows the agent as blocked while a hook's refusal stands. False when nothing blocks it.
   * Blocked is kept per chat but shown per agent, so an agent with a blocked chat and a working one shows whichever pushed last.
   */
  private showBlocked(ws: Workspace, chatId: string): boolean {
    const blocked = this.turns.get(chatId)?.blocked
    if (!blocked) return false
    this.setStatus(ws, this.d.agentFor(ws), 'blocked')
    return true
  }

  private unblock(chat: Chat, ws: Workspace) {
    this.turnsOf(chat.id).blocked = undefined
    this.setStatus(ws, this.d.agentFor(ws), chat.plan ? 'planning' : 'working')
  }

  private item(chat: Chat, item: ChatItem) {
    this.d.store.saveItem(chat.id, item)
    bus.push({ type: 'chat.item', chatId: chat.id, item })
  }

  /**
   * Put an approval card in the chat's transcript, so it stays there after it is answered and across restarts. The chat's
   * process keeps its id, so the card ends with the turn or the process that asked. A Codex plan that waits after its turn
   * (`afterTurn`) is kept on the chat instead (KERNEL-563).
   */
  placeApproval(chatId: string, approvalId: string, o: { afterTurn?: boolean } = {}) {
    this.item(this.mustChat(chatId), { kind: 'approval', id: `approval-${approvalId}`, ts: Date.now(), approvalId })
    if (o.afterTurn) (this.turnsOf(chatId).plans ??= new Set()).add(approvalId)
    else this.live.get(chatId)?.cards.add(approvalId)
  }

  /**
   * The user's answer to a plan, question or agent card, as their own message after the card (KERNEL-836). It is only a row:
   * the agent gets the decision itself, never this. A tool permission, or a card with no answer, adds nothing. The id is
   * the approval's, so a second settle replaces the row instead of adding one. A closed or deleted chat gets nothing.
   */
  placeAnswer(a: Approval) {
    const parts = answerParts(a)
    const chat = a.chatId ? this.d.store.chat(a.chatId) : undefined
    if (!parts || !chat || chat.closed) return
    this.item(chat, { kind: 'user', id: answerItemId(a.id), ts: Date.now(), parts, approvalId: a.id })
  }

  /** Where a shared file's card sits in the chat that shared it, one per version (KERNEL-302). */
  placeShared(chatId: string, sharedId: string, version: number) {
    this.item(this.mustChat(chatId), { kind: 'shared', id: `shared-${sharedId}-v${version}`, ts: Date.now(), sharedId, version })
  }

  private mustChat(id: string) { const c = this.d.store.chat(id); if (!c) throw new Error(`Unknown chat ${id}`); return c }
  private mustWorkspace(id: string) { const w = this.d.store.workspace(id); if (!w) throw new Error(`Unknown workspace ${id}`); return w }
}

export function agentPrompt(agent: AgentDef | undefined, ws: Workspace, rule?: string): string {
  // Before KERNEL-405 the Lead's shared worktree was detached, on no branch. Each Lead chat now has a branch of its own.
  const where = ws.shared
    ? `You are working in the folder Kernel keeps for this project's chats, at ${ws.path}, detached at ${ws.baseRef}, not on a branch. Other chats work there too, and Kernel keeps it on the latest main. It is not the main checkout, which the user may be running. Stay inside it.`
    : ws.lead && ws.mode === 'worktree' && ws.branch === 'HEAD'
    ? `You are working in your own git worktree at ${ws.path}, detached at ${ws.baseRef}, not on a branch. It is not the main checkout, which the user may be running. Stay inside it.`
    : ws.mode === 'worktree'
    ? `You are working in a git worktree at ${ws.path} on branch ${ws.branch}, created from ${ws.baseRef}.${ws.lead ? ' It is not the main checkout, which the user may be running.' : ''} Stay inside it. Push with \`git push -u origin ${ws.branch}\` (or \`HEAD\`), never a bare \`git push\`.`
    : `You are working directly in the main checkout at ${ws.path} on ${ws.branch}. Some files already had changes before you started; never commit those unless asked.`
  const port = ws.shared ? undefined : `If you start a dev server, use port ${ws.port} ($KERNEL_PORT).`
  return [agent?.prompt, agent?.lead && LEAD_RULE, rule, where, port].filter(Boolean).join('\n\n')
}

/** What Restart session sends, after any messages held for the chat. */
export const RESTART_NUDGE = 'Your session ended unexpectedly. Check the worktree and pick up where you left off.'

/** Statuses a pause leaves showing: the user still has to act on them. */
export const PAUSE_KEEPS = new Set<AgentStatus>(['needs', 'blocked', 'offline'])

/** What Kernel sends a chat a usage limit stopped, once the limit lifts. */
export const LIMIT_LIFTED = 'The usage limit that stopped you no longer applies. Pick up where you left off.'

/** What Kernel sends a chat whose turn stopped because the account it ran on was removed (KERNEL-941). */
export const ACCOUNT_LEFT = 'Your last step stopped because the account it ran on was removed from Kernel, so it may not have finished. Check the worktree and what you already did before you redo anything, then carry on.'

/** What Kernel sends a chat whose turn was running when Kernel quit or closed, once it opens again (KERNEL-215). */
export const RELAUNCH_NUDGE = 'Kernel closed while you were working, so your last step may not have finished. Check the worktree and what you already did (git status, open PRs, workspaces you handed off) before you redo anything, then carry on.'

/** Why a chat that carries on after a relaunch stopped, as `onExit` reports it: a quit, or a crash or a force quit. */
/** The note when Bypass permissions waits for the running turn, and what it says once Bypass is turned off again before that (KERNEL-809). */
export const BYPASS_WAITS = 'Bypass permissions starts once this turn ends.'
export const BYPASS_OFF_AGAIN = 'Bypass permissions was turned off before this turn ended.'

export const QUIT_REASON = 'Kernel quit'
export const CRASH_REASON = 'Kernel closed unexpectedly'

/** The note in a chat whose turn a quit cut off, and the one after a crash or a force quit. */
export const QUIT_NOTE = 'Kernel quit while this agent was working.'
export const CRASH_NOTE = 'Kernel closed unexpectedly while this agent was working.'
/** The notes when the turn waited on a tool permission or a question, which ended with it. */
export const QUIT_WAIT_NOTE = 'Kernel quit while this agent was waiting for your answer, so the request ended.'
export const CRASH_WAIT_NOTE = 'Kernel closed unexpectedly while this agent was waiting for your answer, so the request ended.'

/** The tools that put a plan card up: Claude's ExitPlanMode and the Lead's request_plan_approval. */
const isPlanTool = (name: string) => name === 'ExitPlanMode' || name === 'mcp__kernel__request_plan_approval'

/** The note in a chat whose session was gone, so Kernel started a new one. */
export const SESSION_GONE_NOTE = "Kernel started a new session because the old one is gone. The agent doesn't remember earlier turns in this chat."

/** How the nudge a fresh session gets in place of a restart, limit or relaunch nudge starts (KERNEL-286). */
export const FRESH_NUDGE = "Your earlier session in this chat is gone, so you don't remember anything from it."

/** The fresh-session nudge: what the agent lost, the chat's brief when there is one, and where to look before carrying on. */
export function freshNudge(brief?: string): string {
  return [
    FRESH_NUDGE,
    ...(brief ? [`The chat started with this message:\n\n${brief}`] : []),
    'Before you carry on, check the worktree to see what you already did: git status, git log and any open PR.'
  ].join('\n\n')
}

/** How long a quit waits for interrupted turns to end before it stops their processes. */
export const QUIT_BUDGET_MS = 3000

/** Every provider, for the holds that name one. */
const PROVIDER_IDS: Provider[] = ['claude', 'codex']

/** Meta keys Sessions saves itself: the working journal, every queue that isn't held, and the pids of live processes. */
const WORKING = 'working'
const QUEUES = 'queues'
const PIDS = 'claudePids'

/** How much of a process's stderr Kernel keeps for the error note. */
const STDERR_KEPT = 4000

/** Kernel's restart, limit, relaunch and fresh-session nudges, which carry on a turn rather than start one. */
export const isNudge = (parts: ChatPart[]) => parts.length === 1 && parts[0].type === 'text' && (parts[0].text === RESTART_NUDGE || parts[0].text === LIMIT_LIFTED || parts[0].text === RELAUNCH_NUDGE || parts[0].text.startsWith(FRESH_NUDGE))

/**
 * The leading run of a queue that goes out as a chat's first turn. A message with a skill chip goes alone, since Claude Code
 * reads a slash command only at the start of a message (D-030), and so does a Kernel nudge. Either ends the run, and the rest
 * go in the turns after it. When the first message is one of them, it is the whole run.
 */
const firstTurn = (queue: QueuedMessage[]): QueuedMessage[] => {
  const alone = (m: QueuedMessage) => m.parts.some((p) => p.type === 'skill') || (m.from === 'kernel' && isNudge(m.parts))
  if (alone(queue[0])) return queue.slice(0, 1)
  const end = queue.findIndex((m, at) => at > 0 && alone(m))
  return end < 0 ? queue : queue.slice(0, end)
}

/**
 * The process is alive and was started the way Kernel saved: its binary and first argument. Matching the first argument
 * too keeps a reused pid running `node something-else` from passing for `node cli.js`. An exited one (`(claude)`) is not.
 */
function runs(p: SavedPid): Promise<boolean> {
  const started = [p.command, p.arg].filter(Boolean).join(' ')
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-p', String(p.pid), '-o', 'command='], (err, out) => {
      const line = out.trim()
      resolve(!err && !!p.command && (line === started || line.startsWith(`${started} `)))
    })
  })
}

/** A negative pid is a process group. False when nothing got the signal: it is already gone. */
function signal(pid: number, sig: NodeJS.Signals | 0): boolean { try { process.kill(pid, sig); return true } catch { return false } }
