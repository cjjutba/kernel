import { useEffect } from 'react'
import type { Project } from '@shared/types'
import { readSaved, useRemembered } from '../../remember'
import { lastProject } from '../../store'
import { ALL_PROJECTS } from './scope'

const SHARED = 'kernel.workProject'
const LAST_SINGLE = 'kernel.workIssuesProject'
// Rooms were renamed projects (KERNEL-880). Pull requests saved its pick under this name before the two tabs shared one.
const LEGACY_PRS = 'kernel.prsRoom'

/**
 * The one project both Work tabs are narrowed to (KERNEL-1009). Pull requests may be on every project; Issues needs one, so while the
 * shared pick is All projects it uses the last single project it was on, then the first project there is. A saved project that was
 * archived or hidden since reads as All projects on Pull requests. Before the first pick, what Pull requests saved under its old key is used, then the project Issues last used (kernel.lastRoom), so both tabs open on the same one.
 * `routeProjectId` is a project the route names, which becomes the pick.
 */
export function useWorkProject(choices: Project[], routeProjectId?: string) {
  const [saved, setSaved] = useRemembered<string>(SHARED, (raw) => raw ?? readSaved(LEGACY_PRS) ?? lastProject() ?? ALL_PROJECTS)
  const [last, setLast] = useRemembered<string>(LAST_SINGLE, (raw) => raw ?? lastProject() ?? '')
  const pick = (id: string) => { setSaved(id); if (id !== ALL_PROJECTS) setLast(id) }
  const routed = choices.find((r) => r.id === routeProjectId)
  useEffect(() => { if (routed && (saved !== routed.id || last !== routed.id)) pick(routed.id) }, [routed?.id])
  const scope = routed ?? choices.find((r) => r.id === saved)
  const single = scope ?? choices.find((r) => r.id === last) ?? choices[0]
  return { scope, single, pick }
}
