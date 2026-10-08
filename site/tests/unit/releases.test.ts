import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { groupReleases, loadReleases } from '@/lib/releases'
import { formatReleaseFile, parseReleaseFile, PLACEHOLDER_TITLE, type Release } from '@/lib/schema'

const release = (version: string, date: string, extra: Partial<Release> = {}): Release => ({
  version,
  date,
  title: `Kernel ${version}`,
  sections: [{ title: 'Fixed', items: [{ text: `Fixed something in ${version}.`, pr: 40 }] }],
  ...extra
})

function dirWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-releases-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

describe('release files', () => {
  it('reads 0.1.0 and writes it back unchanged', () => {
    const text = readFileSync(join(import.meta.dirname, '../../content/releases/0.1.0.md'), 'utf8')
    const parsed = parseReleaseFile(text)
    expect(parsed.image?.alt).toContain(': the lead')
    expect(parsed.sections.map((s) => s.title)).toEqual(['Highlights', 'Under the hood'])
    expect(parsed.sections[0]!.items[5]).toEqual({ lead: 'Checkpoints', text: "after every turn, and your agent's own terminal in a tab." })
    expect(parsed.sections[1]!.items.map((i) => i.pr)).toEqual([32, 33, 34, 35, 37, 38])
    expect(formatReleaseFile(parsed)).toBe(text)
  })

  it('round trips a patch release with no image or intro', () => {
    const r = release('0.1.1', '2026-10-20')
    expect(parseReleaseFile(formatReleaseFile(r))).toEqual(r)
  })

  it('refuses the placeholder title, unknown keys and stray lines', () => {
    expect(() => parseReleaseFile(formatReleaseFile(release('0.2.0', '2026-11-01', { title: PLACEHOLDER_TITLE })))).toThrow(
      'write a title'
    )
    expect(() => parseReleaseFile('---\nversion: 0.2.0\ndate: 2026-11-01\ntitle: A\nauthor: me\n---\n## New\n\n- A.\n')).toThrow(
      'Unrecognized key'
    )
    expect(() => parseReleaseFile('---\nversion: 0.2.0\ndate: 2026-11-01\ntitle: A\n---\n\nSome prose.\n')).toThrow(
      'line 7: expected "## Section" or "- item"'
    )
  })
})

describe('the changelog', () => {
  it('folds patches into their minor, oldest patch first, entries newest first', () => {
    const entries = groupReleases([
      release('0.1.0', '2026-10-08'),
      release('0.2.1', '2026-11-05'),
      release('0.1.2', '2026-10-25'),
      release('0.2.0', '2026-11-01'),
      release('0.1.1', '2026-10-20')
    ])
    expect(entries.map((e) => [e.version, e.patches.map((p) => p.version)])).toEqual([
      ['0.2.0', ['0.2.1']],
      ['0.1.0', ['0.1.1', '0.1.2']]
    ])
  })

  it('fails when a patch has no minor to show under', () => {
    expect(() => groupReleases([release('0.1.0', '2026-10-08'), release('0.2.1', '2026-11-05')])).toThrow(
      '0.2.1 has no 0.2.0 release'
    )
  })

  it('loads newest first and checks each file is named after its version', () => {
    const ok = dirWith({
      '0.1.0.md': formatReleaseFile(release('0.1.0', '2026-10-08')),
      '0.1.1.md': formatReleaseFile(release('0.1.1', '2026-10-20'))
    })
    expect(loadReleases(ok).map((r) => r.version)).toEqual(['0.1.1', '0.1.0'])
    const misnamed = dirWith({ '0.1.2.md': formatReleaseFile(release('0.1.1', '2026-10-20')) })
    expect(() => loadReleases(misnamed)).toThrow('content/releases/0.1.2.md says version 0.1.1')
  })
})
