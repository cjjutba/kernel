import { describe, expect, it } from 'vitest'
import { githubPause } from '../src/renderer/src/components/footer/model'

// KERNEL-401: the footer's word while a GitHub rate limit holds Kernel's PR reads off.

describe('the GitHub pause in the footer', () => {
  const now = new Date(2026, 9, 11, 15, 0).getTime()
  const until = new Date(2026, 9, 11, 15, 41).getTime()

  it('says when PRs update again, and why in its tooltip', () => {
    expect(githubPause({ pausedUntil: until }, now)).toEqual({
      label: 'GitHub paused',
      sub: 'PRs update at 3:41 PM',
      why: "GitHub's rate limit is almost used up, so Kernel stopped reading pull requests until 3:41 PM. Agents keep working, and opening a workspace still reads its PR."
    })
    expect(githubPause({ pausedUntil: until, slowDown: true }, now)?.why).toBe('GitHub asked Kernel to slow down, so it reads pull requests again at 3:41 PM. Agents keep working.')
  })

  it('shows nothing while Kernel reads, or once the pause has passed', () => {
    expect(githubPause({}, now)).toBeNull()
    expect(githubPause({ pausedUntil: until }, until)).toBeNull()
  })
})
