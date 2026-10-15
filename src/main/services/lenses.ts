import { posix } from 'node:path'
import { REVIEW_KINDS, type AgentDef, type ReviewConfig, type ReviewKind } from '@shared/types'
import { KERNEL_REVIEWER } from '@shared/team'
import { agentFromFile } from './agents'
import code from '../../../docs/lenses/code.md?raw'
import security from '../../../docs/lenses/security.md?raw'
import ux from '../../../docs/lenses/ux.md?raw'

// Review kinds (KERNEL-549): Kernel's own prompt for each, and which kinds a pull request's changed files call for.

/**
 * Kernel's prompt for each review kind, from `docs/lenses`. Bundled into the app rather than read from disk, so a review chat,
 * which picks its prompt as its session starts, always has one.
 */
const FILES: Record<ReviewKind, string> = { code, security, ux }

/** "Code", "Security" or "UX". */
export const kindLabel = (kind: ReviewKind) => REVIEW_KINDS.find((k) => k.id === kind)?.label ?? kind

/**
 * Kernel's own agent for a review kind: its `docs/lenses` file, run under `kernel-reviewer` so a verdict from it names no project
 * agent. It pins no model, so its chat runs on the reviewer role's from Settings, Models.
 */
export function lensAgent(kind: ReviewKind): AgentDef {
  const { model: _model, effort: _effort, ...def } = agentFromFile('', FILES[kind])
  return { ...def, id: KERNEL_REVIEWER, name: `${kindLabel(kind)} review`, role: 'Reviewer', file: '', builtIn: 'reviewer' }
}

/**
 * Whether a repo path is one a `paths` entry names. A glob matches as git paths do (`src/renderer/**`, `**\/*.css`). An entry
 * with no glob character names that file, or every file under that folder, so `src/renderer` and `src/renderer/` work too.
 */
export function inPaths(file: string, paths: string[]): boolean {
  return paths.some((p) => {
    const entry = p.replace(/^\.?\//, '')
    if (/[*?[\]{}]/.test(entry)) return posix.matchesGlob(file, entry)
    const folder = entry.replace(/\/+$/, '')
    return file === folder || file.startsWith(`${folder}/`)
  })
}

/**
 * The kinds a pull request gets, in REVIEW_KINDS' order: each one turned on whose `paths` is empty or names a file the PR
 * changes. `files` undefined means Kernel couldn't read them, and then every kind turned on runs, since a review that should
 * have run and didn't costs more than one that ran for nothing.
 */
export function kindsFor(review: ReviewConfig, files: string[] | undefined): ReviewKind[] {
  return REVIEW_KINDS.map((k) => k.id).filter((kind) => {
    const c = review.kinds[kind]
    return c.enabled && (!c.paths.length || !files || files.some((f) => inPaths(f, c.paths)))
  })
}
