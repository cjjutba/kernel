import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { APP_SETTING_TIMING, PROJECT_SETTING_TIMING, type ProjectSettingPath } from '../src/shared/settingsTiming'
import { DEFAULT_SETTINGS, loadRepoSettings } from '../src/main/services/settings'

const isTable = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Every dotted path in `o`, tables included, and which of them are leaves: a value, a list, null or an empty table. */
function paths(o: Record<string, unknown>, prefix = ''): { all: string[]; leaves: string[] } {
  const all: string[] = []
  const leaves: string[] = []
  for (const [k, v] of Object.entries(o)) {
    const p = prefix + k
    all.push(p)
    if (isTable(v) && Object.keys(v).length) {
      const below = paths(v, `${p}.`)
      all.push(...below.all)
      leaves.push(...below.leaves)
    } else leaves.push(p)
  }
  return { all, leaves }
}

/** An entry for the path itself or a table above it. */
const covered = (map: Record<string, unknown>, path: string) => path.split('.').some((_, i, parts) => parts.slice(0, i + 1).join('.') in map)

describe('settings timing (KERNEL-724)', () => {
  const app = paths(DEFAULT_SETTINGS('/Users/you') as unknown as Record<string, unknown>)

  it('records every app setting', () => {
    expect(app.leaves.filter((p) => !covered(APP_SETTING_TIMING, p))).toEqual([])
  })

  it('records only app settings that exist', () => {
    expect(Object.keys(APP_SETTING_TIMING).filter((p) => !app.all.includes(p))).toEqual([])
  })

  it('records every project setting', () => {
    // The type is the full list, so a project key without an entry fails pnpm typecheck.
    expectTypeOf<keyof typeof PROJECT_SETTING_TIMING>().toEqualTypeOf<ProjectSettingPath>()
    // A project's workspace keys are the app's, and an empty project file still has its tables.
    const workspace = Object.keys(DEFAULT_SETTINGS('').workspace).map((k) => `workspace.${k}`)
    expect(workspace.filter((p) => !(p in PROJECT_SETTING_TIMING))).toEqual([])
  })

  it('records every table an empty project loads with', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'kernel-timing-'))
    const { sources: _sources, ...project } = await loadRepoSettings(repo)
    const keys = Object.keys(PROJECT_SETTING_TIMING)
    expect(Object.keys(project).filter((g) => !keys.some((k) => k === g || k.startsWith(`${g}.`)))).toEqual([])
  })

  it('gives a project key the same timing as the app key it overrides', () => {
    const differs = Object.entries(PROJECT_SETTING_TIMING).filter(([p, t]) => p in APP_SETTING_TIMING && APP_SETTING_TIMING[p] !== t)
    expect(differs).toEqual([])
  })
})
