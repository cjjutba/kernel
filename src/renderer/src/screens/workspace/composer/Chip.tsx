import type { ChatPart } from '@shared/types'
import { Icon } from '../../../ui'

/** A short label under a chip: lines of a pasted text, or the size of an image. */
function chipMeta(p: ChatPart): string {
  if (p.type === 'file' && p.lines && !p.path) return `${p.lines} lines`
  if (p.type === 'image' && p.width && p.height) return `${p.width}×${p.height}`
  return ''
}

/** One attachment in a composer: pasted text, an image, a file or a skill. Every composer draws them the same way, with an icon for the kind, never a preview. */
export function ComposerChip({ part, onRemove }: { part: ChatPart; onRemove: () => void }) {
  if (part.type === 'text') return null
  const label = part.type === 'skill' ? `/${part.name}` : part.name
  const meta = chipMeta(part)
  return (
    <span className="chip cmp-chip" data-kind={part.type === 'skill' ? 'skill' : part.type === 'image' ? 'image' : 'file'}>
      <Icon name={part.type === 'image' ? 'image' : 'doc'} size={12} />
      <span className="ellipsis" style={{ maxWidth: 220 }}>{label}</span>
      {meta && <span className="chip-meta">{meta}</span>}
      <button type="button" className="chip-x" aria-label={`Remove ${label}`} onClick={onRemove}><Icon name="close" size={10} /></button>
    </span>
  )
}
