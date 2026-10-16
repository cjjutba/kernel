import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { appendFileSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { hookCommand } from '@shared/hookEntry'

// KERNEL-959: the four Claude Code behaviors a Lead run in the user's terminal depends on, against the real interactive
// `claude` TUI in a pty. It spends a few Sonnet turns on the Claude plan and holds one tool call open for 10 minutes, so it
// only runs when asked:
//   KERNEL_LIVE=1 pnpm test test/terminalLead.live.test.ts
// KERNEL_LIVE_HOLD_MS shortens the held call (600000 by default). KERNEL_LIVE_TOOL_TIMEOUT sets MCP_TOOL_TIMEOUT for it
// (the hold plus 5 minutes by default), and `unset` leaves it out, to see whether Claude Code's default is enough.
// KERNEL_LIVE_OUT names a file for the raw pty output.
// It never touches ~/.claude: Claude Code runs on a temp CLAUDE_CONFIG_DIR and a temp settings file, signed in with the
// Mac's login read from the Keychain and passed as CLAUDE_CODE_OAUTH_TOKEN.

const HOLD_MS = Number(process.env.KERNEL_LIVE_HOLD_MS ?? 600_000)
/** The MCP timeout the held call runs under, in milliseconds as Claude Code reads it. `unset` runs on Claude Code's default. */
const TOOL_TIMEOUT = process.env.KERNEL_LIVE_TOOL_TIMEOUT ?? String(HOLD_MS + 300_000)
const TOKEN = randomBytes(16).toString('hex')
const CHAT_ID = `chat-${randomBytes(4).toString('hex')}`

type Hook = { event: string; body: Record<string, unknown>; headers: IncomingMessage['headers'] }
type Call = { tool: string; args: Record<string, unknown>; auth?: string; at: number }

describe.skipIf(!process.env.KERNEL_LIVE)('terminal Lead mechanics (KERNEL-959)', () => {
  const hooks: Hook[] = []
  const calls: Call[] = []
  const mcpAuth: (string | undefined)[] = []
  /** What the next Stop hook answers. Each one is used once, then Stop goes through. */
  const stopAnswers: object[] = []
  let server: Server
  let port = 0
  let root = ''
  let cwd = ''
  let configDir = ''
  let settingsFile = ''
  let mcpFile = ''
  let oauth = ''

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'kernel-959-')))
    cwd = join(root, 'work')
    configDir = join(root, 'claude')
    execFileSync('mkdir', ['-p', cwd, configDir])
    oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? keychainToken()

    server = createServer(async (req, res) => {
      const url = req.url ?? ''
      if (url.startsWith('/hooks')) {
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const event = String(body.hook_event_name ?? '')
        hooks.push({ event, body, headers: req.headers })
        const answer = event === 'Stop' ? stopAnswers.shift() ?? {} : {}
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer))
        return
      }
      if (url.startsWith('/mcp')) {
        mcpAuth.push(req.headers.authorization)
        if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return }
        // Stateless: a server and transport per request, so a 10 minute call holds only its own.
        const mcp = mcpServer(req.headers.authorization)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => { void transport.close(); void mcp.close() })
        await mcp.connect(transport)
        const raw = await readBody(req)
        await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined)
        return
      }
      res.writeHead(404).end()
    })
    // A held call's response stays open far longer than Node's default timeouts allow a request.
    server.requestTimeout = 0
    server.headersTimeout = 0
    server.timeout = 0
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port

    mcpFile = join(root, 'mcp.json')
    await writeFile(mcpFile, JSON.stringify({
      mcpServers: { kernel: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } } }
    }))
    // Kernel's installed command, with the chat's id sent back from the environment the same way as the build.
    const command = hookCommand(port, 8, TOKEN, 'dev').replace(' --data-binary', ' -H "X-Kernel-Chat: ${KERNEL_CHAT_ID:-}" --data-binary')
    settingsFile = join(root, 'settings.json')
    await writeFile(settingsFile, JSON.stringify({
      permissions: { allow: ['mcp__kernel'] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 10 }] }],
        Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
      }
    }))
    // The first run's theme picker and the folder's trust prompt, already answered.
    await writeFile(join(configDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true } }
    }))
  })

  afterAll(async () => {
    await new Promise((r) => server?.close(r))
    server?.closeAllConnections()
    if (root) await rm(root, { recursive: true, force: true })
  })

  function mcpServer(auth?: string) {
    const mcp = new McpServer({ name: 'kernel', version: '0.0.0' })
    mcp.registerTool('ping', { description: 'Answers pong with a code word.', inputSchema: {} }, async () => {
      calls.push({ tool: 'ping', args: {}, auth, at: Date.now() })
      return { content: [{ type: 'text', text: 'pong, the code word is heliotrope' }] }
    })
    mcp.registerTool('hold', { description: 'Waits a while, then returns a code word.', inputSchema: {} }, async () => {
      calls.push({ tool: 'hold', args: {}, auth, at: Date.now() })
      await new Promise((r) => setTimeout(r, HOLD_MS))
      calls.push({ tool: 'hold:done', args: {}, auth, at: Date.now() })
      return { content: [{ type: 'text', text: 'held, the code word is marmalade' }] }
    })
    mcp.registerTool('mark', { description: 'Records a word.', inputSchema: { word: z.string() } }, async (args) => {
      calls.push({ tool: 'mark', args, auth, at: Date.now() })
      return { content: [{ type: 'text', text: `marked ${args.word}` }] }
    })
    return mcp
  }

  /** The real TUI in a pty, with the chat's id in its environment and the MCP timeout under test. */
  function startClaude(extraEnv: Record<string, string> = {}) {
    const bin = execFileSync('/bin/zsh', ['-lc', 'whence -p claude'], { encoding: 'utf8' }).trim()
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color', COLORTERM: 'truecolor',
      CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_OAUTH_TOKEN: oauth, KERNEL_CHAT_ID: CHAT_ID, KERNEL_BUILD: 'dev',
      DISABLE_AUTOUPDATER: '1', ...extraEnv
    }
    const args = ['--mcp-config', mcpFile, '--strict-mcp-config', '--settings', settingsFile, '--model', 'sonnet']
    const proc = pty.spawn(bin, args, { name: 'xterm-256color', cwd, env, cols: 120, rows: 40 })
    let screen = ''
    proc.onData((d) => {
      screen = (screen + d).slice(-200_000)
      if (process.env.KERNEL_LIVE_OUT) appendFileSync(process.env.KERNEL_LIVE_OUT, d)
    })
    return {
      proc,
      text: () => strip(screen),
      async say(prompt: string) {
        proc.write(prompt)
        await sleep(500)
        proc.write('\r')
      },
      stop() { try { proc.kill() } catch { /* gone */ } }
    }
  }

  it('loads the HTTP MCP server, blocks Stop with a reason and sends the chat id from the hook', { timeout: 300_000 }, async () => {
    const t = startClaude()
    try {
      await waitFor('the TUI to be ready', () => /for shortcuts|\? for/.test(t.text()), 60_000)
      stopAnswers.push({ decision: 'block', reason: 'Before you stop, call the mcp__kernel__mark tool with the word "aubergine".' })
      await t.say('Call the mcp__kernel__ping tool and tell me the code word it returns. Nothing else.')

      // 1. The server loaded with its token, and its tool ran.
      const ping = await waitFor('the ping call', () => calls.find((c) => c.tool === 'ping'), 180_000)
      expect(ping.auth).toBe(`Bearer ${TOKEN}`)
      // 3. The blocked Stop sent Claude back to work on the reason, and the next Stop says a hook continued it.
      const mark = await waitFor('the mark call', () => calls.find((c) => c.tool === 'mark'), 180_000)
      expect(mark.args.word).toBe('aubergine')
      const stops = await waitFor('the second Stop', () => { const s = hooks.filter((h) => h.event === 'Stop'); return s.length >= 2 && s }, 180_000)
      expect(stops[0].body.stop_hook_active).toBe(false)
      expect(stops[1].body.stop_hook_active).toBe(true)
      // 4. The process's KERNEL_CHAT_ID came back on every hook post, with the token and the build.
      for (const h of hooks) {
        expect(h.headers['x-kernel-chat']).toBe(CHAT_ID)
        expect(h.headers['x-kernel-token']).toBe(TOKEN)
        expect(h.headers['x-kernel-build']).toBe('dev')
      }
      expect(hooks.some((h) => h.event === 'UserPromptSubmit')).toBe(true)
      expect(mcpAuth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true)
    } finally {
      t.stop()
    }
  })

  it(`returns a tool call held open for ${HOLD_MS / 60_000} minutes`, { timeout: HOLD_MS + 600_000 }, async () => {
    const t = startClaude(TOOL_TIMEOUT === 'unset' ? {} : { MCP_TOOL_TIMEOUT: TOOL_TIMEOUT })
    try {
      await waitFor('the TUI to be ready', () => /for shortcuts|\? for/.test(t.text()), 60_000)
      const before = hooks.filter((h) => h.event === 'Stop').length
      await t.say('Call the mcp__kernel__hold tool once. It takes a long time; wait for it. Then tell me the code word it returns.')
      const start = await waitFor('the hold call', () => calls.find((c) => c.tool === 'hold'), 180_000)
      await waitFor('the hold to finish', () => calls.find((c) => c.tool === 'hold:done'), HOLD_MS + 60_000)
      const stop = await waitFor('the turn to end', () => hooks.filter((h) => h.event === 'Stop')[before], 300_000)
      expect(calls.filter((c) => c.tool === 'hold')).toHaveLength(1)
      expect(Date.now() - start.at).toBeGreaterThanOrEqual(HOLD_MS)
      // The result reached the model: its last message names the word only the result had.
      expect(String(stop.body.last_assistant_message ?? t.text()).toLowerCase()).toContain('marmalade')
    } finally {
      t.stop()
    }
  })
})

function keychainToken(): string {
  const raw = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' })
  return (JSON.parse(raw) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = ''
    req.setEncoding('utf8').on('data', (c) => { s += c }).on('end', () => resolve(s)).on('error', reject)
  })
}

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]/g, '')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = check()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await sleep(250)
  }
}
