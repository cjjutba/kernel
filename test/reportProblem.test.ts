import { describe, expect, it } from 'vitest'
import { reportProblemUrl } from '../src/renderer/src/components/footer/reportProblem'

describe('Report a problem (KERNEL-674)', () => {
  const url = new URL(reportProblemUrl({ version: '0.4.2', os: 'macOS 14.5.0', arch: 'arm64' }))
  const body = url.searchParams.get('body') ?? ''

  it('opens a new bug issue on the repo, with the body URL-encoded', () => {
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/cjjutba/kernel/issues/new')
    expect(url.searchParams.get('labels')).toBe('bug')
    expect(reportProblemUrl({ version: '1', os: 'macOS' })).not.toMatch(/[ \n#]/)
  })

  it('has headings to fill in and an Environment block with the version, the OS and the logs folder', () => {
    for (const h of ['## What happened', '## What you expected', '## Steps to reproduce', '## Environment']) expect(body).toContain(h)
    expect(body).toContain('Kernel 0.4.2')
    expect(body).toContain('macOS 14.5.0, arm64')
    expect(body).toContain('~/Library/Logs/Kernel')
  })

  it('names no account, email, path or repo', () => {
    expect(body).not.toMatch(/@/)
    expect(body).not.toMatch(/\/Users\//)
  })
})
