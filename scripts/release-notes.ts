// pnpm release:notes --preview           what the next release would say, and the version to use. Changes nothing.
// pnpm release:notes <version>           writes site/content/releases/<version>.md and moves the fragments.
//
// scripts/release.sh also runs:
//   --check <version>                       validate the release file
//   --app <version>                         the notes for What's new (latest-mac.yml)
//   --github <version> [--full-list <file>] the GitHub release body, with GitHub's generated list appended
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collect, compile, packageVersion, readRelease, renderApp, renderGithub, SECTIONS, suggestVersion, type Note } from './notes.ts'

const root = join(import.meta.dirname, '..')
const args = process.argv.slice(2)
// pnpm passes a `--` through (`pnpm release:notes -- --preview`), so drop it.
if (args[0] === '--') args.shift()
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const line = (n: Note) => `  ${n.text}${n.pr ? ` (#${n.pr})` : ' (no PR yet)'}${n.issue ? ` ${n.issue}` : ''}`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function preview() {
  const c = collect(root)
  const current = packageVersion(root)
  const counts = SECTIONS.map((s) => c.byType[s.type].length)
  const total = counts.reduce((a, b) => a + b, 0)
  for (const s of SECTIONS) {
    if (!c.byType[s.type].length) continue
    console.log(`${s.title}\n${c.byType[s.type].map(line).join('\n')}\n`)
  }
  if (c.internal.length) console.log(`Internal, left out of the notes\n${c.internal.map(line).join('\n')}\n`)
  console.log(`${plural(total, 'change')} since ${current}: ${counts[0]} new, ${counts[1]} improved, ${counts[2]} fixed, plus ${c.internal.length} internal.`)
  if (!total) return console.log('Nothing to release yet.')
  const next = suggestVersion(current, c)
  console.log(`Suggested version: ${next.version} (${next.bump}, ${next.bump === 'minor' ? 'something is new' : 'nothing is new'}).`)
}

function release(version: string) {
  // Local date as yyyy-mm-dd, so a release cut early in the morning isn't dated yesterday (UTC).
  const today = new Date().toLocaleDateString('en-CA')
  const { file, release, collected, moved } = compile({ root, version, date: today })
  console.log(`Wrote ${file}`)
  for (const s of release.sections) console.log(`  ${s.title}: ${s.items.length}`)
  console.log(`Moved ${plural(SECTIONS.reduce((n, s) => n + collected.byType[s.type].length, 0) + collected.internal.length, 'fragment')} to ${moved}/`)
  if (collected.internal.length) console.log(`Internal, not published:\n${collected.internal.map(line).join('\n')}`)
  const noPr = SECTIONS.flatMap((s) => collected.byType[s.type]).filter((n) => !n.pr)
  if (noPr.length) console.log(`No PR found for:\n${noPr.map((n) => `  ${n.file}`).join('\n')}`)
  if (release.title.startsWith('TITLE')) console.log(`\nNext: write the title (and an intro if you like) in ${file}. The site and the release refuse the placeholder.`)
}

try {
  if (args[0] === '--preview') preview()
  else if (args[0] === '--check') console.log(`${readRelease(root, args[1] ?? '').version} is valid.`)
  else if (args[0] === '--app') process.stdout.write(renderApp(readRelease(root, args[1] ?? '')))
  else if (args[0] === '--github') {
    const list = flag('--full-list')
    process.stdout.write(renderGithub(readRelease(root, args[1] ?? ''), list ? readFileSync(list, 'utf8') : undefined))
  } else if (args[0] && /^\d/.test(args[0])) release(args[0])
  else {
    console.error('Usage: pnpm release:notes --preview | <version>')
    process.exit(2)
  }
} catch (e) {
  console.error(`release:notes: ${(e as Error).message}`)
  process.exit(1)
}
