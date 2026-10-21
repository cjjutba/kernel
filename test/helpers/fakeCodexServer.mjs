// A stand-in for `codex app-server` (KERNEL-406): JSON-RPC over stdio, one message per line. Every message it gets, and
// every answer to its own requests, goes to the log in FAKE_CODEX_LOG, one JSON line each, for the test to read.
//
// A turn plays the script in its first text input, a JSON array of steps:
//   { "notify": method, "params": {...} }   a notification, `$turn` and `$thread` in strings become the ids
//   { "request": method, "params": {...} }  a request to Kernel, waiting for its answer
//   { "complete": "completed" | "failed" | "interrupted", "error": {...} }   the turn's end
//   { "wait": "interrupt" }                 waits for turn/interrupt, then ends the turn as interrupted
//   { "limit": true }                       the account hits its 5-hour limit: account/rateLimits/updated says the window is
//                                           full, and the turn ends failed with usageLimitExceeded, as Codex 0.153.4 does. The
//                                           home stays full for every later account/rateLimits/read, from any process
//   { "complete": ..., "withStart": true }  as the first step: turn/start's answer, turn/started and turn/completed go out
//                                           in one write, so Kernel reads them in one chunk (KERNEL-625)
// FAKE_CODEX_START_MS holds turn/start's answer that long, as a slow Codex does, so Stop can come before the turn has an id.
// turn/steer is answered for the running turn (see below). turn/interrupt ends the running turn at any step, as Codex 0.153.4 does: a request still waiting for Kernel's answer is
// cleared with serverRequest/resolved, and the turn completes as interrupted (KERNEL-563).
// Input that isn't a script ends the turn at once with a short reply.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const log = (entry) => { if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + '\n') }
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
let next = 1000
const pending = new Map()
const request = (method, params, turn) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); if (turn) turn.open = id; send({ id, method, params }) })
// What the process started with: its home, its arguments, whether an API key reached its environment (KERNEL-523), and
// its pid, for a test to kill it.
log({ started: process.env.CODEX_HOME ?? null, cwd: process.cwd(), args: process.argv.slice(2), keyInEnv: !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY), pid: process.pid })
const home = process.env.CODEX_HOME
// Started with `-c cli_auth_credentials_store="ephemeral"`, an API key login stays in memory, as Codex 0.153.4 does it.
const ephemeral = process.argv.includes('cli_auth_credentials_store="ephemeral"')
let apiKey
let threads = 0
let turns = 0
/** The turn playing its script: its ids, the request it waits on, and whether turn/interrupt stopped it. */
let running
const CLEARED = Symbol('cleared')

/** A 5-hour window `used` percent full, resetting in an hour, and the snapshot Codex sends with it. */
const full = (used = 100) => ({ usedPercent: used, windowDurationMins: 300, resetsAt: Math.round(Date.now() / 1000) + 3600 })
const snapshot = (primary) => ({ limitId: 'codex', primary, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1792320991 }, rateLimitReachedType: null })
/** A `limit` step filled this home, in this process or another: the log says so. */
const limitedHere = () => {
  if (!process.env.FAKE_CODEX_LOG) return false
  return readFileSync(process.env.FAKE_CODEX_LOG, 'utf8').split('\n').some((l) => l && JSON.parse(l).limited === (home ?? ''))
}

const ids = (v, turn, thread) => JSON.parse(JSON.stringify(v).replaceAll('$turn', turn).replaceAll('$thread', thread))

async function play(threadId, turnId, script) {
  const turn = (running = { threadId, turnId, stopped: false, open: undefined, wake: undefined })
  for (const step of script) {
    if (turn.stopped) break
    if (step.notify) send({ method: step.notify, params: ids(step.params ?? {}, turnId, threadId) })
    else if (step.request) {
      const answer = await request(step.request, ids(step.params ?? {}, turnId, threadId), turn)
      turn.open = undefined
      if (answer === CLEARED) break
      log({ answer: step.request, result: answer })
    }
    else if (step.wait === 'interrupt') { if (!turn.stopped) await new Promise((r) => { turn.wake = r }); break }
    else if (step.limit) {
      log({ limited: home ?? '' })
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { ...snapshot(full()), rateLimitReachedType: 'rate_limit_reached' } } })
      return complete(threadId, turnId, 'failed', { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null })
    }
    else if (step.complete) return complete(threadId, turnId, step.complete, step.error)
  }
  complete(threadId, turnId, turn.stopped ? 'interrupted' : 'completed')
}

const completed = (threadId, turnId, status, error = null) => ({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], itemsView: 'summary', status, error, startedAt: 1, completedAt: 2, durationMs: 1200 } } })

