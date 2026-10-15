import { spawn } from 'node:child_process'
import { NO_PROMPTS } from '../../exec'
import { initializeParams, Rpc, type RpcHandlers } from './rpc'
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse'
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse'
import type { LoginAccountParams } from './protocol/v2/LoginAccountParams'
import type { ListMcpServerStatusParams } from './protocol/v2/ListMcpServerStatusParams'
import type { McpAuthStatus } from './protocol/v2/McpAuthStatus'
import type { McpServerConnectionStatus } from './protocol/v2/McpServerConnectionStatus'
import type { McpServerOauthLoginCompletedNotification } from './protocol/v2/McpServerOauthLoginCompletedNotification'
import type { McpServerOauthLoginParams } from './protocol/v2/McpServerOauthLoginParams'
import type { McpServerOauthLoginResponse } from './protocol/v2/McpServerOauthLoginResponse'
import type { McpServerStartupState } from './protocol/v2/McpServerStartupState'
import type { McpServerStatusUpdatedNotification } from './protocol/v2/McpServerStatusUpdatedNotification'
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams'
import type { ModelListResponse } from './protocol/v2/ModelListResponse'

// Short `codex app-server` sessions for reads outside a chat: the account, the rate limits, the model list (KERNEL-406).

/** Kernel's own version, for Codex's `initialize`. */
export const KERNEL_VERSION = process.env.npm_package_version ?? '0.0.0'

/**
 * The environment a Codex process runs with: the account's home, no API key from the Mac or the workspace (D-018), and no
 * git prompts. An API key account's key reaches Codex only through `loginWithKey` (KERNEL-523).
 */
export function codexEnv(base: NodeJS.ProcessEnv, home: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...base, ...extra } as Record<string, string>
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  if (home) env.CODEX_HOME = home
  else delete env.CODEX_HOME
  // Codex passes these on to the commands it runs, so a push without a login fails instead of hanging (KERNEL-460).
  return Object.assign(env, NO_PROMPTS)
}

/**
 * `codex app-server` and its arguments. Codex's own login writes an API key to `auth.json` in plain text, so a key account's
 * process keeps its credentials in memory only and logs in with `loginWithKey` (KERNEL-523).
 */
export function appServerArgs(apiKey?: string): string[] {
  return apiKey ? ['app-server', '-c', 'cli_auth_credentials_store="ephemeral"'] : ['app-server']
}

/** Logs an API key account's process in, over stdin, right after `initialize`. Nothing for any other account. */
export async function loginWithKey(rpc: Rpc, apiKey: string | undefined, timeoutMs = 20_000) {
  if (apiKey) await rpc.request('account/login/start', { type: 'apiKey', apiKey } satisfies LoginAccountParams, { timeoutMs })
}

/**
 * Starts `codex app-server` with `home` as CODEX_HOME, initializes it, runs `fn`, and stops it. `apiKey` logs an API key
 * account's process in first. A process that doesn't answer within `timeoutMs` is stopped and the call fails.
 */
export async function withCodex<T>(bin: string, home: string | undefined, fn: (rpc: Rpc) => Promise<T>, o: { timeoutMs?: number; handlers?: RpcHandlers; cwd?: string; apiKey?: string } = {}): Promise<T> {
  const child = spawn(bin, appServerArgs(o.apiKey), { cwd: o.cwd, env: codexEnv(process.env, home), stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-2000) })
  const rpc = new Rpc(child.stdin, child.stdout, o.handlers)
  const failed = new Promise<never>((_, reject) => {
    child.once('error', (e) => reject(e))
    child.once('exit', (code) => reject(new Error(`Codex exited (${code ?? 'signal'})${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}`)))
  })
  failed.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Codex did not answer in time.')), o.timeoutMs ?? 20_000) })
  try {
    return await Promise.race([(async () => {
      await rpc.request('initialize', initializeParams(KERNEL_VERSION))
      rpc.notify('initialized', {})
      await loginWithKey(rpc, o.apiKey)
      return fn(rpc)
    })(), failed, late])
  } finally {
    clearTimeout(timer)
    rpc.close()
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
  }
}

