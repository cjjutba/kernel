import { spawn } from 'node:child_process'
import { NO_PROMPTS } from '../../exec'
import { initializeParams, Rpc, type RpcHandlers } from './rpc'
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse'
import type { GetAccountRateLimitsResponse } from './protocol/v2/GetAccountRateLimitsResponse'
import type { LoginAccountParams } from './protocol/v2/LoginAccountParams'
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

/** The ChatGPT account a Codex home is signed in to, with its rate limits. Never throws: a failed read is signed out. */
export async function readCodexAccount(bin: string, home: string | undefined): Promise<{ account: GetAccountResponse['account']; limits?: GetAccountRateLimitsResponse }> {
  try {
    return await withCodex(bin, home, async (rpc) => {
      const { account } = await rpc.request<GetAccountResponse>('account/read', { refreshToken: false })
      const limits = account ? await rpc.request<GetAccountRateLimitsResponse>('account/rateLimits/read').catch(() => undefined) : undefined
      return { account, limits }
    })
  } catch { return { account: null } }
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

/** "ChatGPT Plus" for the plan Codex reports. */
export function codexPlan(planType: string | null | undefined): string | undefined {
  if (!planType || planType === 'unknown') return undefined
  return `ChatGPT ${planType[0].toUpperCase()}${planType.slice(1)}`
}
