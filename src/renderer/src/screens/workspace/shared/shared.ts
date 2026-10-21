import { useEffect, useState } from 'react'
import type { SharedFile, SharedKind, SharedVersion } from '@shared/types'
import { call } from '../../../api'
import { actions, useStore } from '../../../store'
import { agoShort } from '../../projects/projectInfo'
import { fmtClock } from '../thread'

/** A file name of each kind. A shared file's tab, card tile and panel row draw its VS Code icon (KERNEL-399). */
export const kindFile: Record<SharedKind, string> = { html: 'page.html', image: 'image.png', pdf: 'file.pdf', markdown: 'file.md' }

export const sharedTab = (sharedId: string) => `shared:${sharedId}`

export const latestOf = (file: SharedFile): SharedVersion => file.versions.reduce((a, b) => (b.n > a.n ? b : a))
/** The version numbered `n`, or the latest when there is none or it is gone. A tab passes the one picked in it, so it follows new versions until then. */
export const versionOf = (file: SharedFile, n?: number): SharedVersion => file.versions.find((v) => v.n === n) ?? latestOf(file)

const IMAGE_NAMES: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'image/svg+xml': 'SVG' }
/** "HTML", "PNG", "PDF" or "Markdown": what the file is, for the line under its title. An image is named by its type when the version's is known. */
export function kindLabel(kind: SharedKind, mime = ''): string {
  switch (kind) {
    case 'html': return 'HTML'
    case 'pdf': return 'PDF'
    case 'markdown': return 'Markdown'
    case 'image': return IMAGE_NAMES[mime] ?? 'Image'
  }
}

/** What a shared file is called on a card and in the Session rail (Pen 9.19): a page, an image, a note or a PDF. */
export const typeWord = (kind: SharedKind): string => ({ html: 'Page', image: 'Image', markdown: 'Note', pdf: 'PDF' })[kind]

/** "HTML · v2", or "HTML · v2 of 3" when newer versions exist than the one shown. */
export function versionLine(file: SharedFile, n: number): string {
  const v = versionOf(file, n)
  const latest = latestOf(file).n
  return `${kindLabel(file.kind, v.mime)} · v${v.n}${latest > v.n ? ` of ${latest}` : ''}`
}

/** "14:41", the time a version was shared. */
export const clock = (v: SharedVersion) => fmtClock(v.at)
/** "2h", the time since the file last changed, for the panel's tight rows. */
export const sinceShort = (ts: number) => agoShort(ts).replace(' ago', '')

/** The name of the agent that shared the file, or its id while the project's agents haven't loaded. */
export function useSharer(file: SharedFile | undefined): string {
  return useStore((s) => (file ? s.agents[file.projectId]?.find((a) => a.id === file.agentId)?.name ?? file.agentId : ''))
}

/** Opens the file's tab in the workspace on screen. The copy is Kernel's, so any workspace can show it. */
export function useOpenShared(): (sharedId: string, version?: number) => void {
  const workspaceId = useStore((s) => (s.ui.route.name === 'workspace' ? s.ui.route.workspaceId : undefined))
  return (sharedId, version) => { if (workspaceId) actions.ui.openShared(workspaceId, sharedId, version) }
}

const stills = new Map<string, Promise<string | null>>()
/**
 * The still capture of a version, as a data URL, or null while it has none. A version's bytes never change, so a still is read once and
 * kept; one that isn't made yet (`thumb` unset) is not asked for. A higher `again` reads it anew, for Reload.
 */
export function useThumb(file: SharedFile | undefined, version: SharedVersion | undefined, again = 0): string | null {
  const [url, setUrl] = useState<string | null>(null)
  const key = file && version?.thumb ? `${file.id}@${version.n}` : undefined
  useEffect(() => {
    setUrl(null)
    if (!key || !file || !version) return
    let live = true
    if (again > 0) stills.delete(key)
    let pending = stills.get(key)
    if (!pending) { pending = call('shared.thumb', { sharedId: file.id, version: version.n }).catch(() => null); stills.set(key, pending) }
    void pending.then((u) => { if (live) setUrl(u); if (!u) stills.delete(key) })
    return () => { live = false }
  }, [key, again])
  return url
}

/** What `shared.read` returns for a version, once it has: text for Markdown, a data URL for an image. `failed` when it can't be read. */
export function useRead(file: SharedFile | undefined, version: SharedVersion | undefined): { text?: string; dataUrl?: string; failed: boolean } {
  const [read, setRead] = useState<{ key: string; text?: string; dataUrl?: string; failed: boolean }>()
  const key = file && version ? `${file.id}@${version.n}` : undefined
  useEffect(() => {
    if (!key || !file || !version) return
    let live = true
    call('shared.read', { sharedId: file.id, version: version.n })
      .then((r) => { if (live) setRead({ key, text: r.text, dataUrl: r.dataUrl, failed: false }) })
      .catch(() => { if (live) setRead({ key, failed: true }) })
    return () => { live = false }
  }, [key])
  // An answer for the version shown before this one is not an answer for this one.
  return read && read.key === key ? read : { failed: false }
}
