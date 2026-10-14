import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../src/renderer/src')
const ui = join(root, 'ui') + sep

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? tsxFiles(p) : p.endsWith('.tsx') ? [p] : []
  })
}

describe('the dot loader (KERNEL-714)', () => {
  it('has no raw ring outside ui/, so every loader is a Spinner', () => {
    const files = tsxFiles(root).filter((f) => !f.startsWith(ui))
    expect(files.length).toBeGreaterThan(0)
    const raw = files.filter((f) => /className=(?:"spin[\s"]|\{`spin)/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f))
    expect(raw).toEqual([])
  })
})
