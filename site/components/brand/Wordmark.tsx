import { KernelMark } from './KernelMark'

/** The mark is the "K", followed by "ernel". Reads as "Kernel". */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span role="img" aria-label="Kernel" className={`inline-flex items-baseline text-brand text-ink ${className}`}>
      <KernelMark className="wordmark-k" />
      <span aria-hidden="true">ernel</span>
    </span>
  )
}
