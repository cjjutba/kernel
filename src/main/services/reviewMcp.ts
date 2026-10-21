import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { BLOCKER_RULE } from './handoff'

/** What a reviewer sends with submit_review. */
export interface ReviewInput {
  verdict: 'approved' | 'blockers'
  summary: string
  blockers?: { text: string; file?: string; line?: number }[]
  criteria?: { index: number; met: boolean; note?: string }[]
}

export interface ReviewToolDeps {
  /** Saves the verdict on the reviewed workspace and tells the Lead. Returns what the reviewer is told back. */
  submit: (review: ReviewInput) => Promise<string>
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/** The one tool a review workspace gets, apart from the server so tests can call it (KERNEL-130). */
export function reviewTools(d: ReviewToolDeps) {
  return [
    tool('submit_review', `Report your review to the Lead: "approved" when nothing blocks, or "blockers" with each blocker. Call it once per review. ${BLOCKER_RULE}`, {
      verdict: z.enum(['approved', 'blockers']),
      summary: z.string().min(1).describe('A few sentences on what you checked, and at most three short notes on minor findings'),
      blockers: z.array(z.object({ text: z.string().min(1), file: z.string().optional(), line: z.number().int().positive().optional() })).optional()
        .describe('Required with "blockers": each in one or two sentences, what breaks, with file and line and no code'),
      criteria: z.array(z.object({ number: z.number().int().min(1), met: z.boolean(), note: z.string().optional() })).optional()
        .describe('Only when the brief lists acceptance criteria: each one\'s number in that list (from 1) and your judgment. Judge only what you checked')
    }, async (review) => {
      if (review.verdict === 'blockers' && !review.blockers?.length) return { ...text('Not saved: list each blocker in blockers, with its file and line when you know them.'), isError: true }
      try { return text(await d.submit({ ...review, criteria: review.criteria?.map(({ number, ...rest }) => ({ index: number - 1, ...rest })) })) } catch (e) { return { ...text(`Not saved: ${e instanceof Error ? e.message : String(e)}`), isError: true } }
    })
  ]
}
