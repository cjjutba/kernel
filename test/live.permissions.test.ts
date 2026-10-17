import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type CanUseTool, type McpStdioServerConfig, type Options, type PermissionMode, type SDKMessage, type SDKUserMessage, type Settings } from '@anthropic-ai/claude-agent-sdk'
import { claudeModels, InputQueue, sessionEnv, toUserMessage } from '../src/main/services/providers/claude'
import { claudePolicy, supportsAuto } from '../src/main/services/claudeSettings'
import { bundledCodex } from '../src/main/services/providers/binary'
import { codexEnv, KERNEL_VERSION } from '../src/main/services/providers/codex/client'
import { initializeParams, Rpc, RpcError } from '../src/main/services/providers/codex/rpc'
import type { ApprovalsReviewer } from '../src/main/services/providers/codex/protocol/v2/ApprovalsReviewer'
import type { AskForApproval } from '../src/main/services/providers/codex/protocol/v2/AskForApproval'
import type { ThreadStartResponse } from '../src/main/services/providers/codex/protocol/v2/ThreadStartResponse'
import type { Workspace } from '@shared/types'
import { Store } from '../src/main/db'
import { Approvals } from '../src/main/services/approvals'
import { neverAllowed, pushOwnBranch } from '../src/main/services/permissions'
import { Sessions } from '../src/main/services/sessions'
import type { AppSettings } from '../src/main/services/settings'
import { tempRepo } from './helpers'

// KERNEL-433: how a permission decision reaches the user on the pinned Claude Code (SDK 0.3.292) and the pinned Codex
// (0.153.4). Each probe talks to the CLI straight, not through Kernel, in a temp repo, and records whether Kernel would
// have been asked. docs/decisions/KERNEL-433.md holds the draft answers these tests check. Model turns on the maintainer's plans, so
// they run only when asked:
//   KERNEL_LIVE=1 KERNEL_LIVE_CODEX=1 pnpm test test/live.permissions.test.ts
// Leave KERNEL_LIVE_CODEX out to run only the Claude probes. KERNEL_LIVE_MODEL (Haiku 4.5) runs the bypass and plan probes,
// KERNEL_LIVE_AUTO_MODEL (Sonnet 5.5) the auto ones, KERNEL_LIVE_CODEX_MODEL (gpt-5.6-luna) the Codex ones. The evidence
// goes to KERNEL_LIVE_OUT, else kernel-live-permissions.json in the temp folder.
//
// Every probe answers ask or deny, never allow, and runs nothing that matters: `touch` on a file in a temp folder, and a
// stub MCP server that only logs its calls. No probe tries the SDK's critical-path `rm`. A wrong reading there would delete
// real files, and the decision doesn't depend on it.
// Codex runs on a temp CODEX_HOME that links auth.json from ~/.codex, so the probe's MCP server and rules never touch it.

const live = !!process.env.KERNEL_LIVE
const liveCodex = live && !!process.env.KERNEL_LIVE_CODEX
const MODEL = process.env.KERNEL_LIVE_MODEL ?? 'claude-haiku-4-5-20251001'
const AUTO_MODEL = process.env.KERNEL_LIVE_AUTO_MODEL ?? 'claude-sonnet-5-5'
const CODEX_MODEL = process.env.KERNEL_LIVE_CODEX_MODEL ?? 'gpt-5.6-luna'

const MARK = 'kernel-probe-433'
const TOUCH = `touch ${MARK}.txt`
const RUN_TOUCH = `Use the Bash tool to run this exact command, once, and nothing else: ${TOUCH}\nIf it is refused or fails, don't retry. Reply "done".`
const CALL_TOOL = (tool: string) => `Call the ${tool} tool of the probe MCP server once, with no arguments, and nothing else. If it is refused, don't retry. Reply "done".`
const DENY = 'The probe denies every call it is asked about. Stop and reply "done".'

const evidence: Record<string, unknown> = {}
afterAll(async () => {
  if (!Object.keys(evidence).length) return
  const out = process.env.KERNEL_LIVE_OUT ?? join(tmpdir(), 'kernel-live-permissions.json')
  await writeFile(out, JSON.stringify(evidence, null, 2))
  console.log(`[live] permissions evidence: ${out}`)
})

