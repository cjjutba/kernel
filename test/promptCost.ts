import { z } from 'zod'
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { LEAD_RULE, LEAD_SHARING_RULE, reviewRule, SHARE_RULE, TEAMMATE_RULE } from '../src/main/services/handoff'
import { kernelTools, LEAD_INSTRUCTIONS } from '../src/main/services/kernelMcp'
import { teammateTools } from '../src/main/services/teammateMcp'
import { reviewTools } from '../src/main/services/reviewMcp'
import { issueTools } from '../src/main/services/issueMcp'
import { sharedTools } from '../src/main/services/sharedMcp'
import { LEAD_ALWAYS_LOADED } from '../src/main/services/kernelServer'

// What every session of each role pays before the user says anything (lean-lead-prompt): the rule text, and the JSON of the
// tool schemas and descriptions. Tokens are characters / 4, a rough figure that is the same before and after a change.
// Print the table with `KERNEL_PROMPT_COST=1 pnpm exec vitest run test/promptCost.test.ts`.

export interface Cost { words: number; chars: number; tokens: number }
const cost = (text: string): Cost => ({ words: text.split(/\s+/).filter(Boolean).length, chars: text.length, tokens: Math.ceil(text.length / 4) })

/** The JSON a tool costs: its name, description and input schema, as the model reads them. */
export const toolJson = (t: SdkMcpToolDefinition<any>) => JSON.stringify({ name: t.name, description: t.description, input_schema: z.toJSONSchema(z.object(t.inputSchema)) })

export interface RoleCost { rule: Cost; tools: Cost; loaded: Cost; toolCount: number; loadedCount: number }

const stub = {} as never
const extra = () => [...issueTools(stub), ...sharedTools(stub)]

/** `loaded` is the tools in the first prompt. A deferred tool costs nothing until the model searches for it. With no list, all are loaded. */
function role(rule: string, tools: SdkMcpToolDefinition<any>[], loaded?: readonly string[]): RoleCost {
  const on = loaded ? tools.filter((t) => loaded.includes(t.name)) : tools
  return { rule: cost(rule), tools: cost(tools.map(toolJson).join('\n')), loaded: cost(on.map(toolJson).join('\n')), toolCount: tools.length, loadedCount: on.length }
}

/** Lead, teammate and reviewer. */
export function promptCosts(): Record<'lead' | 'teammate' | 'reviewer', RoleCost> {
  const review = { author: 'Sean', task: 'Add export', workspaceId: 'ws1', branch: 'feat/export', head: 'abc1234', base: 'origin/main', pr: { number: 12, url: 'https://github.com/o/r/pull/12' } }
  return {
    lead: role([LEAD_RULE, LEAD_SHARING_RULE, LEAD_INSTRUCTIONS].join('\n'), [...kernelTools(stub), ...extra()], LEAD_ALWAYS_LOADED),
    teammate: role([TEAMMATE_RULE, SHARE_RULE].join('\n'), [...teammateTools(stub), ...extra()]),
    reviewer: role([reviewRule(review), SHARE_RULE].join('\n'), [...reviewTools(stub), ...extra()])
  }
}

export function costTable(): string {
  return Object.entries(promptCosts()).map(([name, c]) => `${name.padEnd(9)} rule ${String(c.rule.words).padStart(4)} words ${String(c.rule.tokens).padStart(5)} tok | tools ${String(c.toolCount).padStart(2)} ${String(c.tools.tokens).padStart(6)} tok | loaded up front ${String(c.loadedCount).padStart(2)} ${String(c.loaded.tokens).padStart(6)} tok`).join('\n')
}
