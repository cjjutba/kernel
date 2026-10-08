import Image, { type StaticImageData } from 'next/image'

type Props = {
  /** A static import, or a path under public/ for a 1440x900 screenshot. */
  src: StaticImageData | string
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
        <Image
          src={src}
          {...(typeof src === 'string' ? { width: 1440, height: 900 } : {})}
          alt={alt}
          sizes={sizes}
          preload={preload}
          quality={90}
          className="block aspect-16/10 h-auto w-full"
        />
      </div>
    </div>
  )
}
