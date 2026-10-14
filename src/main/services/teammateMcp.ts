import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Workspace } from '@shared/types'
import { isMerged, resolveTarget, waitRefusal } from './waits'

export interface TeammateToolDeps {
  /** The calling teammate's workspace, as it is now. */
  workspace: () => Workspace
  /** The room's workspaces, archived ones included. */
  workspaces: () => Workspace[]
  isLead: (w: Workspace) => boolean
  /** The agent's name for a workspace: "Noor". */
  nameOf: (w: Workspace) => string
  /** Kernel's setWait on the caller's workspace, as a wait the teammate set itself, which the Lead hasn't heard about. */
  setWait: (on: string[], why?: string) => Promise<Workspace>
  /** The room's remote, stripped from the bases a wait compares (KERNEL-693). */
  remote?: () => Promise<string>
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

/**
 * The tool a teammate that isn't reviewing gets, apart from the server so tests can call it (KERNEL-262). It records the
 * wait with the same rules as the Lead's wait_for_merge (`services/waits.ts`), and Kernel's release on merge does the rest.
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
        if (isMerged(target)) return text(`${what} already merged, so there is nothing to wait for. Rebase onto it and carry on.`)
        // Added to what the workspace already waits for: the teammate can't see a wait the Lead set.
        await d.setWait([...(ws.waitsFor?.on ?? []), target.id], why?.trim() || undefined)
        return text(`Kernel will message you when ${what} merges. End your turn now.`)
      } catch (e) { return refuse(e instanceof Error ? e.message : String(e)) }
    })
  ]
}
