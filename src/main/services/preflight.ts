import { createConnection } from 'node:net'
import { exec } from './exec'
import { ghUser } from './github'
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

async function portOwner(port: number) {
  const r = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { timeoutMs: 5000 })
  return r.code === 0 ? parseLsof(r.stdout) : null
}

/** "max" becomes "Claude Max". An API key login has no plan, so it reads as undefined. */
export function planName(subscriptionType: unknown): string | undefined {
  return typeof subscriptionType === 'string' && subscriptionType ? `Claude ${subscriptionType[0].toUpperCase()}${subscriptionType.slice(1)}` : undefined
}

/** The checks behind the "Getting Kernel ready" screens, in canvas order: Claude Code, sign in, agent teams, GitHub CLI, hook server. */
export async function runPreflight(o: { hookPort: number; hookServerUp: boolean; agentTeams: boolean }): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  const v = await exec('claude', ['--version'], { timeoutMs: 15000 })
  const version = v.code === 0 ? parseClaudeVersion(v.stdout) : null
  if (!version) checks.push({ id: 'claude', ok: false, title: 'Claude Code not found', detail: 'Kernel runs your agents with Claude Code. Install it, then check again.', fix: { command: 'npm install -g @anthropic-ai/claude-code' } })
  else if (compareVersions(version, MIN_CLAUDE) < 0) checks.push({ id: 'claude', ok: false, title: 'Claude Code is too old', detail: `Found v${version}. Agent teams need v2.1.32 and Channels need v${MIN_CLAUDE} or later.`, meta: `v${version}`, fix: { command: 'claude update' } })
  else checks.push({ id: 'claude', ok: true, title: 'Claude Code', detail: 'Found on your PATH', meta: `v${version}` })

  // Signing in needs the CLI, so a missing CLI shows one failure, not two.
  if (version) {
    const a = await exec('claude', ['auth', 'status'], { timeoutMs: 15000 })
    let status: { loggedIn?: boolean; subscriptionType?: unknown } = {}
    try { status = JSON.parse(a.stdout) } catch { /* not signed in, or an older CLI */ }
    checks.push(status.loggedIn
      ? { id: 'auth', ok: true, title: 'Signed in', detail: planName(status.subscriptionType) ?? 'Claude account' }
      : { id: 'auth', ok: false, title: 'Not signed in to Claude', detail: 'Agents run on your own Claude plan. Sign in, then check again.', fix: { command: 'claude auth login' } })
  }

  checks.push(o.agentTeams
    ? { id: 'teams', ok: true, title: 'Agent teams', detail: 'Enabled for Kernel sessions' }
    : { id: 'teams', ok: false, title: 'Agent teams are off', detail: 'Kernel turns on CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS for its own sessions only.', fix: { action: 'enable-teams' } })

  const gh = await exec('gh', ['--version'], { timeoutMs: 10000 })
  const ghVersion = /gh version (\d+\.\d+(?:\.\d+)?)/.exec(gh.stdout)?.[1]
  const user = await ghUser()
  checks.push(user
    ? { id: 'gh', ok: true, title: 'GitHub CLI', detail: `Signed in as ${user}`, meta: ghVersion ? `gh ${ghVersion}` : undefined }
    : { id: 'gh', ok: false, title: 'GitHub CLI is not signed in', detail: 'Kernel uses gh to open and merge pull requests.', fix: { command: 'gh auth login' } })

  if (o.hookServerUp) checks.push({ id: 'hooks', ok: true, title: 'Hook server', detail: 'Listening for events', meta: `localhost:${o.hookPort}` })
  else {
    const owner = await portOwner(o.hookPort)
    const next = await nextFreePort(o.hookPort + 1).catch(() => o.hookPort + 1)
    const who = owner ? `Another process (${owner.name}, pid ${owner.pid})` : 'Another process'
    checks.push({ id: 'hooks', ok: false, title: `Port ${o.hookPort} is taken`, detail: `${who} is using it. Kernel can listen on ${next} and update your hooks.`, fix: { action: 'use-next-port' } })
  }
  return checks
}
