import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// KERNEL-680: every dropdown is Select from ui. A native select draws a macOS popup menu that matches nothing else in Kernel.
const root = join(__dirname, '..')
const NATIVE = /<(select|option|optgroup|datalist)[\s>/]/

export function nativeSelects(source: string): number[] {
  return source.split('\n').flatMap((line, i) => (NATIVE.test(line) ? [i + 1] : []))
}

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name)
  if (e.isDirectory()) return files(p)
  return /\.(tsx|jsx)$/.test(e.name) ? [p] : []
})

describe('no native select', () => {
  it('finds native select markup', () => {
    expect(nativeSelects('<Select value="a" />\n<select value="a">\n  <option value="a">A</option>')).toEqual([2, 3])
    expect(nativeSelects('const x = <Select\n  label="Run by"')).toEqual([])
  })
  it('the renderer uses Select from ui instead of select and option', () => {
    const hits: string[] = []
    for (const f of files(join(root, 'src/renderer/src'))) {
      for (const line of nativeSelects(readFileSync(f, 'utf8'))) hits.push(`${f.slice(root.length + 1)}:${line}`)
    }
    expect(hits).toEqual([])
  })
})
