import { describe, expect, it } from 'vitest'
import { githubIssueUrl, issueFromPart, issueOpen, issueTracker } from '../src/renderer/src/screens/workspace/issueKey'

const issue = (id: string, url?: string) => ({ kind: 'issue' as const, id, title: 'Invoice table', url })

describe('githubIssueUrl', () => {
  it('keeps the url the source carries', () => {
    expect(githubIssueUrl(issue('#12', 'https://github.com/a/b/issues/12'), { kind: 'repo', repo: 'x/y' })).toBe('https://github.com/a/b/issues/12')
  })
  it('builds it from the project repo when the source has none', () => {
    expect(githubIssueUrl(issue('#12'), { kind: 'repo', repo: 'cjjutba/client-a' })).toBe('https://github.com/cjjutba/client-a/issues/12')
    expect(githubIssueUrl(issue('#12'), { kind: 'folder', repo: 'cjjutba/client-a' })).toBe('https://github.com/cjjutba/client-a/issues/12')
  })
  it('has nothing to open without a repo, for a scratch project, or for a key that is not a number', () => {
    expect(githubIssueUrl(issue('#12'), { kind: 'folder' })).toBeUndefined()
    expect(githubIssueUrl(issue('#12'), { kind: 'scratch', repo: 'kernel/starter' })).toBeUndefined()
    expect(githubIssueUrl(issue('#12'))).toBeUndefined()
    expect(githubIssueUrl(issue('#abc'), { kind: 'repo', repo: 'a/b' })).toBeUndefined()
  })
})

describe('issueTracker', () => {
  it('takes the tracker the source carries', () => {
    expect(issueTracker({ ...issue('#12'), tracker: 'linear' })).toBe('linear')
    expect(issueTracker({ ...issue('#12'), tracker: 'github' })).toBe('github')
  })
  it('reads a source saved before the tag from its key: # is GitHub, anything else Linear', () => {
    expect(issueTracker(issue('#12'))).toBe('github')
    expect(issueTracker(issue('KERNEL-12'))).toBe('linear')
  })
})

describe('issueOpen', () => {
  const linear = { kind: 'linear' as const }
  const github = { kind: 'github' as const, where: 'cjjutba/client-a' }
  const repo = { id: 'p1', kind: 'repo' as const, repo: 'cjjutba/client-a' }
  const tagged = (id: string, tracker: 'linear' | 'github', url?: string) => ({ ...issue(id, url), tracker })

  it('opens a Linear issue in Issues when the project uses Linear', () => {
    expect(issueOpen(tagged('KERNEL-1', 'linear', 'https://linear.app/x/issue/KERNEL-1'), repo, linear)).toEqual({ kind: 'issues', projectId: 'p1' })
  })
  it('opens a Linear issue in the browser in a GitHub project, and nowhere without a url', () => {
    expect(issueOpen(tagged('KERNEL-1', 'linear', 'https://linear.app/x/issue/KERNEL-1'), repo, github)).toEqual({ kind: 'url', url: 'https://linear.app/x/issue/KERNEL-1' })
    expect(issueOpen(tagged('KERNEL-1', 'linear'), repo, github)).toEqual({ kind: 'none' })
  })
  it('opens a GitHub issue in Issues from the project repo, in the browser from another repo', () => {
    expect(issueOpen(tagged('#12', 'github', 'https://github.com/CJJutba/client-a/issues/12'), repo, github)).toEqual({ kind: 'issues', projectId: 'p1' })
    expect(issueOpen(tagged('#12', 'github'), repo, github)).toEqual({ kind: 'issues', projectId: 'p1' })
    expect(issueOpen(tagged('#12', 'github', 'https://github.com/other/thing/issues/12'), repo, github)).toEqual({ kind: 'url', url: 'https://github.com/other/thing/issues/12' })
  })
  it('builds a GitHub url from the repo when the project does not use GitHub', () => {
    expect(issueOpen(tagged('#12', 'github'), repo, linear)).toEqual({ kind: 'url', url: 'https://github.com/cjjutba/client-a/issues/12' })
    expect(issueOpen(tagged('#12', 'github'), repo, { kind: 'none' })).toEqual({ kind: 'url', url: 'https://github.com/cjjutba/client-a/issues/12' })
  })
  it('has nowhere to go for a scratch project with no url', () => {
    expect(issueOpen(tagged('#12', 'github'), { id: 'p2', kind: 'scratch', repo: 'kernel/starter' }, { kind: 'none' })).toEqual({ kind: 'none' })
    expect(issueOpen(tagged('KERNEL-1', 'linear'), { id: 'p2', kind: 'scratch' }, { kind: 'none' })).toEqual({ kind: 'none' })
  })
  it('falls to the url while the tracker is loading, and without a project', () => {
    expect(issueOpen(tagged('KERNEL-1', 'linear', 'https://linear.app/x/issue/KERNEL-1'), repo, undefined)).toEqual({ kind: 'url', url: 'https://linear.app/x/issue/KERNEL-1' })
    expect(issueOpen(tagged('KERNEL-1', 'linear', 'https://linear.app/x/issue/KERNEL-1'), undefined, linear)).toEqual({ kind: 'url', url: 'https://linear.app/x/issue/KERNEL-1' })
  })
  it('lets the key decide for a chip with no tracker tag', () => {
    expect(issueOpen(issue('KERNEL-1'), repo, linear)).toEqual({ kind: 'issues', projectId: 'p1' })
    expect(issueOpen(issue('#12'), repo, github)).toEqual({ kind: 'issues', projectId: 'p1' })
    expect(issueOpen(issue('#12'), repo, linear)).toEqual({ kind: 'url', url: 'https://github.com/cjjutba/client-a/issues/12' })
  })
})

describe('issueFromPart', () => {
  it('reads the name as the key and the source as the tracker', () => {
    expect(issueFromPart({ type: 'issue', name: 'KERNEL-1', title: 'T', url: 'https://x.test', source: 'linear' })).toEqual({ id: 'KERNEL-1', url: 'https://x.test', tracker: 'linear' })
  })
})
