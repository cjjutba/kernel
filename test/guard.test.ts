import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// The guard reads HOME through os.homedir(), so a fake home keeps these runs
// away from the real ~/.claude.
const tmp = mkdtempSync(join(tmpdir(), 'kernel-guard-'))
const home = join(tmp, 'home')
const repo = join(tmp, 'repo')
const outside = join(tmp, 'outside')
mkdirSync(join(home, '.claude', 'plans', 'real-sub'), { recursive: true })
mkdirSync(join(home, 'Library', 'Application Support', 'Kernel'), { recursive: true })
mkdirSync(repo)
mkdirSync(join(outside, 'deeper'), { recursive: true })
writeFileSync(join(home, '.claude', 'settings.json'), '{}')
const plans = join(home, '.claude', 'plans')
symlinkSync(join(home, '.claude', 'settings.json'), join(plans, 'link.md'))
symlinkSync(join(outside, 'evil.plist'), join(plans, 'dangling.md'))
symlinkSync(join(outside, 'deeper'), join(plans, 'd'))
symlinkSync(join(outside, 'new.ts'), join(repo, 'dangling.ts'))
symlinkSync(join(outside, 'deeper'), join(repo, 'd'))
symlinkSync(join(repo, 'loop-b'), join(repo, 'loop-a'))
symlinkSync(join(repo, 'loop-a'), join(repo, 'loop-b'))

// A second home whose plans folder is a symlink to its own ~/.claude.
const linkedHome = join(tmp, 'linked-home')
mkdirSync(join(linkedHome, '.claude'), { recursive: true })
symlinkSync(join(linkedHome, '.claude'), join(linkedHome, '.claude', 'plans'))

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function guard(tool: string, toolInput: Record<string, string>, h = home) {
  const out = execFileSync(process.execPath, [resolve('.claude/hooks/guard.mjs')], {
    input: JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: repo }),
    env: { ...process.env, HOME: h, CLAUDE_PROJECT_DIR: repo },
    encoding: 'utf8'
  })
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow'
}

describe('guard: edits outside the repo', () => {
  it.each([
    ['a file in the repo', 'Write', join(repo, 'src/a.ts')],
    ['a relative path in the repo', 'Write', 'src/a.ts'],
    ['a plan file in the plans folder', 'Write', `${plans}/kernel-63-rosy-pixel.md`],
    ['an edit to a plan file', 'Edit', `${plans}/kernel-63-rosy-pixel.md`],
    ['a MultiEdit to a plan file', 'MultiEdit', `${plans}/kernel-63-rosy-pixel.md`],
    ['a plan file written with ~', 'Write', '~/.claude/plans/kernel-63-rosy-pixel.md'],
    ['a real subfolder and .. back into the plans folder', 'Write', `${plans}/real-sub/../x.md`]
  ])('allows %s', (_, tool, file) => {
    expect(guard(tool, { file_path: file })).toBe('allow')
  })

  it.each([
    ['~/.claude/settings.json', 'Write', join(home, '.claude/settings.json')],
    ['~/.claude/settings.json with ~', 'Edit', '~/.claude/settings.json'],
    ['Application Support/Kernel', 'Write', join(home, 'Library/Application Support/Kernel/kernel.db')],
    ['a non-.md file in the plans folder', 'Write', `${plans}/notes.txt`],
    ['a prefix trap', 'Write', join(home, '.claude/plans-evil/x.md')],
    ['a literal .. out of the plans folder', 'Write', `${plans}/../x.md`],
    ['a subfolder of the plans folder', 'Write', `${plans}/real-sub/x.md`],
    ['a plans folder in another home', 'Write', join(repo, '..', 'elsewhere/.claude/plans/x.md')],
    ['a .md symlink to settings.json', 'Write', `${plans}/link.md`],
    ['a dangling .md symlink in the plans folder', 'Write', `${plans}/dangling.md`],
    ['a .. behind a symlinked folder in the plans folder', 'Write', `${plans}/d/../x.md`],
    ['a dangling symlink in the repo that points outside', 'Write', join(repo, 'dangling.ts')],
    ['a .. behind a symlinked folder in the repo', 'Edit', `${repo}/d/../x.ts`],
    ['a symlink loop', 'Write', join(repo, 'loop-a')],
    ['a MultiEdit outside the repo', 'MultiEdit', join(outside, 'x.md')]
  ])('denies %s', (_, tool, file) => {
    expect(guard(tool, { file_path: file })).toBe('deny')
  })

  it('checks NotebookEdit through notebook_path', () => {
    expect(guard('NotebookEdit', { notebook_path: join(repo, 'a.ipynb') })).toBe('allow')
    expect(guard('NotebookEdit', { notebook_path: join(outside, 'a.ipynb') })).toBe('deny')
    expect(guard('NotebookEdit', { notebook_path: `${plans}/a.ipynb` })).toBe('deny')
  })

  it('does not follow a plans folder that is a symlink to ~/.claude', () => {
    expect(guard('Write', { file_path: join(linkedHome, '.claude/plans/CLAUDE.md') }, linkedHome)).toBe('deny')
  })
})
