import { describe, expect, it } from 'vitest'
import { feedProblems, parsePercent, readFeed, setStagingPercentage, sha512OfStream } from '../scripts/rollout.ts'

const feed = `version: 0.4.1
files:
  - url: Kernel-arm64.zip
    sha512: abc==
    size: 3
  - url: Kernel-arm64.dmg
    sha512: def==
    size: 4
path: Kernel-arm64.zip
sha512: abc==
releaseNotes: |
  ### Fixed
  stagingPercentage: 5 in the notes is not the field
releaseDate: '2026-10-13T15:51:20.476Z'
minimumSystemVersion: 22.0.0
`

describe('staged rollout (KERNEL-712)', () => {
  it('adds the field after minimumSystemVersion and leaves the rest alone', () => {
    const out = setStagingPercentage(feed, 10)
    expect(out).toBe(feed.replace('minimumSystemVersion: 22.0.0\n', 'minimumSystemVersion: 22.0.0\nstagingPercentage: 10\n'))
    expect(readFeed(out).percent).toBe(10)
  })

  it('replaces an existing field, so 0 pauses a release', () => {
    const out = setStagingPercentage(setStagingPercentage(feed, 10), 0)
    expect(out.match(/^stagingPercentage:/gm)).toHaveLength(1)
    expect(readFeed(out).percent).toBe(0)
  })

  it('reads a feed without the field as 100, the way installs do', () => {
    expect(readFeed(feed)).toEqual({ version: '0.4.1', percent: 100, zip: { url: 'Kernel-arm64.zip', sha512: 'abc==', size: 3 } })
  })

  it('names every way the live feed differs from what was published', () => {
    const live = readFeed(setStagingPercentage(feed, 10))
    expect(feedProblems(live, { version: '0.4.1', percent: 10 })).toEqual([])
    expect(feedProblems(live, { version: '0.5.0', percent: 100 })).toEqual([
      'the live feed is for 0.4.1, not 0.5.0.',
      'the live feed rolls out to 10%, not 100%.'
    ])
  })

  it('takes only whole percentages from 0 to 100', () => {
    expect(['0', '10', '100'].map(parsePercent)).toEqual([0, 10, 100])
    for (const bad of ['101', '-1', '10.5', '010', '', undefined]) expect(() => parsePercent(bad)).toThrow(/whole percentage/)
  })

  it('hashes a download the way electron-updater checks it', async () => {
    async function* body() {
      yield new TextEncoder().encode('ab')
      yield new TextEncoder().encode('c')
    }
    expect(await sha512OfStream(body())).toEqual({
      sha512: '3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==',
      size: 3
    })
  })
})
