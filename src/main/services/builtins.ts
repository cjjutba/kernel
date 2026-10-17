import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentDef } from '@shared/types'
import { KERNEL_LEAD, KERNEL_NAME, KERNEL_REVIEWER } from '@shared/team'
import { agentFromFile } from './agents'

/**
 * Kernel's own Lead (KERNEL-397), the only Lead since KERNEL-692. It comes from the starter file the app ships, runs under a
 * reserved id, is always named Kernel, and is never written to the repo. It has no model of its own, so Settings, Models
 * decides it, unless a repo file customizes it (`resolveTeam`).
 *
 * The Lead is Kernel's only built-in agent (KERNEL-553). Theo is a starter, and a project with no reviewer gets Kernel's code review
 * (KERNEL-549). `theo` is Kernel's Theo as it reviewed until then. It never joins a team. A review workspace made while it
 * reviewed still runs it and shows its name.
 */
export interface Builtins { lead?: AgentDef; theo?: AgentDef }

/** The starter files read once per folder: they ship with the app and don't change while it runs. */
const read = new Map<string, Promise<Record<string, string | undefined>>>()

function starterFiles(starterDir: string) {
  let files = read.get(starterDir)
  if (!files) {
    files = Promise.all(([['kernel', 'kernel.md'], ['theo', 'legacy/theo.md']] as const).map(async ([id, file]) => [id, await readFile(join(starterDir, file), 'utf8').catch(() => undefined)] as const)).then(Object.fromEntries)
    read.set(starterDir, files)
  }
  return files
}

/** A starter file as Kernel runs it: no file in the repo, and no model or effort, so Settings, Models decides them. */
function builtin(src: string): AgentDef {
  const { model: _model, effort: _effort, ...def } = agentFromFile('', src)
  return { ...def, file: '' }
}

/** Kernel, the Lead, and Kernel's Theo from before KERNEL-553. Nothing without a starter folder. */
export async function loadBuiltins(starterDir: string | undefined): Promise<Builtins> {
  if (!starterDir) return {}
  const files = await starterFiles(starterDir)
  const out: Builtins = {}
  if (files.kernel) out.lead = { ...builtin(files.kernel), id: KERNEL_LEAD, name: KERNEL_NAME, role: 'Lead', lead: true, builtIn: 'lead' }
  if (files.theo) out.theo = { ...builtin(files.theo), id: KERNEL_REVIEWER, name: 'Theo', role: 'Reviewer', lead: false, builtIn: 'reviewer' }
  return out
}

/** The bundled file Kernel runs from, for Customize. */
export const builtinFile = (starterDir: string) => join(starterDir, 'kernel.md')
