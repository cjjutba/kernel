import './projectIcon.css'
import { useEffect, useReducer, useState, type CSSProperties } from 'react'
import type { Project } from '@shared/types'
import { call } from '../api'
import { projectLetter } from '../screens/projects/projectInfo'

/**
 * One project icon, drawn everywhere a project shows its letter (KERNEL-253). The image comes from `projects.icon` and is cached by
 * `projectId:at`, so a new icon has a new key and an old one is never shown. It shows in grayscale (CJ's choice, KERNEL-241), and the
 * letter stands in while it loads, when the project has no icon, or when the image can't be read.
 */
const loading = new Map<string, Promise<void>>()
const loaded = new Map<string, string | null>()

const keyOf = (project: Pick<Project, 'id' | 'icon'> | undefined) => (project?.icon ? `${project.id}:${project.icon.at}` : null)

function fetchIcon(projectId: string, key: string) {
  let p = loading.get(key)
  if (!p) {
    // A project only needs its newest image, so older keys for it go.
    for (const k of [...loaded.keys(), ...loading.keys()]) if (k.startsWith(`${projectId}:`) && k !== key) { loaded.delete(k); loading.delete(k) }
    // An icon that changed while this read was out has dropped its key from `loading`, so the late answer isn't kept.
    const read: Promise<void> = call('projects.icon', { projectId }).then((url) => { if (loading.get(key) === read) loaded.set(key, url) })
    p = read
    // A failed read isn't cached, so the next mount asks again.
    p.catch(() => loading.delete(key))
    loading.set(key, p)
  }
  return p
}

export function useProjectIcon(project: Pick<Project, 'id' | 'icon'> | undefined): string | null {
  const [, update] = useReducer((n: number) => n + 1, 0)
  const key = keyOf(project)
  const projectId = project?.id
  useEffect(() => {
    if (!key || !projectId || loaded.has(key)) return
    let live = true
    fetchIcon(projectId, key).then(() => { if (live) update() }, () => {})
    return () => { live = false }
  }, [key, projectId])
  return key ? loaded.get(key) ?? null : null
}

/**
 * `className` carries the place's own look (border, fill, letter size). `size` sets both sides in px for places with no class of
 * their own. `fallback` is the letter for a place that has no project yet. `current` marks the project in view, for a place that fills its tile then.
 */
export function ProjectIcon({ project, className, size, fallback = '', current }: { project: Pick<Project, 'id' | 'name' | 'icon'> | undefined; className?: string; size?: number; fallback?: string; current?: boolean }) {
  const url = useProjectIcon(project)
  const [failed, setFailed] = useState<string | null>(null)
  const style: CSSProperties | undefined = size ? { width: size, height: size } : undefined
  const shown = url && failed !== url ? url : null
  return (
    <span className={['project-icon', className].filter(Boolean).join(' ')} style={style} aria-hidden="true" data-image={shown ? '' : undefined} data-current={current || undefined}>
      {shown ? <img className="project-icon-img" src={shown} alt="" draggable={false} onError={() => setFailed(shown)} /> : project ? projectLetter(project.name) : fallback}
    </span>
  )
}
