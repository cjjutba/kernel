import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDef } from '@shared/types'
import { KERNEL_LEAD, KERNEL_REVIEWER } from '@shared/team'
import { agentFromFile } from './agents'

/**
 * Kernel's own Lead and reviewer (KERNEL-397). They come from the starter files the app ships, run under reserved ids, and
 * are never written to the repo. They have no model of their own, so Settings, Models decides theirs. A room whose files
 * already have a Rowan or a Theo sees them as Lead and Reviewer (or Kernel Lead and Kernel Reviewer when those are taken too),
 * so the Lead never hands work to a second Rowan.
 */
export interface Builtins { lead?: AgentDef; reviewer?: AgentDef }

const BUILTINS = [
  { id: KERNEL_LEAD, from: 'rowan', name: 'Rowan', role: 'Lead', builtIn: 'lead' as const },
  { id: KERNEL_REVIEWER, from: 'theo', name: 'Theo', role: 'Reviewer', builtIn: 'reviewer' as const }
]

/** The starter files read once per folder: they ship with the app and don't change while it runs. */
const read = new Map<string, Promise<Record<string, string | undefined>>>()

function starterFiles(starterDir: string) {
  let files = read.get(starterDir)
  if (!files) {
    files = Promise.all(BUILTINS.map(async (b) => [b.from, await readFile(join(starterDir, `${b.from}.md`), 'utf8').catch(() => undefined)] as const)).then(Object.fromEntries)
    read.set(starterDir, files)
  }
  return files
}

/** Kernel's Lead and reviewer, named so neither shares a name or id with `team`. Nothing without a starter folder. */
export async function loadBuiltins(starterDir: string | undefined, team: AgentDef[]): Promise<Builtins> {
  if (!starterDir) return {}
  const files = await starterFiles(starterDir)
  const taken = new Set(team.flatMap((a) => [a.id.toLowerCase(), a.name.toLowerCase()]))
  const out: Builtins = {}
  for (const b of BUILTINS) {
    const src = files[b.from]
    if (!src) continue
    const def = agentFromFile('', src)
    const name = !taken.has(b.from) ? b.name : !taken.has(b.role.toLowerCase()) ? b.role : `Kernel ${b.role}`
    // "You are Rowan, the lead of..." reads "You are the Lead of..." when the room has its own Rowan.
    const prompt = name === b.name ? def.prompt : def.prompt.replace(new RegExp(`^You are ${b.name}, the ${b.role}\\b`, 'i'), `You are the ${b.builtIn === 'lead' ? 'Lead' : 'reviewer'}`)
    const { model: _model, effort: _effort, ...rest } = def
    out[b.builtIn] = { ...rest, id: b.id, name, role: b.role, prompt, file: '', lead: b.builtIn === 'lead', builtIn: b.builtIn }
  }
  return out
}

/** The bundled file a built-in agent runs from, for Customize. */
export const builtinFile = (starterDir: string, which: 'lead' | 'reviewer') => join(starterDir, `${BUILTINS.find((b) => b.builtIn === which)!.from}.md`)
