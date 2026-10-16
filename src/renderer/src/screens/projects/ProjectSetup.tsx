import { useEffect } from 'react'
import { go } from '../../store'

/**
 * The full-screen project setup is gone (KERNEL-948): setup shows as rows on the project's New chat page instead. A route to the
 * old screen, from an older dialog or a saved place, opens that New chat.
 */
export function ProjectSetup({ projectId }: { projectId?: string }) {
  useEffect(() => { go({ name: 'leadNew', projectId: projectId ?? '' }, { history: 'replace' }) }, [projectId])
  return null
}
