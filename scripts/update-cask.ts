// node scripts/update-cask.ts <version> [--dmg <path>] [--dry]   point the Homebrew cask at a published release (KERNEL-904).
//
// Sets `version` and `sha256` in Casks/kernel.rb of cjjutba/homebrew-tap, through the contents API with the gh login
// the release already uses. The sha256 is the release's DMG: the local --dmg when given, otherwise the published asset.
// scripts/release.sh runs it after the live feed check at 100%, and release:rollout runs it when a rollout reaches 100.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { REPO } from './rollout.ts'

const TAP = 'cjjutba/homebrew-tap'
const CASK = 'Casks/kernel.rb'

export function setCaskVersion(cask: string, version: string, sha256: string): string {
  const next = cask.replace(/^(\s*version\s+)"[^"]*"/m, `$1"${version}"`).replace(/^(\s*sha256\s+)"[^"]*"/m, `$1"${sha256}"`)
  if (!next.includes(`version "${version}"`) || !next.includes(`sha256 "${sha256}"`)) throw new Error(`${CASK} has no version and sha256 lines to update.`)
  return next
}

async function sha256Of(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

export async function updateCask(version: string, opts: { dmg?: string; dry?: boolean } = {}): Promise<void> {
  let sha256: string
  if (opts.dmg) sha256 = await sha256Of(createReadStream(opts.dmg))
  else {
    const res = await fetch(`https://github.com/${REPO}/releases/download/v${version}/Kernel-arm64.dmg`)
    if (!res.ok || !res.body) throw new Error(`downloading the v${version} DMG failed with ${res.status}.`)
    sha256 = await sha256Of(res.body as unknown as AsyncIterable<Uint8Array>)
  }
  const file = JSON.parse(execFileSync('gh', ['api', `repos/${TAP}/contents/${CASK}`], { encoding: 'utf8' })) as { content: string; sha: string }
  const before = Buffer.from(file.content, 'base64').toString('utf8')
  const after = setCaskVersion(before, version, sha256)
  const line = (text: string, key: string) => text.match(new RegExp(`^\\s*${key}\\s+"[^"]*"`, 'm'))?.[0].trim()
  const change = ['version', 'sha256'].map((k) => `  ${line(before, k)}\n  -> ${line(after, k)}`).join('\n')
  if (after === before) return console.log(`update-cask: ${TAP} already has ${version}.`)
  if (opts.dry) return console.log(`update-cask: dry run, would push to ${TAP} ${CASK}:\n${change}`)
  execFileSync('gh', ['api', '-X', 'PUT', `repos/${TAP}/contents/${CASK}`, '-f', `message=chore: kernel ${version}`, '-f', `content=${Buffer.from(after).toString('base64')}`, '-f', `sha=${file.sha}`], { stdio: ['ignore', 'ignore', 'inherit'] })
  console.log(`update-cask: ${TAP} now installs Kernel ${version}.\n${change}`)
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((a) => a !== '--')
  const dmgAt = args.indexOf('--dmg')
  const dmg = dmgAt >= 0 ? args.splice(dmgAt, 2)[1] : undefined
  const dry = args.includes('--dry')
  const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a))
  if (!version) {
    console.error('Usage: node scripts/update-cask.ts <version> [--dmg <path>] [--dry]')
    process.exit(2)
  }
  try {
    await updateCask(version, { dmg, dry })
  } catch (e) {
    console.error(`update-cask: ${(e as Error).message}`)
    process.exit(1)
  }
}
