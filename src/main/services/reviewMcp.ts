import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/** What a reviewer sends with submit_review. */
export interface ReviewInput {
  verdict: 'approved' | 'blockers'
  summary: string
  blockers?: { text: string; file?: string; line?: number }[]
}

export interface ReviewToolDeps {
  /** Saves the verdict on the reviewed workspace and tells the Lead. Returns what the reviewer is told back. */
  submit: (review: ReviewInput) => Promise<string>
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** The one tool a review workspace gets, apart from the server so tests can call it (KERNEL-130). */
export function reviewTools(d: ReviewToolDeps) {
  return [
    tool('submit_review', 'Report your review to the Lead: "approved" when the work meets its acceptance criteria and nothing blocks a merge, or "blockers" with each blocker. Call it once per review.', {
      verdict: z.enum(['approved', 'blockers']),
      summary: z.string().min(1).describe('A few sentences on what you checked and what you found'),
      blockers: z.array(z.object({ text: z.string().min(1), file: z.string().optional(), line: z.number().int().positive().optional() })).optional()
        .describe('Required with "blockers": each one with its file and line when you know them')
    }, async (review) => {
      if (review.verdict === 'blockers' && !review.blockers?.length) return { ...text('Not saved: list each blocker in blockers, with its file and line when you know them.'), isError: true }
      try { return text(await d.submit(review)) } catch (e) { return { ...text(`Not saved: ${e instanceof Error ? e.message : String(e)}`), isError: true } }
    })
  ]
}

/**
 * The review workspace's own MCP server. It is named `kernel` like the Lead's, so Kernel's auto-allow for
 * `mcp__kernel__` tools covers it (sessions.ts canUseTool).
 */
export function reviewMcpServer(d: ReviewToolDeps) {
  return createSdkMcpServer({ name: 'kernel', version: '0.1.0', alwaysLoad: true, tools: reviewTools(d) })
}
