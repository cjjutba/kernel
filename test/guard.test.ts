import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The guard reads HOME through os.homedir(), so a fake home keeps these runs
// away from the real ~/.claude.
const home = mkdtempSync(join(tmpdir(), 'kernel-guard-home-'))
const repo = mkdtempSync(join(tmpdir(), 'kernel-guard-repo-'))
mkdirSync(join(home, '.claude', 'plans'), { recursive: true })
mkdirSync(join(home, 'Library', 'Application Support', 'Kernel'), { recursive: true })
writeFileSync(join(home, '.claude', 'settings.json'), '{}')
symlinkSync(join(home, '.claude', 'settings.json'), join(home, '.claude', 'plans', 'link.md'))

function guard(tool: string, file_path: string) {
  const out = execFileSync(process.execPath, [resolve('.claude/hooks/guard.mjs')], {
    input: JSON.stringify({ tool_name: tool, tool_input: { file_path }, cwd: repo }),
    env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: repo },
    encoding: 'utf8'
  })
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow'
}

describe('guard: edits outside the repo', () => {
  it.each([
    ['a file in the repo', 'Write', join(repo, 'src/a.ts')],
    ['a plan file in the plans folder', 'Write', join(home, '.claude/plans/kernel-63-rosy-pixel.md')],
    ['an edit to a plan file', 'Edit', join(home, '.claude/plans/kernel-63-rosy-pixel.md')],
    ['a plan file written with ~', 'Write', '~/.claude/plans/kernel-63-rosy-pixel.md']
  ])('allows %s', (_, tool, file) => {
    expect(guard(tool, file)).toBe('allow')
  })

  it.each([
    ['~/.claude/settings.json', 'Write', join(home, '.claude/settings.json')],
    ['~/.claude/settings.json with ~', 'Edit', '~/.claude/settings.json'],
    ['Application Support/Kernel', 'Write', join(home, 'Library/Application Support/Kernel/kernel.db')],
    ['a non-.md file in the plans folder', 'Write', join(home, '.claude/plans/notes.txt')],
    ['a prefix trap', 'Write', join(home, '.claude/plans-evil/x.md')],
    ['a .. out of the plans folder', 'Write', join(home, '.claude/plans/../x.md')],
    ['a subfolder of the plans folder', 'Write', join(home, '.claude/plans/sub/x.md')],
    ['a plans folder in another home', 'Write', join(repo, '..', 'elsewhere/.claude/plans/x.md')],
    ['a .md symlink to settings.json', 'Write', join(home, '.claude/plans/link.md')]
  ])('denies %s', (_, tool, file) => {
    expect(guard(tool, file)).toBe('deny')
  })
})
