import { describe, expect, it } from 'vitest'
import { githubIssueUrl } from '../src/renderer/src/screens/workspace/issueKey'

const issue = (id: string, url?: string) => ({ kind: 'issue' as const, id, title: 'Invoice table', url })

describe('githubIssueUrl', () => {
  it('keeps the url the source carries', () => {
    expect(githubIssueUrl(issue('#12', 'https://github.com/a/b/issues/12'), { kind: 'repo', repo: 'x/y' })).toBe('https://github.com/a/b/issues/12')
  })
  it('builds it from the room repo when the source has none', () => {
    expect(githubIssueUrl(issue('#12'), { kind: 'repo', repo: 'cjjutba/client-a' })).toBe('https://github.com/cjjutba/client-a/issues/12')
    expect(githubIssueUrl(issue('#12'), { kind: 'folder', repo: 'cjjutba/client-a' })).toBe('https://github.com/cjjutba/client-a/issues/12')
  })
  it('has nothing to open without a repo, for a scratch room, or for a key that is not a number', () => {
    expect(githubIssueUrl(issue('#12'), { kind: 'folder' })).toBeUndefined()
    expect(githubIssueUrl(issue('#12'), { kind: 'scratch', repo: 'kernel/starter' })).toBeUndefined()
    expect(githubIssueUrl(issue('#12'))).toBeUndefined()
    expect(githubIssueUrl(issue('#abc'), { kind: 'repo', repo: 'a/b' })).toBeUndefined()
  })
})
