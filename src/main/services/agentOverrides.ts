import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentDef, AgentEdit } from '@shared/types'

/** The fields an edit for me can set over an agent's file. `model: ''` unpins a model the file pins (KERNEL-406). */
export type OwnEdit = Omit<AgentEdit, 'name'>

/**
 * What the user changed about one of a room's agents on this Mac only (KERNEL-466). Kernel keeps it in its data folder, never
 * in the repo, and lays it over the file each time it reads the team.
 */
export interface AgentOverride {
  edit?: OwnEdit
  /** Retired on this Mac. The file stays where it is. */
  retired?: boolean
  /**
   * Hired or brought back for the user in this room, so it is on their team here even when `[team] roster` leaves it out
   * (KERNEL-465), without writing the shared roster for an agent only they have.
   */
  joined?: boolean
}

/** A field as an agent file holds it: no tools line, no skills line and no model pin all read as nothing, and text is trimmed. */
function norm(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim() : v
  return t === undefined || t === null || t === '' || (Array.isArray(t) && !t.length) ? null : JSON.stringify(t)
}

/**
 * The agent with the user's own edit over its file. An empty tools or skills list leaves the line out, as saving the file
 * would, so the agent gets every tool. A file Kernel couldn't read stays as it is.
 */
export function withOwnEdit(a: AgentDef, edit: OwnEdit | undefined): AgentDef {
  if (!edit || a.warnings?.some((w) => w.kind === 'unreadable-file')) return a
  const out: AgentDef = { ...a }
  if (edit.description !== undefined) out.description = edit.description
  if (edit.role?.trim()) out.role = edit.role
  if (edit.model !== undefined) {
    out.model = edit.model || undefined
    out.provider = edit.model ? edit.provider : undefined
  }
  if (edit.effort !== undefined) out.effort = edit.effort
  if (edit.tools !== undefined) out.tools = edit.tools.length ? edit.tools : undefined
  if (edit.skills !== undefined) out.skills = edit.skills.length ? edit.skills : undefined
  if (edit.prompt !== undefined) out.prompt = edit.prompt
  return out
}

/**
 * The edit for me that makes `file` read as `cur` with `patch` saved over it: only the fields that end up different from the
 * file, so a field set back to what the file says follows the file again. Undefined when nothing differs.
 */
export function ownEditOf(file: AgentDef, cur: AgentDef, patch: AgentEdit): OwnEdit | undefined {
  // As saving the file reads a patch: clearing the model clears the provider with it (KERNEL-406).
  const model = patch.model ?? cur.model
  const provider = model ? (patch.model === '' ? undefined : patch.provider ?? cur.provider) : undefined
  const next = {
    description: patch.description ?? cur.description, role: patch.role ?? cur.role, effort: patch.effort ?? cur.effort,
    tools: patch.tools ?? cur.tools, skills: patch.skills ?? cur.skills, prompt: patch.prompt ?? cur.prompt
  }
  const out: OwnEdit = {}
  for (const k of Object.keys(next) as (keyof typeof next)[]) {
    const v = next[k]
    if (norm(v) === norm(file[k])) continue
    // A list the edit empties gives every tool, or no skills, over a file that lists some.
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
    else if (k === 'tools' || k === 'skills') out[k] = []
  }
  // The model and its provider go together, and `''` is no pin over a file that has one.
  if (norm(model) !== norm(file.model) || norm(provider) !== norm(file.provider)) {
    out.model = model ?? ''
    if (model && provider) out.provider = provider
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The fields of a profile save that differ from the agent as the user saw it, so a change for the team carries only what they
 * changed, never their own edits for me. A model goes with its provider.
 */
export function editedFields(cur: AgentDef, patch: AgentEdit): AgentEdit {
  const out: AgentEdit = {}
  for (const k of ['description', 'role', 'effort', 'tools', 'skills', 'prompt'] as const) {
    if (patch[k] !== undefined && norm(patch[k]) !== norm(cur[k])) (out as Record<string, unknown>)[k] = patch[k]
  }
  if (patch.model !== undefined && (norm(patch.model) !== norm(cur.model) || (!!patch.model && patch.provider !== undefined && patch.provider !== cur.provider))) {
    out.model = patch.model
    if (patch.model && patch.provider) out.provider = patch.provider
  }
  return out
}

/**
 * Each room's changes for me, by agent id, in `agent-overrides.json` in Kernel's data folder (KERNEL-466). One write at a time,
 * each with the whole map as it is then, like `ScriptTrustStore`.
 */
export class AgentOverrides {
  private rooms?: Record<string, Record<string, AgentOverride>>
  private writing = Promise.resolve()

  constructor(private file: string) {}

  private async load(): Promise<Record<string, Record<string, AgentOverride>>> {
    if (this.rooms) return this.rooms
    let saved: unknown
    try { saved = JSON.parse(await readFile(this.file, 'utf8')) } catch { saved = {} }
    const rooms: Record<string, Record<string, AgentOverride>> = {}
    const isTable = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    for (const [roomId, agents] of Object.entries(isTable(saved) ? saved : {})) {
      if (!isTable(agents)) continue
      for (const [id, o] of Object.entries(agents)) {
        if (!isTable(o)) continue
        const own: AgentOverride = { ...(isTable(o.edit) ? { edit: o.edit as OwnEdit } : {}), ...(o.retired === true ? { retired: true } : {}), ...(o.joined === true ? { joined: true } : {}) }
        if (own.edit || own.retired || own.joined) (rooms[roomId] ??= {})[id] = own
      }
    }
    return (this.rooms ??= rooms)
  }

  /** The room's changes, by agent id. */
  async of(roomId: string): Promise<Record<string, AgentOverride>> { return { ...(await this.load())[roomId] } }

  /** Sets one agent's changes in a room. Nothing left to keep removes the agent, and a room left with none goes. */
  async set(roomId: string, agentId: string, next: AgentOverride): Promise<void> {
    const rooms = await this.load()
    const room = { ...rooms[roomId] }
    if (next.edit || next.retired || next.joined) room[agentId] = { ...(next.edit ? { edit: next.edit } : {}), ...(next.retired ? { retired: true } : {}), ...(next.joined ? { joined: true } : {}) }
    else delete room[agentId]
    if (Object.keys(room).length) rooms[roomId] = room
    else delete rooms[roomId]
    await this.save()
  }

  async forget(roomId: string): Promise<void> {
    const rooms = await this.load()
    if (!(roomId in rooms)) return
    delete rooms[roomId]
    await this.save()
  }

  private save() {
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.file, JSON.stringify(this.rooms ?? {}, null, 2))
    })
    return this.writing
  }
}
