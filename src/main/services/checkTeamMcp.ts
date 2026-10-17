import { tool } from '@anthropic-ai/claude-agent-sdk'

/** What check_team answers when nothing waits. */
export const NOTHING_NEW = 'No team updates are waiting.'

/**
 * check_team, for a Lead in a terminal (KERNEL-1000). Kernel never types into a terminal, so a teammate's news waits for the
 * Lead's next prompt. The tool hands it over at once and clears it, so it is never read twice.
 */
export function checkTeamTools(d: { take: () => string | undefined }) {
  return [
    tool('check_team', 'Read what your teammates did since you last heard: finished turns, failed checks, reviews, questions for you and PRs ready to merge. Kernel also adds these to your next message from the user, so call this when you wait on a teammate and the user has not written. Each update is returned once.', {}, async () => ({ content: [{ type: 'text' as const, text: d.take() ?? NOTHING_NEW }] }))
  ]
}
