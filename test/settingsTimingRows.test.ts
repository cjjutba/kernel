import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_SETTING_TIMING, PROJECT_SETTING_TIMING } from '../src/shared/settingsTiming'
import { appliesTo } from '../src/renderer/src/screens/settings/kit'

const dir = 'src/renderer/src/screens/settings'
const files = [join(dir, 'kit.tsx'), ...readdirSync(join(dir, 'pages')).filter((f) => f.endsWith('.tsx')).map((f) => join(dir, 'pages', f))]
const lines = files.flatMap((f) => readFileSync(f, 'utf8').split('\n')).filter((l) => /\bsetting=|appliesTo\(/.test(l))

/**
 * Settings that have no row in Settings at all: main reads them, but only a settings file sets them.
 */
const NO_ROW = new Set(['hookPort', 'experimental.sharing', 'models.effortByModel', 'mcp.aliases', 'agents.unlistedTools', 'agents.allow'])

const NOTED = new Set(['newChats', 'newWorkspaces', 'newProjects', 'restart'])
const noted = (map: Record<string, string>) => Object.entries(map).filter(([, t]) => NOTED.has(t)).map(([k]) => k)

describe('Applies to notes (KERNEL-725)', () => {
  const keys = [...new Set([...noted(APP_SETTING_TIMING), ...noted(PROJECT_SETTING_TIMING)])].filter((k) => !NO_ROW.has(k))

  it.each(keys)('%s has a row that shows its note', (key) => {
    expect(lines.some((l) => l.includes(`'${key}'`) || l.includes(`"${key}"`))).toBe(true)
  })

  it('lists only settings that have no row', () => {
    for (const key of NO_ROW) expect(lines.some((l) => l.includes(`'${key}'`) || l.includes(`"${key}"`))).toBe(false)
  })

  it('words each timing', () => {
    expect(appliesTo('models.leadPlanMode')).toBe('Applies to new chats')
    expect(appliesTo('workspace.mode')).toBe('Applies to teammates and to chats when they switch to Build here')
    expect(appliesTo('workspace.baseRef')).toBe('Applies to new workspaces')
    expect(appliesTo('team.defaultTemplate')).toBe('Applies to new projects')
    expect(appliesTo('general.openTo')).toBe('Applies the next time Kernel opens')
    expect(appliesTo('terminal.preset')).toBe('Applies to new terminal tabs')
    expect(appliesTo('terminal.onlyInWorktrees')).toBe('Applies to new terminal tabs')
    expect(appliesTo('models.roles.lead.model')).toBe('Applies to new chats')
  })

  it('says nothing for a change that reaches running agents', () => {
    expect(appliesTo('permissions.network')).toBeUndefined()
    expect(appliesTo('models.compact')).toBeUndefined()
    expect(appliesTo('no.such.setting')).toBeUndefined()
  })
})
