// The landing page demo: the whole loop from a blank chat, told with real renderer screens and sample data.
//
// 1. You brief Kernel in a new chat in the Kernel project. Kernel reads the repo and says this demo plans one sample change,
//    and to switch to plan mode.
// 2. In plan mode you ask for the plan. Kernel proposes it (Why, Behavior, Files, Checks, Tracker and three tasks).
// 3. You approve. Kernel hands the tasks to Noor, Kai and Ivy, whose workspaces appear under the chat and build on their own.
// 4. Each opens a PR. A team update reaches Kernel, which starts Theo's review. Theo approves, and the PR is ready to merge.
//
// Clicks change this fixture and push the same events the engine would, so the real renderer draws every step.
import { scene } from '../fixtures/base'
import { fixtureHandlers } from '../src/main/fixtures'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { bus } from '../src/main/bus'
import type { Fixture } from '../fixtures'
import type { AccountProfile, Effort, ProviderModel, AgentStatus, Approval, Chat, ChatItem, ChatPart, ChatRunMode, Decision, PlanStep, PrInfo, Provider, RateLimit, SwitchReason, TeamUpdateRow, Thread, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'

export const PROJECT = 'project-a'
const LEAD = 'kernel-lead'
const PROJECT_PATH = '/Users/you/code/kernel'
const REPO = 'you/kernel'

// ---------- The starting fixture: three projects, the Kernel project open on a new chat

const t0 = Date.now()
const ago = (min: number) => t0 - min * 60_000

const leadWorkspace = (id: string, projectId: string, name: string, threadId: string, port: number, minAgo: number, over: Partial<Workspace> = {}): Workspace => ({
  id, projectId, name, branch: `kernel/${name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/${projectId}/kernel-${name}`, mode: 'worktree',
  agentId: LEAD, lead: true, threadId, port, status: 'ready', prState: 'none', createdAt: ago(minAgo), ...over
})
const leadChat = (id: string, workspaceId: string, title: string, threadId: string, minAgo: number, over: Partial<Chat> = {}): Chat =>
  ({ id, workspaceId, title, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, mode: 'acceptEdits', threadId, createdAt: ago(minAgo), ...over })
const thread = (id: string, projectId: string, title: string, minAgo: number): Thread => ({ id, projectId, title, createdAt: ago(minAgo), lastSentAt: ago(minAgo) })
const said = (id: string, minAgo: number, text: string, from?: 'user'): ChatItem =>
  from ? { kind: 'user', id, ts: ago(minAgo), parts: [{ type: 'text', text }] } : { kind: 'text', id, ts: ago(minAgo), text }

const seed = scene(() => ({}))

// Two test accounts on each provider, with usage, for the footer, its popover and the account menu. Switching works.
const account = (provider: Provider, id: string, label: string, email: string, plan: string, active: boolean): AccountProfile =>
  ({ id, provider, label, email, plan, cli: id === 'cli', auth: 'subscription', active, signedIn: true })
const accounts: AccountProfile[] = [
  account('claude', 'cli', 'Main account', 'main@example.com', 'Claude Max', true),
  account('claude', 'second', '2nd account', 'second@example.com', 'Claude Pro', false),
  account('codex', 'cli', 'Personal', 'personal@example.com', 'ChatGPT Plus', true),
  account('codex', 'work', 'Work', 'work@example.com', 'ChatGPT Pro', false)
]
const inHours = (h: number) => Math.round((t0 + h * 3_600_000) / 1000)
const limit = (provider: Provider, accountId: string, type: RateLimit['type'], pct: number, hours: number): RateLimit =>
  ({ type, status: 'allowed', utilization: pct / 100, resetsAt: inHours(hours), ...(provider === 'codex' ? { provider } : {}), ...(accountId === 'cli' ? {} : { accountId }) })
const usage: RateLimit[] = [
  limit('claude', 'cli', 'five_hour', 24, 3.2), limit('claude', 'cli', 'seven_day', 11, 74),
  limit('claude', 'second', 'five_hour', 6, 4.5), limit('claude', 'second', 'seven_day', 31, 98),
  limit('codex', 'cli', 'five_hour', 9, 2.4), limit('codex', 'cli', 'seven_day', 17, 120),
  limit('codex', 'work', 'five_hour', 42, 1.1), limit('codex', 'work', 'seven_day', 28, 150)
]
// Codex's model list, as the app's picker shows it: three current models with their own default efforts, and four older ones under Legacy models.
const codexModel = (label: string, defaultEffort: Effort, legacy: boolean, efforts: Effort[] = ['low', 'medium', 'high', 'xhigh']): ProviderModel =>
  ({ provider: 'codex', id: label.toLowerCase(), label, legacy, efforts, defaultEffort })
const codexModels: ProviderModel[] = [
  { ...codexModel('GPT-6.1-Sol', 'medium', false), isDefault: true },
  codexModel('GPT-6-Astra', 'low', false),
  codexModel('GPT-6-Luna', 'medium', false),
  codexModel('GPT-5.6-Sol', 'medium', true),
  codexModel('GPT-5.6-Terra', 'medium', true),
  codexModel('GPT-5.5', 'medium', true),
  codexModel('GPT-5.4', 'medium', true)
]
/** The request names a model, and the engine reads its provider from it: a model in Codex's list runs on Codex. */
const providerOf = (model?: string, provider?: Provider): { provider?: Provider } => {
  const p = provider ?? codexModels.find((m) => m.id === model)?.provider
  return p ? { provider: p } : {}
}
const settings = seed.settings ?? DEFAULT_SETTINGS('/Users/you')
export const f: Fixture = {
  ...seed,
  models: { codex: codexModels },
  // A new chat starts in the project's usual mode, not plan mode, so switching to Plan is a step the visitor takes.
  // The efforts the app's picker shows beside each Codex model are the ones picked last, which Settings remembers per model.
  settings: { ...settings, models: { ...settings.models, leadPlanMode: false, effortByModel: { ...settings.models.effortByModel, 'gpt-6.1-sol': 'medium', 'gpt-6-astra': 'low', 'gpt-6-luna': 'medium' } } },
  projects: [
    { ...seed.projects.find((r) => r.id === PROJECT)!, name: 'Kernel', path: PROJECT_PATH, repo: REPO },
    ...seed.projects.filter((r) => r.id === 'project-own' || r.id === 'project-portfolio')
  ],
  status: { [PROJECT]: { [LEAD]: 'idle', kai: 'idle', noor: 'idle', ivy: 'idle', theo: 'idle' } },
  threads: [
    thread('t-seed', 'project-own', 'Seed realistic demo data', 300),
    thread('t-case', 'project-portfolio', 'Case study page for Kernel', 600)
  ],
  workspaces: [
    leadWorkspace('ws-seed', 'project-own', 'seed-realistic-demo-data', 't-seed', 4320, 300),
    leadWorkspace('ws-case', 'project-portfolio', 'case-study-page-for-kernel', 't-case', 4330, 600)
  ],
  chats: [
    leadChat('chat-seed', 'ws-seed', 'Seed realistic demo data', 't-seed', 300),
    leadChat('chat-case', 'ws-case', 'Case study page for Kernel', 't-case', 600)
  ],
  items: {
    'chat-seed': [said('sd-u', 300, 'Seed the dev database with realistic invoices and clients.', 'user'), said('sd-r', 298, 'Seeded 40 clients and 380 invoices across three currencies.')],
    'chat-case': [said('cs-u', 600, 'Draft the case study page for Kernel.', 'user'), said('cs-r', 597, 'Drafted it in content/case-studies/kernel.md, with three screenshots.')]
  },
  accounts,
  usage,
  approvals: [],
  notifications: [],
  activity: [],
  tasks: {},
  changes: {},
  diffs: {},
  prs: {},
  push: [],
  ui: { route: { name: 'leadNew', projectId: PROJECT }, workspace: { right: 'changes', leadRight: 'prs', bottom: 'run' } }
}

const handlers = fixtureHandlers(f) as unknown as Record<string, (req: unknown) => Promise<unknown>>
export const fixtureAnswers = handlers

// ---------- What changed, written to the fixture and pushed like the engine pushes it

/** Where the story is. `quiet` is any moment Kernel is working and the visitor has nothing to do. */
export type Stage = 'brief' | 'quiet' | 'replied' | 'planMode' | 'planReady' | 'building' | 'ready' | 'done'
let stage: Stage = 'brief'
const stageListeners = new Set<(s: Stage) => void>()
/** The hints follow the story through these. */
export const onStage = (l: (s: Stage) => void) => { stageListeners.add(l); l(stage); return () => stageListeners.delete(l) }
const reach = (s: Stage) => { stage = s; stageListeners.forEach((l) => l(s)) }

const push = (e: PushEvent) => bus.push(e)
const later = (ms: number, fn: () => void) => setTimeout(fn, ms)

function item(chatId: string, it: ChatItem) {
  const list = (f.items[chatId] ??= [])
  const i = list.findIndex((x) => x.id === it.id)
  if (i >= 0) list[i] = it
  else list.push(it)
  push({ type: 'chat.item', chatId, item: it })
}
function upsertWorkspace(w: Workspace) {
  const i = f.workspaces.findIndex((x) => x.id === w.id)
  if (i >= 0) f.workspaces[i] = w
  else f.workspaces.push(w)
  push({ type: 'workspace', workspace: w })
}
const patchWorkspace = (id: string, patch: Partial<Workspace>) => upsertWorkspace({ ...f.workspaces.find((w) => w.id === id)!, ...patch })
function upsertChat(c: Chat) {
  const i = f.chats.findIndex((x) => x.id === c.id)
  if (i >= 0) f.chats[i] = c
  else f.chats.push(c)
  push({ type: 'chat', chat: c })
}
function upsertThread(t: Thread) {
  const list = (f.threads ??= [])
  const i = list.findIndex((x) => x.id === t.id)
  if (i >= 0) list[i] = t
  else list.push(t)
  push({ type: 'thread', thread: t })
}
function upsertApproval(a: Approval) {
  const i = f.approvals.findIndex((x) => x.id === a.id)
  if (i >= 0) f.approvals[i] = a
  else f.approvals.unshift(a)
  push({ type: 'approval', approval: a })
}
function setPr(info: PrInfo) {
  ;(f.prs ??= {})[info.workspaceId] = info
  push({ type: 'pr.info', info })
}
const running = (chatId: string, on: boolean) => push({ type: 'chat.running', chatId, running: on })
function status(agentId: string, s: AgentStatus) {
  ;(f.status[PROJECT] ??= {})[agentId] = s
  push({ type: 'agent.status', projectId: PROJECT, agentId, status: s })
}
async function runMode(chatId: string) {
  const mode = (await handlers['chats.runMode']!({ chatId })) as ChatRunMode
  push({ type: 'chat.runMode', chatId, mode })
}

// ---------- Item builders, in the fixtures' own shapes

const now = () => Date.now()
const user = (id: string, text: string, extra: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem => ({ kind: 'user', id, ts: now(), parts: [{ type: 'text', text }], ...extra })
const think = (id: string, text: string): ChatItem => ({ kind: 'thinking', id, ts: now(), text })
const say = (id: string, text: string): ChatItem => ({ kind: 'text', id, ts: now(), text })
type Tool = Extract<ChatItem, { kind: 'tool' }>
const tool = (id: string, label: string, detail: string, extra: Partial<Tool> = {}): Tool =>
  ({ kind: 'tool', id, ts: now(), toolUseId: `toolu_${id}`, name: 'Bash', label, detail, status: 'running', ...extra })
const result = (id: string, startedAt: number, files?: Extract<ChatItem, { kind: 'result' }>['files']): ChatItem => ({ kind: 'result', id, ts: now(), durationMs: now() - startedAt, ok: true, files })

/** A turn's steps, each `gap` ms after the last. A tool shows running, then done after its own `ms`. A function runs in place. */
type Step = ChatItem | { run: Tool; ms: number; output?: string } | (() => void)
function play(chatId: string, steps: Step[], gap: number, then?: () => void) {
  let t = 0
  for (const s of steps) {
    later(t, () => {
      if (typeof s === 'function') return s()
      if ('run' in s) {
        const r = { ...s.run, ts: now() }
        item(chatId, r)
        later(s.ms, () => item(chatId, { ...r, status: 'done', durationMs: s.ms, ...(s.output ? { output: s.output } : {}) }))
        return
      }
      item(chatId, { ...s, ts: now() } as ChatItem)
    })
    t += typeof s === 'object' && 'run' in s ? s.ms + gap : gap
  }
  if (then) later(t, then)
}

// ---------- The plan

const PLAN_TITLE = 'Save every new plan as plan.md'
const PLAN = [
  `# ${PLAN_TITLE}`,
  '',
  '## Why',
  'Kernel names a saved plan after its first heading. Plan mode almost always opens with "## Context", so nearly every plan is saved as `.kernel/plans/context.md`, then `context-2.md`, and so on. The name tells you nothing, and it reads like a context dump rather than a plan you approved.',
  '',
  '## Behavior',
  '- A new plan is saved as `.kernel/plans/plan.md` in its workspace folder.',
  '- If `plan.md` is taken, the plan goes to the next free name: `plan-2.md`, `plan-3.md` and up.',
  '- A revision after Request changes still overwrites the file of the plan it revises.',
  '- The plan card shows the file it was saved as, and clicking it opens the file.',
  '- Plans already on disk keep their names. Nothing is renamed or migrated.',
  '',
  '## Files',
  '- `src/main/services/plans.ts`: `savePlan` always starts from `plan`, and `planName` goes. Engine lane, Noor.',
  '- `src/renderer/src/screens/workspace/cards/plan.tsx`: the file chip on the plan card. Workspace lane, Kai.',
  '- `test/plans.test.ts`: the naming cases and the revision rule. QA, Ivy.',
  '',
  '## Checks',
  '- `pnpm test:changed` and `pnpm typecheck` pass.',
  '- `pnpm shots WorkspacePlan` shows the chip on the card.',
  '',
  '## Tracker',
  'On approval I file one Linear issue per task in team Kernel, project "Kernel v1", and hand each to its agent. Theo reviews each pull request as it lands.'
].join('\n')

type Task = { key: 'engine' | 'card' | 'tests'; agent: string; agentName: string; issue: string; title: string; name: string; pr: number; files: { path: string; status: 'A' | 'M'; added: number; removed: number }[] }
const TASKS: Task[] = [
  { key: 'engine', agent: 'noor', agentName: 'Noor', issue: 'KERNEL-735', title: 'Save new plans as plan.md, then plan-2.md and up', name: 'kernel-735-save-plans-as-plan-md', pr: 701,
    files: [{ path: 'src/main/services/plans.ts', status: 'M', added: 41, removed: 23 }, { path: 'src/main/features/lead.ts', status: 'M', added: 6, removed: 4 }, { path: 'docs/decisions/KERNEL-735.md', status: 'A', added: 18, removed: 0 }] },
  { key: 'card', agent: 'kai', agentName: 'Kai', issue: 'KERNEL-736', title: 'Show the saved plan file on the plan card', name: 'kernel-736-plan-file-chip', pr: 702,
    files: [{ path: 'src/renderer/src/screens/workspace/cards/plan.tsx', status: 'M', added: 34, removed: 6 }, { path: 'src/renderer/src/screens/workspace/cards/cards.css', status: 'M', added: 9, removed: 0 }, { path: 'fixtures/workspace.ts', status: 'M', added: 12, removed: 2 }] },
  { key: 'tests', agent: 'ivy', agentName: 'Ivy', issue: 'KERNEL-737', title: 'Cover plan naming and revisions with tests', name: 'kernel-737-plan-naming-tests', pr: 703,
    files: [{ path: 'test/plans.test.ts', status: 'M', added: 88, removed: 31 }] }
]
const wsId = (t: Task) => `ws-${t.key}`
const chatId = (t: Task) => `chat-${t.key}`

// ---------- The story's state

let leadWs = ''
let leadChatId = ''
let threadId = ''
let planId = ''

function brief(projectId: string, prompt: string, plan: boolean, clientId?: string, pick: Partial<Pick<Chat, 'provider' | 'model' | 'effort'>> = {}): Chat {
  if (leadChatId) throw new Error('This demo runs one chat at a time. Use Start over under the demo to begin again.')
  threadId = 't-demo'
  leadWs = 'ws-demo-lead'
  leadChatId = 'chat-demo-lead'
  upsertThread({ id: threadId, projectId, title: 'New tab', createdAt: now(), lastSentAt: now() })
  upsertWorkspace(leadWorkspace(leadWs, projectId, 'new-chat', threadId, 4340, 0, { createdAt: now() }))
  const chat = leadChat(leadChatId, leadWs, 'New tab', threadId, 0, { plan, createdAt: now(), ...pick })
  upsertChat(chat)
  f.items[leadChatId] = []
  reach('quiet')
  later(50, () => {
    item(leadChatId, user(clientId ?? 'd-brief', prompt))
    if (plan) proposePlan()
    else firstReply(prompt)
  })
  return chat
}

/** Not in plan mode yet: Kernel looks around and says how to get a plan. */
function firstReply(prompt: string) {
  const c = leadChatId
  const start = now()
  running(c, true)
  status(LEAD, 'working')
  play(c, [
    think('d-th1', 'Before planning anything, I should see how the repo is laid out and where this would land.'),
    { run: tool('d-t1', 'Read the repo layout', 'ls src/main src/renderer/src docs', { name: 'Read' }), ms: 700 },
    { run: tool('d-t2', 'Find where plans are saved', 'rg -n "savePlan|planName" src', { name: 'Grep' }), ms: 800 },
    say('d-r1', [
      `This is a demo, so I won't plan "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}" for real. Instead I'll plan one sample change to Kernel itself: plans are named after their first heading, so almost every one is saved as context.md. They should be saved as plan.md.`,
      '',
      'Switch this chat to Plan, with Shift+Tab or the mode menu below, and ask me for the implementation plan. I will write it up for you to approve, and nothing changes until you do.'
    ].join('\n'))
  ], 900, () => {
    item(c, result('d-res1', start))
    running(c, false)
    status(LEAD, 'idle')
    upsertThread({ ...f.threads!.find((t) => t.id === threadId)!, title: 'Save plans as plan.md' })
    upsertChat({ ...f.chats.find((x) => x.id === c)!, title: 'Save plans as plan.md' })
    patchWorkspace(leadWs, { name: 'save-plans-as-plan-md', branch: 'kernel/save-plans-as-plan-md' })
    reach('replied')
  })
}

/** In plan mode: Kernel writes the plan and asks for approval. */
function proposePlan() {
  const c = leadChatId
  const start = now()
  reach('quiet')
  running(c, true)
  status(LEAD, 'planning')
  play(c, [
    think('d-th2', "Since I'm in plan mode, I'll write the plan and ask for approval with request_plan_approval. Three lanes: the engine change, the card and the tests."),
    { run: tool('d-t3', 'Read the plans service', 'cat src/main/services/plans.ts', { name: 'Read' }), ms: 700 },
    { run: tool('d-t4', 'Find every caller of planName', 'rg -n "planName" src test', { name: 'Grep' }), ms: 700 },
    { run: tool('d-t5', 'Read the plan card', 'cat src/renderer/src/screens/workspace/cards/plan.tsx', { name: 'Read' }), ms: 700 },
    { run: tool('d-t6', 'kernel · request_plan_approval', JSON.stringify({ title: PLAN_TITLE, plan: '## Why\nKernel names a saved plan after its first heading...' }), { name: 'mcp__kernel__request_plan_approval' }), ms: 900 },
    () => {
      planId = `ap-plan-demo-${now()}`
      const steps: PlanStep[] = TASKS.map((t) => ({ title: t.title, taskId: t.issue, agentId: t.agent }))
      upsertApproval({ id: planId, kind: 'plan', source: 'sdk', projectId: PROJECT, workspaceId: leadWs, chatId: c, agentId: LEAD, title: PLAN_TITLE, detail: PLAN, steps, status: 'pending', createdAt: now() })
      item(c, { kind: 'approval', id: `approval-${planId}`, ts: now(), approvalId: planId })
      item(c, result('d-res2', start))
      running(c, false)
      status(LEAD, 'needs')
      reach('planReady')
    }
  ], 1000)
}

function approvePlan(a: Approval): Approval {
  const next: Approval = { ...a, status: 'allowed', steps: a.steps?.map((s, i) => ({ ...s, workspaceId: wsId(TASKS[i]!) })) }
  upsertApproval(next)
  const chat = f.chats.find((x) => x.id === leadChatId)!
  upsertChat({ ...chat, plan: false })
  void runMode(leadChatId)
  status(LEAD, 'working')
  running(leadChatId, true)
  play(leadChatId, [
    { run: tool('d-t7', 'File the Linear issues', 'linear issue create × 3 (KERNEL-735, KERNEL-736, KERNEL-737)', { name: 'mcp__linear__save_issue' }), ms: 900 },
    { run: tool('d-t8', 'kernel · start_tasks', 'Noor, Kai and Ivy, one workspace each', { name: 'mcp__kernel__start_tasks' }), ms: 700 },
    say('d-r3', 'Approved and handed off. I filed KERNEL-735 to KERNEL-737: Noor has the engine change, Kai has the plan card and Ivy has the tests, each in its own workspace. Theo reviews each pull request as it lands, and I will post a team update here as they do.')
  ], 700, () => { running(leadChatId, false); status(LEAD, 'idle') })
  TASKS.forEach((t, i) => later(1300 + i * 800, () => startTask(t, i)))
  reach('building')
  return next
}

function startTask(t: Task, i: number) {
  upsertWorkspace({
    id: wsId(t), projectId: PROJECT, name: t.name, title: t.title, branch: `feat/${t.name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/project-a/${t.name}`, mode: 'worktree',
    agentId: t.agent, port: 4341 + i, status: 'ready', prState: 'none', threadId, leadChatId, createdAt: now(), source: { kind: 'issue', id: t.issue, title: t.title }
  })
  upsertChat({ id: chatId(t), workspaceId: wsId(t), title: t.title, kind: 'chat', model: t.agent === 'noor' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: now() })
  f.items[chatId(t)] = []
  status(t.agent, 'working')
  running(chatId(t), true)
  item(chatId(t), { kind: 'user', id: `${t.key}-brief`, ts: now(), from: 'lead', parts: [{ type: 'text', text: `${t.issue}: ${t.title}. Build it from the approved plan.` }, { type: 'file', name: 'plan.md', path: '.kernel/plans/plan.md', lines: 34 }] })
  later(1200, () => taskTurn(t))
}

function taskTurn(t: Task) {
  const c = chatId(t)
  const start = now()
  const steps: Record<Task['key'], Step[]> = {
    engine: [
      think('e-th', 'savePlan builds the name from the first heading. Starting from "plan" and walking the free names is a small change.'),
      { run: tool('e-t1', 'Read the plans service', 'cat src/main/services/plans.ts', { name: 'Read' }), ms: 700 },
      { run: tool('e-t2', 'Edit savePlan', 'src/main/services/plans.ts', { name: 'Edit' }), ms: 1100 },
      { run: tool('e-t3', 'Update the callers', 'src/main/features/lead.ts', { name: 'Edit' }), ms: 900 },
      { run: tool('e-t4', 'Write the decision', 'docs/decisions/KERNEL-735.md', { name: 'Write' }), ms: 700 },
      { run: tool('e-t5', 'Run the tests', 'pnpm test:changed', { output: ' ✓ test/plans.test.ts (9)\n ✓ test/lead.test.ts (24)\n\n Test Files  2 passed (2)' }), ms: 2600 },
      say('e-tx', 'New plans are saved as plan.md, then plan-2.md and up, and a revision still overwrites the file it revises. Tests and typecheck pass.')
    ],
    card: [
      think('k-th', 'The approval already carries planFile. The card only needs a chip that opens it, like the turn files card.'),
      { run: tool('k-t1', 'Read the plan card', 'cat src/renderer/src/screens/workspace/cards/plan.tsx', { name: 'Read' }), ms: 700 },
      { run: tool('k-t2', 'Add the file chip', 'src/renderer/src/screens/workspace/cards/plan.tsx', { name: 'Edit' }), ms: 1200 },
      { run: tool('k-t3', 'Style the chip', 'src/renderer/src/screens/workspace/cards/cards.css', { name: 'Edit' }), ms: 700 },
      { run: tool('k-t4', 'Take the shot', 'pnpm shots WorkspacePlan', { output: 'shots/WorkspacePlan.png' }), ms: 2400 },
      say('k-tx', 'The plan card shows plan.md next to Propose plan, and clicking it opens the file. I checked the shot against DESIGN.md.')
    ],
    tests: [
      think('i-th', 'The old cases assert heading slugs. They become plan.md, plan-2.md, and the revision rule.'),
      { run: tool('i-t1', 'Read the current tests', 'cat test/plans.test.ts', { name: 'Read' }), ms: 700 },
      { run: tool('i-t2', 'Rewrite the naming cases', 'test/plans.test.ts', { name: 'Edit' }), ms: 1300 },
      { run: tool('i-t3', 'Run them', 'pnpm test test/plans.test.ts', { output: ' ✓ test/plans.test.ts (11)\n\n Tests  11 passed (11)' }), ms: 2200 },
      say('i-tx', 'Eleven cases: the first plan, the next free name, a revision overwriting its own file, and plans already on disk keeping their names.')
    ]
  }
  play(c, steps[t.key], 1300, () => {
    const added = t.files.reduce((n, x) => n + x.added, 0)
    const removed = t.files.reduce((n, x) => n + x.removed, 0)
    f.changes[wsId(t)] = t.files
    item(c, result(`${t.key}-res`, start, t.files))
    patchWorkspace(wsId(t), { stat: { files: t.files.length, added, removed } })
    openPr(t, added, removed)
  })
}

function openPr(t: Task, added: number, removed: number) {
  const c = chatId(t)
  const head = `h${t.pr}`
  const start = now()
  play(c, [
    { run: tool(`${t.key}-pr`, 'Open the pull request', 'gh pr create --fill', { output: `https://github.com/${REPO}/pull/${t.pr}` }), ms: 1100 },
    () => {
      patchWorkspace(wsId(t), { prNumber: t.pr, prUrl: `https://github.com/${REPO}/pull/${t.pr}`, prTitle: `feat: ${t.title.charAt(0).toLowerCase()}${t.title.slice(1)} (${t.issue})`, prHead: head, prState: 'checks' })
      setPr(prInfo(t, 'checks', head))
      push({ type: 'pr', workspaceId: wsId(t), state: 'checks' })
    },
    say(`${t.key}-done`, `Opened PR #${t.pr}. Checks are running.`)
  ], 600, () => {
    item(c, result(`${t.key}-res2`, start))
    running(c, false)
    status(t.agent, 'idle')
    teamUpdate(t, [{ kind: 'pr.opened', text: `Opened PR #${t.pr}`, actionable: false }, { kind: 'pr.review', text: 'Not reviewed', actionable: false }],
      `${t.title}. ${added} lines added and ${removed} removed. Opened PR #${t.pr}.`)
    later(1500, () => {
      item(leadChatId, say(`${t.key}-lead1`, `${t.agentName} opened PR #${t.pr}. I started Theo's review.`))
      review(t, head)
    })
  })
}

const prInfo = (t: Task, state: 'checks' | 'ready' | 'merged', head: string): PrInfo => ({
  workspaceId: wsId(t), number: t.pr, url: `https://github.com/${REPO}/pull/${t.pr}`, title: `feat: ${t.title} (${t.issue})`, state, baseRef: 'main', head, comments: [], conflicts: [],
  checks: state === 'checks' ? [{ name: 'lint', state: 'pass', meta: '14s' }, { name: 'test', state: 'running' }, { name: 'release note', state: 'pass', meta: '3s' }] : [{ name: 'lint', state: 'pass', meta: '14s' }, { name: 'test', state: 'pass', meta: '2m 41s' }, { name: 'release note', state: 'pass', meta: '3s' }]
})

/** Theo's review of the PR, in a workspace of its own under the chat. */
function review(t: Task, head: string) {
  const id = `ws-review-${t.pr}`
  const c = `chat-review-${t.pr}`
  upsertWorkspace({
    id, projectId: PROJECT, name: `review-pr-${t.pr}`, title: `Review PR #${t.pr}`, branch: `feat/${t.name}-review`, baseRef: `feat/${t.name}`, path: `/Users/you/kernel/worktrees/project-a/review-pr-${t.pr}`,
    mode: 'worktree', agentId: 'theo', port: 4350 + (t.pr % 10), status: 'ready', prState: 'none', reviewOf: wsId(t), threadId, leadChatId, createdAt: now()
  })
  upsertChat({ id: c, workspaceId: id, title: `Review PR #${t.pr}`, kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: false, lens: { kind: 'code' }, createdAt: now() })
  f.items[c] = []
  status('theo', 'working')
  running(c, true)
  const start = now()
  play(c, [
    { kind: 'user', id: `rv-${t.pr}-u`, ts: now(), from: 'lead', parts: [{ type: 'text', text: `Review PR #${t.pr} for ${t.issue} against the plan and CLAUDE.md.` }] },
    { run: tool(`rv-${t.pr}-t1`, 'Read the diff', `gh pr diff ${t.pr}`, { name: 'Read' }), ms: 900 },
    { run: tool(`rv-${t.pr}-t2`, 'Check it against the plan', 'cat .kernel/plans/plan.md', { name: 'Read' }), ms: 700 },
    say(`rv-${t.pr}-tx`, `No blockers. ${t.issue} does what the plan says, the tests cover it and the copy follows the rules.`)
  ], 1200, () => {
    item(c, result(`rv-${t.pr}-res`, start))
    running(c, false)
    status('theo', 'idle')
    patchWorkspace(wsId(t), { prState: 'ready', reviews: [{ workspaceId: id, agentId: 'theo', verdict: 'approved', summary: 'No blockers.', sha: head, prNumber: t.pr, ts: now() }] })
    setPr(prInfo(t, 'ready', head))
    push({ type: 'pr', workspaceId: wsId(t), state: 'ready' })
    teamUpdate(t, [{ kind: 'pr.ready', text: 'Ready to merge', actionable: true }, { kind: 'pr.review', text: 'Code approved', actionable: false }], `Every check passed and Theo approved PR #${t.pr}.`,
      { workspaceId: id, agentId: 'theo', name: 'Theo', task: `Review PR #${t.pr}`, events: [{ kind: 'review', text: `Approved PR #${t.pr}`, actionable: true }], reply: 'No blockers.' })
    later(1200, () => item(leadChatId, say(`${t.key}-lead2`, `PR #${t.pr} is ready to merge: code approved and every check passed. Merge it from the card above or the PRs panel.`)))
    // Only the first ready PR shows the merge hint. After a merge the story is done, and later PRs don't bring it back.
    if (stage === 'building') reach('ready')
  })
}

function teamUpdate(t: Task, events: TeamUpdateRow['events'], reply: string, extra?: TeamUpdateRow) {
  const row: TeamUpdateRow = { workspaceId: wsId(t), agentId: t.agent, name: t.agentName, task: t.title, prNumber: t.pr, events, reply }
  const rows = extra ? [row, extra] : [row]
  const text = ['Team update from Kernel, not from the user.', '', ...rows.flatMap((r) => [`${r.name} (${r.agentId}) · ${r.task} · workspace ${r.workspaceId}`, ...r.events.map((e) => `- ${e.text}.`)])].join('\n')
  item(leadChatId, { kind: 'user', id: `tu-${t.key}-${now()}`, ts: now(), from: 'kernel', update: { rows }, parts: [{ type: 'text', text }] })
}

function merge(workspaceId: string): Workspace {
  const w = f.workspaces.find((x) => x.id === workspaceId)!
  push({ type: 'pr.pending', workspaceId, action: 'merge' })
  later(1600, () => {
    patchWorkspace(workspaceId, { prState: 'merged', mergedAt: now() })
    const info = f.prs?.[workspaceId]
    if (info) setPr({ ...info, state: 'merged' })
    push({ type: 'pr', workspaceId, state: 'merged' })
    push({ type: 'pr.pending', workspaceId })
    const c = f.chats.find((x) => x.workspaceId === workspaceId && x.kind === 'chat')
    if (c) item(c.id, { kind: 'note', id: `merged-${workspaceId}`, ts: now(), text: `PR #${w.prNumber ?? ''} was squashed into main.`, pr: 'merged' })
    if (leadChatId && w.leadChatId === leadChatId) item(leadChatId, say(`merged-lead-${workspaceId}`, `Merged PR #${w.prNumber ?? ''}.`))
  })
  if (stage === 'ready') reach('done')
  return w
}

function decide(id: string, d: Decision): Approval {
  const a = f.approvals.find((x) => x.id === id)
  if (!a) throw new Error('That request is gone.')
  if (a.kind === 'plan' && a.status === 'pending') {
    if (d.behavior === 'allow') return approvePlan(a)
    const notes = d.behavior === 'deny' ? d.message ?? '' : d.behavior === 'answer' ? d.text : ''
    const next: Approval = { ...a, status: 'denied', answer: notes }
    upsertApproval(next)
    running(leadChatId, true)
    later(1200, () => item(leadChatId, say(`d-rev-${now()}`, notes ? `Understood. I will fold that in: "${notes.slice(0, 120)}". Here is the revised plan.` : 'Understood. Here is the revised plan.')))
    later(2600, () => {
      planId = `ap-plan-demo-${now()}`
      upsertApproval({ ...a, id: planId, status: 'pending', answer: undefined, createdAt: now() })
      item(leadChatId, { kind: 'approval', id: `approval-${planId}`, ts: now(), approvalId: planId })
      running(leadChatId, false)
    })
    return next
  }
  const next: Approval = d.behavior === 'answer' ? { ...a, status: 'answered', answer: d.text } : { ...a, status: d.behavior === 'allow' ? 'allowed' : 'denied' }
  upsertApproval(next)
  return next
}

/** A message in any chat. In the story's chat it moves the story on; anywhere else it gets one honest reply. */
function send(chat: string, parts: ChatPart[], clientId?: string): ChatItem {
  const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim()
  const id = `m-${now()}`
  const row: ChatItem = { kind: 'user', id: clientId ?? `${id}-u`, ts: now(), parts }
  item(chat, row)
  const c = f.chats.find((x) => x.id === chat)
  if (chat === leadChatId && c?.plan && !planId) { proposePlan(); return row }
  running(chat, true)
  later(1100, () => {
    const reply = chat !== leadChatId
      ? 'This is a demo running on sample data. Download Kernel to work with your own agents on your own repo.'
      : stage === 'replied' || stage === 'brief'
        ? 'Switch this chat to Plan first, with Shift+Tab or the mode menu below, then ask me for the implementation plan.'
        : stage === 'planReady'
          ? 'The plan is waiting for you above. Approve it, or type what to change and I will revise it.'
          : 'The team is on it. Open a workspace in the sidebar to watch it build, or wait for the team updates here.'
    item(chat, say(`${id}-r`, reply))
    running(chat, false)
  })
  return row
}

async function configure(req: { chatId: string; provider?: Provider; model?: string; effort?: Chat['effort']; plan?: boolean; mode?: Chat['mode'] }) {
  const { chatId: id, ...patch } = req
  const c = f.chats.find((x) => x.id === id)
  if (!c) throw new Error('That chat is gone.')
  const next: Chat = { ...c, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), ...(patch.model ? { provider: providerOf(patch.model, patch.provider).provider ?? 'claude' } : {}) }
  upsertChat(next)
  await runMode(id)
  if (id === leadChatId && next.plan && stage === 'replied') reach('planMode')
  return next
}

function switchAccount(provider: Provider, accountId: string, reason: SwitchReason): AccountProfile[] {
  const from = f.accounts!.find((a) => a.provider === provider && a.active)?.id ?? ''
  f.accounts = f.accounts!.map((a) => (a.provider === provider ? { ...a, active: a.id === accountId } : a))
  // As the engine does: the accounts first, so the notice can name both accounts.
  push({ type: 'accounts', accounts: f.accounts })
  if (from !== accountId) push({ type: 'accountSwitched', provider, from, to: accountId, reason })
  return f.accounts
}

const unavailable = (what: string) => async () => { throw new Error(`${what} works in the app. Download Kernel to try it.`) }

/** The bridge answers from these first, then from the fixture. */
export const storyHandlers: Record<string, (req: never) => Promise<unknown>> = {
  'lead.start': async ({ projectId, prompt, plan, clientId, provider, model, effort }: { projectId: string; prompt: string; plan?: boolean; clientId?: string; provider?: Provider; model?: string; effort?: Effort }) =>
    brief(projectId, prompt, !!plan, clientId, { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...providerOf(model, provider) }),
  'chats.send': async ({ chatId: id, parts, clientId }: { chatId: string; parts: ChatPart[]; clientId?: string }) => ({ queued: false, item: send(id, parts, clientId) }),
  'chats.configure': async (req: Parameters<typeof configure>[0]) => configure(req),
  'approvals.decide': async ({ id, decision }: { id: string; decision: Decision }) => decide(id, decision),
  'pr.merge': async ({ workspaceId }: { workspaceId: string }) => merge(workspaceId),
  'workspaces.archive': async ({ workspaceId }: { workspaceId: string }) => { patchWorkspace(workspaceId, { status: 'archived', archivedAt: now() }); return { ok: true } },
  'accounts.switch': async ({ provider, accountId, reason }: { provider: Provider; accountId: string; reason?: Exclude<SwitchReason, 'limit'> }) => switchAccount(provider, accountId, reason ?? 'user'),
  'chats.create': unavailable('Another tab'),
  'workspaces.create': unavailable('A new workspace'),
  'projects.add': unavailable('Adding a repo'),
  'projects.create': unavailable('A new project'),
  'pr.create': unavailable('Opening a pull request by hand')
}
