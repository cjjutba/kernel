import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// KERNEL-681: the app and the website keep their own tokens, but the colors that carry meaning are the same in both. Green is add and
// purple is merged. The site is read as text only: it is not part of this package (D-056).
const root = join(__dirname, '..')
const app = readFileSync(join(root, 'src/renderer/src/tokens.css'), 'utf8')
const site = readFileSync(join(root, 'site/app/globals.css'), 'utf8')

/** The first value of a custom property. The app's dark theme comes first in tokens.css, and the site is dark only. */
const value = (css: string, name: string) => new RegExp(`(?<![\\w-])${name}:\\s*([^;]+);`).exec(css)?.[1].trim()

describe('app and website colors', () => {
  it('share the add and merged colors', () => {
    const pairs = [['--add', '--color-add'], ['--merged', '--color-merged'], ['--merged-solid', '--color-merged-fill']]
    expect(pairs.map(([a, s]) => [a, value(app, a), value(site, s)]).filter(([, a, s]) => !a || a !== s)).toEqual([])
  })
})
