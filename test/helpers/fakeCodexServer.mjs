// A stand-in for `codex app-server` (KERNEL-406): JSON-RPC over stdio, one message per line. Every message it gets, and
// every answer to its own requests, goes to the log in FAKE_CODEX_LOG, one JSON line each, for the test to read.
//
// A turn plays the script in its first text input, a JSON array of steps:
//   { "notify": method, "params": {...} }   a notification, `$turn` and `$thread` in strings become the ids
//   { "request": method, "params": {...} }  a request to Kernel, waiting for its answer
//   { "complete": "completed" | "failed" | "interrupted", "error": {...} }   the turn's end
//   { "wait": "interrupt" }                 waits for turn/interrupt, then ends the turn as interrupted
// Input that isn't a script ends the turn at once with a short reply.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = (entry) => { if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(entry) + '\n') }
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
let next = 1000
const pending = new Map()
const request = (method, params) => new Promise((resolve) => { const id = next++; pending.set(id, resolve); send({ id, method, params }) })
let threads = 0
let turns = 0
let interrupted

const ids = (v, turn, thread) => JSON.parse(JSON.stringify(v).replaceAll('$turn', turn).replaceAll('$thread', thread))

async function play(threadId, turnId, script) {
  for (const step of script) {
    if (step.notify) send({ method: step.notify, params: ids(step.params ?? {}, turnId, threadId) })
    else if (step.request) { const answer = await request(step.request, ids(step.params ?? {}, turnId, threadId)); log({ answer: step.request, result: answer }) }
    else if (step.wait === 'interrupt') { await new Promise((r) => { interrupted = r }); return complete(threadId, turnId, 'interrupted') }
    else if (step.complete) return complete(threadId, turnId, step.complete, step.error)
  }
  complete(threadId, turnId, 'completed')
}

function complete(threadId, turnId, status, error = null) {
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
    send({ id, result: { turn: { id: turnId, items: [], status: 'inProgress' } } })
    send({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turnId } } })
    let script
    try { script = JSON.parse(params.input?.[0]?.text ?? '') } catch { script = [{ notify: 'item/completed', params: { item: { type: 'agentMessage', id: `msg-${turnId}`, text: 'Done.', phase: 'final_answer' } } }] }
    void play(params.threadId, turnId, Array.isArray(script) ? script : [])
    return
  }
  if (method === 'turn/interrupt') { send({ id, result: {} }); interrupted?.(); interrupted = undefined; return }
  if (method === 'account/rateLimits/read') return send({ id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1791734191 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1792320991 }, rateLimitReachedType: null } } })
  if (method === 'account/read') return send({ id, result: { account: { type: 'chatgpt', email: 'cj@example.com', planType: 'plus' }, requiresOpenaiAuth: true } })
  if (method === 'thread/compact/start') return send({ id, result: {} })
  send({ id, result: {} })
})
