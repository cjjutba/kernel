import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { isRunName, RUN_SCRIPT_NAME, type AgentChangePr, type AgentDef, type AgentReach, type AgentScope, type Approval, type AskedQuestion, type ChatPart, type Decision, type IssueTaken, type PrState, type QueueReason, type RoomSettingsPatch, type Workspace, type WorkspaceMode } from '@shared/types'
import { isLeadWorkspace } from '@shared/leadWorkspace'
import { blockedWhy, headBlockers, notMergeable, reviewsText } from '@shared/merge'
import { isReviewer, RESERVED_AGENT_IDS, takesTasks } from '@shared/team'
import { bus } from '../bus'
import { kernelServer } from './kernelServer'
import { canOpenPr } from './agentTools'
import { agentFromFile, hireDefaults, renderAgentFile } from './agents'
import { HANDOFF_NOW } from './handoff'
import { firstLine } from './text'
import { archiveSkip, CLOSED_PR } from './archiveGuard'
import { isMerged, joinLabels, waitLabel, waitRefusal, waitTargets } from './waits'
import { trackerName } from './trackers'
import { convertScriptVariables, SCRIPT_VARIABLES } from './scriptImport'

export interface KernelToolDeps {
  roomId: string
  lead: AgentDef | undefined
  /** The Lead tab these tools belong to. Workspaces it hands off report back to it (KERNEL-105). */
  chatId?: string
  /** The name of the Lead chat a tab is in, for work another chat handed off. */
  chatTitle?: (chatId: string) => string | undefined
  /** Whether a tab is in the same Lead chat as this one, whose work is this tab's too (KERNEL-337). Left out, only this tab is. */
  ownTab?: (chatId: string) => boolean
  /** Plans approved in every tab of this tab's Lead chat, newest first: the tab's title, when it was asked for, and the plan (KERNEL-337). */
  plans?: () => { tab: string; at: number; plan: string }[]
  agents: () => Promise<AgentDef[]>
  workspaces: () => Workspace[]
  /**
   * `setupFailed` says how setup failed, when it did ("exit code 1"), and `queued` what the brief waits for when it didn't
   * go out (KERNEL-272), so the result can tell the Lead the teammate hasn't started.
   */
  createWorkspace: (o: { prompt: string; agentId: string; mode?: WorkspaceMode; baseRef?: string; title?: string; branch?: string; reviewOf?: string; linkReviewOf?: string; issue?: string; waitFor?: string[]; images?: ChatPart[]; goAhead?: string }) => Promise<Workspace & { setupFailed?: string; queued?: QueueReason }>
  /**
   * How many teammate workspaces may be open in the room at once, read on each call: the room's own limit when it sets one,
   * else Settings, Models' agent limit. 0 is no cap, and so is leaving it out (KERNEL-220, KERNEL-492).
   */
  agentCap?: () => Promise<OpenCap>
  /**
   * Whether someone else may already be on the issue: a branch on the remote, an open PR, another assignee (KERNEL-479).
   * Never rejects: a check that can't answer is a note. Left out, create_workspace doesn't check.
   */
  issueTaken?: (issue: string) => Promise<IssueTaken>
  /**
   * Sends the Lead's message into a teammate's workspace. `ok` is false when it was refused; `sent` is true when it went out
   * now rather than waiting in a queue; `note` says what happened.
   */
  messageWorkspace: (workspaceId: string, text: string, images?: ChatPart[]) => Promise<{ ok: boolean; sent?: boolean; note: string }>
  /**
   * The images the user attached in the Lead's chat that the Lead named, by path, as chat parts scaled down for the model.
   * Rejects with the reason one can't go. Left out, create_workspace and message_agent refuse images (KERNEL-658).
   */
  attachedImages?: (paths: string[]) => Promise<ChatPart[]>
  /**
   * One version of an image a teammate shared with share_file, by its id and version, as a chat part scaled down for the
   * model. Rejects with the reason it can't go. Left out, create_workspace and message_agent refuse shared images (KERNEL-659).
   */
  sharedImage?: (id: string, version: number) => Promise<ChatPart>
  /**
   * `steps` and `agentFile` shape plan and new agent cards; the hand-off links come from `onWorkspace`. `questions` carries a
   * question's options with their descriptions, as AskUserQuestion's do (KERNEL-407). `signal` is the tool call's: when the
   * turn stops, as when the user writes in the message box instead, the card ends as expired and the answer is null (KERNEL-496).
   */
  askUser: (o: { kind: 'plan' | 'question' | 'agent'; title: string; detail?: string; options?: string[]; questions?: AskedQuestion[]; steps?: string[]; agentFile?: Approval['agentFile'] }, signal?: AbortSignal) => Promise<Decision | null>
  /** Saves the Lead's new agent: the file it wrote for `me`, or the pull request that adds it for `team` (KERNEL-466). */
  hireAgent: (o: { id: string; description: string; prompt: string; model?: string; tools?: string[]; role?: string }, scope?: AgentScope) => Promise<string | AgentChangePr>
  /**
   * The MCP servers an agent can reach in the room, and the ones its tools line names that it can't use. `wait` waits for
   * the room's first check. Left out, create_agent says nothing about servers (KERNEL-476).
   */
  reach?: (agent: AgentDef, o?: { wait?: boolean }) => Promise<AgentReach>
  /** Archives with the user's Settings for the branch, as the sidebar does (KERNEL-93). */
  archiveWorkspace: (workspaceId: string) => Promise<void>
  /** Merges the workspace's PR as the Merge button does, refusing with the reason when it can't merge (KERNEL-349). */
  mergeWorkspace?: (workspaceId: string) => Promise<Workspace>
  /** Overrules the reviews' blockers on the PR's head commit for the user, refusing with the reason when nothing blocks it (KERNEL-732). Left out, overrule_blockers refuses. */
  overrule?: (workspaceId: string, note?: string) => Workspace | Promise<Workspace>
  /** Whether Settings, Pull requests lets the Lead merge. Read on each call, since the Lead's tools are built once. Left out, it can't (KERNEL-352). */
  leadMerge?: () => boolean
  /** Whether the user started the Lead's current turn, rather than Kernel. Left out, Kernel did. */
  userTurn?: () => boolean
  /**
   * The text of the user's latest message in this chat and when they sent it, not Kernel's. With plan mode off, create_workspace
   * checks the Lead's go_ahead quote against it. Left out, create_workspace doesn't check (KERNEL-678).
   */
  userSaid?: () => { text: string; at: number } | undefined
  /** Sets what the workspace waits for, by workspace id; an empty list ends the wait and starts a held brief (KERNEL-259). */
  setWait?: (workspaceId: string, on: string[]) => Promise<Workspace>
  /** The room's remote and the base a hand-off from `baseRef` starts from, so a wait across bases is refused (KERNEL-693). Left out, bases aren't compared. */
  handoffBase?: (baseRef?: string) => Promise<{ remote: string; base: string }>
  /** Reads the PR from GitHub and saves its state, so a merge Kernel missed doesn't block archive (KERNEL-109). Left out, the saved state decides. */
  refreshPr?: (workspaceId: string) => Promise<Workspace>
  /** Whether any of the workspace's chats is running a turn. */
  isRunning: (workspaceId: string) => boolean
  /** Whether archiving would lose uncommitted work: 'dirty', 'unknown' when git can't tell, or false. */
  unsaved: (workspaceId: string) => Promise<'dirty' | 'unknown' | false>

