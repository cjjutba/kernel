import { z } from 'zod'

/** Below this the star count stays hidden. */
export const STAR_COUNT_MIN = 10

const Repo = z.object({ stargazers_count: z.number().int().nonnegative() })

/** The repo's star count, refreshed hourly, or null when GitHub can't be reached. */
export async function getStarCount(): Promise<number | null> {
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const token = process.env.GITHUB_TOKEN
  try {
    const res = await fetch(`${base}/repos/cjjutba/kernel`, {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const parsed = Repo.safeParse(await res.json())
    return parsed.success ? parsed.data.stargazers_count : null
  } catch {
    return null
  }
}
