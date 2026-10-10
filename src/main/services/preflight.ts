import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { exec } from './exec'
import { ghAuth } from './github'
import { packagedClaude } from './sessions'
import type { PreflightCheck } from '@shared/types'

export const MIN_CLAUDE = '2.1.80'

/** Compare dotted versions. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

export function parseClaudeVersion(out: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null
}

/** Something already listening on the port that is not Kernel's hook server. */
export function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

/** First port at or after `from` that nothing is listening on. */
export async function nextFreePort(from: number, busy: (port: number) => Promise<boolean> = portBusy): Promise<number> {
  for (let p = from; p < from + 50; p++) if (!(await busy(p))) return p
  throw new Error(`No free port from ${from} to ${from + 49}`)
}

/** Reads `lsof -Fpc` output (p<pid> then c<command>) into the process listening on a port. */
export function parseLsof(out: string): { pid: number; name: string } | null {
  const pid = /^p(\d+)/m.exec(out)?.[1]
  if (!pid) return null
  return { pid: Number(pid), name: /^c(.+)$/m.exec(out)?.[1] ?? 'unknown' }
}

async function portOwner(port: number, run: typeof exec = exec) {
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { timeoutMs: 5000 })
  return r.code === 0 ? parseLsof(r.stdout) : null
}

/** "max" becomes "Claude Max". An API key login has no plan, so it reads as undefined. */
export function planName(subscriptionType: unknown): string | undefined {
  return typeof subscriptionType === 'string' && subscriptionType ? `Claude ${subscriptionType[0].toUpperCase()}${subscriptionType.slice(1)}` : undefined
}

