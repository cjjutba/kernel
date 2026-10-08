import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { run } from '../src/main/services/exec'
import { saveRepoSettings } from '../src/main/services/settings'

// KERNEL-69: the personal settings file never shows up as a change, and an empty one is never written.

const status = async (repo: string) => (await run('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'])).trim()
const exclude = async (repo: string) => readFile(join(repo, '.git', 'info', 'exclude'), 'utf8').catch(() => '')

describe('.kernel/settings.local.toml', () => {
  it("stays out of git: Kernel adds it to info/exclude when the repo doesn't ignore it", async () => {
    const repo = await tempRepo()
    await saveRepoSettings(repo, { scripts: { setup: 'npm ci' } })
    expect(existsSync(join(repo, '.kernel/settings.local.toml'))).toBe(true)
    expect(await status(repo)).toBe('')
    // A second save finds it ignored and adds nothing.
    await saveRepoSettings(repo, { scripts: { run: 'npm run dev' } })
    expect((await exclude(repo)).split('\n').filter((l) => l === '/.kernel/settings.local.toml')).toHaveLength(1)
  })

  it("leaves a repo alone when its .gitignore already covers the file", async () => {
    const repo = await tempRepo({ 'README.md': '# x\n', '.gitignore': '.kernel/settings.local.toml\n' })
    const before = await exclude(repo)
    await saveRepoSettings(repo, { scripts: { setup: 'npm ci' } })
    expect(await exclude(repo)).toBe(before)
    expect(await status(repo)).toBe('')
  })

  it('writes no file for a save that leaves nothing to override, and removes one that becomes empty', async () => {
    const repo = await tempRepo()
    await saveRepoSettings(repo, {})
    expect(existsSync(join(repo, '.kernel/settings.local.toml'))).toBe(false)
    await saveRepoSettings(repo, { scripts: { setup: 'npm ci' } })
    await saveRepoSettings(repo, { scripts: { setup: null } })
    expect(existsSync(join(repo, '.kernel/settings.local.toml'))).toBe(false)
    expect(await status(repo)).toBe('')
  })

  it('keeps the shared settings.toml visible to git, since it is meant to be committed', async () => {
    const repo = await tempRepo()
    await saveRepoSettings(repo, { scripts: { setup: 'npm ci' } }, true)
    expect(await status(repo)).toContain('.kernel/settings.toml')
    expect(await exclude(repo)).not.toContain('settings.local.toml')
  })
})
