import type { Hunk } from '@shared/types'
import { exec, git } from './exec'

/**
 * Split `git diff` text into one patch per hunk. Each patch carries its file header, so it applies on its own.
 */
export function splitHunks(diff: string, owner: Hunk['owner'], seen: Map<string, number>): Hunk[] {
  const out: Hunk[] = []
  for (const block of diff.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git'))) {
    const at = block.search(/^@@ /m)
    if (at < 0) continue
    const header = block.slice(0, at)
    const path = /^\+\+\+ b\/(.+)$/m.exec(header)?.[1] ?? /^--- a\/(.+)$/m.exec(header)?.[1]
    if (!path) continue
    for (const body of block.slice(at).split(/^(?=@@ )/m).filter(Boolean)) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(body)
      if (!m) continue
      const start = Number(m[3]), len = m[4] === undefined ? 1 : Number(m[4])
      const lines = body.split('\n').slice(1)
      const n = seen.get(`${path}#${owner}`) ?? 0
      seen.set(`${path}#${owner}`, n + 1)
      out.push({
        id: `${path}#${owner}#${n}`, path, owner,
        lines: len <= 1 ? String(start) : `${start}-${start + len - 1}`,
        added: lines.filter((l) => l.startsWith('+')).length,
        removed: lines.filter((l) => l.startsWith('-')).length,
        patch: header + body.replace(/\n*$/, '\n')
      })
    }
  }
  return out
}

/**
 * Hunks of tracked files. `mine` hunks are changes that predate the workspace (HEAD to the baseline snapshot);
 * `agent` hunks are everything since. Without a baseline every hunk is the agent's.
 */
export async function listHunks(cwd: string, o: { since: string; baselineRef?: string; head?: string }, path?: string): Promise<Hunk[]> {
  const scope = path ? ['--', path] : []
  const seen = new Map<string, number>()
  const mine = o.baselineRef && o.baselineRef !== (o.head ?? 'HEAD')
    ? splitHunks(await git(cwd, 'diff', '--no-color', o.head ?? 'HEAD', o.baselineRef, ...scope), 'mine', seen)
    : []
  const agent = splitHunks(await git(cwd, 'diff', '--no-color', o.since, ...scope), 'agent', seen)
  return [...agent, ...mine].sort((a, b) => a.path.localeCompare(b.path) || a.owner.localeCompare(b.owner))
}

/** Commit exactly the picked hunks. The index starts from HEAD, so anything else stays in the working tree. */
export async function commitHunks(cwd: string, hunks: Hunk[], message: string): Promise<void> {
  if (!hunks.length) throw new Error('Pick at least one change to commit.')
  await git(cwd, 'reset', '-q')
  for (const h of hunks) {
    const r = await exec('git', ['-C', cwd, 'apply', '--cached', '--recount', '--whitespace=nowarn', '-'], { input: h.patch })
    if (r.code !== 0) throw new Error(`Could not stage ${h.path} lines ${h.lines}: ${r.stderr.trim()}`)
  }
  await git(cwd, 'commit', '-q', '-m', message)
}
