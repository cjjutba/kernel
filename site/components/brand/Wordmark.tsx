import { KernelMark } from './KernelMark'

/** The mark is the "K", followed by "ernel". A hidden "K" makes the text read "Kernel". */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline text-brand text-ink ${className}`}>
      <KernelMark className="wordmark-k" />
      {/* One inline box, so the name and copied text are "Kernel" with no gap. */}
      <span>
        <span className="wordmark-k-text">K</span>ernel
      </span>
    </span>
  )
}
