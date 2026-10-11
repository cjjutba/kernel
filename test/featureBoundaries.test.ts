import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A feature reaches Kernel and the other features through the Kernel it was built with, never by importing them, so
// moving or adding a feature never edits another's imports and no two of them can load each other (KERNEL-324). These
// files hold no feature and are fine to import.
const DIR = 'src/main/features'
const SHARED = new Set(['./feature', './records', './shared', './channels', './options'])

/** The modules a file imports as values: `import type` is erased at build time and doesn't count. */
function valueImports(text: string): string[] {
  const from = [...text.matchAll(/^import\s+(?!type\s)[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  const bare = [...text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  return [...from, ...bare]
}

describe('src/main/features', () => {
  it('imports kernel.ts and the other features only as types', () => {
    const wrong = readdirSync(DIR).filter((f) => f.endsWith('.ts')).flatMap((file) =>
      valueImports(readFileSync(join(DIR, file), 'utf8'))
        .filter((m) => m === '../kernel' || (m.startsWith('./') && !SHARED.has(m)))
        .map((m) => `${file} imports ${m}`))
    expect(wrong).toEqual([])
  })

  it('catches a value import of kernel.ts or a feature', () => {
    expect(valueImports("import { Kernel } from '../kernel'\nimport type { Prs } from './prs'\nimport {\n  waits\n} from './waits'\nimport './chats'"))
      .toEqual(['../kernel', './waits', './chats'])
  })
})