/**
 * The ChatGPT account a Codex home is signed in to, with its rate limits. Never throws: a failed read is signed out, with
 * `failed` set, so sign-in health can tell it from Codex saying so (KERNEL-567).
 */
export async function readCodexAccount(bin: string, home: string | undefined): Promise<{ account: GetAccountResponse['account']; limits?: GetAccountRateLimitsResponse; failed?: boolean }> {
  try {
    return await withCodex(bin, home, async (rpc) => {
      const { account } = await rpc.request<GetAccountResponse>('account/read', { refreshToken: false })
      const limits = account ? await rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read').catch(() => undefined) : undefined
      return { account, limits }
    })
  } catch { return { account: null, failed: true } }
}

/** Codex's models with their efforts, from `model/list`, hidden ones left out. `apiKey` is a key account's. */
export async function readCodexModels(bin: string, home: string | undefined, apiKey?: string): Promise<ModelListResponse['data']> {
  return withCodex(bin, home, async (rpc) => {
    const out: ModelListResponse['data'] = []
    let cursor: string | null = null
    do {
      const page: ModelListResponse = await rpc.request<ModelListResponse>('model/list', cursor ? { cursor } : {})
      out.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    return out.filter((m) => !m.hidden)
  }, { apiKey })
}

/**
 * The ids of Codex's older models, which `model/list` doesn't mark: a `gpt-<version>-<name>` model is older when a model of
 * a higher major version is listed, or the same name at a higher version. Ids of another shape are never older.
 */
export function legacyCodexModels(ids: string[]): Set<string> {
  const parsed = ids.flatMap((id) => { const m = /^gpt-(\d+(?:\.\d+)?)-(\w+)$/.exec(id); return m ? [{ id, version: Number(m[1]), name: m[2] }] : [] })
  const major = Math.max(...parsed.map((m) => Math.floor(m.version)))
  return new Set(parsed.filter((m) => Math.floor(m.version) < major || parsed.some((o) => o.name === m.name && o.version > m.version)).map((m) => m.id))
}

/** What Kernel reads of one server in `mcpServerStatus/list`: its tools by name, not what they take, and its plugin. */
export interface CodexMcpServer { name: string; authStatus: McpAuthStatus; runtimeStatus: McpServerConnectionStatus | null; pluginId?: string | null; tools: Record<string, unknown> }

/** How a server's start went on a thread Kernel started to hear it (KERNEL-646). `error` is Codex's own words. */
export interface CodexMcpStartup { status: McpServerStartupState; error?: string }

/**
 * A Codex home's MCP servers from `mcpServerStatus/list`, with their tools and sign-in only (KERNEL-626). Codex starts each
 * server to list its tools, so a slow one can take a while: `timeoutMs` is a minute by default.
 *
 * The list says nothing of why a server has no tools, so when one has none and doesn't wait on a sign-in, Kernel starts an
 * ephemeral thread in `cwd` and hears each server's start (`mcpServer/startupStatus/updated`), which carries Codex's reason
 * for a failure (KERNEL-646). No turn runs and nothing is saved. It waits until every server that started has finished
 * starting, at most `startupMs`. A server Codex never starts on a thread has no entry in `startup`.
 */
export async function readCodexMcp(bin: string, home: string | undefined, o: { timeoutMs?: number; startupMs?: number; cwd?: string } = {}): Promise<{ servers: CodexMcpServer[]; startup: Record<string, CodexMcpStartup> }> {
  const timeoutMs = o.timeoutMs ?? 60_000
  const startupMs = o.startupMs ?? 30_000
  const startup: Record<string, CodexMcpStartup> = {}
  let threadId: string | undefined
  let heard = () => {}
  const notify = (method: string, p: unknown) => {
    if (method !== 'mcpServer/startupStatus/updated') return
    const n = p as McpServerStatusUpdatedNotification
    if (threadId && n.threadId && n.threadId !== threadId) return
    startup[n.name] = { status: n.status, ...(n.error ? { error: n.error } : {}) }
    heard()
  }
  return withCodex(bin, home, async (rpc) => {
    const servers: CodexMcpServer[] = []
    let cursor: string | null = null
    do {
      const page: { data: CodexMcpServer[]; nextCursor: string | null } = await rpc.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) } satisfies ListMcpServerStatusParams, { timeoutMs })
      servers.push(...page.data)
      cursor = page.nextCursor
    } while (cursor)
    const unexplained = servers.some((s) => !Object.keys(s.tools ?? {}).length && s.authStatus !== 'notLoggedIn')
    if (!unexplained) return { servers, startup: {} }
    try {
      const started = await rpc.request<{ thread: { id: string } }>('thread/start', { ephemeral: true, ...(o.cwd ? { cwd: o.cwd } : {}) } satisfies ThreadStartParams, { timeoutMs })
      threadId = started.thread.id
      await new Promise<void>((resolve) => {
        const end = setTimeout(resolve, startupMs)
        // Codex says every server it starts is starting right after the thread starts, so a quiet second means it named them all.
        let quiet = setTimeout(check, 1_000)
        function check() {
          if (Object.values(startup).some((s) => s.status === 'starting')) return
          clearTimeout(end)
          resolve()
        }
        heard = () => { clearTimeout(quiet); quiet = setTimeout(check, 200) }
      })
    } catch { /* the list alone says what it can */ }
    return { servers, startup }
  }, { timeoutMs: timeoutMs + startupMs + 10_000, handlers: { notify }, ...(o.cwd ? { cwd: o.cwd } : {}) })
}

