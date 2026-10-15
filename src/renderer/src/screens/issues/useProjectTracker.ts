import { useEffect, useState } from 'react'
import type { ProjectTracker } from '@shared/types'
import { call, cleanError } from '../../api'
import { generation, getTracker, setTracker } from './cache'

export type TrackerRead = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; projectId: string; tracker: ProjectTracker }

const LOADING: TrackerRead = { kind: 'loading' }

const seed = (projectId: string | undefined): TrackerRead => {
  const hit = projectId ? getTracker(projectId) : undefined
  return projectId && hit ? { kind: 'ready', projectId, tracker: hit.value } : LOADING
}

const same = (a: ProjectTracker, b: ProjectTracker) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The tracker a project uses, read when the project changes (KERNEL-471). Main works it out on every call, so a change in the project's
 * settings shows the next time a screen opens. The last answer shows at once and the read behind it swaps it only when it differs (KERNEL-892).
 * An answer for another project is never handed back as this project's: it reads as loading.
 */
export function useProjectTracker(projectId: string | undefined): { read: TrackerRead; retry: () => void } {
  const [answer, setAnswer] = useState<TrackerRead>(() => seed(projectId))
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!projectId) return
    let live = true
    const gen = generation()
    const first = seed(projectId)
    setAnswer((a) => (first.kind === 'ready' && a.kind === 'ready' && a.projectId === projectId && same(a.tracker, first.tracker) ? a : first))
    call('issues.tracker', { projectId }).then(
      (tracker) => {
        setTracker(projectId, tracker, gen)
        if (live) setAnswer((a) => (a.kind === 'ready' && a.projectId === projectId && same(a.tracker, tracker) ? a : { kind: 'ready', projectId, tracker }))
      },
      (e) => { if (live) setAnswer((a) => (a.kind === 'ready' && a.projectId === projectId ? a : { kind: 'error', message: cleanError(e) })) }
    )
    return () => { live = false }
  }, [projectId, tries])
  const read: TrackerRead = answer.kind === 'ready' && answer.projectId !== projectId ? LOADING : answer
  return { read, retry: () => setTries((n) => n + 1) }
}
