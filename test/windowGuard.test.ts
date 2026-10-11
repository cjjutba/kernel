import { describe, expect, it } from 'vitest'
import { insideRoots, isAppUrl } from '../src/main/windowGuard'

describe('isAppUrl', () => {
  const packaged = 'file:///Applications/Kernel.app/Contents/Resources/app.asar/out/renderer/index.html'
  const dev = 'http://localhost:5173'

  it.each([
    ['the packaged page', packaged, packaged, true],
    ['the packaged page with a hash route', `${packaged}#/dev/ui/buttons`, packaged, true],
    ['a bundle in a folder with a % and a space', 'file:///Users/you/100%25%20done/Kernel.app/index.html', 'file:///Users/you/100% done/Kernel.app/index.html', true],
    ['a bundle in a folder named in another script', 'file:///Users/you/%C3%A9t%C3%A9/index.html', 'file:///Users/you/été/index.html', true],
    ['the dev server','http://localhost:5173/', dev, true],
    ['the dev server with a query', 'http://localhost:5173/?t=1', dev, true],
    ['a dropped HTML file', 'file:///Users/you/Downloads/page.html', packaged, false],
    ['another file in the bundle', 'file:///Applications/Kernel.app/Contents/Resources/app.asar/out/renderer/other.html', packaged, false],
    ['another port', 'http://localhost:5174/', dev, false],
    ['a web page', 'https://example.com/', dev, false],
    ['javascript:', 'javascript:alert(1)', packaged, false],
    ['about:blank', 'about:blank', packaged, false],
    ['an empty url', '', packaged, false],
    ['no url (a closed frame)', undefined, packaged, false]
  ])('%s', (_name, url, appUrl, expected) => {
    expect(isAppUrl(url, appUrl)).toBe(expected)
  })
})

describe('insideRoots', () => {
  const roots = ['/Users/you/code/app', '/Users/you/.kernel/worktrees/app/fix-login']

  it.each([
    ['a room checkout', '/Users/you/code/app', true],
    ['a file in a room', '/Users/you/code/app/src/index.ts', true],
    ['a plan in a worktree', '/Users/you/.kernel/worktrees/app/fix-login/plans/login.md', true],
    ['a sibling with the same prefix', '/Users/you/code/app-secrets/run.command', false],
    ['a path that climbs out', '/Users/you/code/app/../../Downloads/run.command', false],
    ['a file elsewhere', '/Applications/Terminal.app', false],
    ['a relative path', 'src/index.ts', false]
  ])('%s', (_name, path, expected) => {
    expect(insideRoots(path, roots)).toBe(expected)
  })

  it('accepts nothing when Kernel knows no rooms', () => {
    expect(insideRoots('/Users/you/code/app/a.ts', [])).toBe(false)
  })
})
