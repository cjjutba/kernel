import { useEffect, useState } from 'react'
import type { ProjectTracker } from '@shared/types'
import { call, cleanError } from '../../api'

export type TrackerRead = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; projectId: string; tracker: ProjectTracker }

const LOADING: TrackerRead = { kind: 'loading' }

/**
 * The tracker a project uses, read when the project changes (KERNEL-471). Main works it out on every call, so a change in the project's
 * settings shows the next time a screen opens. An answer for another project is never handed back as this project's: it reads as loading.
 */
export function useProjectTracker(projectId: string | undefined): { read: TrackerRead; retry: () => void } {
  const [answer, setAnswer] = useState<TrackerRead>(LOADING)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!projectId) return
    let live = true
    setAnswer(LOADING)
    call('issues.tracker', { projectId }).then((tracker) => live && setAnswer({ kind: 'ready', projectId, tracker }), (e) => live && setAnswer({ kind: 'error', message: cleanError(e) }))
    return () => { live = false }
  }, [projectId, tries])
  const read: TrackerRead = answer.kind === 'ready' && answer.projectId !== projectId ? LOADING : answer
  return { read, retry: () => setTries((n) => n + 1) }
}
