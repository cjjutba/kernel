import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAV_PAGES, ROOM_PAGES, keywordHits, type Keyword } from '../src/renderer/src/screens/settings/nav'

const dir = 'src/renderer/src/screens/settings'
const read = (f: string) => readFileSync(join(dir, f), 'utf8')

/** The files that draw each page, so a keyword's row is looked for on its own page. */
const APP_FILES: Record<string, string[]> = {
  general: ['General'], appearance: ['Appearance'], notifications: ['Notifications'], accounts: ['Accounts'], models: ['Models'], agents: ['Agents'],
  permissions: ['Permissions'], git: ['Git'], prs: ['PRs'], bigterm: ['BigTerminal'], integrations: ['Integrations'], hooks: ['Hooks'], privacy: ['Privacy'], about: ['About']
}
const ROOM_FILES: Record<string, string[]> = {
  general: ['Room', 'RoomIconRow', 'RoomTrackerRow'], git: ['RoomGit'], setup: ['RoomSetup', 'RunScripts', 'PreviewUrls'], agents: ['Team'], prs: ['RoomPrs'], permissions: ['RoomPermissions']
}

/** Does a Row or Section in these files have this id: written out, or as a template that starts the way the id does (`review-${id}`)? */
function hasRow(files: string[], rowId: string): boolean {
  const src = files.map((f) => read(`pages/${f}.tsx`)).join('\n')
  if (src.includes(`id="${rowId}"`)) return true
  return [...src.matchAll(/\bid=\{`([^`$]*)\$\{/g)].some((m) => rowId.startsWith(m[1]))
}

const cases = (pages: { label: string; keywords: Keyword[]; key: string }[], files: Record<string, string[]>) =>
  pages.flatMap((p) => p.keywords.map((k) => [p.label, k.label, k.rowId, files[p.key]] as const))

describe('Settings search (KERNEL-727)', () => {
  const app = NAV_PAGES.map((p) => ({ label: p.label, keywords: p.keywords, key: p.page }))
  const room = ROOM_PAGES.map((p) => ({ label: `Room ${p.label}`, keywords: p.keywords, key: p.section }))

  it.each([...cases(app, APP_FILES), ...cases(room, ROOM_FILES)])('%s: "%s" lands on a Row with id %s', (_page, _label, rowId, files) => {
    expect(files, 'add the page to the file list in this test').toBeDefined()
    expect(hasRow(files, rowId)).toBe(true)
  })

  it('finds the settings the issue names', () => {
    const rows = (q: string) => NAV_PAGES.flatMap((p) => keywordHits(q, p.keywords).map((k) => `${p.page}/${k.rowId}`))
    expect(rows('size limit')).toEqual(['prs/size-limit'])
    expect(rows('quiet hours')).toEqual(['notifications/quiet-hours'])
    expect(rows('protected branches')).toEqual(['permissions/protected-branches'])
  })

  it('names no row twice on a page', () => {
    for (const p of [...NAV_PAGES, ...ROOM_PAGES]) {
      const ids = p.keywords.map((k) => k.rowId)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
