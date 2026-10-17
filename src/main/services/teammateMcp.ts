import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentDef, Workspace } from '@shared/types'
import { takesTasks } from '@shared/team'
import { pickAgent } from './kernelMcp'
import { isMerged, resolveTarget, waitRefusal } from './waits'
import { isPushed, stripRemote } from './worktrees'

export interface TeammateToolDeps {
  /** The calling teammate's workspace, as it is now. */
  workspace: () => Workspace
  /** The project's workspaces, archived ones included. */
  workspaces: () => Workspace[]
  isLead: (w: Workspace) => boolean
  /** The agent's name for a workspace: "Noor". */
  nameOf: (w: Workspace) => string
  /** Kernel's setWait on the caller's workspace, as a wait the teammate set itself, which the Lead hasn't heard about. */
  setWait: (on: string[], why?: string) => Promise<Workspace>
  /** The project's remote, stripped from the bases a wait compares (KERNEL-693). */
  remote?: () => Promise<string>
  /** The project's team, as list_agents reads it, for propose_handoff (KERNEL-747). */
  team: () => AgentDef[]
  /** Records ask_lead's question for the Lead chat that handed the workspace off (`LeadUpdates.asked`). */
  ask: (question: string, options?: string[]) => void
  /** Records propose_handoff's proposal for that Lead chat (`LeadUpdates.proposed`). Kernel never creates the workspace. */
  propose: (p: { agentId: string; agent: string; task: string; why: string }) => void
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/**
 * Why propose_handoff refuses `asked`, or the agent it names (KERNEL-747). The same checks as create_workspace's: an agent the
 * team has, not the Lead, one that takes tasks, and not the teammate proposing it.
 */
export function proposalRefusal(team: AgentDef[], asked: string, self: string): AgentDef | { refusal: string } {
  const pick = pickAgent(team, asked)
  if ('refusal' in pick) return { refusal: pick.refusal.replace(/^Not created: /, '') }
  if (pick.id === self) return { refusal: 'that is you. Carry on with it yourself, or ask the Lead with ask_lead if it is outside your task.' }
  if (pick.lead) return { refusal: `${pick.name} is the Lead, who hands work out and builds none. Propose a teammate from list_agents.` }
  if (!takesTasks(pick)) return { refusal: `${pick.name} is a helper in this project and doesn't take tasks.` }
  return pick
}

/**
 * The tools a teammate that isn't reviewing gets, apart from the server so tests can call them (KERNEL-262). wait_for_merge
 * records the wait with the same rules as the Lead's (`services/waits.ts`), and Kernel's release on merge does the rest.
 * ask_lead and propose_handoff reach the Lead as Team update events (KERNEL-747).
 */
export function teammateTools(d: TeammateToolDeps) {
  return [
    tool('wait_for_merge', "Tell Kernel you can't go on until another teammate's pull request merges. Kernel messages you when it merges, so end your turn right after.", {
      on: z.string().min(1).describe('What you wait for: a PR number like "#164", an issue key like "PROJ-197", or a workspace id'),
      why: z.string().optional().describe('What you need from it, in a sentence. The Lead reads it')
    }, async ({ on, why }) => {
      const refuse = (m: string) => ({ ...text(`Not set: ${m}`), isError: true })
      try {
        const ws = d.workspace()
        const all = d.workspaces()
        const refusal = waitRefusal({ workspaces: all, refs: [on], waiter: ws, isLead: d.isLead, teammate: true, remote: await d.remote?.() })
        if (refusal) return refuse(refusal)
        const target = resolveTarget(all, on)!
        const what = target.prNumber ? `PR #${target.prNumber}` : `${d.nameOf(target)}'s work`
        if (isMerged(target)) {
          // A branch the remote has takes the base by a merge: a rebase would need a force push, which the team doesn't make (KERNEL-886).
          const remote = await d.remote?.() ?? 'origin'
          const take = await isPushed(ws.path, ws.branch, remote) ? `Merge ${remote}/${stripRemote(ws.baseRef, remote)} into your branch` : 'Rebase onto it'
          return text(`${what} already merged, so there is nothing to wait for. ${take} and carry on.`)
        }
        // Added to what the workspace already waits for: the teammate can't see a wait the Lead set.
        await d.setWait([...(ws.waitsFor?.on ?? []), target.id], why?.trim() || undefined)
        return text(`Kernel will message you when ${what} merges. End your turn now.`)
      } catch (e) { return refuse(e instanceof Error ? e.message : String(e)) }
    }),
    tool('ask_lead', "Ask the Lead a question you can't answer from your brief, such as a choice between two designs or what is in scope. Kernel passes it on and the Lead's answer arrives as a message, so end your turn right after.", {
      question: z.string().min(1).describe('The question, in one or two sentences the Lead can answer without opening your workspace'),
      options: z.array(z.string().min(1)).optional().describe('The answers you see, if there are a few, for example ["Keep drafts per tab", "One draft per chat"]')
    }, async ({ question, options }) => {
      if (!question.trim()) return { ...text('Not sent: the question is empty.'), isError: true }
      d.ask(question, options)
      return text('Kernel passed your question to the Lead. End your turn now. The answer arrives as a message.')
    }),
    tool('propose_handoff', 'Propose that another teammate takes part of your work, when it belongs to their role rather than your task. The Lead asks the user, and a workspace starts only if the user agrees. Carry on with your own work.', {
      agent: z.string().min(1).describe('The id or name of the teammate who should take it, from the team in your brief'),
      task: z.string().min(1).describe('The task in one line, as a title the Lead can hand off'),
      why: z.string().min(1).describe("Why it belongs to them rather than you, in a sentence")
    }, async ({ agent, task, why }) => {
      const refuse = (m: string) => ({ ...text(`Not proposed: ${m}`), isError: true })
      try {
        const pick = proposalRefusal(d.team(), agent, d.workspace().agentId)
        if ('refusal' in pick) return refuse(pick.refusal)
        d.propose({ agentId: pick.id, agent: pick.name, task, why })
        return text(`Kernel passed your proposal for ${pick.name} to the Lead, who asks the user. Carry on with your own work, and leave that task out of it.`)
      } catch (e) { return refuse(e instanceof Error ? e.message : String(e)) }
    })
  ]
}
