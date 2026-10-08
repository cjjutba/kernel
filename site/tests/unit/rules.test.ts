import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// The design rules from docs/plans/website.md section 14.4, as tests.

const root = join(import.meta.dirname, '..', '..')

function files(dir: string, test: (path: string) => boolean): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name)
    return statSync(join(root, path)).isDirectory() ? files(path, test) : test(path) ? [path] : []
  })
}

function offenders(paths: string[], pattern: RegExp) {
  return paths.flatMap((path) =>
    readFileSync(join(root, path), 'utf8')
      .split('\n')
      .flatMap((line, i) => (pattern.test(line) ? [`${relative(root, join(root, path))}:${i + 1}: ${line.trim()}`] : []))
  )
}

const tsx = (p: string) => p.endsWith('.tsx')
const code = (p: string) => /\.tsx?$/.test(p)

describe('design rules', () => {
  it('keeps hex colors out of components and pages (globals.css holds the tokens)', () => {
    const paths = [...files('components', code), ...files('app', tsx)]
    expect(offenders(paths, /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/i)).toEqual([])
  })

  it('uses no arbitrary Tailwind values', () => {
    const paths = [...files('components', code), ...files('app', code)]
    expect(offenders(paths, /-\[|-\(--/)).toEqual([])
  })

  it('has no em or en dashes in user facing text', () => {
    const paths = [...files('components', () => true), ...files('content', () => true), ...files('app', (p) => !p.endsWith('.png'))]
    expect(offenders(paths, /[–—]/)).toEqual([])
  })
})
