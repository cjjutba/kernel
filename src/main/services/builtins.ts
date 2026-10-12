import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDef } from '@shared/types'
import { KERNEL_LEAD, KERNEL_REVIEWER } from '@shared/team'
import { agentFromFile } from './agents'

/**
 * Kernel's own Lead (KERNEL-397). Rowan comes from the starter file the app ships, runs under a reserved id, and is never
 * written to the repo. Rowan has no model of its own, so Settings, Models decides it. A room whose files already have a
 * Rowan sees Kernel's as Lead (or Kernel Lead when that is taken too), so the Lead never hands work to a second Rowan.
 *
 * Rowan is Kernel's only built-in agent (KERNEL-553). Theo is a starter, and a room with no reviewer gets Kernel's code review
 * (KERNEL-549). `theo` is Kernel's Theo as it reviewed until then. It never joins a team. A review workspace made while it
 * reviewed still runs it and shows its name.
 */
export interface Builtins { lead?: AgentDef; theo?: AgentDef }

/** The starter files read once per folder: they ship with the app and don't change while it runs. */
const read = new Map<string, Promise<Record<string, string | undefined>>>()

function starterFiles(starterDir: string) {
  let files = read.get(starterDir)
  if (!files) {
    files = Promise.all(['rowan', 'theo'].map(async (id) => [id, await readFile(join(starterDir, `${id}.md`), 'utf8').catch(() => undefined)] as const)).then(Object.fromEntries)
    read.set(starterDir, files)
  }
  return files
}

/** A starter file as Kernel runs it: no file in the repo, and no model or effort, so Settings, Models decides them. */
function builtin(src: string): AgentDef {
  const { model: _model, effort: _effort, ...def } = agentFromFile('', src)
  return { ...def, file: '' }
}

/** Kernel's Lead, named so it shares no name or id with `team`, and Kernel's Theo from before KERNEL-553. Nothing without a starter folder. */
export async function loadBuiltins(starterDir: string | undefined, team: AgentDef[]): Promise<Builtins> {
  if (!starterDir) return {}
  const files = await starterFiles(starterDir)
  const out: Builtins = {}
  if (files.rowan) {
    const taken = new Set(team.flatMap((a) => [a.id.toLowerCase(), a.name.toLowerCase()]))
    const def = builtin(files.rowan)
    const name = !taken.has('rowan') ? 'Rowan' : !taken.has('lead') ? 'Lead' : 'Kernel Lead'
    // "You are Rowan, the lead of..." reads "You are the Lead of..." when the room has its own Rowan.
    const prompt = name === 'Rowan' ? def.prompt : def.prompt.replace(/^You are Rowan, the Lead\b/i, 'You are the Lead')
    out.lead = { ...def, id: KERNEL_LEAD, name, role: 'Lead', prompt, lead: true, builtIn: 'lead' }
  }
  if (files.theo) out.theo = { ...builtin(files.theo), id: KERNEL_REVIEWER, name: 'Theo', role: 'Reviewer', lead: false, builtIn: 'reviewer' }
  return out
}

/** The bundled file Kernel's Rowan runs from, for Customize. */
export const builtinFile = (starterDir: string) => join(starterDir, 'rowan.md')
