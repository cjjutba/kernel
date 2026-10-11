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

  // `k['name']` reaches a private member around TypeScript's check. It was a stopgap while features moved out of kernel.ts
  // (KERNEL-324). A member another feature needs is public on the feature that owns it, or on Kernel (KERNEL-331).
  it("reaches Kernel's members without bracket access", () => {
    const wrong = readdirSync(DIR).filter((f) => f.endsWith('.ts')).flatMap((file) =>
      readFileSync(join(DIR, file), 'utf8').split('\n').flatMap((line, i) => (/\bk\[['"]/.test(line) ? [`${file}:${i + 1}`] : [])))
    expect(wrong).toEqual([])
  })
})

// kernel.ts only builds, starts and stops the features and joins their channels. Every feature that added a field, an
// import or a channel there made it the file every Engine PR conflicted on (KERNEL-331).
describe('src/main/kernel.ts', () => {
  it('stays small', () => {
    const lines = readFileSync('src/main/kernel.ts', 'utf8').split('\n').length
    expect(lines, "kernel.ts grew past 450 lines. A feature's state, logic and channels go in its file under src/main/features/, a reaction to a finished turn in features/sessionDeps.ts, and a reaction to a push event in features/wiring.ts.").toBeLessThanOrEqual(450)
  })
})
