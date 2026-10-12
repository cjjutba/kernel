// A stand-in for `codex app-server` (KERNEL-406): JSON-RPC over stdio, one message per line. Every message it gets, and
// every answer to its own requests, goes to the log in FAKE_CODEX_LOG, one JSON line each, for the test to read.
//
// A turn plays the script in its first text input, a JSON array of steps:
//   { "notify": method, "params": {...} }   a notification, `$turn` and `$thread` in strings become the ids
//   { "request": method, "params": {...} }  a request to Kernel, waiting for its answer
//   { "complete": "completed" | "failed" | "interrupted", "error": {...} }   the turn's end
//   { "wait": "interrupt" }                 waits for turn/interrupt, then ends the turn as interrupted
// FAKE_CODEX_START_MS holds turn/start's answer that long, as a slow Codex does, so Stop can come before the turn has an id.
// turn/interrupt ends the running turn at any step, as Codex 0.153.4 does: a request still waiting for Kernel's answer is
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
    else if (step.complete) return complete(threadId, turnId, step.complete, step.error)
  }
  complete(threadId, turnId, turn.stopped ? 'interrupted' : 'completed')
}

function complete(threadId, turnId, status, error = null) {
  if (running?.turnId === turnId) running = undefined
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], itemsView: 'summary', status, error, startedAt: 1, completedAt: 2, durationMs: 1200 } } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  log(msg)
  if (msg.method === undefined) { pending.get(msg.id)?.(msg.result ?? { error: msg.error }); pending.delete(msg.id); return }
  const { id, method, params } = msg
  if (id === undefined) return
  if (method === 'initialize') return send({ id, result: { userAgent: 'fake', codexHome: process.env.CODEX_HOME ?? '', platformFamily: 'unix', platformOs: 'macos' } })
  if (method === 'thread/start') { const threadId = `thread-${++threads}`; return send({ id, result: { thread: { id: threadId }, model: params.model } }) }
  if (method === 'thread/resume') {
    if (params.threadId === 'gone') return send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } })
    return send({ id, result: { thread: { id: params.threadId }, model: params.model } })
  }
  if (method === 'turn/start') {
    const turnId = `turn-${++turns}`
    let script
    // Text that isn't a script gets one reply, FAKE_CODEX_REPLY or "Done.".
    try { script = JSON.parse(params.input?.[0]?.text ?? '') } catch { script = [{ notify: 'item/completed', params: { item: { type: 'agentMessage', id: `msg-${turnId}`, text: process.env.FAKE_CODEX_REPLY ?? 'Done.', phase: 'final_answer' } } }] }
    const start = () => {
      send({ id, result: { turn: { id: turnId, items: [], status: 'inProgress' } } })
      send({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } })
      void play(params.threadId, turnId, Array.isArray(script) ? script : [])
    }
    const slow = Number(process.env.FAKE_CODEX_START_MS ?? 0)
    if (slow) setTimeout(start, slow)
    else start()
    return
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
  if (method === 'account/rateLimits/read' && apiKey) return send({ id, error: { code: -32600, message: 'chatgpt authentication required to read rate limits' } })
  // FAKE_CODEX_USED sets a home's 5-hour use, by CODEX_HOME and '' for none, with a reset an hour from now (KERNEL-568).
  const used = JSON.parse(process.env.FAKE_CODEX_USED ?? '{}')[home ?? '']
  const primary = used === undefined ? { usedPercent: 40, windowDurationMins: 300, resetsAt: 1791734191 } : { usedPercent: used, windowDurationMins: 300, resetsAt: Math.round(Date.now() / 1000) + 3600 }
  if (method === 'account/rateLimits/read') return send({ id, result: { rateLimits: { limitId: 'codex', primary, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1792320991 }, rateLimitReachedType: null } } })
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
  if (method === 'thread/compact/start') return send({ id, result: {} })
  // Codex's MCP servers, a JSON table in FAKE_CODEX_MCP. `error` fails the request.
  if (method === 'config/read') {
    if (process.env.FAKE_CODEX_MCP === 'error') return send({ id, error: { code: -32603, message: 'failed to load configuration' } })
    return send({ id, result: { config: { mcp_servers: JSON.parse(process.env.FAKE_CODEX_MCP ?? '{}') }, origins: {}, layers: null } })
  }
  send({ id, result: {} })
})
