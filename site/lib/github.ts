import { z } from 'zod'

/** Below this the star count stays hidden. */
export const STAR_COUNT_MIN = 10

const Repo = z.object({ stargazers_count: z.number().int().nonnegative() })
const LatestRelease = z.object({ tag_name: z.string().regex(/^v\d+\.\d+\.\d+$/) })

/** A GET on Kernel's repo in the GitHub API, cached by Next for `revalidate` seconds. */
function github(path: string, revalidate: number) {
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const token = process.env.GITHUB_TOKEN
  return fetch(`${base}/repos/cjjutba/kernel${path}`, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    next: { revalidate },
    signal: AbortSignal.timeout(5000)
  })
}

/** The repo's star count, refreshed hourly, or null when GitHub can't be reached. */
export async function getStarCount(): Promise<number | null> {
  try {
    const res = await github('', 3600)
    if (!res.ok) return null
    const parsed = Repo.safeParse(await res.json())
    return parsed.success ? parsed.data.stargazers_count : null
  } catch {
    return null
  }
}

/**
 * The version of GitHub's latest published release, such as "0.2.1", checked every 5 minutes. A release PR merges, and
 * the site deploys, before the release is built, notarized and published, so the site shows nothing newer than this
 * (KERNEL-412). Throws when GitHub can't be read, so a build fails and a regeneration keeps the last good page.
 */
export async function getPublishedVersion(): Promise<string> {
  const res = await github('/releases/latest', 300)
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for Kernel's latest release`)
  return LatestRelease.parse(await res.json()).tag_name.slice(1)
}