/** Kernel's Always ask guard as `kernelHooks` returns it in claude.ts, for Bash. */
const askBash: Options['hooks'] = {
  PreToolUse: [{ matcher: 'Bash', hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'On the Always ask list in Kernel.' } })] }]
}

/** Kernel's Never allow guard, the same way. */
const denyBash: Options['hooks'] = {
  PreToolUse: [{ matcher: 'Bash', hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Kernel blocks "${TOUCH}" in every project.` } })] }]
}

/** The same command as an ask rule, the way a project's Always ask list would reach the session through `Options.settings`. */
const askRule: Settings = { permissions: { ask: [`Bash(${TOUCH})`] } }

// --- Claude Code ---

describe.skipIf(!live)('live permissions on Claude Code', () => {
  // KERNEL-447: the two @alpha SDK calls behind admin policy, and the models Claude Code says run Auto, matched to Kernel's
  // model ids. No model turn: the settings are read from disk, and the models from Claude Code's initialize answer.
  it("reads admin policy, and knows which of Kernel's models run Auto", { timeout: 120_000 }, async () => {
    const cwd = await tempRepo()
    try {
      const policy = await claudePolicy(cwd)
      const models = await claudeModels(cwd, { env: {} })
      evidence.policyAndModels = { policy, models: models.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel, supportsAutoMode: m.supportsAutoMode })) }
      expect(models.length, "Claude Code's initialize answer listed no models").toBeGreaterThan(0)
      expect(supportsAuto(models, AUTO_MODEL), `no model row matches ${AUTO_MODEL}, so Kernel would never run Auto on it. Check supportsAuto against the rows in the evidence`).not.toBeUndefined()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('Q1: a hook ask in bypassPermissions', { timeout: 300_000 }, async () => {
    const r = await claude({ mode: 'bypassPermissions', prompt: RUN_TOUCH, hooks: askBash })
    evidence.q1HookAskBypass = r
    tried(r, 'Bash')
    expect(asked(r, 'Bash'), 'Q1 draft: bypass approves a hook ask and canUseTool never sees it. It did, so update the Q1 answer in KERNEL-433.md').toBe(false)
  })

  // Not one of the eight questions: Never allow, network off and protected-branch pushes stop in bypass only if this holds.
  it('Bypass: a hook deny holds in bypassPermissions', { timeout: 300_000 }, async () => {
    const r = await claude({ mode: 'bypassPermissions', prompt: RUN_TOUCH, hooks: denyBash })
    evidence.hookDenyBypass = r
    tried(r, 'Bash')
    expect(r.ran, 'a hook deny let the command run in bypass, so Never allow does not hold there').toBe(false)
  })

  it('Q2: a hook ask in auto', { timeout: 300_000 }, async () => {
    const r = await claude({ mode: 'auto', prompt: RUN_TOUCH, hooks: askBash })
    evidence.q2HookAskAuto = r
    tried(r, 'Bash')
    expect(r.denied.filter((d) => d.tool === 'Bash'), 'Q2: the classifier denied the call instead of asking').toEqual([])
    expect(asked(r, 'Bash'), 'Q2 draft: a hook ask in auto reaches canUseTool. It did not, so Always ask in Auto needs A2').toBe(true)
    expect(r.ran, 'Q2: the command ran although canUseTool denied it').toBe(false)
  })

  for (const mode of ['bypassPermissions', 'auto'] as const) {
    it(`Q3: setMcpPermissionModeOverride('default') in ${mode}`, { timeout: 300_000 }, async () => {
      const r = await claude({ mode, prompt: CALL_TOOL('probe_write'), mcp: true, override: 'default' })
      evidence[`q3Override_${mode}`] = r
      tried(r, 'mcp__probe__probe_write')
      expect(asked(r, 'mcp__probe__probe_write'), `Q3 draft: the override sends the server's calls to canUseTool in ${mode}`).toBe(true)
      expect(r.ran, 'Q3: the MCP tool ran although canUseTool denied it').toBe(false)
    })

    it(`Q4: an ask rule in Options.settings in ${mode}`, { timeout: 300_000 }, async () => {
      const r = await claude({ mode, prompt: RUN_TOUCH, settings: askRule })
      evidence[`q4AskRule_${mode}`] = r
      tried(r, 'Bash')
      expect(r.denied.filter((d) => d.tool === 'Bash'), 'Q4: the classifier denied the call instead of asking').toEqual([])
      expect(asked(r, 'Bash'), `Q4 draft: an ask rule from Options.settings reaches canUseTool in ${mode}`).toBe(true)
      expect(r.ran, 'Q4: the command ran although canUseTool denied it').toBe(false)
    })
  }

  it('Q5: AskUserQuestion in bypassPermissions', { timeout: 300_000 }, async () => {
    const r = await claude({ mode: 'bypassPermissions', prompt: 'Use the AskUserQuestion tool once to ask me whether I prefer tea or coffee, with those two options. Then reply "done".' })
    evidence.q5QuestionBypass = r
    tried(r, 'AskUserQuestion')
    expect(asked(r, 'AskUserQuestion'), 'Q5 draft: AskUserQuestion reaches canUseTool in bypass').toBe(true)
  })

  it('Q5: plan approval in a chat that leaves plan mode for bypass', { timeout: 300_000 }, async () => {
    const r = await claude({ mode: 'plan', allowBypass: true, prompt: 'Plan, in one line, how you would create a file named hello.txt, then call ExitPlanMode with that plan. If the plan is refused, stop and reply "done".' })
    evidence.q5PlanBypass = r
    tried(r, 'ExitPlanMode')
    expect(asked(r, 'ExitPlanMode'), 'Q5 draft: ExitPlanMode reaches canUseTool when the session may bypass').toBe(true)
    expect(existsSync(join(r.cwd, 'hello.txt')), 'Q5: the session left plan mode on its own and wrote the file').toBe(false)
  })
})

