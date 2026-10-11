import { resolvePreviewUrl } from '@shared/previewUrl'

export type PreviewUrls = { name: string; url: string }[]

/** One row of the Open menu. `url` is null when the address still has a port form Kernel can't fill. */
export interface PreviewTarget { id: string; label: string; address: string; url: string | null }

/** An address as the menu shows it: no scheme. */
const bare = (url: string) => url.replace(/^https?:\/\//i, '')

/**
 * The URL a run script printed. The room's scripts come first in their order, so the answer doesn't change while two scripts
 * print; one that is no longer listed comes last.
 */
export function detectedUrl(byScript: Record<string, string> | undefined, order: string[]): string | null {
  if (!byScript) return null
  const name = [...order, ...Object.keys(byScript)].find((n) => byScript[n])
  return name ? byScript[name] : null
}

/** The room's configured URLs for this workspace's port, in order. A row with no name shows its address. */
export function configuredTargets(urls: PreviewUrls, port: number): PreviewTarget[] {
  return urls.map((u, i) => {
    const url = resolvePreviewUrl(u.url, port)
    return { id: `url:${i}`, label: u.name.trim() || bare(url ?? u.url.trim()), address: bare(url ?? u.url.trim()), url }
  })
}

/**
 * What Open opens: the first configured URL, else the detected one. Null when there is nothing to open yet, or the first
 * configured address can't be filled in, so Open is disabled instead of opening a half-filled one.
 */
export function openTarget(urls: PreviewUrls, port: number, detected: string | null): string | null {
  return urls.length ? configuredTargets(urls, port)[0].url : detected
}

/** The Detected row of the menu. */
export const detectedTarget = (detected: string | null): PreviewTarget => ({ id: 'detected', label: 'Detected', address: detected ? bare(detected) : 'Not found yet', url: detected })
