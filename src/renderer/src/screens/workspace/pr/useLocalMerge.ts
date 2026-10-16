import { useMemo } from 'react'
import type { PrInfo, Workspace } from '@shared/types'
import { useStore } from '../../../store'
import { stripRemote } from '../../settings/remote'
import { localStand, type LocalStand } from './model'

/** A branch that merges on the Mac as the window sees it: where it stands, the branch it merges into and what git last said. */
export interface LocalMergeState { stand: LocalStand; base: string; info?: PrInfo }

/**
 * The workspace's local merge, or nothing when its project merges through GitHub (KERNEL-478). Every place a local merge shows reads this
 * one state, so the band, the merge line, the sidebar icon and the chat row can't disagree.
 */
export function useLocalMerge(ws: Pick<Workspace, 'projectId' | 'id' | 'prState' | 'baseRef'> | undefined): LocalMergeState | undefined {
  const local = useStore((s) => !!ws && s.projects.find((r) => r.id === ws.projectId)?.host === 'local')
  const info = useStore((s) => (ws ? s.prs[ws.id] : undefined))
  const prState = ws?.prState
  const baseRef = ws?.baseRef
  return useMemo(() => (local && prState ? { stand: localStand(prState, info), base: info?.baseRef || stripRemote(baseRef ?? '', 'origin'), info } : undefined), [local, prState, baseRef, info])
}
