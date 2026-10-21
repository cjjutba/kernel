import type { ChatItem, SharedFile, SharedKind, SharedVersion } from '@shared/types'
import { useStore } from '../../../store'
import { FileIcon } from '../../../components/FileIcon'
import { Button, EmptyState, Icon, type IconName } from '../../../ui'
import { kindFile, kindLabel, typeWord, useOpenShared, useRead, useSharer, useThumb, versionLine, versionOf } from '../shared/shared'
import '../shared/shared.css'

/**
 * What both cards draw: the file, the version they were made for and whether that version has a picture to show. A card stands for one
 * version, so Open shows that one: the latest follows new versions again, an older one is picked.
 */
type SharedItem = Extract<ChatItem, { kind: 'shared' }>
function useCard(sharedId: string, version: number): { file?: SharedFile; v?: SharedVersion; thumb: string | null; by: string; open: () => void } {
  const file = useStore((s) => s.shared[sharedId])
  const v = file ? versionOf(file, version) : undefined
  const thumb = useThumb(file, v)
  const by = useSharer(file)
  const openShared = useOpenShared()
  return { file, v, thumb, by, open: () => openShared(sharedId, v?.n ?? version) }
}

/** A page and an image are drawn from their picture. A PDF or a note gets a body of its own, because a first page or a line of text says little. */
const picture = (kind: SharedKind) => kind === 'html' || kind === 'image'

/** The icon in front of a card's title, by what was shared. */
const KIND_ICON: Record<SharedKind, IconName> = { html: 'globe', image: 'image', pdf: 'doc', markdown: 'doc' }

/** A card's head (Pen 9.19): what it is, its title, what it holds and who shared it, and Open at the right. */
function CardHead({ icon, title, meta, onOpen }: { icon: IconName; title: string; meta: string; onOpen: () => void }) {
  return (
    <div className="shc-head">
      <span className="shc-ico" aria-hidden="true"><Icon name={icon} size={14} /></span>
      <div className="shc-text"><h3 className="shc-title ellipsis">{title}</h3><span className="shc-meta ellipsis">{meta}</span></div>
      <Button size="sm" aria-label={`Open ${title}`} onClick={onOpen}>Open</Button>
    </div>
  )
}

/** One picture of an image share: its still, cropped to the tile from the top left. */
function Tile({ sharedId, version, caption, more }: { sharedId: string; version: number; caption?: boolean; more?: number }) {
  const { file, thumb, open } = useCard(sharedId, version)
  return (
    <figure className="shc-tile" data-more={more ? '' : undefined}>
      <button type="button" className="shc-pic" aria-label={more ? `Open ${file?.title ?? 'image'}, and ${more} more` : `Open ${file?.title ?? 'image'}`} onClick={open}>
        {thumb && <img src={thumb} alt="" />}
        {more ? <span className="shc-more">+{more}</span> : null}
      </button>
      {caption && file && <figcaption className="shc-cap ellipsis">{file.title}</figcaption>}
    </figure>
  )
}

/**
 * The images an agent shared in one turn, as one plain chat card whose pictures lay out by count (Pen 9.19): one fills the card, two sit side by side with their names, three put one
 * large beside two, four make a grid, and more show +N on the last tile. Each picture is its own shared file, so Open on the card opens the first and a tile opens its own.
 */
function SharedImages({ items }: { items: SharedItem[] }) {
  const files = useStore((s) => s.shared)
  const first = files[items[0].sharedId]
  const by = useSharer(first)
  const openShared = useOpenShared()
  const n = items.length
  const versions = new Set(items.map((i) => i.version))
  const shown = n > 4 ? items.slice(0, 4) : items
  const meta = [`${n} images`, versions.size === 1 ? `Version ${items[0].version}` : '', by].filter(Boolean).join(' · ')
  // The titles of the pictures, since the agent names none for the set: all of them up to three, else the first two and how many more.
  const names = items.map((i) => files[i.sharedId]?.title).filter((t): t is string => !!t)
  const title = names.length <= 3 ? names.join(names.length > 2 ? ', ' : ' and ').replace(/, ([^,]*)$/, ' and $1') : `${names[0]}, ${names[1]} and ${names.length - 2} more`
  return (
    <section className="card tcard shcard shc" data-layout="images" aria-label={title}>
      <CardHead icon="image" title={title} meta={meta} onOpen={() => openShared(items[0].sharedId, items[0].version)} />
      <div className="shc-grid" data-count={n > 4 ? 'more' : n}>
        {shown.map((i, at) => <Tile key={i.id} sharedId={i.sharedId} version={i.version} caption={n === 2} more={n > 4 && at === 3 ? n - 3 : undefined} />)}
      </div>
    </section>
  )
}

