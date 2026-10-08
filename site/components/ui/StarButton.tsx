import { formatStars } from '@/lib/format'
import { getStarCount, STAR_COUNT_MIN } from '@/lib/github'
import { REPO_URL } from '@/lib/links'
import { GitHubIcon, StarIcon } from './icons'

/** The split Star button. The count shows only from STAR_COUNT_MIN stars, and never as a made-up number. */
export function StarButtonView({ count, className = '' }: { count: number | null; className?: string }) {
  const show = count !== null && count >= STAR_COUNT_MIN
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener"
      aria-label={show ? `Star Kernel on GitHub, ${count.toLocaleString('en-US')} stars` : 'Star Kernel on GitHub'}
      className={`group inline-flex h-8 items-stretch overflow-hidden rounded-md border border-line-strong text-label font-medium text-ink-2 hover:border-edge-hover hover:text-white ${className}`}
    >
      <span className="inline-flex items-center gap-2 px-3 group-hover:bg-raised">
        <GitHubIcon size={15} />
        Star
      </span>
      {show ? (
        <span className="inline-flex items-center gap-1 border-l border-line-strong bg-surface-2 px-2.5 font-mono text-count font-medium text-muted">
          <StarIcon />
          {formatStars(count)}
        </span>
      ) : null}
    </a>
  )
}

export async function StarButton({ className }: { className?: string }) {
  return <StarButtonView count={await getStarCount()} className={className} />
}
