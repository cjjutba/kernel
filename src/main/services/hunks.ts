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
 * Uncommitted hunks of tracked files. Every hunk, and its patch, comes from `git diff HEAD`, so a patch always applies to the
 * index `commitHunks` builds from HEAD, whatever was committed before. The ranges only decide the owner: a hunk whose changed
 * lines exactly match one that predates the workspace (HEAD at start to the baseline snapshot) is `mine`, anything else is `agent`.
 * A change within a few lines of an earlier edit merges with it into one `agent` hunk.
 */
export async function listHunks(cwd: string, o: { baselineRef?: string }, path?: string): Promise<Hunk[]> {
  const scope = path ? ['--', path] : []
  const mine = o.baselineRef
    ? splitHunks(await git(cwd, 'diff', '--no-color', await headAtStart(cwd, o.baselineRef), o.baselineRef, ...scope), 'mine', new Map()).map((h) => `${h.path}\0${changedLines(h.patch)}`)
    : []
  const seen = new Map<string, number>()
  return splitHunks(await git(cwd, 'diff', '--no-color', 'HEAD', ...scope), 'agent', new Map()).map((h) => {
    const owner: Hunk['owner'] = mine.includes(`${h.path}\0${changedLines(h.patch)}`) ? 'mine' : 'agent'
    const n = seen.get(`${h.path}#${owner}`) ?? 0
    seen.set(`${h.path}#${owner}`, n + 1)
    return { ...h, owner, id: `${h.path}#${owner}#${n}` }
  }).sort((a, b) => a.path.localeCompare(b.path) || a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id, undefined, { numeric: true }))
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
