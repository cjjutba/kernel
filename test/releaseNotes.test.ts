import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/main/services/exec'
import { parseNotes } from '../src/main/updater'
import { parseReleaseFile, PLACEHOLDER_TITLE, type Release } from '../site/lib/schema.ts'
import {
  checkPullRequest,
  collect,
  compile,
  dependenciesChanged,
  missingMessage,
  parseFragment,
  prFor,
  readFragments,
  readRelease,
  renderApp,
  renderGithub,
  suggestVersion
} from '../scripts/notes.ts'
import { parseNotes as parseNotesV010 } from './fixtures/parseNotes-v0.1.0'
import { tempRepo } from './helpers'

const fragment = (type: string, text: string, extra = '') => `---\ntype: ${type}\n${extra}---\n${text}\n`
const release010 = readFileSync('site/content/releases/0.1.0.md', 'utf8')

/** A repo shaped like Kernel at 0.1.0, with no fragments yet. */
const kernelRepo = () =>
  tempRepo({
    'package.json': JSON.stringify({ name: 'kernel', version: '0.1.0', dependencies: { zod: '^4.1.12' } }, null, 2),
    'site/content/releases/0.1.0.md': release010,
    '.changes/unreleased/.gitkeep': ''
  })

/** Adds files in one commit, the way a squash merge lands on main. */
async function land(dir: string, subject: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) {
    await mkdir(dirname(join(dir, f)), { recursive: true })
    await writeFile(join(dir, f), c)
  }
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-q', '-m', subject])
}

describe('fragments', () => {
  it('reads type, issue and the sentence', () => {
    expect(parseFragment('pr-refresh.md', fragment('fixed', 'Fixed a stale status.', 'issue: KERNEL-41\n'))).toEqual({
      type: 'fixed',
      issue: 'KERNEL-41',
      text: 'Fixed a stale status.'
    })
    expect(parseFragment('ci.md', fragment('internal', 'CI checks release notes.'))).toEqual({ type: 'internal', text: 'CI checks release notes.' })
  })

  it.each([
    ['Bad_Name.md', fragment('new', 'Something new.'), 'kebab-case'],
    ['a.md', 'type: new\nSomething.', 'must start with a --- line'],
    ['a.md', fragment('feature', 'Something new.'), 'type is new, improved, fixed or internal'],
    ['a.md', fragment('new', 'Something new.', 'issue: 41\n'), 'issue looks like KERNEL-41'],
    ['a.md', fragment('new', 'Something new.', 'pr: 44\n'), 'Unrecognized key'],
    ['a.md', fragment('new', ''), 'the note is empty'],
    ['a.md', fragment('new', 'One sentence.\nAnother one.'), 'one sentence on one line'],
    ['a.md', fragment('new', 'Faster — much faster.'), 'em or en dash'],
    ['a.md', fragment('new', 'Something new. (#44)'), 'leave the PR number out'],
    ['a.md', fragment('new', 'Something new'), 'end the sentence with a period'],
    ['a.md', fragment('fixed', 'A stale status no longer shows.'), 'a fixed note starts with "Fixed"']
  ])('refuses %s: %s', (name, text, problem) => {
    expect(() => parseFragment(name, text)).toThrow(problem)
  })

  it('reports each bad file by path and skips dotfiles', async () => {
    const dir = await kernelRepo()
    await land(dir, 'notes', {
      '.changes/unreleased/good.md': fragment('new', 'Something new.'),
      '.changes/unreleased/bad.md': fragment('new', 'No period')
    })
    const { fragments, errors } = readFragments(dir)
    expect(fragments.map((f) => f.file)).toEqual(['.changes/unreleased/good.md'])
    expect(errors).toEqual(['.changes/unreleased/bad.md: text: end the sentence with a period'])
  })
})

