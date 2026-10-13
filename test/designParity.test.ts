import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// KERNEL-681: the app and the website keep their own values (design/site is the site's spec) but the same token families, and the colors
// they share with meaning stay the same. The site is read as text only: it is not part of this package (D-056).
const root = join(__dirname, '..')
const app = readFileSync(join(root, 'src/renderer/src/tokens.css'), 'utf8')
const site = readFileSync(join(root, 'site/app/globals.css'), 'utf8')
/** The first value of a custom property: the app's dark theme comes first in tokens.css, and the site is dark only. */
const value = (css: string, name: string) => new RegExp(`(?<![\\w-])${name}:\\s*([^;]+);`).exec(css)?.[1].trim()

describe('app and website tokens', () => {
  it('share the diff and merged colors', () => {
    const pairs = [['--add', '--color-add'], ['--merged', '--color-merged'], ['--merged-solid', '--color-merged-fill']]
    expect(pairs.map(([a, s]) => [a, value(app, a), value(site, s)]).filter(([, a, s]) => !a || a !== s)).toEqual([])
  })
  it('both have tokens for color, radius, type size, weight, layer and motion', () => {
    const families: [string, RegExp, RegExp][] = [
      ['color', /--ink:/, /--color-ink:/],
      ['radius', /--r-md:/, /--radius-[\w-]+:\s*\d/],
      ['type size', /--fs-ui:/, /--text-body:/],
      ['weight', /--fw-medium:/, /--font-weight-medium:/],
      ['layer', /--z-modal:/, /--z-index-[\w-]+:/],
      ['motion', /--dur-fast:/, /--duration-[\w-]+:/],
    ]
    expect(families.filter(([, a, s]) => !a.test(app) || !s.test(site)).map(([name]) => name)).toEqual([])
  })
})
