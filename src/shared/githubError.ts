import type { GitHubErrorKind } from './types'

// A GitHub read that fails in main reaches the window as an ordinary IPC error. Electron passes only the error's string,
// "<name>: <message>", so the kind travels in the name (KERNEL-861).

const KINDS: readonly GitHubErrorKind[] = ['signed-out', 'not-found', 'rate-limited', 'offline', 'other']

/** The error name main gives a GitHub failure of `kind`. */
export const githubErrorName = (kind: GitHubErrorKind) => `GitHubError[${kind}]`

/** The name as it shows at the front of a failed call's message, for the text a person reads. */
export const GITHUB_ERROR_PREFIX = /GitHubError\[[a-z-]+\]: /

/** The kind of a failed GitHub call, from the error the window got. Undefined for an error that isn't a GitHub failure. */
export function githubErrorKind(e: unknown): GitHubErrorKind | undefined {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === 'string' ? e : ''
  const kind = /GitHubError\[([a-z-]+)\]/.exec(text)?.[1] as GitHubErrorKind | undefined
  return kind && KINDS.includes(kind) ? kind : undefined
}