describe('npm run release:notes', () => {
  async function withFragments() {
    const dir = await kernelRepo()
    await land(dir, 'fix(workspace): a PR shows its new status (KERNEL-41) (#44)', {
      '.changes/unreleased/pr-refresh.md': fragment('fixed', 'Fixed a pull request sometimes showing its old status after a quick refresh.', 'issue: KERNEL-41\n')
    })
    await land(dir, 'feat(floor): outside sessions (#45)', { '.changes/unreleased/outside-sessions.md': fragment('new', 'Agents you start in a terminal show up on the floor.') })
    await land(dir, 'chore: bump zod (#46)', { '.changes/unreleased/zod.md': fragment('internal', 'Zod 4.2.') })
    await land(dir, 'feat(team): titles (#43)', { '.changes/unreleased/titles.md': fragment('improved', "Notifications show the chat's title instead of the branch name.") })
    // Not merged yet, so no PR number.
    await writeFile(join(dir, '.changes/unreleased/wip.md'), fragment('fixed', 'Fixed a typo in Settings, Hooks.'))
    return dir
  }

  it('finds the PR from the squash commit that added the fragment', async () => {
    const dir = await withFragments()
    expect(prFor(dir, '.changes/unreleased/pr-refresh.md')).toBe(44)
    expect(prFor(dir, '.changes/unreleased/wip.md')).toBeUndefined()
    await land(dir, 'notes without a PR', { '.changes/unreleased/direct.md': fragment('new', 'Direct.') })
    expect(prFor(dir, '.changes/unreleased/direct.md')).toBeUndefined()
  })

  it('previews and suggests minor when something is new, patch otherwise', async () => {
    const dir = await withFragments()
    const c = collect(dir)
    expect(c.byType.new.map((n) => n.pr)).toEqual([45])
    expect(c.byType.fixed.map((n) => [n.pr, n.issue])).toEqual([[44, 'KERNEL-41'], [undefined, undefined]])
    expect(c.internal.map((n) => n.file)).toEqual(['.changes/unreleased/zod.md'])
    expect(suggestVersion('0.1.0', c)).toEqual({ version: '0.2.0', bump: 'minor' })
    expect(suggestVersion('0.1.0', { ...c, byType: { ...c.byType, new: [] } })).toEqual({ version: '0.1.1', bump: 'patch' })
    expect(existsSync(join(dir, 'site/content/releases/0.2.0.md'))).toBe(false)
  })

  it('writes the release file in New, Improved, Fixed order and moves every fragment', async () => {
    const dir = await withFragments()
    const { file, moved } = compile({ root: dir, version: '0.2.0', date: '2026-11-02' })
    expect(file).toBe('site/content/releases/0.2.0.md')
    expect(readFileSync(join(dir, file), 'utf8')).toBe(
      [
        '---',
        'version: 0.2.0',
        'date: 2026-11-02',
        `title: "${PLACEHOLDER_TITLE}"`,
        '---',
        '',
        '## New',
        '',
        '- Agents you start in a terminal show up on the floor. (#45)',
        '',
        '## Improved',
        '',
        "- Notifications show the chat's title instead of the branch name. (#43)",
        '',
        '## Fixed',
        '',
        '- Fixed a pull request sometimes showing its old status after a quick refresh. (#44)',
        '- Fixed a typo in Settings, Hooks.',
        ''
      ].join('\n')
    )
    expect((await readdir(join(dir, '.changes/unreleased'))).sort()).toEqual(['.gitkeep'])
    expect((await readdir(join(dir, moved))).sort()).toEqual(['outside-sessions.md', 'pr-refresh.md', 'titles.md', 'wip.md', 'zod.md'])
    // The placeholder title keeps a minor from shipping until someone writes one.
    expect(() => readRelease(dir, '0.2.0')).toThrow('write a title')
  })

  it('titles a patch release after its version', async () => {
    const dir = await kernelRepo()
    await land(dir, 'fix: stale status (#44)', { '.changes/unreleased/pr-refresh.md': fragment('fixed', 'Fixed a stale status.') })
    compile({ root: dir, version: '0.1.1', date: '2026-10-20' })
    expect(readRelease(dir, '0.1.1')).toMatchObject({ title: 'Kernel 0.1.1', sections: [{ title: 'Fixed', items: [{ text: 'Fixed a stale status.', pr: 44 }] }] })
  })

  it('refuses a bad version, an existing file, nothing to publish and a bad fragment', async () => {
    const dir = await kernelRepo()
    expect(() => compile({ root: dir, version: 'v0.2', date: '2026-11-02' })).toThrow('is not a version')
    expect(() => compile({ root: dir, version: '0.1.0', date: '2026-11-02' })).toThrow('0.1.0 is not higher than 0.1.0 in package.json')
    expect(() => compile({ root: dir, version: '0.0.9', date: '2026-11-02' })).toThrow('is not higher')
    expect(() => compile({ root: dir, version: '0.1.1', date: '2026-11-02' })).toThrow('There are no fragments')
    await land(dir, 'chore: ci (#46)', { '.changes/unreleased/ci.md': fragment('internal', 'CI.') })
    expect(() => compile({ root: dir, version: '0.1.1', date: '2026-11-02' })).toThrow('Every fragment in .changes/unreleased/ is internal')
    await land(dir, 'fix: x (#47)', { '.changes/unreleased/x.md': fragment('fixed', 'No Fixed prefix.') })
    expect(() => compile({ root: dir, version: '0.1.1', date: '2026-11-02' })).toThrow('.changes/unreleased/x.md: text: a fixed note starts with "Fixed"')
    await land(dir, 'release 0.1.1 by hand', { 'site/content/releases/0.1.1.md': release010.replace('0.1.0', '0.1.1') })
    expect(() => compile({ root: dir, version: '0.1.1', date: '2026-11-02' })).toThrow('0.1.1.md already exists')
  })
})

