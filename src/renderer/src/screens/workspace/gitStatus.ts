import type { ChangedFile } from '@shared/types'

export type GitStatus = ChangedFile['status']

/** `color` is the letter's, and `nameColor` the file name's: a modified file's name stays as it is and only its letter goes muted (Pen 9.3, KERNEL-1096). */
export interface GitDecoration { letter: string; label: string; color: string; nameColor: string; struck: boolean }

const DECORATION: Record<GitStatus, GitDecoration> = {
  M: { letter: 'M', label: 'Modified', color: 'var(--muted)', nameColor: 'inherit', struck: false },
  A: { letter: 'A', label: 'Added', color: 'var(--add)', nameColor: 'var(--add)', struck: false },
  D: { letter: 'D', label: 'Deleted', color: 'var(--del)', nameColor: 'var(--del)', struck: true },
  R: { letter: 'R', label: 'Renamed', color: 'var(--add)', nameColor: 'var(--add)', struck: false },
  '?': { letter: 'U', label: 'Untracked', color: 'var(--add)', nameColor: 'var(--add)', struck: false }
}

/** How VS Code marks a changed file: its letter (untracked shows U), the color of its name and letter, and a line through a deleted name (KERNEL-399). */
export const gitDecoration = (s?: GitStatus): GitDecoration | undefined => (s ? DECORATION[s] : undefined)

const RANK: Record<GitStatus, number> = { M: 4, D: 3, R: 2, A: 1, '?': 1 }

/** The status a folder shows for the changes inside it: modified over deleted over the rest, so a folder with an edited file never reads red. */
export const strongest = (a: GitStatus | undefined, b: GitStatus): GitStatus => (a && RANK[a] >= RANK[b] ? a : b)
