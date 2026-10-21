// Records a live provider session as a replay file for test/providerReplay.test.ts (test/fixtures/replay/README.md). It drives
// the real Claude Agent SDK or the real `codex app-server` through one turn and writes every message as an NDJSON frame.
// It spends a real turn on the account, so it never runs in CI and refuses to start without KERNEL_LIVE=1. Runs on plain Node
// with built-in type stripping, so only erasable TypeScript here.
//
//   KERNEL_LIVE=1 node scripts/record-replay.ts <claude|codex> <scenario> --prompt "..." [options]
//
//   --prompt <text>          the user's message (required)
//   --description <text>     the header's description (default: the scenario's name)
//   --cwd <folder>           where the agent works (default: the current folder). Use a throwaway repo
//   --model <id>             the model (default: the provider's own)
//   --resume <id>            a Claude session id or Codex thread id to resume
//   --deny                   decline every approval (default: allow it)
//   --interrupt-after <n>    interrupt the turn after the provider's n-th message
//   --codex <path>           the codex binary (default: `codex` on PATH)
//   --out <file>             where to write (default: test/fixtures/replay/<provider>-<scenario>.ndjson)
//   --timeout <seconds>      give up after this long (default 300)
//
// The frames the provider sends are kept as they came. What the recorder itself sends is cut to the fields Kernel's own
// requests share (model, thread, input), since a replay checks those and nothing else. Read the file before you commit it: it
// holds the paths, ids and text of a real session. Keep the scenario small, and edit out what a test should not depend on.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

type Frame = Record<string, unknown>

const [provider, scenario, ...rest] = process.argv.slice(2)
const flags = new Map<string, string>()
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) throw new Error(`Unexpected argument ${rest[i]}`)
  const next = rest[i + 1]
  flags.set(rest[i].slice(2), next === undefined || next.startsWith('--') ? 'true' : (i++, next))
}

if (process.env.KERNEL_LIVE !== '1') throw new Error('This spends a real turn on your account. Set KERNEL_LIVE=1 to record.')
if ((provider !== 'claude' && provider !== 'codex') || !scenario) throw new Error('Usage: KERNEL_LIVE=1 node scripts/record-replay.ts <claude|codex> <scenario> --prompt "..."')
const prompt = flags.get('prompt')
if (!prompt) throw new Error('--prompt is required')

const cwd = flags.get('cwd') ?? process.cwd()
const model = flags.get('model')
const resume = flags.get('resume')
const deny = flags.has('deny')
const interruptAfter = Number(flags.get('interrupt-after') ?? 0)
const timeoutMs = Number(flags.get('timeout') ?? 300) * 1000
const out = flags.get('out') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'replay', `${provider}-${scenario}.ndjson`)

const frames: Frame[] = []
const timer = setTimeout(() => { save(); throw new Error(`Timed out after ${timeoutMs / 1000}s. What was recorded so far is in ${out}.`) }, timeoutMs)
function save() {
  const header = { provider, scenario, description: flags.get('description') ?? scenario }
  writeFileSync(out, [header, ...frames].map((f) => JSON.stringify(f)).join('\n') + '\n')
}

if (provider === 'claude') await recordClaude()
else await recordCodex()
clearTimeout(timer)
save()
console.log(`Wrote ${frames.length} frames to ${out}`)
process.exit(0)

async function recordClaude() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  frames.push({ dir: 'out', query: { ...(model ? { model } : {}), permissionMode: 'default', ...(resume ? { resume } : {}) } })
  frames.push({ dir: 'out', user: { text: prompt } })
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  // The SDK reads the prompt as a stream, so it stays open until the turn's result.
  async function* input() {
    yield { type: 'user' as const, message: { role: 'user' as const, content: [{ type: 'text' as const, text: prompt! }] }, parent_tool_use_id: null }
    await finished
  }
  const q = query({
    prompt: input(),
    options: {
      cwd, permissionMode: 'default', ...(model ? { model } : {}), ...(resume ? { resume } : {}),
      canUseTool: async (tool, toolInput, { toolUseID }) => {
        frames.push({ dir: 'in', ask: { tool, input: toolInput, toolUseID } })
        const answer = deny ? { behavior: 'deny' as const, message: 'Denied while recording.' } : { behavior: 'allow' as const, updatedInput: toolInput }
        frames.push({ dir: 'out', answer })
        return answer
      }
    }
  })
  let seen = 0
  for await (const msg of q) {
    frames.push({ dir: 'in', msg })
    if (++seen === interruptAfter) { frames.push({ dir: 'out', interrupt: true }); await q.interrupt() }
    if (msg.type === 'result') { finish(); break }
  }
}

async function recordCodex() {
  const child = spawn(flags.get('codex') ?? 'codex', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map<number, (v: any) => void>()
  let next = 1
  // What a replay checks of a request: the fields Kernel's own requests carry too.
  const trim = (method: string, params: any): Record<string, unknown> | undefined => {
    if (method === 'initialize') return { clientInfo: { name: 'kernel' } }
    if (method === 'thread/start') return model ? { model } : undefined
    if (method === 'thread/resume') return { threadId: params.threadId, ...(model ? { model } : {}) }
    if (method === 'turn/start') return { threadId: params.threadId, input: params.input }
    if (method === 'turn/interrupt') return { threadId: params.threadId, turnId: params.turnId }
    return undefined
  }
  const write = (msg: Record<string, unknown>) => child.stdin.write(JSON.stringify(msg) + '\n')
  const request = (method: string, params: Record<string, unknown>) => new Promise<any>((resolve) => {
    const id = next++
    pending.set(id, resolve)
    const shown = trim(method, params)
    frames.push({ dir: 'out', msg: { method, ...(shown ? { params: shown } : {}) } })
    write({ id, method, params })
  })
  const notify = (method: string) => { frames.push({ dir: 'out', msg: { method } }); write({ method, params: {} }) }

  let seen = 0
  let threadId = resume
  let turnId: string | undefined
  const ended = new Promise<void>((resolve) => {
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return
      const msg = JSON.parse(line)
      // An answer carries no id in the recording: the replay gives it the id of the request Kernel is waiting on.
      if (msg.method === undefined) { const { id, ...answer } = msg; frames.push({ dir: 'in', msg: answer }); pending.get(id)?.(msg.result); pending.delete(id); return }
      frames.push({ dir: 'in', msg })
      if (msg.id !== undefined) {
        // A request from Codex: an approval is answered as the flags say, and anything else Kernel would answer is refused.
        const approval = /requestApproval$/.test(msg.method)
        const result = approval ? { decision: deny ? 'decline' : 'accept' } : undefined
        const reply = approval ? { id: msg.id, result } : { id: msg.id, error: { code: -32601, message: `The recorder can't answer ${msg.method}.` } }
        frames.push({ dir: 'out', msg: reply })
        write(reply)
        return
      }
      if (msg.method === 'turn/started') turnId = msg.params?.turn?.id
      if (++seen === interruptAfter && threadId && turnId) void request('turn/interrupt', { threadId, turnId })
      if (msg.method === 'turn/completed') resolve()
    })
    child.once('exit', () => resolve())
  })

  await request('initialize', { clientInfo: { name: 'kernel', title: 'Kernel', version: 'recorder' }, capabilities: { experimentalApi: true } })
  notify('initialized')
  const settings = { cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write', ...(model ? { model } : {}) }
  const thread = resume ? await request('thread/resume', { threadId: resume, ...settings }) : await request('thread/start', settings)
  threadId = thread.thread.id
  await request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(model ? { model } : {}), approvalPolicy: 'untrusted' })
  await ended
  child.kill()
}
