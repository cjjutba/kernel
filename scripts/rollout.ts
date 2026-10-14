// Staged rollout and the live feed check (KERNEL-712). Installed copies read latest-mac.yml from the latest GitHub
// release, and electron-updater offers the update only to the share of installs that stagingPercentage names.
import { createHash } from 'node:crypto'
import { parse } from 'yaml'

export const REPO = 'cjjutba/kernel'
export const FEED_URL = `https://github.com/${REPO}/releases/latest/download/latest-mac.yml`

export function parsePercent(text: string | undefined): number {
  if (!text || !/^(\d|[1-9]\d|100)$/.test(text)) throw new Error(`the rollout must be a whole percentage from 0 to 100, not "${text ?? ''}".`)
  return Number(text)
}

// Edits the one line, so the rest of the file (the notes block, the sha512s) stays byte for byte as uploaded. The field
// goes after minimumSystemVersion, where release.sh writes it, or at the end of a feed without that line.
export function setStagingPercentage(feed: string, percent: number): string {
  const line = `stagingPercentage: ${percent}`
  const lines = feed.replace(/\n$/, '').split('\n')
  const existing = lines.findIndex((l) => /^stagingPercentage:/.test(l))
  if (existing !== -1) lines[existing] = line
  else {
    const min = lines.findIndex((l) => /^minimumSystemVersion:/.test(l))
    lines.splice(min === -1 ? lines.length : min + 1, 0, line)
  }
  return `${lines.join('\n')}\n`
}

export interface Feed {
  version: string
  // What installs see: electron-updater treats a feed without the field as 100.
  percent: number
  zip: { url: string; sha512: string; size: number }
}

export function readFeed(text: string): Feed {
  const doc = parse(text) as { version?: unknown; stagingPercentage?: unknown; files?: { url?: string; sha512?: string; size?: number }[] }
  if (typeof doc?.version !== 'string') throw new Error('the feed has no version.')
  const zip = doc.files?.find((f) => f.url?.endsWith('.zip'))
  if (!zip?.url || !zip.sha512 || typeof zip.size !== 'number') throw new Error('the feed lists no zip with a sha512 and a size.')
  const percent = doc.stagingPercentage == null ? 100 : Number(doc.stagingPercentage)
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error(`the feed's stagingPercentage "${String(doc.stagingPercentage)}" is not a percentage.`)
  return { version: doc.version, percent, zip: { url: zip.url, sha512: zip.sha512, size: zip.size } }
}

// Problems with what the feed promises, before anything is downloaded. Empty means it matches.
export function feedProblems(feed: Feed, expect: { version?: string; percent?: number }): string[] {
  const problems: string[] = []
  if (expect.version && feed.version !== expect.version) problems.push(`the live feed is for ${feed.version}, not ${expect.version}.`)
  if (expect.percent !== undefined && feed.percent !== expect.percent) problems.push(`the live feed rolls out to ${feed.percent}%, not ${expect.percent}%.`)
  return problems
}

export async function sha512OfStream(body: AsyncIterable<Uint8Array>): Promise<{ sha512: string; size: number }> {
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of body) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sha512: hash.digest('base64'), size }
}

export function zipUrl(feed: Feed): string {
  return `https://github.com/${REPO}/releases/download/v${feed.version}/${feed.zip.url}`
}
