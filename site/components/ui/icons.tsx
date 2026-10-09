// Icons from the reference markup. All decorative: the text next to them carries the meaning.

type IconProps = { size?: number; className?: string }

const stroke = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function GitHubIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

export function StarIcon({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.5} className={className}>
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" />
    </svg>
  )
}

export function DownloadIcon({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.8} className={className}>
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
    </svg>
  )
}

export function ArrowIcon({ size = 12, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.7} className={className}>
      <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" />
    </svg>
  )
}

export function BranchIcon({ size = 15, strokeWidth = 1.4, className }: IconProps & { strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={strokeWidth} className={className}>
      <path d="M4.5 5.3v5.4M11.5 7c0 2.6-7 1.5-7 3.7M6 3.8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM6 12.2a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM13 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
    </svg>
  )
}

export function InboxIcon({ size = 15, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.4} className={className}>
      <path d="M2.5 9 4.2 3.2h7.6L13.5 9v3.3a.9.9 0 0 1-.9.9H3.4a.9.9 0 0 1-.9-.9ZM2.5 9h3.1l.8 1.6h3.2l.8-1.6h3.1" />
    </svg>
  )
}

export function TeamIcon({ size = 15, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.4} className={className}>
      <path d="M8 5.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM2 13c.4-2 2-3 4-3s3.6 1 4 3M11 3.9a1.8 1.8 0 1 1 0 3.6M12 10.2c1.2.4 1.9 1.4 2 2.8" />
    </svg>
  )
}

export function CheckpointIcon({ size = 15, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.4} className={className}>
      <path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.8 3v2.6h2.6M8 5.2V8l2 1.3" />
    </svg>
  )
}

export function SendIcon({ size = 14, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.8} className={className}>
      <path d="M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2" />
    </svg>
  )
}

export function CheckIcon({ size = 13, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...stroke} strokeWidth={1.8} className={className}>
      <path d="m3.5 8.3 2.8 2.7 6.2-6.3" />
    </svg>
  )
}
