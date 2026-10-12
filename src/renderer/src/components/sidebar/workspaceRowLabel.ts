import type { Workspace } from '@shared/types'

/**
 * What a workspace is called where the sidebar and ⌘K list it: its task title, or its name (the slug made when it was created) when it has none.
 * A review's title is "Review PR #N", so its row reads that. The branch stays in the workspace panel (KERNEL-587).
 */
export const workspaceRowLabel = (ws: Pick<Workspace, 'title' | 'name'>): string => ws.title?.trim() || ws.name
