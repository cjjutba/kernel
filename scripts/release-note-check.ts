// The Release note check (.github/workflows/release-note.yml, D-058). Fails a PR that changes app files without
// adding a fragment in .changes/unreleased/, and any PR with a malformed fragment.
//
// CI sets BASE_SHA, HEAD_REF, FORK and LABELS (a JSON array). Locally it compares with origin/main:
//   node scripts/release-note-check.ts
import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { checkPullRequest, dependenciesChanged, missingMessage, readFragments, README_URL } from './notes.ts'

const root = join(import.meta.dirname, '..')
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const show = (ref: string, file: string) => {
  try {
    return git('show', `${ref}:${file}`)
  } catch {
    return '{}'
  }
}

const base = git('merge-base', process.env.BASE_SHA || 'origin/main', 'HEAD').trim()
const branch = process.env.HEAD_REF || git('rev-parse', '--abbrev-ref', 'HEAD').trim()
const labels = JSON.parse(process.env.LABELS || '[]') as string[]
const fork = process.env.FORK === 'true'
const files = git('diff', '--name-status', '--no-renames', base, 'HEAD')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [status = '', path = ''] = l.split('\t')
    return { status, path }
  })

function fail(summary: string, details: string): never {
  console.log(`::error title=Release note::${summary}`)
  console.error(`\n${details}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release note\n\n\`\`\`\n${details}\n\`\`\`\n`)
  process.exit(1)
}

const { fragments, errors } = readFragments(root)
if (errors.length) fail('A release-note fragment is malformed.', `Fix these fragments:\n${errors.map((e) => `  ${e}`).join('\n')}\n\nSee ${README_URL}`)

const result = checkPullRequest({
  branch,
  fork,
  labels,
  files,
  dependenciesChanged: dependenciesChanged(show(base, 'package.json'), show('HEAD', 'package.json'))
})
if (!result.ok) fail('This PR changes app files but adds no release note.', missingMessage(result))
console.log(`Release note: ok (${result.reason}). ${fragments.length} unreleased fragment${fragments.length === 1 ? '' : 's'} valid.`)