const sample: Release = {
  version: '0.2.0',
  date: '2026-11-02',
  title: 'Outside sessions',
  intro: 'Agents you start anywhere show up on the floor.',
  sections: [
    { title: 'Highlights', items: [{ lead: 'Outside sessions.', text: 'Agents you start in a terminal show up on the floor.', pr: 45 }] },
    { title: 'Improved', items: [{ text: "Notifications show the chat's title instead of the branch name.", pr: 43 }, { text: 'The board scrolls faster.', pr: 48 }] },
    { title: 'Fixed', items: [{ text: 'Fixed a pull request sometimes showing its old status after a quick refresh.', pr: 44 }] }
  ]
}

describe('notes for What\'s new', () => {
  it('reads cleanly in the parser installed 0.1.0 copies run on their first update', () => {
    const notes = parseNotesV010(renderApp(sample))
    expect(notes).toEqual([
      { title: 'Outside sessions', body: 'Agents you start in a terminal show up on the floor.' },
      { title: 'Improved', body: "Notifications show the chat's title instead of the branch name. The board scrolls faster." },
      { title: 'Fixed', body: 'Fixed a pull request sometimes showing its old status after a quick refresh.' }
    ])
    for (const n of notes) expect(`${n.title} ${n.body}`).not.toMatch(/\(#|\*\*|^-|\s-\s/)
  })

  it('puts each change on its own line in the current parser', () => {
    expect(parseNotes(renderApp(sample))[1]).toEqual({
      title: 'Improved',
      body: "Notifications show the chat's title instead of the branch name.\nThe board scrolls faster."
    })
  })

  it('keeps a lead without a period in its sentence (0.1.0 style)', () => {
    const r = parseReleaseFile(release010)
    const notes = parseNotesV010(renderApp(r))
    expect(notes.map((n) => n.title)).toEqual(['The floor', 'Plans you approve', 'Workspaces', 'Inbox', 'Pull requests, end to end', 'Highlights', 'Under the hood'])
    expect(notes[5]!.body).toBe("Checkpoints after every turn, and your agent's own terminal in a tab. Board, settings and a light theme, plus macOS notifications.")
  })
})

describe('the GitHub release body', () => {
  it('has the intro, the sections with PR numbers, then GitHub\'s generated list', () => {
    const generated = "## What's Changed\n* feat(floor): outside sessions by @cjjutba in https://github.com/cjjutba/kernel/pull/45\n\n\n**Full Changelog**: https://github.com/cjjutba/kernel/compare/v0.1.0...v0.2.0"
    expect(renderGithub(sample, generated)).toBe(
      [
        'Agents you start anywhere show up on the floor.',
        '',
        '## Highlights',
        '',
        '- **Outside sessions.** Agents you start in a terminal show up on the floor. (#45)',
        '',
        '## Improved',
        '',
        "- Notifications show the chat's title instead of the branch name. (#43)",
        '- The board scrolls faster. (#48)',
        '',
        '## Fixed',
        '',
        '- Fixed a pull request sometimes showing its old status after a quick refresh. (#44)',
        '',
        '## Full list of changes',
        '',
        '* feat(floor): outside sessions by @cjjutba in https://github.com/cjjutba/kernel/pull/45',
        '',
        '',
        '**Full Changelog**: https://github.com/cjjutba/kernel/compare/v0.1.0...v0.2.0',
        ''
      ].join('\n')
    )
    expect(renderGithub({ ...sample, intro: undefined })).not.toContain('Full list of changes')
  })
})

describe('the Release note check', () => {
  const pr = (files: [string, string][], extra: Partial<Parameters<typeof checkPullRequest>[0]> = {}) =>
    checkPullRequest({ branch: 'cjjutba/kernel-70-fix-pr-refresh', labels: [], dependenciesChanged: false, files: files.map(([status, path]) => ({ status, path })), ...extra })

  it('fails app changes without a fragment and names the file to add', () => {
    const r = pr([['M', 'src/main/kernel.ts'], ['M', 'docs/PRODUCT.md']])
    expect(r).toEqual({ ok: false, appFiles: ['src/main/kernel.ts'], suggestion: '.changes/unreleased/kernel-70-fix-pr-refresh.md' })
    if (!r.ok) expect(missingMessage(r)).toContain('Add .changes/unreleased/kernel-70-fix-pr-refresh.md')
  })

  it.each(['src/renderer/src/App.tsx', 'docs/starter-agents/rowan.md', 'build/entitlements.mac.plist', 'electron-builder.yml', 'scripts/release.sh'])(
    'counts %s as an app file',
    (path) => expect(pr([['M', path]]).ok).toBe(false)
  )

  it('counts dependency changes in package.json, not script changes', () => {
    expect(pr([['M', 'package.json']], { dependenciesChanged: true }).ok).toBe(false)
    expect(pr([['M', 'package.json']]).ok).toBe(true)
    const before = JSON.stringify({ version: '0.1.0', scripts: { a: 'x' }, dependencies: { zod: '4.1' } })
    expect(dependenciesChanged(before, JSON.stringify({ version: '0.2.0', scripts: { a: 'y' }, dependencies: { zod: '4.1' } }))).toBe(false)
    expect(dependenciesChanged(before, JSON.stringify({ version: '0.1.0', devDependencies: { electron: '39' }, dependencies: { zod: '4.1' } }))).toBe(true)
    const two = (a: object) => JSON.stringify({ dependencies: a })
    expect(dependenciesChanged(two({ zod: '4.1', ajv: '8' }), two({ ajv: '8', zod: '4.1' }))).toBe(false)
  })

  it('passes with an added fragment of any type, including internal', () => {
    expect(pr([['M', 'src/main/kernel.ts'], ['A', '.changes/unreleased/ci.md']])).toEqual({ ok: true, reason: 'has a fragment' })
    expect(pr([['M', 'src/main/kernel.ts'], ['M', '.changes/unreleased/old.md']]).ok).toBe(false)
  })

  it('exempts docs-only PRs, release branches and the skip label', () => {
    expect(pr([['M', 'site/app/page.tsx'], ['M', 'docs/RELEASING.md'], ['M', '.github/workflows/site.yml'], ['A', 'test/x.test.ts'], ['M', '.claude/commands/issue.md'], ['M', 'design/screens/Home.png']])).toEqual({ ok: true, reason: 'no app files' })
    expect(pr([['M', 'package.json'], ['A', 'site/content/releases/0.2.0.md'], ['D', '.changes/unreleased/a.md']], { branch: 'release/0.2.0', dependenciesChanged: true })).toEqual({ ok: true, reason: 'release branch' })
    expect(pr([['M', 'package-lock.json'], ['M', 'package.json']], { labels: ['skip-release-note'], dependenciesChanged: true })).toEqual({ ok: true, reason: 'skip label' })
    // Anyone can name a fork's branch release/x.
    expect(pr([['M', 'src/main/kernel.ts']], { branch: 'release/0.2.0', fork: true }).ok).toBe(false)
  })
})
