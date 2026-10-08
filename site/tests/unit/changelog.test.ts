import { describe, expect, it } from 'vitest'
import { changelog } from '@/content/changelog'
import { Changelog } from '@/lib/schema'

const allItems = [...changelog.releases.flatMap((r) => r.sections.flatMap((s) => s.items)), ...changelog.upNext.items]

function compareVersions(a: string, b: string) {
  const [pa, pb] = [a.split('.').map(Number), b.split('.').map(Number)]
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!
  return 0
}

describe('changelog content', () => {
  it('matches the schema', () => {
    expect(Changelog.safeParse(changelog).success).toBe(true)
  })

  it('has unique versions', () => {
    const versions = changelog.releases.map((r) => r.version)
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('lists releases newest first, by version and by date', () => {
    const r = changelog.releases
    for (let i = 1; i < r.length; i++) {
      expect(compareVersions(r[i - 1]!.version, r[i]!.version)).toBeGreaterThan(0)
      expect(r[i - 1]!.date >= r[i]!.date).toBe(true)
    }
  })

  it('links every change to a positive pull request number', () => {
    for (const item of allItems) if (item.pr !== undefined) expect(Number.isInteger(item.pr) && item.pr > 0).toBe(true)
  })
})