function complete(threadId, turnId, status, error = null) {
  if (running?.turnId === turnId) running = undefined
  send(completed(threadId, turnId, status, error))
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  log(msg)
  if (msg.method === undefined) { pending.get(msg.id)?.(msg.result ?? { error: msg.error }); pending.delete(msg.id); return }
  const { id, method, params } = msg
  if (id === undefined) return
  if (method === 'initialize') return send({ id, result: { userAgent: 'fake', codexHome: process.env.CODEX_HOME ?? '', platformFamily: 'unix', platformOs: 'macos' } })
  if (method === 'thread/start') {
    const threadId = `thread-${++threads}`
    send({ id, result: { thread: { id: threadId }, model: params.model } })
    // How each MCP server starts on a thread, a JSON table by CODEX_HOME ('' for none) of name to `{ status, error }` in
    // FAKE_CODEX_MCP_STARTUP: each says it is starting, then how it ended, as Codex 0.153.4 does (KERNEL-646).
    const startup = Object.entries(JSON.parse(process.env.FAKE_CODEX_MCP_STARTUP ?? '{}')[home ?? ''] ?? {})
    const note = (name, status, error = null) => send({ method: 'mcpServer/startupStatus/updated', params: { threadId, name, status, error, failureReason: null } })
    for (const [name] of startup) note(name, 'starting')
    setTimeout(() => { for (const [name, s] of startup) if (s.status !== 'starting') note(name, s.status, s.error ?? null) }, 20)
    return
  }
  if (method === 'thread/resume') {
    if (params.threadId === 'gone') return send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } })
    return send({ id, result: { thread: { id: params.threadId }, model: params.model } })
  }
  if (method === 'turn/start') {
    const turnId = `turn-${++turns}`
    // Which home ran the turn, for a test of where a chat runs (KERNEL-844).
    log({ turnOn: home ?? null, text: params.input?.[0]?.text ?? '' })
    let script
    // Text that isn't a script gets one reply, FAKE_CODEX_REPLY or "Done.".
    try { script = JSON.parse(params.input?.[0]?.text ?? '') } catch { script = [{ notify: 'item/completed', params: { item: { type: 'agentMessage', id: `msg-${turnId}`, text: process.env.FAKE_CODEX_REPLY ?? 'Done.', phase: 'final_answer' } } }] }
    const start = () => {
      const answer = { id, result: { turn: { id: turnId, items: [], status: 'inProgress' } } }
      const started = { method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } }
      const first = Array.isArray(script) ? script[0] : undefined
      if (first?.withStart) return void process.stdout.write([answer, started, completed(params.threadId, turnId, first.complete)].map((m) => JSON.stringify(m) + '\n').join(''))
      send(answer)
      send(started)
      void play(params.threadId, turnId, Array.isArray(script) ? script : [])
    }
    const slow = Number(process.env.FAKE_CODEX_START_MS ?? 0)
    if (slow) setTimeout(start, slow)
    else start()
    return
  }
  // turn/steer adds input to the running turn when expectedTurnId names it, as Codex does, and answers with its id. Any other id, or
  // FAKE_CODEX_NO_STEER (a turn that can't be steered), is refused.
  // FAKE_CODEX_STEER_HANG takes the message and never answers, as a Codex that accepted it too late to reply.
  if (method === 'turn/steer') {
    if (process.env.FAKE_CODEX_STEER_HANG) return
    if (process.env.FAKE_CODEX_NO_STEER || !running || running.stopped || running.turnId !== params.expectedTurnId) return send({ id, error: { code: -32600, message: 'expected active turn id does not match the active turn' } })
    return send({ id, result: { turnId: running.turnId } })
  }
  if (method === 'turn/interrupt') {
    send({ id, result: {} })
    const turn = running
    if (!turn || turn.stopped) return
    turn.stopped = true
    if (turn.open !== undefined) {
      const open = turn.open
      pending.get(open)?.(CLEARED)
      pending.delete(open)
      send({ method: 'serverRequest/resolved', params: { threadId: turn.threadId, requestId: open } })
      log({ cleared: open })
    }
    turn.wake?.()
    return
  }
  if (method === 'account/rateLimits/read' && process.env.FAKE_CODEX_LIMITS_FAIL) return send({ id, error: { code: -32603, message: 'rate limits unavailable' } })
  if (method === 'account/rateLimits/read' && apiKey) return send({ id, error: { code: -32600, message: 'chatgpt authentication required to read rate limits' } })
  // FAKE_CODEX_USED sets a home's 5-hour use, by CODEX_HOME and '' for none, with a reset an hour from now (KERNEL-568). A home
  // a `limit` step filled reads full.
  const used = JSON.parse(process.env.FAKE_CODEX_USED ?? '{}')[home ?? ''] ?? (limitedHere() ? 100 : undefined)
  const primary = used === undefined ? { usedPercent: 40, windowDurationMins: 300, resetsAt: 1791734191 } : full(used)
  if (method === 'account/rateLimits/read') return send({ id, result: { rateLimits: snapshot(primary) } })
  // Signed in when the home has an auth.json, as Codex reads it. Without CODEX_HOME the fake counts as signed in. A home's
  // ChatGPT login is the email its auth.json names, so each added account is its own (KERNEL-616).
  if (method === 'account/read' && apiKey) return send({ id, result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } })
  if (method === 'account/read') {
    let auth = {}
    try { auth = home ? JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8')) : {} } catch { /* none */ }
    return send({ id, result: { account: !home || existsSync(join(home, 'auth.json')) ? { type: 'chatgpt', email: auth.email ?? process.env.FAKE_CODEX_EMAIL ?? 'cj@example.com', planType: 'plus' } : null, requiresOpenaiAuth: true } })
  }
  // The browser step happens at once: the fake writes the account's auth.json and says the login finished.
  // An API key login checks nothing and finishes at once. Without the ephemeral store it writes the key to auth.json.
  if (method === 'account/login/start' && params.type === 'apiKey') {
    apiKey = params.apiKey
    if (home && !ephemeral) writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }))
    send({ id, result: { type: 'apiKey' } })
    return send({ method: 'account/login/completed', params: { loginId: null, success: true, error: null } })
  }
  if (method === 'account/login/start') {
    send({ id, result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/oauth/authorize?fake=1' } })
    if (process.env.FAKE_CODEX_LOGIN !== 'wait') setTimeout(() => { if (home) writeFileSync(join(home, 'auth.json'), JSON.stringify({ email: process.env.FAKE_CODEX_LOGIN_EMAIL ?? 'chatgpt@example.com' })); send({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } }) }, 20)
    return
  }
  if (method === 'account/login/cancel') { send({ id, result: {} }); return send({ method: 'account/login/completed', params: { loginId: 'login-1', success: false, error: 'canceled' } }) }
  if (method === 'account/logout') { if (home) rmSync(join(home, 'auth.json'), { force: true }); return send({ id, result: {} }) }
  // Codex's models, the ids in FAKE_CODEX_MODELS (KERNEL-624).
  if (method === 'model/list') return send({ id, result: { data: JSON.parse(process.env.FAKE_CODEX_MODELS ?? '[]').map((m) => ({ id: m, model: m, displayName: m, description: '', hidden: false, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' })), nextCursor: null } })
  // Compacting runs as a turn of its own, as Codex 0.153.4 does it, and leaves the thread at FAKE_CODEX_COMPACTED tokens (KERNEL-844).
  if (method === 'thread/compact/start') {
    send({ id, result: {} })
    log({ compactedOn: home ?? null })
    const turnId = `turn-${++turns}`
    const compaction = { type: 'contextCompaction', id: `compact-${process.pid}-${turnId}` }
    const size = Number(process.env.FAKE_CODEX_COMPACTED ?? 2000)
    const last = { totalTokens: size, inputTokens: size, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
    send({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } })
    send({ method: 'item/started', params: { item: compaction } })
    send({ method: 'item/completed', params: { item: compaction } })
    send({ method: 'thread/tokenUsage/updated', params: { threadId: params.threadId, turnId, tokenUsage: { total: last, last, modelContextWindow: 272000 } } })
    send(completed(params.threadId, turnId, 'completed'))
    return
  }
  // Each home's MCP servers for `mcpServerStatus/list`, a JSON table by CODEX_HOME ('' for none) in FAKE_CODEX_MCP_STATUS (KERNEL-626).
  if (method === 'mcpServerStatus/list') return send({ id, result: { data: JSON.parse(process.env.FAKE_CODEX_MCP_STATUS ?? '{}')[home ?? ''] ?? [], nextCursor: null } })
  // Codex's MCP OAuth (KERNEL-646): the page at once, then the login completes. A server named in FAKE_MCP_FAIL fails with
  // Codex's reason, FAKE_CODEX_MCP_LOGIN=wait never completes, and FAKE_CODEX_MCP_NO_OAUTH refuses the server outright.
  if (method === 'mcpServer/oauth/login') {
    if (process.env.FAKE_CODEX_MCP_NO_OAUTH === params.name) return send({ id, error: { code: -32600, message: `OAuth login is only supported for streamable HTTP servers.` } })
    send({ id, result: { authorizationUrl: `https://${params.name}.example.com/authorize?client=codex` } })
    if (process.env.FAKE_CODEX_MCP_LOGIN === 'wait') return
    const failed = process.env.FAKE_MCP_FAIL === params.name
    setTimeout(() => send({ method: 'mcpServer/oauthLogin/completed', params: { name: params.name, threadId: null, success: !failed, ...(failed ? { error: 'access denied' } : {}) } }), 20)
    return
  }
  // Codex's MCP servers, a JSON table in FAKE_CODEX_MCP. `error` fails the request.
  if (method === 'config/read') {
    if (process.env.FAKE_CODEX_MCP === 'error') return send({ id, error: { code: -32603, message: 'failed to load configuration' } })
    return send({ id, result: { config: { mcp_servers: JSON.parse(process.env.FAKE_CODEX_MCP ?? '{}') }, origins: {}, layers: null } })
  }
  send({ id, result: {} })
})
