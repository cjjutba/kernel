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

/** The checks behind the "Getting Kernel ready" screens. */
export async function runPreflight(o: { hookPort: number; hookServerUp: boolean }): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = []
  const v = await exec('claude', ['--version'], { timeoutMs: 15000 })
  const version = v.code === 0 ? parseClaudeVersion(v.stdout) : null
  if (!version) checks.push({ id: 'claude', ok: false, title: 'Claude Code not found', detail: 'Kernel runs your agents with Claude Code. Install it, then check again.', fix: { command: 'npm install -g @anthropic-ai/claude-code' } })
  else if (compareVersions(version, MIN_CLAUDE) < 0) checks.push({ id: 'claude', ok: false, title: 'Claude Code is too old', detail: `Found v${version}. Kernel needs v${MIN_CLAUDE} or later.`, fix: { command: 'claude update' } })
  else checks.push({ id: 'claude', ok: true, title: 'Claude Code', detail: `v${version}` })

  const user = await ghUser()
  checks.push(user ? { id: 'gh', ok: true, title: 'GitHub CLI', detail: `Signed in as ${user}` } : { id: 'gh', ok: false, title: 'GitHub CLI is not signed in', detail: 'Kernel uses gh to open and merge pull requests.', fix: { command: 'gh auth login' } })

  if (o.hookServerUp) checks.push({ id: 'hooks', ok: true, title: 'Hook server', detail: `Listening on localhost:${o.hookPort}` })
  else checks.push({ id: 'hooks', ok: false, title: `Port ${o.hookPort} is taken`, detail: 'Another process is using it. Kernel can listen on the next port and update your hooks.', fix: { action: 'use-next-port' } })
  return checks
}