/** The first lines of a Markdown note: its heading, then what follows, as the card shows them. */
function noteLines(text: string): { heading?: string; body: string[] } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const heading = lines[0]?.startsWith('#') ? lines.shift()!.replace(/^#+\s*/, '') : undefined
  return { heading, body: lines.slice(0, 3).map((l) => l.replace(/^[-*]\s+/, '').replace(/[*_`]/g, '')) }
}

/**
 * A file the agent shared, in its chat (Pen 9.19). It reads the SharedFile from the store, like an approval card reads its approval, so a later version shows on it. Open goes to the
 * file's tab, which follows the latest version. A page shows its picture under its address, a note its first lines, and a PDF its first page.
 */
export function SharedCard({ sharedId, version }: { sharedId: string; version: number }) {
  const { file, v, thumb, by, open } = useCard(sharedId, version)
  const read = useRead(file?.kind === 'markdown' ? file : undefined, file?.kind === 'markdown' ? v : undefined)
  if (!file || !v) return <div className="card tcard shcard" data-layout="missing"><EmptyState icon="doc" title="A shared file">This file is no longer available</EmptyState></div>
  const meta = `${typeWord(file.kind)} · Version ${v.n} · ${by}`
  const note = file.kind === 'markdown' && read.text ? noteLines(read.text) : undefined
  return (
    <section className="card tcard shcard shc" data-layout={file.kind} aria-label={file.title}>
      <CardHead icon={KIND_ICON[file.kind]} title={file.title} meta={meta} onOpen={open} />
      {file.kind === 'html' && (
        <div className="shc-page">
          <span className="shc-addr mono ellipsis"><Icon name="globe" size={12} />{file.source.split('/').pop()}</span>
          {thumb && <button type="button" className="shc-pic" aria-label={`Open ${file.title}`} onClick={open}><img src={thumb} alt="" /></button>}
        </div>
      )}
      {file.kind === 'image' && (
        <div className="shc-grid" data-count="1"><Tile sharedId={sharedId} version={version} /></div>
      )}
      {note && (
        <div className="shc-note">
          {note.heading && <strong>{note.heading}</strong>}
          {note.body.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      )}
      {file.kind === 'pdf' && (
        <div className="shc-pdf"><span className="shc-sheet" aria-hidden="true">{thumb ? <img src={thumb} alt="" /> : <FileIcon path={kindFile.pdf} size={20} />}</span></div>
      )}
    </section>
  )
}

/** Shared files in a row: the images that came together are one card, anything else is a card of its own. */
export function SharedCards({ items }: { items: SharedItem[] }) {
  const files = useStore((s) => s.shared)
  const runs: SharedItem[][] = []
  for (const item of items) {
    const image = files[item.sharedId]?.kind === 'image'
    const last = runs[runs.length - 1]
    if (image && last && files[last[0].sharedId]?.kind === 'image') last.push(item)
    else runs.push([item])
  }
  return <>{runs.map((run) => (run.length > 1 ? <SharedImages key={run[0].id} items={run} /> : <SharedCard key={run[0].id} sharedId={run[0].sharedId} version={run[0].version} />))}</>
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
        ? <span className="shrow-thumb" aria-hidden="true" onClick={open}><img src={thumb} alt="" /></span>
        : <span className="shrow-tile" aria-hidden="true"><FileIcon path={kindFile[file?.kind ?? kind]} /></span>}
      <div className="shrow-text">
        <span className="shrow-title ellipsis">{name}</span>
        <span className="shrow-meta ellipsis">{meta.join(' · ')}</span>
      </div>
      <Button className="small shrow-open" aria-label={`Open ${name}`} onClick={open}>Open</Button>
    </div>
  )
}
