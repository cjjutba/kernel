import Image, { type StaticImageData } from 'next/image'

type Props = {
  src: StaticImageData
  alt: string
  /** The rendered width, for the browser's image choice. */
  sizes: string
  /** Only the hero's screenshot, the largest paint on the landing page. */
  preload?: boolean
  className?: string
}

/** A screenshot in the gradient hairline frame. */
export function Shot({ src, alt, sizes, preload = false, className = '' }: Props) {
  return (
    <div className={`frame-gradient ${className}`}>
      <div className="overflow-hidden rounded-frame-in bg-surface-2">
        <Image src={src} alt={alt} sizes={sizes} preload={preload} className="block h-auto w-full" />
      </div>
    </div>
  )
}
