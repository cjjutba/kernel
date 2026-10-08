import type { Workspace } from '@shared/types'
import type { IconName } from '../../icons'

/** The colors a workspace's sidebar icon takes. Green, red and purple mean what they mean in a diff and on GitHub. */
export type GlyphTone = 'muted' | 'ink' | 'add' | 'del' | 'merged'

export interface WorkspaceGlyph {
  /** `spin` draws the spinner instead of an icon. */
  icon: IconName | 'spin'
  tone: GlyphTone
  /** Read out with the row's name, since the icon carries the state. */
  label: string
}

const spin = (label: string): WorkspaceGlyph => ({ icon: 'spin', tone: 'muted', label })

/**
 * The icon in front of a workspace in the sidebar: what waits on you first, then what is running, then the pull request.
 * Every input is a real signal: a pending approval, a running chat, setup's status, the PR state from GitHub.
 */
export function workspaceGlyph(ws: Workspace, o: { needsYou: boolean; running: boolean }): WorkspaceGlyph {
  if (o.needsYou) return { icon: 'question', tone: 'ink', label: 'Needs you' }
  if (ws.status === 'failed') return { icon: 'warning', tone: 'del', label: 'Setup failed' }
  if (ws.status === 'setup') return spin('Setting up')
  if (o.running) return spin('Working')
  switch (ws.prState) {
    case 'creating': return spin('Creating PR')
    case 'resolving': return spin('Resolving')
    case 'merging': return spin('Merging')
    case 'ready': return { icon: 'pr', tone: 'add', label: 'Ready to merge' }
    case 'open': return { icon: 'pr', tone: 'add', label: 'PR open' }
    case 'checks': return { icon: 'pr', tone: 'muted', label: 'Checks running' }
    case 'conflict': return { icon: 'pr', tone: 'del', label: 'Merge conflicts' }
    case 'cifail': return { icon: 'pr', tone: 'del', label: 'Checks failed' }
    case 'changes': return { icon: 'pr', tone: 'del', label: 'Changes requested' }
    case 'draft': return { icon: 'prDraft', tone: 'muted', label: 'Draft PR' }
    case 'merged': return { icon: 'merged', tone: 'merged', label: 'Merged' }
    case 'closed': return { icon: 'prClosed', tone: 'muted', label: 'PR closed' }
    case 'none': return { icon: 'branch', tone: 'muted', label: ws.stat?.files ? 'No PR yet' : 'No changes yet' }
  }
}