  /** Whether the Lead chat is in plan mode now. Read on each call, since the toggle can change mid-session. Left out, it counts as off (KERNEL-176). */
  planMode?: () => boolean
  /**
   * The user approved a plan, and a workspace was created. Together they hold the Lead to the hand-off (KERNEL-67). An approval
   * also ends plan mode (D-074), and returns the approval's note with the plan's path, for the tool's result.
   */
  planApproved?: () => string | void | Promise<string | void>
  handedOff?: () => void
  /**
   * The Lead acted on what the chat owes (KERNEL-745, KERNEL-749): message_agent reached `messaged`, create_workspace handed
   * work to the agent `created`, or ask_user asked the user about the workspace or agent ids in `asked`, none for the
   * teammates the user addressed.
   */
  acted?: (a: { messaged: Workspace } | { created: string } | { asked: string[] }) => void
  /** What list_workspaces adds after each workspace this chat owes something, by id (KERNEL-749). Left out, nothing. */
  openMarks?: () => Map<string, string>
  /** Saves set_room_scripts' patch to the room's `.kernel/settings.local.toml` as Settings does. Left out, the tool refuses (KERNEL-683). */
  saveRoomScripts?: (patch: RoomSettingsPatch) => Promise<unknown>
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** The abort signal of a tool call, from the handler's `extra`. Claude Code cancels the call when the turn is interrupted (KERNEL-496). */
const signalOf = (extra: unknown) => {
  const signal = (extra as { signal?: unknown } | undefined)?.signal
  return signal instanceof AbortSignal ? signal : undefined
}

/** The most images one create_workspace or message_agent call passes on (KERNEL-658, docs/decisions/KERNEL-658.md). */
export const IMAGES_MAX = 3

/** The `images` argument of create_workspace and message_agent (KERNEL-658). */
const imagesArg = z.array(z.union([
  z.object({ path: z.string().describe('The image\'s path in .kernel/attachments/, as the user\'s message names it') }),
  // An image a teammate shared, at the version the Team update names (KERNEL-659).
  z.object({ shared: z.string().describe('The id of an image a teammate shared, as the Team update names it'), version: z.number().int().describe('Which version of it to pass on') })
])).optional()
type ImageArg = { path: string } | { shared: string; version: number }

/** What the `images` argument says, for both tools. */
const IMAGES_DESCRIBE = 'Images the teammate needs to act on, at most 3 in all: a screenshot the user attached in this chat by its path in .kernel/attachments/, or an image a teammate shared by its id and version from the Team update. Kernel copies each into the teammate\'s workspace and shows it in their chat. Leave out images that don\'t change what the teammate does'

/**
 * The images a create_workspace or message_agent call passes on, in the order given, or why one can't go (KERNEL-658,
 * KERNEL-659). The cap is checked here, across both kinds, so it holds whatever the deps do. Every image is read before
 * any is returned, so a refused one sends nothing.
 */
async function loadImages(d: KernelToolDeps, images: ImageArg[] | undefined): Promise<{ parts: ChatPart[] } | { refusal: string }> {
  if (!images?.length) return { parts: [] }
  if (images.length > IMAGES_MAX) return { refusal: `${images.length} images is over the limit of ${IMAGES_MAX}. Send only the ones the teammate needs to act on.` }
  const paths = images.flatMap((i) => ('path' in i ? [i.path] : []))
  if (paths.length && !d.attachedImages) return { refusal: 'images can\'t be passed on here.' }
  if (paths.length < images.length && !d.sharedImage) return { refusal: 'shared images can\'t be passed on here.' }
  try {
    const attached = paths.length ? await d.attachedImages!(paths) : []
    const parts: ChatPart[] = []
    for (const i of images) parts.push('path' in i ? attached.shift()! : await d.sharedImage!(i.shared, i.version))
    return { parts }
  } catch (e) { return { refusal: e instanceof Error ? e.message : String(e) } }
}

/**
 * The open-workspace cap create_workspace checks, 0 for none. `own` is true when the room's `[agents] open_workspaces` sets
 * it, and `room` is the room's name, so the refusal can say where to change it (KERNEL-492).
 */
export interface OpenCap { cap: number; own: boolean; room: string }

/** create_workspace's refusal at the cap, naming the setting that gave it. `user_asked` is the way past it, for a user who asked for more. */
export function capRefusal(open: number, { cap, own, room }: OpenCap): string {
  const count = `${open} teammate ${open === 1 ? 'workspace is' : 'workspaces are'} open in this room`
  const where = own ? `change it in Settings, ${room}, Agents` : `raise Agents working at once in Settings, Models and effort, or set this room's own limit in Settings, ${room}, Agents`
  return `${count}${open === cap ? ', the limit' : `, over the limit of ${cap}`}. Archive one, or the user can ${where}.`
}

/** Why a brief or message waits, and when it goes out, for the reasons that hold a whole chat rather than one turn. */
const WAITS: Partial<Record<QueueReason, { because: string; until: string }>> = {
  capacity: { because: 'Every agent slot in Settings, Models is in use', until: 'when a slot frees up' },
  paused: { because: 'The room is paused', until: 'when the user resumes it' },
  offline: { because: 'Kernel is offline or signed out', until: 'once it is back' },
  limit: { because: 'Usage is close to the limit', until: 'when it resets or usage drops' }
}

/**
 * What create_workspace and message_agent tell the Lead when the agent limit, a paused room or being offline holds what
 * they sent, so both tools use the same words (KERNEL-272). A brief also says the teammate hasn't started. Nothing for
 * other reasons, which each tool words itself.
 */
export function queuedNote(why: QueueReason | undefined, o: { name: string; brief?: boolean }): string | undefined {
  const w = why && WAITS[why]
  if (!w) return undefined
  return o.brief ? `${w.because}, so ${o.name} hasn't started. The brief goes out ${w.until}.` : `${w.because}, so the message goes out ${w.until}.`
}

/**
 * create_workspace's warning when someone else may already be on the issue (KERNEL-479). It names what Kernel found, and the
 * Lead asks the user before it passes confirm. A notes line says which checks couldn't answer.
 */
export function takenWarning(issue: string, t: IssueTaken): string {
  const found = t.findings.map((f) => (f.kind === 'branch' ? `the branch ${f.ref}` : f.kind === 'pr' ? `the open PR #${f.number} (${f.title})` : `${f.name} assigned to it`))
  const notes = t.notes.length ? ` ${t.notes.join(' ')}` : ''
  return `Not created: someone else may already be on ${issue}. Kernel found ${joinLabels(found)}.${notes} Tell the user what Kernel found and ask whether to start anyway. If they say yes, call create_workspace again with confirm: true.`
}

/** request_plan_approval's refusal in a chat that isn't in plan mode (KERNEL-176, KERNEL-678). */
export const PLAN_MODE_OFF = "Not asked: plan mode is off, so there is no plan to approve. Propose who gets what in one yes-or-no question, and hand off only on a go-ahead that raises nothing new, quoted in go_ahead. If the reply also asks questions, changes scope or only agrees with the idea, answer it and ask once."

/** create_workspace's refusal with plan mode off when go_ahead is missing or isn't in the user's latest message (KERNEL-678). */
export const NO_GO_AHEAD = "Not handed off: quote the user's go-ahead from their latest message, or ask them first."

/** Whether `quote` appears in what the user said, ignoring case and whitespace (KERNEL-678). An empty quote never does. */
export function quotesUser(quote: string | undefined, said: string | undefined): boolean {
  const flat = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  const q = flat(quote ?? '')
  return !!q && flat(said ?? '').includes(q)
}

/** request_plan_approval's refusal when it gets task lines without the write-up (KERNEL-373). */
export const NO_PLAN = 'Not asked: plan is missing. Pass the full plan as markdown in plan (context, approach, files, checks) and one line per task in steps, then call request_plan_approval again.'

/** The longest option label ask_user takes (KERNEL-415). */
export const LABEL_MAX = 60

/** merge_workspace's refusals: the switch in Settings is off, or Kernel started the turn (KERNEL-352). */
export const MERGE_OFF = 'Merging is off in Settings, Pull requests. Tell the user they can merge from the PRs tab.'
export const MERGE_NOT_ASKED = 'Only the user can ask you to merge. Tell them which PRs are ready.'

/** overrule_blockers' refusal when the user's latest message doesn't hold go_ahead, or Kernel started the turn (KERNEL-732). */
export const NO_OVERRULE = "Not overruled: only the user can overrule a review's blockers. Quote their words from their latest message in go_ahead, or tell them what the reviews found and ask."

/** Why merge_workspace skips a PR in this state, shared with Merge all (KERNEL-411). */
const NOT_MERGEABLE = notMergeable

/**
 * The agent `asked` names: its exact id, else the one whose id or name matches ignoring case. A miss or a name two
 * agents share comes back as the tool's refusal, listing who takes tasks, so the Lead can try again with a real id
 * (KERNEL-119). `reason` is what Kernel counts (KERNEL-397).
 */
export function pickAgent(team: AgentDef[], asked: string): AgentDef | { refusal: string; reason: 'unknown' | 'ambiguous' | 'no-teammates' } {
  const exact = team.find((a) => a.id === asked)
  if (exact) return exact
  const want = asked.trim().toLowerCase()
  const found = team.filter((a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want)
  if (found.length === 1) return found[0]
  if (found.length > 1) return { reason: 'ambiguous', refusal: `Not created: "${asked}" matches more than one agent (${found.map((a) => a.id).join(', ')}). Use the id from list_agents.` }
  const list = takers(team)
  return list
    ? { reason: 'unknown', refusal: `Not created: no agent "${asked}" on this team. Use an id from list_agents: ${list}.` }
    : { reason: 'no-teammates', refusal: NO_TEAMMATES }
}

/** The agents the Lead can hand a task to, as refusals list them. */
const takers = (team: AgentDef[]) => team.filter((a) => !a.lead && takesTasks(a)).map((a) => `${a.id} (${a.name}, ${a.role})`).join(', ')

/** create_workspace's refusal in a room where nobody takes tasks (KERNEL-554). */
export const NO_TEAMMATES = 'Not created: this team has no teammates yet. Ask the user whether to create one with create_agent or to add a starter agent in Team, and build nothing yourself.'

/** What list_agents adds after an agent's role: who leads and who reviews (KERNEL-397). */
function roleTag(a: AgentDef): string {
  if (a.lead) return ' (the Lead, you)'
  if (isReviewer(a)) return takesTasks(a) ? ' (reviews PRs, takes tasks)' : ' (reviews PRs)'
  return ''
}

/**
 * list_agents' answer: the Lead, the reviewer and every member in full, then the helpers as one line of names, so a room with
 * 30 plugin agents doesn't fill the Lead's prompt (KERNEL-554). With no member it says how to get one.
 */
export function agentList(team: AgentDef[]): string {
  const full = team.filter((a) => a.lead || isReviewer(a) || takesTasks(a))
  const helpers = team.filter((a) => !full.includes(a))
  const lines = full.map((a) => `${a.id}: ${a.name}, ${a.role}${roleTag(a)}. ${a.description}`)
  if (helpers.length) lines.push(`Helpers, which don't take tasks: ${helpers.map((a) => a.name).join(', ')}.`)
  if (!team.some((a) => !a.lead && takesTasks(a))) lines.push('Nobody on this team takes tasks yet. Before planning work, ask the user whether to create an agent with create_agent or to add a starter agent in Team.')
  return lines.join('\n')
}

/** Where create_agent's new agent landed on the team, as the room resolved it (KERNEL-476). */
function joinedNote(a: AgentDef | undefined, id: string): string {
  if (!a) return `${id} joins the team.`
  if (isReviewer(a)) return `${a.name} joins the team and reviews PRs${takesTasks(a) ? ' and takes tasks' : ''}.`
  if (takesTasks(a)) return `${a.name} joins the team and takes tasks.`
  if (!canOpenPr(a.tools, a.disallowedTools)) return `${a.name} joins as a helper and doesn't take tasks. To open a PR, its tools need Bash, and Edit or Write. The user can add them on ${a.name}'s profile in Team.`
  return `${a.name} joins as a helper and doesn't take tasks.`
}

const BLOCKED: Record<AgentReach['blocked'][number]['why'], string> = {
  failed: 'failed to connect',
  'needs-auth': 'needs the user to sign in with /mcp in Claude Code',
  disabled: 'is switched off in Claude Code, and /mcp turns it on',
  off: 'is switched off in this room, in Settings, under the room, Skills and MCP',
  missing: 'is not a server in this room'
}

/** The MCP servers create_agent's new agent can reach, and the ones its file names that it can't use (KERNEL-476). */
function reachNote(name: string, r: AgentReach): string {
  const out = [r.reach.length ? `MCP servers ${name} can reach: ${r.reach.join(', ')}.` : `${name} can reach no MCP servers besides Kernel's own.`]
  if (r.blocked.length) {
    const many = r.blocked.length > 1
    out.push(`${name} can't use ${many ? `${r.blocked.length} servers` : 'a server'} its file names.`)
    for (const b of r.blocked) out.push(`${b.name} ${BLOCKED[b.why]}${b.suggestion ? `, but ${b.suggestion} may be the one it means` : ''}.`)
    out.push(`Don't hand ${name} work that needs ${many ? 'those' : 'it'} until the user fixes that.`)
  }
  return out.join(' ')
}

/** Kernel's variables and the Conductor and Superset names that become each, for set_room_scripts' description. */
const VARIABLE_TABLE = [...new Set(Object.values(SCRIPT_VARIABLES))].map((to) => {
  const from = Object.keys(SCRIPT_VARIABLES).filter((name) => SCRIPT_VARIABLES[name] === to)
  return `${joinLabels(from.map((name) => `$${name}`))} ${from.length > 1 ? 'become' : 'becomes'} $${to}`
}).join(', ')

/** set_room_scripts' description, which holds how to read a pasted Conductor or Superset config (KERNEL-683). */
export const SET_ROOM_SCRIPTS_DESCRIBE = [
  "Save this room's scripts to .kernel/settings.local.toml on the user's Mac. The user sees every script in full on a card, after Kernel renames variables, and nothing is written unless they press Save.",
  'Pass only what changes. setup runs once when a workspace is made, run starts the app, archive runs when a workspace is archived, run_scripts adds run scripts by name, and run_mode says whether run scripts run in every workspace at once (concurrent) or in one workspace at a time (single).',
  'Commands are non-interactive, non-destructive and safe in a git worktree. A run script takes its port from $KERNEL_PORT.',
  `Kernel renames Conductor's and Superset's variables: ${VARIABLE_TABLE}. Any other CONDUCTOR_* or SUPERSET_* name stays as written, and the result names it.`,
  "Reading a pasted config: Conductor's conductor.json has scripts.setup, scripts.run and scripts.archive, and runScriptMode nonconcurrent is run_mode single.",
  "Conductor's .conductor/settings.toml has setup, run, archive and run_mode (nonconcurrent is single) under [scripts]. Each [scripts.run.<id>] table is a run script: command, then args, with cd <options.cwd> && first when it has one. The one with default = true, or the only one, is run, and the rest go in run_scripts under their id. Leave out one with hide = true or whose available_in lacks local.",
  "Superset's .superset/config.json has setup, teardown and run as lists of commands: join each list with &&, put cd <cwd> && first when it has a cwd, and teardown is archive."
].join(' ')

/** The patch set_room_scripts saves, and what its card shows: each script after conversion, exactly as saved. */
function roomScripts(a: { setup?: string; run?: string; archive?: string; run_scripts?: Record<string, string>; run_mode?: 'concurrent' | 'single' }): { refusal: string } | { patch: RoomSettingsPatch; card: string; saved: string[]; renamed: string[]; unknown: string[] } {
  const named = Object.entries(a.run_scripts ?? {})
  const bad = named.find(([name]) => isRunName(name) || !RUN_SCRIPT_NAME.test(name))
  if (bad) return { refusal: isRunName(bad[0]) ? 'pass the main run script as run, not in run_scripts.' : `"${bad[0]}" can't name a run script. Use up to 32 letters, digits, - and _, starting with a letter or digit.` }
  const asked: { label: string; text: string; put: (patch: RoomSettingsPatch, text: string) => void }[] = [
    ...(['setup', 'run', 'archive'] as const).flatMap((key) => (a[key] === undefined ? [] : [{ label: `${key[0].toUpperCase()}${key.slice(1)} script`, text: a[key]!, put: (p: RoomSettingsPatch, t: string) => { p.scripts = { ...p.scripts, [key]: t } } }])),
    ...named.map(([name, text]) => ({ label: `Run script "${name}"`, text, put: (p: RoomSettingsPatch, t: string) => { p.runScripts = { ...p.runScripts, [name]: t } } }))
  ]
  const empty = asked.find((s) => !s.text.trim())
  if (empty) return { refusal: `${empty.label} is empty. Leave out a script you don't change.` }
  if (!asked.length && !a.run_mode) return { refusal: 'pass at least one script, or run_mode.' }
  const patch: RoomSettingsPatch = {}
  const renamed = new Set<string>()
  const unknown = new Set<string>()
  const card: string[] = []
  for (const s of asked) {
    const c = convertScriptVariables(s.text.trim())
    c.renamed.forEach((n) => renamed.add(n))
    c.unknown.forEach((n) => unknown.add(n))
    s.put(patch, c.script)
    card.push(`${s.label}\n${c.script}`)
  }
  if (a.run_mode) {
    patch.scripts = { ...patch.scripts, runMode: a.run_mode }
    card.push(`Run mode\n${a.run_mode === 'single' ? 'One at a time' : 'Concurrent'}`)
  }
  const saved = [...asked.map((s) => s.label.replace(/^[A-Z]/, (c) => c.toLowerCase())), ...(a.run_mode ? [`run mode ${a.run_mode}`] : [])]
  return { patch, card: card.join('\n\n'), saved, renamed: [...renamed].sort(), unknown: [...unknown].sort() }
}

/** The question on set_room_scripts' card, and its answers (KERNEL-683). */
export const SAVE_SCRIPTS_QUESTION = 'Save these scripts to .kernel/settings.local.toml?'
const SAVE = 'Save'

/** What the Lead's server tells the model, next to the tools. */
export const LEAD_INSTRUCTIONS = 'You lead a team of agents in Kernel. While the chat is in plan mode, plan first and ask for approval with request_plan_approval: the full plan as markdown in plan, and one line per task in steps, which plan doesn\'t repeat. Once the user approves, hand each task to one teammate with create_workspace in the same turn. With plan mode off, propose who gets what in one yes-or-no question, and call create_workspace only on a go-ahead that raises nothing new, quoted in go_ahead. Answer a reply that also asks questions, changes scope or only agrees with the idea, then ask once. Filing tracker issues needs the same go-ahead. A task that needs another task\'s PR merged first takes wait_for, and wait_for_merge sets or ends a wait later. Follow up with message_agent. Use say for a short status line people see on your card in the sidebar. When the user asks, archive finished workspaces with archive_workspace; it skips any that are still in use. Merge ready PRs with merge_workspace only when the user asks; it says when merging is off. When the user says to go past a review\'s blockers, call overrule_blockers with their words in go_ahead.'

/**
 * The workspace a reviewer's base names: the Lead sometimes starts a review from the reviewed branch with base_ref instead
 * of review_of (KERNEL-299). Only for a Reviewer, so a task branched off another task is never archived with it. The base
 * may carry `origin/`. A workspace on the main checkout has no branch of its own to review. An open workspace wins;
 * `done` also takes an archived one whose PR merged or closed, for the start sweep.
 */
export function reviewedByBase(agent: AgentDef | undefined, baseRef: string | undefined, workspaces: Workspace[], o: { self?: string; done?: boolean } = {}): Workspace | undefined {
  if (!agent || !isReviewer(agent) || !baseRef) return undefined
  const branch = baseRef.trim().replace(/^origin\//, '')
  const on = workspaces.filter((w) => w.id !== o.self && w.mode !== 'current' && w.branch === branch).sort((a, b) => b.createdAt - a.createdAt)
  return on.find((w) => w.status !== 'archived') ?? (o.done ? on.find((w) => w.prState === 'merged' || w.prState === 'closed') : undefined)
}

/**
 * Tools exposed to the Lead as mcp__kernel__*. They are how a plan turns into workspaces:
 * The Lead proposes a plan, waits for the user to approve it, then creates one workspace per task.
 */
export function kernelMcpServer(d: KernelToolDeps) {
  return kernelServer(kernelTools(d), LEAD_INSTRUCTIONS)
}

/** The Lead's tools, apart from the server so tests can call them. */
export function kernelTools(d: KernelToolDeps) {
  /** Work a tab of this Lead chat handed off, this tab or another (KERNEL-337). */
  const mine = (w: Workspace) => !!w.leadChatId && !!d.chatId && (w.leadChatId === d.chatId || !!d.ownTab?.(w.leadChatId))
  /** Which Lead chat a workspace reports to, as list_workspaces shows it. Nothing for work no Lead chat handed off. */
  const owner = (w: Workspace) => {
    if (!w.leadChatId || !d.chatId) return ''
    if (mine(w)) return ' · yours'
    const title = d.chatTitle?.(w.leadChatId)
    return title ? ` · from Lead chat "${title}"` : ' · from another Lead chat'
  }
  /**
   * The workspace with its PR state as GitHub has it. A saved open state can be stale, as when the PR merged after the
   * folder was deleted. A closed one needs no check, and when GitHub can't be reached the saved state decides (KERNEL-109).
   */
  const latestPr = async (ws: Workspace): Promise<Workspace> => {
    if (CLOSED_PR.has(ws.prState) || !d.refreshPr) return ws
    return d.refreshPr(ws.id).catch(() => ws)
  }
  /** What list_workspaces shows for a wait: " · waits for PR #164". */
  const waits = (w: Workspace, all: Workspace[]) => {
    const on = w.waitsFor?.on ?? []
    if (!on.length) return ''
    return ` · waits for ${joinLabels(on.map((id) => { const t = all.find((x) => x.id === id); return t?.prNumber ? `PR #${t.prNumber}` : `workspace ${id}` }))}`
  }
  /** "PR #164 by Noor" for each target, joined. */
  const labels = (targets: Workspace[], team: AgentDef[]) => joinLabels(targets.map((t) => waitLabel(t, team.find((a) => a.id === t.agentId)?.name ?? t.agentId)))
  /**
   * A hand-off Kernel made wait because the tracker marks its issue as blocked (KERNEL-263): the teammate started, and Kernel
   * messages it when the blocking PRs merge. The Lead's own wait_for always holds the brief, so a wait that doesn't is the
   * tracker's. Named as the issue's source has it (KERNEL-473).
   */
  const blocked = (ws: Workspace, team: AgentDef[], pick: AgentDef, queued: boolean) => {
    const key = (w: Workspace | undefined) => (w?.source?.kind === 'issue' ? w.source.id : undefined)
    const issue = key(ws)
    if (!ws.waitsFor?.on.length || ws.waitsFor.held || !issue) return ''
    const all = d.workspaces()
    const on = ws.waitsFor.on.map((id) => all.find((w) => w.id === id)).filter((t): t is Workspace => !!key(t))
    if (!on.length) return ''
    const name = (t: Workspace) => team.find((a) => a.id === t.agentId)?.name ?? t.agentId
    const builders = [...new Set(on.map(name))]
    const prs = on.map((t) => (t.prNumber ? `PR #${t.prNumber}` : `${name(t)}'s PR`))
    const tracker = ws.source?.kind === 'issue' ? ws.source.tracker : undefined
    return ` ${tracker ? trackerName(tracker) : 'The issue tracker'} marks ${issue} as blocked by ${joinLabels(on.map((t) => key(t)!))}, which ${joinLabels(builders)} ${builders.length > 1 ? 'are' : 'is'} building. ${pick.name} starts ${queued ? 'once the brief goes out' : 'now'}, and Kernel messages ${pick.name} when ${joinLabels(prs)} ${prs.length > 1 ? 'merge' : 'merges'}. Pass wait_for to hold the brief instead.`
  }
  return [
    tool('list_agents', 'List the agents in this room with their roles. Helpers, which don\'t take tasks, come as one line of names.', {}, async () => text(agentList(await d.agents()))),
    tool('list_workspaces', 'List open workspaces in this room: id, agent, branch, PR state, "yours" for the ones you handed off in this chat, and "open" for a question, blockers or a proposed hand-off you haven\'t acted on.', {}, async () => {
      const all = d.workspaces()
      const list = all.filter((w) => w.status !== 'archived')
      const marks = d.openMarks?.()
      return text(list.map((w) => `${w.id} · ${w.agentId} · ${w.branch} · PR ${w.prState}${w.prNumber ? ' #' + w.prNumber : ''}${w.prBlocked ? ` (GitHub blocks the merge: ${blockedWhy[w.prBlocked]})` : ''}${waits(w, all)}${owner(w)}${marks?.get(w.id) ?? ''}`).join('\n') || 'No open workspaces.')
    }),
    tool('request_plan_approval', 'Show a plan to the user and wait for approval. Only while the chat is in plan mode. With plan mode off it refuses, and you ask in the chat before handing off. Put the full plan as markdown in plan, and one line per task in steps, which plan doesn\'t repeat. Returns "approved" with what to do next, or the requested changes.', {
      title: z.string().describe('Short plan title, for example "T-15 Export invoices as PDF"'),
      plan: z.string().describe('The full plan as markdown: context, approach, files, checks. The tasks go in steps, not here'),
      steps: z.array(z.string()).min(1).describe('One line per task, ideally "<task> · <agent name>"')
    }, async ({ title, plan, steps }, extra) => {
      // The chat's plan toggle decides, so a plan never shows with Copy and Approve in a chat that isn't planning (KERNEL-176).
      if (!d.planMode?.()) return { ...text(PLAN_MODE_OFF), isError: true }
      // Task lines alone hide the write-up, which then never reaches the chat or .kernel/plans/ (KERNEL-373).
      if (!plan?.trim()) return { ...text(NO_PLAN), isError: true }
      bus.activity({ kind: 'approval.requested', roomId: d.roomId, agentId: d.lead?.id, text: 'asked you to review', object: title })
      const decision = await d.askUser({ kind: 'plan', title, detail: plan, steps }, signalOf(extra))
      if (!decision) return text('No answer yet. Wait and ask again later.')
      // Out of plan mode before the answer goes back, so the hand-off that follows runs outside it.
      if (decision.behavior === 'allow') return text((await d.planApproved?.()) || `approved. ${HANDOFF_NOW}`)
      return text(`changes requested: ${decision.behavior === 'deny' ? decision.message ?? 'no details' : decision.text}`)
    }),
    tool('ask_user', 'Ask the user a short question, optionally with options. Waits for the answer.', {
      question: z.string(),
      options: z.array(z.union([z.string(), z.object({ label: z.string(), description: z.string().optional(), recommended: z.boolean().optional() })])).optional()
        .describe(`Each option: label is the answer in a few words (${LABEL_MAX} characters at most), description says what it means or why. Set recommended: true on the option you recommend instead of writing it in the text`),
      about: z.array(z.string()).optional().describe("When the question settles a teammate's question or a proposed hand-off, the ids of those workspaces, or of the agents, from list_workspaces")
    }, async ({ question, options, about }, extra) => {
      const asked = options?.map((o) => (typeof o === 'string' ? { label: o } : o))
      // A paragraph in a label squeezes the card's answer row, so the explanation has to go in description (KERNEL-415).
      const long = asked?.find((o) => o.label.length > LABEL_MAX)
      if (long) return { ...text(`Not asked: the label "${long.label.slice(0, 40)}..." is over ${LABEL_MAX} characters. Keep each label to a few words and move the rest into description.`), isError: true }
      const questions = asked && [{ question, options: asked }]
      // The user decides now, for what `about` names, or for every teammate the message was addressed to.
      d.acted?.({ asked: about ?? [] })
      const decision = await d.askUser({ kind: 'question', title: question, options: asked?.map((o) => o.label), questions }, signalOf(extra))
      if (!decision) return text('No answer yet.')
      return text(decision.behavior === 'answer' ? decision.text : decision.behavior)
    }),
    tool('create_workspace', 'Create a workspace for one task and hand it to an agent. The agent starts once setup passes, or, with wait_for, once those PRs merge.', {
      agent: z.string().describe('Agent id from list_agents, for example "kai"'),
      title: z.string().describe('Task title, used to name the branch'),
      brief: z.string().describe('Everything the agent needs: goal, files, acceptance criteria'),
      mode: z.enum(['worktree', 'current']).optional(),
      base_ref: z.string().optional(),
      branch: z.string().optional().describe('Only when the user asked for a particular branch name. Left out, Kernel names it from the issue key and title, for example fix/kernel-267-review-cant-start-reviewed-branch'),
      issue: z.string().optional().describe('The key of the issue this task builds, as the room\'s tracker shows it, for example "PROJ-83" or "#41". Kernel links the workspace to it, names the branch after it unless you pass branch, puts the issue in the brief, and moves it to In Progress where the tracker has that state'),
      review_of: z.string().optional().describe("For a review: the id of the workspace whose work to review. The reviewer's worktree starts from that workspace's branch, and the reviewer reports back with submit_review"),
      wait_for: z.array(z.string()).optional().describe('For a task that needs other tasks merged first: the ids of their workspaces (a PR number like "#164" or an issue key works too). Kernel creates the worktree and runs setup now, holds the brief, and sends it from the new base once every one of them has merged'),
      user_asked: z.boolean().optional().describe("Set to true only when the user explicitly asked for more teammate workspaces than the room's limit allows. Left out, create_workspace refuses once the limit is reached"),
      confirm: z.boolean().optional().describe('Set to true only after the user said to start anyway, when create_workspace warned that someone else may already be on the issue. Left out, Kernel checks for a branch on the remote, an open PR or another assignee first'),
      go_ahead: z.string().optional().describe("With plan mode off: the user's words that approved this hand-off, quoted from their latest message, for example \"hand it to Noor\". Kernel refuses the hand-off when they aren't in it. Not needed after an approved plan, for a review, or for a follow-up on approved work"),
      images: imagesArg.describe(IMAGES_DESCRIBE)
    }, async ({ agent, title, brief, mode, base_ref, branch, issue, review_of: askedReview, wait_for, user_asked, confirm, go_ahead, images }) => {
      // An agent the team doesn't have used to fall back to the Lead, whose work never reports back (KERNEL-119).
      const team = await d.agents()
      const pick = pickAgent(team, agent)
      if ('refusal' in pick) { bus.track({ name: 'handoff.refused', reason: pick.reason }); return { ...text(pick.refusal), isError: true } }
      if (pick.lead) { bus.track({ name: 'handoff.refused', reason: 'self' }); return { ...text('Not created: hand tasks to a teammate, not to yourself. Call list_agents for the team.'), isError: true } }
      const refuse = (why: string) => ({ ...text(`Not created: ${why}`), isError: true })
      // A reviewer started on another workspace's branch is a review of it, with the same checks. It keeps base_ref and
      // branch, since a long reviewed branch can't take review_of yet (KERNEL-299, KERNEL-265).
      const review_of = askedReview ?? reviewedByBase(pick, base_ref, d.workspaces())?.id
      // A helper only answers when another agent calls it, so it gets no workspace of its own. The reviewer can still review (KERNEL-397).
      if (!takesTasks(pick) && !(review_of && isReviewer(pick))) {
        bus.track({ name: 'handoff.refused', reason: 'helper' })
        const list = takers(team)
        return refuse(`${pick.name} is a helper in this room and doesn't take tasks${isReviewer(pick) ? ', only reviews with review_of' : ''}.${list ? ` Use an id from list_agents: ${list}.` : ' No one on this team takes tasks yet, so ask the user whether to create a teammate with create_agent or to add a starter agent in Team.'}`)
      }
      // A Lead that carries on after a quit may call this again for a task it already handed off (KERNEL-287). The same
      // issue anywhere in the room, or the same agent and title from this chat, is that task while its PR is still open.
      if (!review_of) {
        const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
        const open = d.workspaces().find((w) => w.status !== 'archived' && !w.reviewOf && w.prState !== 'merged' && w.prState !== 'closed' && (issue
          ? w.source?.kind === 'issue' && same(w.source.id, issue)
          : mine(w) && w.agentId === pick.id && !!w.title && same(w.title, title)))
        if (open) {
          const name = team.find((a) => a.id === open.agentId)?.name ?? open.agentId
          const what = issue ? `${issue.trim()} is already handed off` : 'this task is already handed off'
          if (open.status === 'failed') return refuse(`${what} to ${name} (workspace ${open.id}), and its setup failed. Tell the user to fix it and click Run again there.`)
          return refuse(`${what} to ${name} (workspace ${open.id}). Follow up with message_agent.`)
        }
      }
      // With plan mode off, a hand-off needs the user's go-ahead, quoted from their latest message (KERNEL-678). A review needs
      // none, and neither does plan mode, a plan approved since the user last wrote, or a turn Kernel started in a chat that
      // already had an approved plan or a hand-off, which is a follow-up on approved work.
      const guarded = !!d.userSaid && !review_of && !d.planMode?.()
      const plans = guarded ? d.plans?.() ?? [] : []
      const followUp = guarded && !d.userTurn?.() && (plans.length > 0 || d.workspaces().some((w) => mine(w) && !w.reviewOf))
      const said = guarded && !followUp ? d.userSaid!() : undefined
      const goAhead = guarded && !followUp && !plans.some((p) => p.at > (said?.at ?? 0)) ? go_ahead?.trim() ?? '' : undefined
      if (goAhead !== undefined && !quotesUser(goAhead, said?.text)) {
        bus.track({ name: 'handoff.refused', reason: 'go-ahead' })
        return { ...text(NO_GO_AHEAD), isError: true }
      }
      // A room keeps a limited number of teammate workspaces open at once, so a Lead can't fan out without end. A review is no
      // build workspace and doesn't count, and a user who asked for more goes past it (KERNEL-220). A cap of 0 is none (KERNEL-492).
      const limit = !review_of && !user_asked ? await d.agentCap?.() : undefined
      if (limit?.cap) {
        const open = d.workspaces().filter((w) => w.status !== 'archived' && !w.reviewOf && !isLeadWorkspace(w, d.lead?.id) && w.prState !== 'merged' && w.prState !== 'closed').length
        if (open >= limit.cap) return refuse(capRefusal(open, limit))
      }
      // A review starts from the work it reviews, and only one per reviewer is open at a time (KERNEL-130).
      if (review_of) {
        const target = d.workspaces().find((w) => w.id === review_of)
        if (!target) return refuse(`there is no workspace ${review_of} in this room to review. Call list_workspaces for the ids.`)
        if (target.status === 'archived') return refuse(`${target.name} is archived. Ask the user to restore it from History first.`)
        if (team.find((a) => a.id === target.agentId)?.lead) return refuse('that is your own workspace.')
        if (target.reviewOf) return refuse(`${target.name} is itself a review. Review the work it reviews instead (workspace ${target.reviewOf}).`)
        if (target.prState === 'merged' || target.prState === 'closed') return refuse(`${target.name}'s PR is already ${target.prState}, so there is nothing left to review.`)
        if (target.mode === 'current') return refuse(`${target.name} works on the main checkout, not a branch of its own, so there is no branch to review. Ask its teammate to commit and open a pull request first.`)
        const open = d.workspaces().find((w) => w.reviewOf === target.id && w.agentId === pick.id && w.status !== 'archived')
        if (open?.status === 'failed') return refuse(`${pick.name} already has a review of this open (workspace ${open.id}), and its setup failed. Tell the user to fix it and click Run again there.`)
        if (open) return refuse(`${pick.name} already has a review of this open (workspace ${open.id}). Ask for another pass with message_agent.`)
      }
      // Work that merged already is left out; with nothing left, the hand-off starts as usual (KERNEL-259).
      let targets: Workspace[] = []
      if (wait_for?.length) {
        const all = d.workspaces()
        const bases = await d.handoffBase?.(base_ref)
        const why = waitRefusal({ workspaces: all, refs: wait_for, mode, reviewOf: review_of, isLead: (w) => !!team.find((a) => a.id === w.agentId)?.lead, ...bases })
        if (why) return { ...text(`Not created: ${why}`), isError: true }
        targets = waitTargets(all, wait_for).filter((t) => !isMerged(t))
      }
      // Another person may be on the issue already: their branch, their PR, or the tracker has it assigned to them. The Lead
      // asks the user before it starts anyway. A review starts no work on the issue (KERNEL-479).
      // Every image is read and checked before anything is created, so a refused one sends nothing (KERNEL-658).
      const attached = await loadImages(d, images)
      if ('refusal' in attached) return refuse(attached.refusal)
      const key = issue?.trim()
      const taken = key && !review_of && !confirm ? await d.issueTaken?.(key).catch(() => undefined) : undefined
      if (key && taken?.findings.length) return { ...text(takenWarning(key, taken)), isError: true }
      const ws = await d.createWorkspace({ prompt: brief, agentId: pick.id, mode, baseRef: base_ref, title, branch, ...(issue ? { issue } : {}), ...(askedReview ? { reviewOf: askedReview } : review_of ? { linkReviewOf: review_of } : {}), ...(wait_for?.length ? { waitFor: targets.map((t) => t.id) } : {}), ...(attached.parts.length ? { images: attached.parts } : {}), ...(goAhead ? { goAhead } : {}) })
      bus.activity({ kind: 'workspace.created', roomId: d.roomId, workspaceId: ws.id, agentId: d.lead?.id, text: `assigned ${title} to`, object: pick.id, data: { assignee: pick.id } })
      d.handedOff?.()
      d.acted?.({ created: pick.id })
      // Kernel's backfill reads the "Created <id> on" prefix (kernel.ts backfillLeadChats), so it stays first.
      const failed = ws.status === 'failed' ? ` Setup failed (${ws.setupFailed ?? 'it did not pass'}), so ${pick.name} hasn't started. The brief waits until the user fixes setup and clicks Run again in that workspace.` : ''
      const stale = ws.fetchFailed ? ` ${ws.fetchFailed}` : ''
      const waiting = ws.waitsFor?.held && ws.waitsFor.on.length ? ` ${pick.name} waits for ${labels(targets.filter((t) => ws.waitsFor!.on.includes(t.id)), team)} to merge, and Kernel sends the brief then. Tell the user that merging it starts ${pick.name}.` : ''
      // A room whose scripts the user hasn't trusted holds the brief too (KERNEL-209, KERNEL-261). A merge it also waits
      // for says when the brief goes out instead.
      const trust = ws.status === 'trust' ? ` ${pick.name}'s workspace waits for the user to trust this room's scripts, so ${pick.name} hasn't started.${waiting ? '' : ' The brief goes out once they do.'}` : ''
      // A brief held for a slot, a pause or the connection isn't the teammate starting either (KERNEL-272). A brief held
      // for a merge or for trust says so above instead.
      const queued = failed || waiting || trust ? undefined : queuedNote(ws.queued, { name: pick.name, brief: true })
      // A check that couldn't answer didn't hold the start up, and the Lead hears which one (KERNEL-479).
      const unchecked = taken?.notes.length ? ` ${taken.notes.join(' ')}` : ''
      return text(`Created ${ws.id} on ${ws.branch} for ${pick.id}.${stale}${failed}${trust}${waiting}${queued ? ` ${queued}` : ''}${wait_for?.length ? '' : blocked(ws, team, pick, !!queued || !!trust)}${unchecked}`)
    }),
    tool('wait_for_merge', "Make a teammate wait for other workspaces' PRs to merge, or stop waiting. Replaces any earlier wait. A teammate whose brief hasn't gone out gets it once they merge; one that already started is told to rebase onto them. An empty list ends the wait and sends a held brief now.", {
      workspace_id: z.string().describe('The workspace that waits, from list_workspaces'),
      on: z.array(z.string()).describe('The ids of the workspaces whose PRs it waits for (a PR number like "#164" or an issue key works too). Empty to stop waiting')
    }, async ({ workspace_id, on }) => {
      const refuse = (why: string) => ({ ...text(`Not set: ${why}`), isError: true })
      if (!d.setWait) return refuse('waiting is not available here.')
      const all = d.workspaces()
      const ws = all.find((w) => w.id === workspace_id && w.status !== 'archived')
      if (!ws) return refuse(`there is no open workspace ${workspace_id} in this room. Call list_workspaces for the ids.`)
      const team = await d.agents()
      const isLead = (w: Workspace) => !!team.find((a) => a.id === w.agentId)?.lead
      if (isLead(ws)) return refuse('that is your own workspace.')
      const name = team.find((a) => a.id === ws.agentId)?.name ?? ws.agentId
      if (on.length) { const why = waitRefusal({ workspaces: all, refs: on, waiter: ws, isLead, remote: (await d.handoffBase?.())?.remote }); if (why) return refuse(why) }
      const targets = waitTargets(all, on)
      const merged = targets.filter(isMerged)
      const left = targets.filter((t) => !isMerged(t))
      const was = ws.waitsFor
      const after = await d.setWait(ws.id, left.map((t) => t.id))
      const already = merged.length ? `${labels(merged, team)} already merged. ` : ''
      if (!left.length) {
        if (!was) return text(`${already}${name} wasn't waiting for anything.`)
        return text(`${already}${name} no longer waits.${was.held && ws.status === 'ready' ? ` Kernel sent the brief, so ${name} starts now.` : ''}`)
      }
      const label = labels(left, team)
      return text(`${already}${after.waitsFor?.held ? `${name} waits for ${label} to merge, and Kernel sends the brief then. Tell the user that merging it starts ${name}.` : `${name} waits for ${label} to merge, and Kernel tells ${name} to rebase onto it then. Tell the user that merging it moves ${name} on.`}`)
    }),
    tool('message_agent', 'Send a follow-up message into an existing workspace chat.', {
      workspace_id: z.string(), text: z.string(),
      images: imagesArg.describe(IMAGES_DESCRIBE)
    }, async ({ workspace_id, text: t, images }) => {
      const attached = await loadImages(d, images)
      if ('refusal' in attached) return { ...text(`Not sent: ${attached.refusal}`), isError: true }
      const r = await d.messageWorkspace(workspace_id, t, attached.parts.length ? attached.parts : undefined)
      // Nothing went out: say why, as an error, so the Lead doesn't report it as done (KERNEL-118).
      if (!r.ok) return { ...text(r.note), isError: true }
      const ws = d.workspaces().find((w) => w.id === workspace_id)
      if (ws) d.acted?.({ messaged: ws })
      // The log shows who the Lead messaged and its first line (KERNEL-24), once the message has gone out.
      if (ws && d.lead && r.sent !== false) bus.activity({ kind: 'agent.talk', roomId: d.roomId, workspaceId: ws.id, agentId: d.lead.id, text: 'messaged', object: ws.name, quote: t.slice(0, 280), data: { from: d.lead.id, to: ws.agentId, workspaceId: ws.id, line: firstLine(t) } })
      // Its updates still go to the chat that handed it off, so say so rather than leave this chat waiting (KERNEL-105).
      const from = ws?.leadChatId && d.chatId && !mine(ws) ? d.chatTitle?.(ws.leadChatId) : undefined
      return text(from ? `${r.note} This workspace was handed off in the Lead chat "${from}", so its updates go there, not here.` : r.note)
    }),
    tool('archive_workspace', 'Archive workspaces whose work is done. Skips the Lead\'s own workspace, any with an agent still working, an open PR or uncommitted changes. The user can restore them from History.', {
      workspace_ids: z.array(z.string()).min(1).describe('Workspace ids from list_workspaces')
    }, async ({ workspace_ids }) => {
      const lines: string[] = []
      // One id at a time, so a skip or a failed archive doesn't stop the rest (D-090).
      for (const id of workspace_ids) {
        const ws = d.workspaces().find((w) => w.id === id && w.status !== 'archived')
        if (!ws) { lines.push(`Skipped ${id}: not an open workspace in this room.`); continue }
        const reason = await archiveSkip(ws, {
          // Only the Lead's own workspace. One handed to the Lead when an agent retired can go.
          isOwnLead: (w) => isLeadWorkspace(w, d.lead?.id),
          isRunning: d.isRunning, latestPr, unsaved: d.unsaved
        })
        if (reason) { lines.push(`Skipped ${ws.name}: ${reason}.`); continue }
        try {
          await d.archiveWorkspace(ws.id)
          lines.push(`Archived ${ws.name}.`)
        } catch (e) {
          const why = firstLine(e instanceof Error ? e.message : String(e))
          lines.push(`Skipped ${ws.name}: ${/[.!?…]$/.test(why) ? why : why + '.'}`)
        }
      }
      return text(lines.join('\n'))
    }),
    tool('merge_workspace', "Merge workspaces' pull requests, only when the user's own message asks. A review's id merges the PR it reviewed. Each merge needs what Settings, Pull requests asks for, such as passing checks and the reviewer's approval, and no blockers from a reviewer on its latest commit that the user didn't overrule. A PR that can't merge is skipped with the reason.", {
      workspace_ids: z.array(z.string()).min(1).describe('Workspace ids from list_workspaces')
    }, async ({ workspace_ids }) => {
      // Both gates hold here: mcp__kernel__* tools are auto-allowed, and the Lead's tools are built once per session (D-008).
      if (!d.mergeWorkspace || !d.leadMerge?.()) return { ...text(MERGE_OFF), isError: true }
      if (!d.userTurn?.()) return { ...text(MERGE_NOT_ASKED), isError: true }
      const lines: string[] = []
      // One id at a time, so a skip or a failed merge doesn't stop the rest, as archive_workspace does.
      for (const id of workspace_ids) {
        const asked = d.workspaces().find((w) => w.id === id && w.status !== 'archived')
        if (!asked) { lines.push(`Skipped ${id}: not an open workspace in this room.`); continue }
        // A review has no PR of its own: merging it means merging the work it reviewed.
        const target = asked.reviewOf ? d.workspaces().find((w) => w.id === asked.reviewOf) : asked
        if (!target || target.status === 'archived') { lines.push(`Skipped ${asked.name}: the work it reviewed is no longer open.`); continue }
        if (isLeadWorkspace(target, d.lead?.id)) { lines.push(`Skipped ${target.name}: it is your own workspace.`); continue }
        // A merge just before changes every other PR's base, so the saved state may be stale (KERNEL-283).
        const ws = await latestPr(target)
        const pr = ws.prNumber ? `#${ws.prNumber}` : ws.name
        const not = NOT_MERGEABLE[ws.prState]
        if (not) { lines.push(`Skipped ${pr}: ${not}.`); continue }
        // Only a person merges past a review's blockers, so the Lead points the user at the button instead (KERNEL-497, KERNEL-549).
        const found = headBlockers(ws)
        if (found) {
          lines.push(`Skipped ${pr}: ${reviewsText(found.lenses).replace(/^The/, 'the')} found ${found.count} ${found.count === 1 ? 'blocker' : 'blockers'}. Merge it from its Merge anyway button if you want it in.`)
          continue
        }
        try {
          const after = await d.mergeWorkspace(ws.id)
          const title = after.prTitle ?? ws.prTitle
          lines.push(`Merged ${pr}${title ? ` (${title})` : ''}.`)
        } catch (e) {
          // mergeBlock's reason is a finished sentence that names the reviewer and the setting, so it goes whole (KERNEL-349).
          // A failed merge's error is gh output, of which the first line is enough.
          const why = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0].trim().slice(0, 240)
          lines.push(`Skipped ${pr}: ${/[.!?…]$/.test(why) ? why : why + '.'}`)
        }
      }
      return text(lines.join('\n'))
    }),
    tool('overrule_blockers', "Overrule the blockers the reviews found on a pull request's latest commit, only when the user's own latest message says to go past them. A review's id overrules on the PR it reviewed. Until a new commit, a merge goes ahead without Merge anyway, and the new commit's reviews count again. Auto-merge never merges past an overrule.", {
      workspace_id: z.string().describe('Workspace id from list_workspaces'),
      go_ahead: z.string().describe("The user's words that overruled the blockers, quoted from their latest message, for example \"those blockers are fine, ignore them\". Kernel refuses when they aren't in it"),
      note: z.string().optional().describe("Why, in a line, as the user put it")
    }, async ({ workspace_id, go_ahead, note }) => {
      const refuse = (why: string) => ({ ...text(why), isError: true })
      if (!d.overrule) return refuse('Not overruled: overruling is not available here.')
      // The same check as create_workspace's go_ahead (KERNEL-678), and only in a turn the user started, as merge_workspace.
      if (!d.userTurn?.() || !quotesUser(go_ahead, d.userSaid?.()?.text)) return refuse(NO_OVERRULE)
      const asked = d.workspaces().find((w) => w.id === workspace_id && w.status !== 'archived')
      if (!asked) return refuse(`Not overruled: ${workspace_id} is not an open workspace in this room.`)
      // A review has no PR of its own: its blockers are on the work it reviewed, as merge_workspace reads it.
      const target = asked.reviewOf ? d.workspaces().find((w) => w.id === asked.reviewOf) : asked
      if (!target || target.status === 'archived') return refuse(`Not overruled: the work ${asked.name} reviewed is no longer open.`)
      const ws = await latestPr(target)
      try {
        const after = await d.overrule(ws.id, note)
        const o = after.overruled!
        return text(`Overruled ${reviewsText(o.kinds).replace(/^The/, 'the')}${o.kinds.length > 1 ? "'" : "'s"} blockers on PR #${after.prNumber} at ${o.head.slice(0, 7)}. A merge goes ahead without Merge anyway until a new commit. Merge it with merge_workspace only if the user asked.`)
      } catch (e) {
        return refuse(`Not overruled: ${firstLine(e instanceof Error ? e.message : String(e))}`)
      }
    }),
    tool('read_plans', 'Read the plans approved in every tab of this chat, newest first: the tab, when it was approved and the plan.', {}, async () => {
      const plans = d.plans?.() ?? []
      if (!plans.length) return text('No plan has been approved in this chat yet.')
      return text(plans.map((p) => `Approved in the tab "${p.tab}" at ${new Date(p.at).toISOString()}:\n${p.plan}`).join('\n\n'))
    }),
    tool('say', 'Post one short status line. It shows on your card in the sidebar.', { text: z.string().max(140) }, async ({ text: t }) => {
      if (d.lead) bus.push({ type: 'agent.status', roomId: d.roomId, agentId: d.lead.id, status: 'working' })
      bus.activity({ kind: 'agent.say', roomId: d.roomId, agentId: d.lead?.id, text: t })
      return text('ok')
    }),
    tool('set_room_scripts', SET_ROOM_SCRIPTS_DESCRIBE, {
      setup: z.string().optional().describe('The setup script, for example "pnpm install"'),
      run: z.string().optional().describe('The main run script, for example "pnpm dev --port $KERNEL_PORT"'),
      archive: z.string().optional().describe('The archive script, for example "docker compose down"'),
      run_scripts: z.record(z.string(), z.string()).optional().describe('More run scripts by name, for example {"storybook": "pnpm storybook --port $KERNEL_PORT"}'),
      run_mode: z.enum(['concurrent', 'single']).optional()
    }, async (args, extra) => {
      const refuse = (why: string) => ({ ...text(`Not saved: ${why}`), isError: true })
      if (!d.saveRoomScripts) return refuse('saving scripts is not available here.')
      const asked = roomScripts(args)
      if ('refusal' in asked) return refuse(asked.refusal)
      // The card's text is the converted text, exactly what Save writes (KERNEL-683).
      const options = [{ label: SAVE, description: 'Write them to .kernel/settings.local.toml, on this Mac only' }, { label: 'Cancel', description: 'Write nothing' }]
      const decision = await d.askUser({ kind: 'question', title: SAVE_SCRIPTS_QUESTION, detail: asked.card, options: options.map((o) => o.label), questions: [{ question: SAVE_SCRIPTS_QUESTION, options }] }, signalOf(extra))
      if (!decision) return text('Not saved: the card closed without an answer.')
      if (decision.behavior !== 'answer' || decision.text !== SAVE) return text(decision.behavior === 'answer' && decision.text !== 'Cancel' ? `Not saved. The user answered: ${decision.text}` : 'Not saved: the user canceled.')
      try { await d.saveRoomScripts(asked.patch) } catch (e) { return refuse((e as Error).message) }
      const renamed = asked.renamed.map((n) => `$${n} to $${SCRIPT_VARIABLES[n]}`)
      const unknown = asked.unknown.map((n) => `$${n}`)
      return text([
        `Saved ${joinLabels(asked.saved)} to .kernel/settings.local.toml.`,
        renamed.length ? `Kernel renamed ${joinLabels(renamed)}.` : '',
        unknown.length ? `Kernel has no variable for ${joinLabels(unknown)}, so ${unknown.length > 1 ? 'they were' : 'it was'} left as written. Tell the user, since the script may not work in Kernel.` : '',
        asked.patch.scripts?.setup ? 'Workspaces already open keep the old setup until the user clicks Run setup in each.' : ''
      ].filter(Boolean).join(' '))
    }),
    tool('create_agent', 'Create a new agent by proposing its file. The user approves it and picks who gets it: just them (~/.claude/agents on their Mac, in every room) or the team (a pull request that adds .claude/agents/<id>.md). Set scope only when the user said which. Leave tools out for the role\'s defaults: Read, Grep and Glob for a reviewer, and Read, Edit, Write, Bash, Grep and Glob for everyone else. An agent takes tasks only when its tools include Bash, and Edit or Write. Name each MCP server it needs in tools, as mcp__<server>.', {
      id: z.string().regex(/^[a-z][a-z0-9-]*$/), description: z.string(), prompt: z.string(),
      model: z.string().optional(), tools: z.array(z.string()).optional(), role: z.string().optional(),
      scope: z.enum(['me', 'team']).optional()
    }, async ({ scope: asked, ...a }, extra) => {
      // A name the team or Kernel's own agents use is refused before the user sees a card (KERNEL-397).
      if (RESERVED_AGENT_IDS.includes(a.id) || (await d.agents()).some((x) => x.id === a.id)) return { ...text(`Not proposed: ${a.id} is taken. Pick another id.`), isError: true }
      // With no tools line, a new agent gets its role's, so one that should open PRs names Edit and Write. A line the Lead wrote
      // stays as written, since Kernel never widens it on a guess (KERNEL-476).
      const made = { ...a, tools: a.tools?.length ? a.tools : hireDefaults(a.role?.trim() || `${a.id} ${a.description}`).tools }
      const path = `.claude/agents/${a.id}.md`
      const body = renderAgentFile(made)
      const servers = await d.reach?.(agentFromFile(path, body)).catch(() => undefined)
      // The card starts on "Just for me" unless the Lead proposes the team, and the user's choice on it wins (KERNEL-466).
      const proposed = asked ?? 'me'
      const agentFile = { path: `${proposed === 'me' ? '~/' : ''}${path}`, text: body, scope: proposed, ...(servers ? { servers } : {}) }
      const decision = await d.askUser({ kind: 'agent', title: `Add ${a.id} to the team`, detail: a.description, agentFile }, signalOf(extra))
      if (!decision || decision.behavior !== 'allow') return text('The user did not approve this agent.')
      let done: string | AgentChangePr
      try { done = await d.hireAgent(made, decision.scope ?? proposed) } catch (e) { return { ...text(`Not saved: ${(e as Error).message}`), isError: true } }
      if (typeof done !== 'string') {
        if (done.error) return text(`Committed ${path} in workspace ${done.workspaceId}, but the pull request didn't open: ${done.error} Tell the user to click Create PR there.`)
        return text(`Opened ${done.number ? `PR #${done.number}` : 'a pull request'}${done.url ? ` (${done.url})` : ''} that adds ${path}, from workspace ${done.workspaceId}. ${a.id} joins the team once it merges.`)
      }
      const joined = await d.agents().then((list) => list.find((x) => x.id === a.id), () => undefined)
      // Asked again, since the room's first check may have finished while the card was up.
      const reach = await d.reach?.(joined ?? agentFromFile(path, body), { wait: true }).catch(() => undefined)
      return text([`Saved ${done}, just for the user on this Mac.`, joinedNote(joined, a.id), reach ? reachNote(joined?.name ?? a.id, reach) : ''].filter(Boolean).join(' '))
    })
  ]
}