/**
 * Signs one MCP server in on a Codex home through Codex's own MCP OAuth (KERNEL-646): `mcpServer/oauth/login` answers with
 * the page to open, which `onLink` gets, and `mcpServer/oauthLogin/completed` says how it ended. Codex keeps the token in
 * its own store, the Keychain or a file in the home, and nothing of it passes through Kernel. `done` rejects with Codex's
 * reason, on Cancel, or after `timeoutMs`.
 */
export function loginCodexMcp(bin: string, home: string | undefined, server: string, o: { timeoutMs: number; onLink?: (url: string) => void }): { done: Promise<void>; cancel(): void } {
  let finish: (n: McpServerOauthLoginCompletedNotification) => void = () => undefined
  const completed = new Promise<McpServerOauthLoginCompletedNotification>((resolve) => { finish = resolve })
  let cancel!: () => void
  const canceled = new Promise<never>((_, reject) => { cancel = () => reject(new Error('Sign-in canceled.')) })
  canceled.catch(() => undefined)
  const done = withCodex(bin, home, async (rpc) => {
    // `timeoutSecs` is a u64, which ts-rs types as a bigint and the wire carries as a number.
    const params = { name: server, timeoutSecs: Math.ceil(o.timeoutMs / 1000) } satisfies Omit<McpServerOauthLoginParams, 'timeoutSecs'> & { timeoutSecs: number }
    let start: McpServerOauthLoginResponse
    try { start = await Promise.race([rpc.request<McpServerOauthLoginResponse>('mcpServer/oauth/login', params), canceled]) } catch (e) {
      throw (e as Error).message === 'Sign-in canceled.' ? e : new Error(`Codex said: ${(e as Error).message}`)
    }
    o.onLink?.(start.authorizationUrl)
    const end = await Promise.race([completed, canceled])
    if (!end.success) throw new Error(end.error ? `Codex said: ${end.error}` : 'The sign-in did not finish.')
  }, {
    timeoutMs: o.timeoutMs,
    handlers: { notify: (m, p) => { if (m === 'mcpServer/oauthLogin/completed' && (p as McpServerOauthLoginCompletedNotification)?.name === server) finish(p as McpServerOauthLoginCompletedNotification) } }
  }).catch((e: Error) => { throw e.message === 'Codex did not answer in time.' ? new Error('Sign-in took too long, so Kernel stopped waiting.') : e })
  return { done, cancel }
}

/** "ChatGPT Plus" for the plan Codex reports. */
export function codexPlan(planType: string | null | undefined): string | undefined {
  if (!planType || planType === 'unknown') return undefined
  return `ChatGPT ${planType[0].toUpperCase()}${planType.slice(1)}`
}
