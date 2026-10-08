import Image from 'next/image'
import appIcon from '@/public/brand/kernel-app-icon.svg'

/** The mark on the dark rounded square, as shipped with the app. */
export function AppIcon({ size = 64, className }: { size?: number; className?: string }) {
  return <Image src={appIcon} alt="Kernel" width={size} height={size} className={className} />
}
