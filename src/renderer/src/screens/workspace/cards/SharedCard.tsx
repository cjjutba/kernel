import type { SharedFile, SharedKind, SharedVersion } from '@shared/types'
import { useStore } from '../../../store'
import { Button, Icon } from '../../../ui'
import { kindIcon, kindLabel, useOpenShared, useSharer, useThumb, versionLine, versionOf } from '../shared/shared'
import '../shared/shared.css'

/** What both cards draw: the file, the version they were made for and whether that version has a picture to show. */
function useCard(sharedId: string, version: number): { file?: SharedFile; v?: SharedVersion; thumb: string | null; by: string; open: () => void } {
  const file = useStore((s) => s.shared[sharedId])
  const v = file ? versionOf(file, version) : undefined
  const thumb = useThumb(file, v)
  const by = useSharer(file)
  const openShared = useOpenShared()
  return { file, v, thumb, by, open: () => openShared(sharedId) }
}

/** A page and an image are drawn from their picture. A PDF or a note gets a tile, because a first page or a line of text says little. */
const picture = (kind: SharedKind) => kind === 'html' || kind === 'image'

/**
 * A file the agent shared, in its chat (WorkspaceSharedCard.png). It reads the SharedFile from the store, like an approval card reads its
 * approval, so a later version shows on it. Open goes to the file's tab, which follows the latest version.
 */
export function SharedCard({ sharedId, version }: { sharedId: string; version: number }) {
  const { file, v, thumb, by, open } = useCard(sharedId, version)
  if (!file || !v) return null
  const meta = `${versionLine(file, v.n)} · ${by}`
  const button = <Button className="small shcard-open" aria-label={`Open ${file.title}`} onClick={open}>Open</Button>
  if (thumb && picture(file.kind)) {
    return (
      <div className="card shcard" data-layout="picture">
        <div className="shcard-text">
          <div className="shcard-line"><span className="shcard-title ellipsis">{file.title}</span>{button}</div>
          <span className="shcard-meta ellipsis">{meta}</span>
        </div>
        <div className="shcard-thumb" aria-hidden="true"><img src={thumb} alt="" /></div>
      </div>
    )
  }
  return (
    <div className="card shcard" data-layout="tile">
      <span className="shcard-tile" aria-hidden="true"><Icon name={kindIcon[file.kind]} size={16} /></span>
      <div className="shcard-text">
        <span className="shcard-title ellipsis">{file.title}</span>
        <span className="shcard-meta ellipsis">{meta}</span>
      </div>
      {button}
    </div>
  )
}

/**
 * The same file under a teammate's row in a Team update (TeamUpdateShared.png), smaller. The row carries the title and kind it had when the
 * update was written, which show until the file itself has loaded.
 */
export function SharedRow({ sharedId, version, title, kind }: { sharedId: string; version: number; title: string; kind: SharedKind }) {
  const { file, v, thumb, by, open } = useCard(sharedId, version)
  const name = file?.title ?? title
  const meta = file && v ? [versionLine(file, v.n), by] : [kindLabel(kind), `v${version}`]
  return (
    <div className="shrow">
      {thumb && picture(file?.kind ?? kind)
        ? <span className="shrow-thumb" aria-hidden="true"><img src={thumb} alt="" /></span>
        : <span className="shrow-tile" aria-hidden="true"><Icon name={kindIcon[file?.kind ?? kind]} size={16} /></span>}
      <div className="shrow-text">
        <span className="shrow-title ellipsis">{name}</span>
        <span className="shrow-meta ellipsis">{meta.join(' · ')}</span>
      </div>
      <Button className="small shrow-open" aria-label={`Open ${name}`} onClick={open}>Open</Button>
    </div>
  )
}