interface ClaudeRun {
  mode: PermissionMode
  model: string
  cwd: string
  /** The mode the session reported in its init message. A mode the session can't take shows here. */
  initMode?: string
  /** The override's answer, which warns when no server has the name. */
  override?: { warning?: string }
  /** What canUseTool was called for, with what the CLI said about why. */
  asked: { tool: string; decisionReason?: string; matchedAskRule?: unknown; title?: string }[]
  /** Every tool the model called. */
  tools: string[]
  /** `system/permission_denied`: calls refused without asking, by the classifier, a rule or the mode. */
  denied: { tool: string; type?: string; reason?: string }[]
  /** `permission_denials` from the result. */
  denials: string[]
  /** Whether the probe's side effect happened: the touched file, or a logged MCP call. */
  ran: boolean
  result?: string
}

async function claude(o: { mode: PermissionMode; prompt: string; hooks?: Options['hooks']; settings?: Settings; mcp?: boolean; override?: 'default' | 'auto'; allowBypass?: boolean }): Promise<ClaudeRun> {
  const model = o.mode === 'auto' ? AUTO_MODEL : MODEL
  const cwd = await tempRepo()
  const log = join(cwd, '.git', 'probe-calls.log')
  const input = new InputQueue<SDKUserMessage>()
  const abort = new AbortController()
  const r: ClaudeRun = { mode: o.mode, model, cwd, asked: [], tools: [], denied: [], denials: [], ran: false }
  const canUseTool: CanUseTool = async (tool, _input, opts) => {
    r.asked.push({ tool, decisionReason: opts.decisionReason, matchedAskRule: opts.matchedAskRule, title: opts.title })
    return { behavior: 'deny', message: DENY }
  }
  const q = query({
    prompt: input,
    options: {
      cwd, model, permissionMode: o.mode,
      ...(o.mode === 'bypassPermissions' || o.allowBypass ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool,
      // None of the user's own settings, so a global allow list or ask rule can't answer for the CLI.
      settingSources: [],
      persistSession: false,
      maxTurns: 4,
      abortController: abort,
      env: sessionEnv(process.env, {}),
      ...(o.hooks ? { hooks: o.hooks } : {}),
      ...(o.settings ? { settings: o.settings } : {}),
      // Loaded up front, so the model calls the tool without a tool search first.
      ...(o.mcp ? { mcpServers: { probe: { ...await probeServer(cwd, log), alwaysLoad: true } } } : {})
    }
  })
  const done = (async () => {
    for await (const m of q) {
      note(r, m)
      if (m.type === 'result') { input.close(); return }
    }
  })()
  try {
    await within(q.initializationResult(), 60_000, 'Claude Code to start')
    if (o.override) r.override = await q.setMcpPermissionModeOverride('probe', o.override)
    input.push(toUserMessage([{ type: 'text', text: o.prompt }]))
    await within(done, 240_000, 'the turn to end')
    r.ran = existsSync(join(cwd, `${MARK}.txt`)) || (existsSync(log) && (await readFile(log, 'utf8')).trim() !== '')
    console.log(`[live] ${o.mode}: ${JSON.stringify({ asked: r.asked.map((a) => a.tool), tools: r.tools, denied: r.denied, ran: r.ran })}`)
    expect(r.initMode, `the session didn't start in ${o.mode}${o.mode === 'auto' ? `: set KERNEL_LIVE_AUTO_MODEL to a model with auto mode` : ''}`).toBe(o.mode)
    return r
  } finally {
    input.close()
    abort.abort()
    await rm(cwd, { recursive: true, force: true })
  }
}

function note(r: ClaudeRun, m: SDKMessage) {
  if (m.type === 'system' && m.subtype === 'init') r.initMode = m.permissionMode
  else if (m.type === 'system' && m.subtype === 'permission_denied') r.denied.push({ tool: m.tool_name, type: m.decision_reason_type, reason: m.decision_reason })
  else if (m.type === 'assistant') {
    for (const b of m.message.content) if (b.type === 'tool_use') r.tools.push(b.name)
  } else if (m.type === 'result') {
    r.result = m.subtype
    r.denials = m.permission_denials.map((d) => d.tool_name)
  }
}

const asked = (r: ClaudeRun, tool: string) => r.asked.some((a) => a.tool === tool)
const tried = (r: ClaudeRun, tool: string) => expect(r.tools, `the model never called ${tool}, so this probe answers nothing`).toContain(tool)

// --- Codex ---

describe.skipIf(!liveCodex)('live permissions on Codex app-server', () => {
  it("Q6: auto_review under on-request decides an escalation, and Kernel isn't asked", { timeout: 300_000 }, async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kernel-probe-outside-'))
    try {
      const r = await codex({ policy: 'on-request', reviewer: 'auto_review', prompt: `Run this exact shell command once: touch ${join(outside, `${MARK}.txt`)}\nIf the sandbox blocks it, ask for escalated permissions and run it once more. Then reply "done".` })
      evidence.q6AutoReviewEscalation = r
      expect(r.reviews.length, 'Q6: no auto-review ran, so this probe answers nothing (did the model ask to escalate?)').toBeGreaterThan(0)
      expect(r.requests.filter((q) => q.method === 'item/commandExecution/requestApproval'), 'Q6 draft: the reviewer decides and Kernel gets no request').toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("Q6: auto_review under on-request takes a command a `prompt` rule marks, so Always ask can't reach the user", { timeout: 300_000 }, async () => {
    const rules = `prefix_rule(pattern = ["touch", "${MARK}.txt"], decision = "prompt", justification = "On the Always ask list in Kernel.")\n`
    const r = await codex({ policy: 'on-request', reviewer: 'auto_review', rules, prompt: `Run this exact shell command once, and nothing else: ${TOUCH}\nIf it is refused, don't retry. Reply "done".` })
    evidence.q6AutoReviewPromptRule = r
    expect(r.reviews.length + r.requests.length, "Q6: the prompt rule never fired (no review, no request), so this probe answers nothing. Check that Codex reads rules/default.rules").toBeGreaterThan(0)
    expect(r.requests.filter((q) => q.method === 'item/commandExecution/requestApproval'), 'Q6 draft: under auto_review even a `prompt` rule goes to the reviewer. It reached Kernel, so Auto on Codex can keep Always ask: update KERNEL-433.md').toEqual([])
  })

  for (const policy of ['on-request', 'never'] as const) {
    it(`Q7: a command inside the sandbox under ${policy} runs without asking Kernel`, { timeout: 300_000 }, async () => {
      const r = await codex({ policy, prompt: `Run this exact shell command once, and nothing else: ${TOUCH}\nThen reply "done".` })
      evidence[`q7Sandboxed_${policy}`] = r
      expect(r.commands.some((c) => c.includes(MARK)), 'Q7: the model never ran the command, so this probe answers nothing').toBe(true)
      expect(r.requests, `Q7 draft: under ${policy} Kernel gets no request for a command the sandbox allows`).toEqual([])
      expect(r.ran, 'Q7: the command should have run in the sandbox').toBe(true)
    })
  }

  const granular: AskForApproval = { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } }
  for (const [name, policy] of [['untrusted', 'untrusted'], ['granular', granular]] as const) {
    it(`Q8: a call to a user MCP server from CODEX_HOME under ${name} asks Kernel`, { timeout: 300_000 }, async () => {
      const r = await codex({ policy, mcp: true, prompt: CALL_TOOL('probe_write') })
      evidence[`q8Mcp_${name}`] = r
      expect(r.mcpCalls.some((c) => c.server === 'probe') || r.requests.length > 0, 'Q8: the model never called the probe server, so this probe answers nothing').toBe(true)
      expect(r.requests.filter((q) => q.method === 'mcpServer/elicitation/request'), `Q8 draft: the call reaches Kernel as an elicitation under ${name}. It didn't, so D5 on Codex leaves unlisted servers out`).not.toEqual([])
      expect(r.ran, 'Q8: the tool ran although Kernel declined it').toBe(false)
    })
  }

  it('Q8: a read-only tool of a user MCP server under untrusted (recorded, not checked)', { timeout: 300_000 }, async () => {
    const r = await codex({ policy: 'untrusted', mcp: true, prompt: CALL_TOOL('probe_read') })
    evidence.q8McpReadOnly = r
    expect(r.mcpCalls.some((c) => c.server === 'probe') || r.requests.length > 0, 'Q8: the model never called the probe server, so this probe answers nothing').toBe(true)
  })
})

// --- Kernel's Codex runner in Bypass permissions (KERNEL-447) ---

describe.skipIf(!liveCodex)("live Bypass permissions through Kernel's Codex runner", () => {
  it('accepts a command outside the sandbox, and declines Never allow and a push that might reach main, with no card', { timeout: 300_000 }, async () => {
    const bin = bundledCodex()
    expect(bin, 'the pinned @openai/codex package has no binary for this Mac').toBeTruthy()
    const home = await mkdtemp(join(tmpdir(), 'kernel-probe-codex-home-'))
    const data = await mkdtemp(join(tmpdir(), 'kernel-probe-447-data-'))
    const outside = await mkdtemp(join(tmpdir(), 'kernel-probe-447-outside-'))
    const cwd = await tempRepo()
    const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
    expect(existsSync(auth), `Codex isn't signed in with a file login at ${auth}`).toBe(true)
    await symlink(auth, join(home, 'auth.json'))
    const never = 'touch kernel-probe-447-never.txt'
    const store = new Store(join(data, 'kernel.db'))
    const ws: Workspace = { id: 'ws', projectId: 'project', name: 'probe', branch: 'feat/probe', baseRef: 'main', path: cwd, mode: 'worktree', agentId: 'sean', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
    store.saveWorkspace(ws)
    store.saveChat({ id: 'chat', workspaceId: 'ws', title: 'Probe', kind: 'chat', provider: 'codex', model: CODEX_MODEL, effort: 'low', plan: false, createdAt: 1 })
    const settings = { permissions: { mode: 'bypassPermissions', bypassOnlyInWorktrees: true, network: true, alwaysAsk: ['touch'], neverAllow: [never], protectedBranches: ['main'], approvalTimeoutSec: 300 }, providers: { codex: { path: bin, useSystem: false, personality: 'pragmatic' } } } as unknown as AppSettings
    const sessions = new Sessions({
      store, approvals: new Approvals(store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined, envFor: () => ({ ...process.env }) as Record<string, string>,
      projectAllow: () => [], allowInProject: () => undefined, codexFor: () => ({ bin: bin!, home, personality: 'pragmatic', tools: [] })
    })
    try {
      await sessions.send('chat', [{ type: 'text', text: `Run these shell commands one at a time, each exactly once, and nothing else:\n1. touch ${join(outside, `${MARK}.txt`)}\n2. ${never}\n3. git push\nIf one is refused or fails, go on to the next. Then reply "done".` }])
      await within((async () => { while (sessions.isRunning('chat')) await new Promise((r) => setTimeout(r, 200)) })(), 240_000, 'the turn to end')
      const items = store.items('chat')
      const notes = items.flatMap((i) => (i.kind === 'note' ? [i.text] : []))
      const commands = items.flatMap((i) => (i.kind === 'tool' && i.name === 'Bash' ? [i.detail] : []))
      const r = { commands, notes, cards: store.approvals({}).length, outside: existsSync(join(outside, `${MARK}.txt`)), never: existsSync(join(cwd, 'kernel-probe-447-never.txt')) }
      evidence.codexBypassThroughKernel = r
      console.log(`[live] codex bypass through Kernel: ${JSON.stringify(r)}`)
      expect(commands.length, 'the model ran no command, so this probe answers nothing').toBeGreaterThan(0)
      expect(r.cards, 'Bypass permissions put a card in front of the user').toBe(0)
      expect(r.outside, 'Bypass permissions should accept a command outside the sandbox (Always ask on `touch` gives no opinion there)').toBe(true)
      expect(r.never, 'Never allow should hold in Bypass permissions').toBe(false)
      if (commands.some((c) => c.includes('kernel-probe-447-never'))) expect(notes).toContain(neverAllowed(never))
      if (commands.some((c) => /\bgit push\b/.test(c))) expect(notes).toContain(pushOwnBranch(['main'], 'feat/probe'))
    } finally {
      sessions.stopAll()
      store.db.close()
      await rm(home, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

interface CodexRun {
  policy: AskForApproval
  reviewer?: ApprovalsReviewer
  model: string
  /** Every request Codex sent the client, each answered decline, cancel or nothing granted. */
  requests: { method: string; command?: string | null; reason?: string | null; serverName?: string; message?: string; meta?: unknown }[]
  /** auto-review and guardian notifications. */
  reviews: { method: string; status?: string; rationale?: string | null; action?: unknown }[]
  /** Commands Codex started, from `item/started`. */
  commands: string[]
  mcpCalls: { server: string; tool: string; status: string }[]
  /** Whether the probe's side effect happened: the touched file in the workspace, or a logged MCP call. */
  ran: boolean
  error?: string
}

async function codex(o: { policy: AskForApproval; reviewer?: ApprovalsReviewer; prompt: string; rules?: string; mcp?: boolean }): Promise<CodexRun> {
  const bin = bundledCodex()
  expect(bin, 'the pinned @openai/codex package has no binary for this Mac').toBeTruthy()
  const home = await mkdtemp(join(tmpdir(), 'kernel-probe-codex-home-'))
  const cwd = await tempRepo()
  const log = join(home, 'probe-calls.log')
  const r: CodexRun = { policy: o.policy, reviewer: o.reviewer, model: CODEX_MODEL, requests: [], reviews: [], commands: [], mcpCalls: [], ran: false }
  const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
  expect(existsSync(auth), `Codex isn't signed in with a file login at ${auth}`).toBe(true)
  await symlink(auth, join(home, 'auth.json'))
  if (o.mcp) {
    const server = await probeServer(home, log)
    await writeFile(join(home, 'config.toml'), [
      '[mcp_servers.probe]',
      `command = ${JSON.stringify(server.command)}`,
      `args = ${JSON.stringify(server.args)}`,
      `env = { ${Object.entries(server.env ?? {}).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }`,
      ''
    ].join('\n'))
  }
  if (o.rules) {
    await mkdir(join(home, 'rules'))
    await writeFile(join(home, 'rules', 'default.rules'), o.rules)
  }
  const child = spawn(bin!, ['app-server'], { cwd, env: codexEnv(process.env, home), stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-4000) })
  let ended: () => void = () => undefined
  const turnEnded = new Promise<void>((resolve) => { ended = resolve })
  const rpc = new Rpc(child.stdin, child.stdout, {
    notify: (method, params) => {
      const item = params?.item
      if (method === 'item/started' && item?.type === 'commandExecution') r.commands.push(String(item.command ?? ''))
      else if (method === 'item/completed' && item?.type === 'mcpToolCall') r.mcpCalls.push({ server: item.server, tool: item.tool, status: item.status })
      else if (method.startsWith('item/autoApprovalReview/') || method === 'guardianWarning' || method === 'autoApprovalReview/strictReviewRequired') {
        r.reviews.push({ method, status: params?.review?.status, rationale: params?.review?.rationale ?? params?.message, action: params?.action })
      } else if (method === 'error') r.error = String(params?.error?.message ?? JSON.stringify(params))
      else if (method === 'turn/completed') ended()
    },
    request: async (method, params) => {
      r.requests.push({ method, command: params?.command, reason: params?.reason, serverName: params?.serverName, message: params?.message, meta: params?._meta })
      switch (method) {
        case 'item/commandExecution/requestApproval': return { decision: 'decline' }
        case 'item/fileChange/requestApproval': return { decision: 'decline' }
        case 'item/permissions/requestApproval': return { permissions: {}, scope: 'turn' }
        case 'mcpServer/elicitation/request': return { action: 'decline', content: null, _meta: null }
        case 'item/tool/requestUserInput': return { answers: {} }
        default: throw new RpcError(`The probe can't answer ${method}.`, -32601)
      }
    }
  })
  try {
    await within(rpc.request('initialize', initializeParams(KERNEL_VERSION)), 60_000, 'Codex to start')
    rpc.notify('initialized', {})
    const { thread } = await within(rpc.request<ThreadStartResponse>('thread/start', { cwd, model: CODEX_MODEL, approvalPolicy: o.policy, ...(o.reviewer ? { approvalsReviewer: o.reviewer } : {}), sandbox: 'workspace-write', ephemeral: true }), 60_000, 'the thread to start')
    await within(rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: o.prompt, text_elements: [] }], approvalPolicy: o.policy, ...(o.reviewer ? { approvalsReviewer: o.reviewer } : {}) }), 60_000, 'the turn to start')
    await within(turnEnded, 240_000, 'the turn to end')
    r.ran = existsSync(join(cwd, `${MARK}.txt`)) || (existsSync(log) && (await readFile(log, 'utf8')).trim() !== '')
    console.log(`[live] codex ${JSON.stringify(o.policy)}${o.reviewer ? ` ${o.reviewer}` : ''}: ${JSON.stringify({ requests: r.requests.map((q) => q.method), reviews: r.reviews.map((v) => `${v.method}:${v.status ?? ''}`), commands: r.commands, mcpCalls: r.mcpCalls, ran: r.ran, error: r.error })}`)
    return r
  } catch (e) {
    throw new Error(`${(e as Error).message}${stderr.trim() ? `\nCodex stderr: ${stderr.trim().slice(-1000)}` : ''}`)
  } finally {
    rpc.close()
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
    // rm removes the auth.json link, never the file it points to.
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
}

// --- Shared ---

/**
 * A stdio MCP server with two tools that do nothing but log their name to `log`: `probe_write`, with no annotations, which
 * MCP reads as a tool that may change things, and `probe_read`, marked read-only. It runs on this process's own Node
 * (Electron's under `pnpm test`, D-013).
 */
async function probeServer(dir: string, log: string): Promise<McpStdioServerConfig> {
  const file = join(dir, '.git', 'probe-mcp.mjs')
  await mkdir(join(dir, '.git'), { recursive: true })
  await writeFile(file, PROBE_SERVER)
  return { type: 'stdio', command: process.execPath, args: [file], env: { ELECTRON_RUN_AS_NODE: '1', PROBE_LOG: log } }
}

const PROBE_SERVER = `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const empty = { type: 'object', properties: {} }
const tools = [
  { name: 'probe_write', description: 'Kernel probe. Logs that it was called and changes nothing else.', inputSchema: empty },
  { name: 'probe_read', description: 'Kernel probe. Logs that it was called and reads nothing.', inputSchema: empty, annotations: { readOnlyHint: true } }
]
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined) return
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } } })
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools } })
  if (m.method === 'tools/call') {
    appendFileSync(process.env.PROBE_LOG, String(m.params?.name) + '\\n')
    return send({ id: m.id, result: { content: [{ type: 'text', text: 'probe ok' }] } })
  }
  if (m.method === 'ping') return send({ id: m.id, result: {} })
  send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
})
`

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms) })])
  } finally {
    clearTimeout(timer)
  }
}
