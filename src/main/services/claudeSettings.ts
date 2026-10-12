import { filterEscalatingDefaultMode, resolveSettings, type ModelInfo, type ResolvedSettings, type Settings } from '@anthropic-ai/claude-agent-sdk'

// Claude Code's own settings as Kernel reads them (KERNEL-447). `resolveSettings` and `filterEscalatingDefaultMode` are @alpha
// in the pinned SDK, so they are called here and nowhere else, and the live test covers them: an SDK bump that changes them
// fails there first.

/** A mode Claude Code's settings turn off. `admin` is true when managed policy does, and not only the user's own settings. */
export interface PolicyBlock { admin: boolean }

/** What Claude Code's settings turn off for the sessions Kernel starts. Kernel never runs a mode they turn off, on Claude or on Codex. */
export interface ClaudePolicy { auto?: PolicyBlock; bypass?: PolicyBlock }

/**
 * The settings a session in `cwd` loads, read the way the CLI merges them: managed policy from every source (MDM, remote and
 * file), then the user's, the project's and the local file. Without `cwd`, only managed policy and the user's. Kernel acts on
 * them only after `filterEscalatingDefaultMode`, the trust filter the CLI applies, so a repo's committed files can't widen
 * a mode. Turning a mode off is a restriction, so it counts from every source.
 */
export async function claudePolicy(cwd?: string): Promise<ClaudePolicy> {
  const resolved = await resolveSettings(cwd ? { cwd, settingSources: ['user', 'project', 'local'] } : { settingSources: ['user'] })
  return policyOf(resolved, filterEscalatingDefaultMode(resolved))
}

/** What `effective` turns off, and whether managed policy is among the sources that do. */
export function policyOf(resolved: Pick<ResolvedSettings, 'sources'>, effective: Settings): ClaudePolicy {
  const off = (set: (s: Settings) => boolean): PolicyBlock | undefined =>
    set(effective) ? { admin: resolved.sources.some((s) => s.source === 'managed' && set(s.settings)) } : undefined
  const auto = off((s) => s.disableAutoMode === 'disable')
  const bypass = off((s) => s.permissions?.disableBypassPermissionsMode === 'disable')
  return { ...(auto ? { auto } : {}), ...(bypass ? { bypass } : {}) }
}

/** Where a setting comes from: the file that sets it, when one does. MDM and remote policy have no file. */
export interface SetBy { path?: string }

/** What Claude Code's settings do to hooks, Kernel's included (KERNEL-461). Kernel reads managed settings and never writes them. */
export interface HooksPolicy {
  /** Managed settings set disableAllHooks, so no hook runs, managed ones included. */
  managedOff?: SetBy
  /** Managed settings set allowManagedHooksOnly, so only their own hooks run. */
  managedOnly?: SetBy
  /** The user's own settings set disableAllHooks and nothing above them turns it back. Managed hooks still run. */
  userOff?: SetBy
  /** The hooks managed settings carry, by event, so Kernel's own entries an admin put there count as installed. */
  managedHooks: Record<string, unknown[]>
}

/** Managed policy from every source and the user's own settings, merged the way the CLI merges them. */
export async function hooksPolicy(): Promise<HooksPolicy> {
  return hooksPolicyOf(await resolveSettings({ settingSources: ['user'] }))
}

export function hooksPolicyOf(resolved: Pick<ResolvedSettings, 'effective' | 'sources'>): HooksPolicy {
  const managed = resolved.sources.filter((s) => s.source === 'managed')
  const setBy = (s?: { path?: string }): SetBy | undefined => s && (s.path ? { path: s.path } : {})
  const managedOff = setBy(managed.find((s) => s.settings.disableAllHooks === true))
  const managedOnly = setBy(managed.find((s) => s.settings.allowManagedHooksOnly === true))
  const user = resolved.sources.find((s) => s.source === 'user')
  const userOff = !managedOff && resolved.effective.disableAllHooks === true && user?.settings.disableAllHooks === true ? setBy(user) : undefined
  const managedHooks: Record<string, unknown[]> = {}
  for (const s of managed) for (const [event, list] of Object.entries(s.settings.hooks ?? {})) managedHooks[event] = [...(managedHooks[event] ?? []), ...(list ?? [])]
  return { ...(managedOff ? { managedOff } : {}), ...(managedOnly ? { managedOnly } : {}), ...(userOff ? { userOff } : {}), managedHooks }
}

/**
 * Whether Claude Code runs `model` in Auto, from the models its initialize answer lists. A row matches by its id or the model
 * id it resolves to (`sonnet` to `claude-sonnet-5-5`). Undefined when no row is the model, which Kernel reads as no.
 */
export function supportsAuto(models: ModelInfo[], model: string): boolean | undefined {
  const id = bare(model)
  const row = models.find((m) => bare(m.value) === id || (m.resolvedModel !== undefined && bare(m.resolvedModel) === id))
  return row ? row.supportsAutoMode === true : undefined
}

/** A model id without its case and its context-window tag (`[1m]`). */
const bare = (id: string) => id.toLowerCase().replace(/\[[^\]]*\]$/, '')
