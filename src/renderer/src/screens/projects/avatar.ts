import { useEffect, useState } from 'react'
import { call } from '../../api'

/** Owner avatars, asked of main once per owner for the life of the window (KERNEL-945). */
const cache = new Map<string, Promise<string | null>>()

/** The owner's avatar as a data URL, or null while it loads and when there is none. */
export function useAvatar(owner: string): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let found = cache.get(owner)
    if (!found) { found = call('github.avatar', { owner }).catch(() => null); cache.set(owner, found) }
    void found.then((url) => { if (live) setSrc(url) })
    return () => { live = false }
  }, [owner])
  return src
}