/** The `claude` binary sessions run: the unpacked copy in a packaged app, or the SDK's own platform package (sessions.ts). */
export function sessionClaude(): string | undefined {
  const packaged = packagedClaude()
  if (packaged) return packaged
  try {
    const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    return createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`)
  } catch { return undefined }
}

/** The official installer from Claude Code's docs (code.claude.com/docs/en/setup). It needs no Node. */
export const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

/** merge-tree --write-tree, which conflictFiles relies on, arrived in git 2.38. */
export const MIN_GIT = '2.38'

/**
 * The checks behind the "Getting Kernel ready" screens, in canvas order with git before the GitHub CLI. Only Claude sign-in,
 * the hook port, a missing git and a broken bundled Claude block (KERNEL-213). Everything else is a warning.
 * `run` and `claude` are for tests: a stubbed command runner and the session binary's path.
 */
export async function runPreflight(o: { hookPort: number; hookServerUp: boolean; agentTeams: boolean; run?: typeof exec; claude?: string | null; nextPort?: (from: number) => Promise<number> }): Promise<PreflightCheck[]> {
  const run = o.run ?? exec
  const checks: PreflightCheck[] = []
  const bin = o.claude === undefined ? sessionClaude() : o.claude
  const v = bin ? await run(bin, ['--version'], { timeoutMs: 15000 }) : null
  const version = v?.code === 0 ? parseClaudeVersion(v.stdout) : null
  if (!version) checks.push({ id: 'claude', ok: false, blocking: true, title: 'Claude Code is missing from Kernel', detail: 'Kernel could not start its own copy of Claude Code. Reinstall Kernel, then check again.' })
  else if (compareVersions(version, MIN_CLAUDE) < 0) checks.push({ id: 'claude', ok: false, blocking: false, title: 'Claude Code is too old', detail: `Found v${version}. Agent teams need v2.1.32 and Channels need v${MIN_CLAUDE} or later. Update Kernel to get a newer one.`, meta: `v${version}` })
  else {
    // Agents use Kernel's copy. The one on PATH is only for the fixes below, like signing in from Terminal.
    const onPath = (await run('claude', ['--version'], { timeoutMs: 15000 })).code === 0
    checks.push(onPath
      ? { id: 'claude', ok: true, blocking: false, title: 'Claude Code', detail: 'Found on your PATH', meta: `v${version}` }
      : { id: 'claude', ok: false, blocking: false, title: 'Claude Code not found', detail: 'Kernel runs agents with its own copy. Install Claude Code to sign in from Terminal.', meta: `v${version}`, fix: { command: CLAUDE_INSTALL } })
  }

  // Signing in is checked with the same binary, so a broken one shows one failure, not two.
  if (bin && version) {
    const a = await run(bin, ['auth', 'status'], { timeoutMs: 15000 })
    let status: { loggedIn?: boolean; subscriptionType?: unknown } = {}
    try { status = JSON.parse(a.stdout) } catch { /* not signed in, or an older CLI */ }
    checks.push(status.loggedIn
      ? { id: 'auth', ok: true, blocking: true, title: 'Signed in', detail: planName(status.subscriptionType) ?? 'Claude account' }
      : { id: 'auth', ok: false, blocking: true, title: 'Not signed in to Claude', detail: 'Agents run on your own Claude plan. Sign in, then check again.', fix: { command: 'claude auth login' } })
  }

  checks.push(o.agentTeams
    ? { id: 'teams', ok: true, blocking: false, title: 'Agent teams', detail: 'Enabled for Kernel sessions' }
    : { id: 'teams', ok: false, blocking: false, title: 'Agent teams are off', detail: 'Kernel turns on CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS for its own sessions only.', fix: { action: 'enable-teams' } })

  checks.push(await gitCheck(run))
  checks.push(await ghCheck(run))

  if (o.hookServerUp) checks.push({ id: 'hooks', ok: true, blocking: true, title: 'Hook server', detail: 'Listening for events', meta: `localhost:${o.hookPort}` })
  else {
    const owner = await portOwner(o.hookPort, run)
    const next = await (o.nextPort ?? nextFreePort)(o.hookPort + 1).catch(() => o.hookPort + 1)
    const who = owner ? `Another process (${owner.name}, pid ${owner.pid})` : 'Another process'
    checks.push({ id: 'hooks', ok: false, blocking: true, title: `Port ${o.hookPort} is taken`, detail: `${who} is using it. Kernel can listen on ${next} and update your hooks.`, fix: { action: 'use-next-port' } })
  }
  return checks
}

/** Every worktree, commit and merge goes through git, so a missing one blocks. An old one only loses conflict lists. */
async function gitCheck(run: typeof exec): Promise<PreflightCheck> {
  const r = await run('git', ['--version'], { timeoutMs: 15000 })
  // "git version 2.39.5 (Apple Git-154)". Without the command line tools, /usr/bin/git exits 1 and macOS offers to install them.
  const version = r.code === 0 ? /git version (\d+\.\d+(?:\.\d+)?)/.exec(r.stdout)?.[1] : undefined
  if (!version) return { id: 'git', ok: false, blocking: true, title: 'Git not found', detail: 'Kernel keeps each agent\'s work in its own git worktree. Install the command line tools, then check again.', fix: { command: 'xcode-select --install' } }
  if (compareVersions(version, MIN_GIT) < 0) return { id: 'git', ok: false, blocking: false, title: 'Git is too old', detail: `Found v${version}. Kernel needs v${MIN_GIT} or later to list a pull request's conflicting files.`, meta: `git ${version}`, fix: { command: 'brew install git' } }
  return { id: 'git', ok: true, blocking: false, title: 'Git', detail: 'Found on your PATH', meta: `git ${version}` }
}

/** gh only matters for pull requests, so every failure here is a warning. */
async function ghCheck(run: typeof exec): Promise<PreflightCheck> {
  const auth = await ghAuth(run)
  if (auth.state === 'missing') return { id: 'gh', ok: false, blocking: false, title: 'GitHub CLI not found', detail: 'Pull requests need gh. Everything else works without it.', fix: { command: 'brew install gh' } }
  if (auth.state === 'signed-out') return { id: 'gh', ok: false, blocking: false, title: 'GitHub CLI is not signed in', detail: 'Kernel uses gh to open and merge pull requests. Everything else works without it.', fix: { command: 'gh auth login' } }
  const gh = await run('gh', ['--version'], { timeoutMs: 10000 })
  const meta = /gh version (\d+\.\d+(?:\.\d+)?)/.exec(gh.stdout)?.[1]
  if (auth.state === 'offline') return { id: 'gh', ok: false, blocking: false, title: 'Can\'t reach GitHub', detail: 'gh is signed in, but GitHub didn\'t answer. Pull requests need it, so check again once you\'re online.', meta: meta && `gh ${meta}` }
  // ConnectRepo reads the login back out of "Signed in as <login>".
  return { id: 'gh', ok: true, blocking: false, title: 'GitHub CLI', detail: auth.login ? `Signed in as ${auth.login}` : 'Signed in', meta: meta && `gh ${meta}` }
}
