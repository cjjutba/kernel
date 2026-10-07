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

/** The +/- lines of a patch, without line numbers or context, so a hunk can be recognised after its context moves. */
const changedLines = (patch: string) => patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).join('\n')

/**
 * HEAD when the workspace started. A baseline from `git stash create` is a commit on top of it (its first parent);
 * a clean tree has no stash, and the baseline is HEAD itself.
 */
async function headAtStart(cwd: string, baselineRef: string): Promise<string> {
  const subject = (await git(cwd, 'log', '-1', '--format=%s', baselineRef)).trim()
  return /^(WIP on|On) /.test(subject) ? (await git(cwd, 'rev-parse', `${baselineRef}^1`)).trim() : baselineRef
}

/**
 * Uncommitted hunks of tracked files. `mine` hunks are changes that predate the workspace (HEAD at start to the baseline
 * snapshot); `agent` hunks are everything since (baseline, or `since` without one, to the working tree). Both ranges are
 * fixed, so a hunk that was committed is dropped by checking it against HEAD to the working tree, not by moving a range.
 */
export async function listHunks(cwd: string, o: { since: string; baselineRef?: string }, path?: string): Promise<Hunk[]> {
  const scope = path ? ['--', path] : []
  const seen = new Map<string, number>()
  const mineAll = o.baselineRef
    ? splitHunks(await git(cwd, 'diff', '--no-color', await headAtStart(cwd, o.baselineRef), o.baselineRef, ...scope), 'mine', seen)
    : []
  const agentAll = splitHunks(await git(cwd, 'diff', '--no-color', o.since, ...scope), 'agent', seen)
  const pending = splitHunks(await git(cwd, 'diff', '--no-color', 'HEAD', ...scope), 'agent', new Map())
  const keys = pending.map((h) => `${h.path}\0${changedLines(h.patch)}`)
  const open = (h: Hunk) => keys.some((k) => k.startsWith(`${h.path}\0`) && k.includes(changedLines(h.patch)))
  const listed = [...agentAll.filter(open), ...mineAll.filter(open)]
  // A change on or next to a line that was already dirty at start merges with it (or rewrites it), so neither range's hunk
  // matches. Whatever is still uncommitted and not covered by a listed hunk is offered as its own agent hunk.
  const covered = (p: Hunk) => listed.some((h) => h.path === p.path && changedLines(p.patch).includes(changedLines(h.patch)))
  const extra = pending.filter((p) => !covered(p)).map((p, i) => ({ ...p, id: `${p.path}#agent#head${i}` }))
  return [...listed, ...extra].sort((a, b) => a.path.localeCompare(b.path) || a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id))
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
