// pnpm release:rollout <version> <percent>         set how many installs a published release reaches. 0 pauses it.
// pnpm release:rollout --check [<version> [<percent>]]  read-only: check the live feed and the zip it points at.
//
// A rollout change re-uploads only latest-mac.yml on the release (KERNEL-712). The tag, the release and the other
// assets never change. scripts/release.sh runs --check after it publishes.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FEED_URL, feedProblems, parsePercent, readFeed, REPO, setStagingPercentage, sha512OfStream, zipUrl, type Feed } from './rollout.ts'

const args = process.argv.slice(2)
// pnpm passes a `--` through (`pnpm release:rollout -- 0.5.0 10`), so drop it.
if (args[0] === '--') args.shift()

async function fetchFeed(): Promise<{ text: string; feed: Feed }> {
  // A fresh query string on every request, so no cache between here and GitHub answers with the feed from before.
  const res = await fetch(`${FEED_URL}?t=${Date.now()}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetching ${FEED_URL} failed with ${res.status}.`)
  const text = await res.text()
  return { text, feed: readFeed(text) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function check(expect: { version?: string; percent?: number }) {
  // GitHub can take a few seconds to point latest/download at a new release or a re-uploaded asset.
  let live = await fetchFeed()
  for (let attempt = 1; attempt < 6 && feedProblems(live.feed, expect).length; attempt++) {
    await sleep(10_000)
    live = await fetchFeed()
  }
  const problems = feedProblems(live.feed, expect)
  if (problems.length) throw new Error(problems.join(' '))
  const { feed } = live
  console.log(`release:rollout: the live feed offers ${feed.version} to ${feed.percent}% of installs. Downloading ${feed.zip.url} to check it.`)
  const res = await fetch(zipUrl(feed))
  if (!res.ok || !res.body) throw new Error(`downloading ${zipUrl(feed)} failed with ${res.status}.`)
  const got = await sha512OfStream(res.body)
  if (got.size !== feed.zip.size) throw new Error(`${feed.zip.url} is ${got.size} bytes, and the feed says ${feed.zip.size}. Installs will reject this update.`)
  if (got.sha512 !== feed.zip.sha512) throw new Error(`${feed.zip.url} does not match the feed's sha512. Installs will reject this update.`)
  console.log(`release:rollout: ok. ${feed.zip.url} matches the feed's sha512 and size.`)
}

async function rollout(version: string, percent: number) {
  // The feed shows only the latest release, so a rollout on any other release would change nothing installs read.
  const { feed } = await fetchFeed()
  if (feed.version !== version) throw new Error(`the live feed is for ${feed.version}. Only the latest release's rollout reaches installs.`)
  const dir = mkdtempSync(join(tmpdir(), 'kernel-rollout-'))
  try {
    execFileSync('gh', ['release', 'download', `v${version}`, '--repo', REPO, '--pattern', 'latest-mac.yml', '--dir', dir], { stdio: 'inherit' })
    const file = join(dir, 'latest-mac.yml')
    const before = readFileSync(file, 'utf8')
    const from = readFeed(before).percent
    writeFileSync(file, setStagingPercentage(before, percent))
    readFeed(readFileSync(file, 'utf8'))
    execFileSync('gh', ['release', 'upload', `v${version}`, file, '--repo', REPO, '--clobber'], { stdio: 'inherit' })
    console.log(`release:rollout: ${version} goes from ${from}% to ${percent}% of installs.`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  await check({ version, percent })
}

const version = (text: string | undefined) => {
  if (!text || !/^\d+\.\d+\.\d+$/.test(text)) throw new Error(`"${text ?? ''}" is not a version like 0.5.0.`)
  return text
}

try {
  if (args[0] === '--check') await check({ version: args[1] && version(args[1]), percent: args[2] === undefined ? undefined : parsePercent(args[2]) })
  else if (args.length === 2) await rollout(version(args[0]), parsePercent(args[1]))
  else {
    console.error('Usage: pnpm release:rollout <version> <percent> | --check [<version> [<percent>]]')
    process.exit(2)
  }
} catch (e) {
  console.error(`release:rollout: ${(e as Error).message}`)
  process.exit(1)
}
