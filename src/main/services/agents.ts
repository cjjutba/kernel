import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { parse as parseYaml, YAMLError } from 'yaml'
import type { AgentDef, AgentDraft, AgentEdit, AgentPermissionMode, Effort } from '@shared/types'
import { EFFORT_LABELS, PERMISSION_MODES } from '@shared/types'
import { KERNEL_LEAD, RESERVED_AGENT_IDS } from '@shared/team'

// Agents are plain Claude Code subagent files: .claude/agents/<name>.md with YAML frontmatter.
// Kernel reads the same files Claude Code reads, so the team works outside the app too.
//
//   ---
//   name: kai
//   description: Frontend engineer. Builds UI from approved plans and follows DESIGN.md.
//   model: sonnet
//   effort: high            (optional, Kernel only)
//   tools: Read, Edit, Write, Bash, Grep, Glob
//   disallowedTools: WebFetch, mcp__github
//   role: Frontend          (optional, Kernel only)
//   lead: false             (optional, Kernel only)
//   skills: /feature, /verify  (optional, Kernel only)
//   ---
//   You are Kai, the frontend engineer in this room...

/** Claude Code's frontmatter: the first `---` line, then everything up to the next `---`, wherever it falls. */
const FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/

/**
 * The frontmatter as Claude Code 2.1.292 reads it (KERNEL-451). When the YAML doesn't parse, Claude Code quotes every
 * `key: value` line whose value YAML would misread (`description: Use it when: ...`), turns leading tabs into spaces and
 * tries once more. `error` says why the block still doesn't parse, or that it holds no keys, as the end of Team's
 * "Kernel couldn't read its file: ..." line.
 */
export function parseFrontmatter(src: string): { meta: Record<string, unknown>; body: string; error?: string } {
  const text = src.replace(/^﻿/, '')
  const m = text.indexOf('---', 3) < 0 ? null : FRONTMATTER.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const head = m[1] ?? ''
  const body = text.slice(m[0].length).trim()
  let value: unknown
  try { value = yaml(head) } catch {
    try { value = yaml(quoteValues(head).replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length))) } catch (e) { return { meta: {}, body, error: yamlError(e) } }
  }
  if (value === null || value === undefined) return { meta: {}, body }
  if (typeof value !== 'object' || Array.isArray(value)) return { meta: {}, body, error: 'its frontmatter has no key: value lines' }
  return { meta: value as Record<string, unknown>, body }
}

/** YAML as Bun's parser, which Claude Code uses, reads it: a repeated key keeps its last value, and `<<` merges. */
const yaml = (text: string): unknown => parseYaml(text, { uniqueKeys: false, merge: true, logLevel: 'error' })

/** A parse error's line in the file, which starts one line after the opening `---`, and the parser's reason. */
function yamlError(e: unknown): string {
  const why = e instanceof YAMLError ? e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '') : e instanceof Error ? e.message : String(e)
  const line = e instanceof YAMLError ? e.linePos?.[0].line : undefined
  return `${line ? `line ${line + 1}` : 'its frontmatter'} isn't valid YAML. ${why}`
}

/** Claude Code's second try: a plain value holding `: `, `#` or a character YAML reads as syntax, in double quotes. */
function quoteValues(head: string): string {
  return head.split('\n').map((line) => {
    const m = /^([a-zA-Z_-]+):\s+(\S.*)$/.exec(line)
    if (!m) return line
    const v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return line
    if (v.startsWith('[') && v.endsWith(']')) { try { if (Array.isArray(yaml(v))) return line } catch { /* quote it */ } }
    return /[{}[\]*&#!|>%@`]|: /.test(v) ? `${m[1]}: "${v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : line
  }).join('\n')
}

/** Every effort a file may name. A Codex agent can take `max` or `ultra`, which only some of Codex's models offer (KERNEL-406). */
const EFFORT_IDS = Object.keys(EFFORT_LABELS) as Effort[]
/** The modes `permissionMode:` takes, as Claude Code checks them. It reads `manual` as `default`. */
const AGENT_MODES: readonly string[] = [...PERMISSION_MODES, 'plan', 'dontAsk']
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/** A scalar value as text. A list or a table isn't one. */
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined)

/**
 * A tools, disallowedTools or skills value split as Claude Code splits it: a list's strings, or one string cut at commas
 * and at spaces outside parentheses, so `Bash(git status:*)` stays whole. Null for a key with no value.
 */
function entries(v: unknown): string[] | null {
  if (v === undefined || v === null) return null
  if (!v) return []
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const out: string[] = []
  for (const s of raw) {
    let cur = ''
    let paren = false
    const take = () => { if (cur.trim()) out.push(cur.trim()); cur = '' }
    for (const c of s) {
      if (c === '(') { paren = true; cur += c } else if (c === ')') { paren = false; cur += c } else if ((c === ',' || c === ' ') && !paren) take()
      else if (cur || c.trim()) cur += c
    }
    take()
  }
  return out
}

/** `tools:` and `disallowedTools:` as Claude Code reads them: unset without the key or with `*` (every tool), and empty, so no tool, when the key has no value. */
function toolList(v: unknown): string[] | undefined {
  const names = entries(v)
  if (names === null) return v === undefined ? undefined : []
  return names.includes('*') ? undefined : names
}

/** The servers `mcpServers:` names: by name, or defined in place as a one-key table under its name. */
function serverNames(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const names = v.flatMap((s) => (typeof s === 'string' ? [s] : s && typeof s === 'object' && !Array.isArray(s) && Object.keys(s).length === 1 ? Object.keys(s) : []))
  return names.length ? names : undefined
}

/** Why Claude Code refuses a `name:`, or nothing when it takes it. */
function badName(name: unknown): string | undefined {
  if (name === undefined || name === null) return undefined
  if (typeof name !== 'string') return "its name isn't text. Put it in quotes"
  if (name.startsWith('-')) return 'its name starts with a dash'
  if (name.length > 256) return 'its name is longer than 256 characters'
  if (name.normalize('NFKC').includes(':')) return 'its name has a colon, which Claude Code keeps for plugin agents'
  return undefined
}

/**
 * A file Kernel can't use, as Team shows it (KERNEL-451): under the file's name, with what went wrong, written to end Team's
 * "Kernel couldn't read its file: ..." line. It leads no one, takes no task, and a chat that still runs on it gets no
 * tools beyond Kernel's own.
 */
export function unreadableAgent(file: string, detail: string): AgentDef {
  const id = basename(file, '.md')
  return { id, name: titleCase(id), role: 'Agent', description: '', lead: false, tools: [], prompt: '', file, warnings: [{ kind: 'unreadable-file', detail }] }
}

/** Whether Kernel couldn't read the agent's file. */
export const isUnreadable = (a: Pick<AgentDef, 'warnings'>): boolean => !!a.warnings?.some((w) => w.kind === 'unreadable-file')

export function agentFromFile(file: string, src: string): AgentDef {
  const { meta, body, error } = parseFrontmatter(src)
  const refused = error ?? badName(meta.name)
  if (refused) return unreadableAgent(file, refused)
  const id = text(meta.name) || basename(file, '.md')
  // Claude Code turns a written `\n` in a description into a new line.
  const description = (text(meta.description) ?? '').replaceAll('\\n', '\n')
  const ownRole = text(meta.role)
  const role = ownRole || roleFrom(description, id) || 'Agent'
  // Only the file says who leads: `lead: true`, or a `role:` that says Lead. A description that does is a warning on Team (KERNEL-397).
  const lead = meta.lead !== undefined && meta.lead !== null ? /^true$/i.test(String(meta.lead)) : !!ownRole && /\blead\b/i.test(ownRole)
  // `inherit` is Claude Code's word for the model of whoever runs the agent, which in Kernel is Settings, Models.
  const model = text(meta.model) && text(meta.model)!.toLowerCase() !== 'inherit' ? text(meta.model) : undefined
  const provider = text(meta.provider)
  const effort = text(meta.effort) as Effort | undefined
  const mode = meta.permissionMode === 'manual' ? 'default' : text(meta.permissionMode)
  const disallowedTools = toolList(meta.disallowedTools)
  const mcpServers = serverNames(meta.mcpServers)
  const skills = entries(meta.skills)
  return {
    id, name: titleCase(id), role, description, lead,
    model,
    // `provider:` pins the provider `model:` runs on. Without it Kernel tells by the model id (KERNEL-406).
    provider: model && (provider === 'codex' || provider === 'claude') ? provider : undefined,
    effort: effort && EFFORT_IDS.includes(effort) ? effort : undefined,
    tools: toolList(meta.tools),
    ...(disallowedTools?.length ? { disallowedTools } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(mode && AGENT_MODES.includes(mode) ? { permissionMode: mode as AgentPermissionMode } : {}),
    skills: skills?.length ? skills : undefined,
    prompt: body,
    file
  }
}

/**
 * "Frontend engineer. Builds UI..." becomes "Frontend". A description that opens with a sentence, as most outside Kernel do
 * ("Reviews pull requests for..."), names no role in one word, so the file's name does: code-reviewer is "Code Reviewer"
 * (KERNEL-397).
 */
function roleFrom(description: string, id: string): string | undefined {
  const first = description.split(/[.,:]/)[0]?.trim()
  if (!first) return undefined
  const words = first.replace(/\b(engineer|developer|agent)\b/i, '').trim().split(/\s+/).filter(Boolean)
  return words.length === 1 ? titleCase(words[0]) : titleCase(id)
}

/** Why a file couldn't be read, for Team. */
function readError(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM') return "macOS won't let Kernel open it"
  if (code === 'EISDIR') return "it's a folder, not a file"
  return `the read failed with ${code ?? 'an unknown error'}`
}

/** Every file in the folder, a file Kernel can't read or parse among them with what went wrong (KERNEL-451). */
export async function loadAgents(repoPath: string, o: { retired?: boolean } = {}): Promise<AgentDef[]> {
  return readAgents(join(repoPath, '.claude', o.retired ? 'retired-agents' : 'agents'), o.retired ? { retired: true } : {})
}

/** The user's own agents in `~/.claude/agents`, which Claude Code runs in every folder, read the same way (KERNEL-463). */
export function loadPersonalAgents(home: string): Promise<AgentDef[]> {
  return readAgents(join(home, '.claude', 'agents'), { origin: 'personal' })
}

/**
 * The agents a room runs (KERNEL-463): its own files, the user's personal ones, then plugin agents. A personal file with the
 * id of a room file Kernel can read is left out, as Claude Code leaves it out. Plugin agents' ids hold a colon, which no file's can.
 */
export function teamFiles(project: AgentDef[], personal: AgentDef[], plugins: AgentDef[] = []): AgentDef[] {
  const ids = new Set(project.filter((a) => !isUnreadable(a)).map((a) => a.id))
  return [...project, ...personal.filter((a) => !ids.has(a.id)), ...plugins]
}

async function readAgents(dir: string, extra: Partial<AgentDef>): Promise<AgentDef[]> {
  let names: string[] = []
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.md')) } catch { return [] }
  const agents = (await Promise.all(names.map(async (n): Promise<AgentDef | null> => {
    const file = join(dir, n)
    let def: AgentDef
    try { def = agentFromFile(file, await readFile(file, 'utf8')) } catch (e) {
      // A file renamed or retired since the folder was listed is simply gone.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      def = unreadableAgent(file, readError(e))
    }
    const joinedAt = await stat(file).then((s) => s.birthtimeMs, () => 0)
    return { ...def, joinedAt: joinedAt > 0 ? Math.round(joinedAt) : undefined, ...extra }
  }))).filter((a): a is AgentDef => !!a)
  // Lead first, then alphabetical, so the floor seats them in a stable order.
  return agents.sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name))
}

const MANAGED = ['name', 'description', 'model', 'provider', 'effort', 'tools', 'role', 'lead', 'skills']
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** A frontmatter value Claude Code's YAML reader takes literally: quoted when it holds ": ", " #", or starts or ends with something YAML reads. */
export function yamlValue(v: string): string {
  const t = oneLine(v)
  if (/: |:$| #|^[#&*!|>'"%@`\[\]{},?-]/.test(t) || /^(true|false|null|yes|no|~)$/i.test(t)) return `"${t.replace(/[\\"]/g, '\\$&')}"`
  return t
}

type Managed = Partial<Pick<AgentDef, 'description' | 'model' | 'provider' | 'effort' | 'role' | 'lead'>> & { tools?: string[]; skills?: string[] }

const managedLines = (id: string, a: Managed & { description: string }): [string, string | undefined][] => [
  ['name', id], ['description', yamlValue(a.description)], ['model', a.model ? yamlValue(a.model) : undefined], ['provider', a.model ? a.provider : undefined], ['effort', a.effort],
  ['tools', a.tools?.length ? yamlValue(a.tools.join(', ')) : undefined], ['role', a.role ? yamlValue(a.role) : undefined],
  ['lead', a.lead ? 'true' : undefined], ['skills', a.skills?.length ? yamlValue(a.skills.join(', ')) : undefined]
]

export function renderAgentFile(a: Pick<AgentDef, 'id' | 'description' | 'prompt'> & Partial<AgentDef>): string {
  const lines = ['---']
  for (const [k, v] of managedLines(a.id, a)) if (v !== undefined) lines.push(`${k}: ${v}`)
  lines.push('---', '', a.prompt.trim(), '')
  return lines.join('\n')
}

/**
 * Rewrites only the managed lines of an existing file. Everything else in the frontmatter (a hooks: block, color, comments)
 * stays as it was, byte for byte, and so does the order of the lines that remain. With `changed`, only those keys are
 * rewritten, so a `description: >-` block or a tools list the edit didn't touch keeps its form (KERNEL-397).
 */
export function rewriteAgentFile(src: string, id: string, a: Managed & { description: string; prompt: string }, changed?: ReadonlySet<string>): string {
  const text = src.replace(/^\uFEFF/, '')
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1
  const head = end < 0 ? [] : text.slice(3, end).replace(/^\r?\n/, '').split(/\r?\n/)
  // `lead` is not editable here, so a lead: line stays as written.
  const all = managedLines(id, a).filter(([k]) => k !== 'lead')
  const want = new Map(changed ? all.filter(([k]) => changed.has(k) || (k === 'name' && !head.some((l) => /^name:/.test(l)))) : all)
  const out: string[] = []
  const done = new Set<string>()
  for (let i = 0; i < head.length; i++) {
    const key = /^([A-Za-z_][\w-]*):/.exec(head[i])?.[1]
    if (!key || !want.has(key)) { out.push(head[i]); continue }
    while (i + 1 < head.length && /^(\s+|\s*-\s)/.test(head[i + 1]) && head[i + 1].trim() !== '') i++
    done.add(key)
    const v = want.get(key)
    if (v !== undefined) out.push(`${key}: ${v}`)
  }
  for (const [k, v] of want) if (!done.has(k) && v !== undefined) out.push(`${k}: ${v}`)
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return ['---', ...out, '---', '', a.prompt.trim(), ''].join('\n')
}

const agentPath = (repoPath: string, id: string) => join(repoPath, '.claude', 'agents', `${id}.md`)
const ID = /^[a-z][a-z0-9-]*$/
const exists = (p: string) => stat(p).then(() => true, () => false)

/**
 * The file an agent lives in. Its `name:` is its id, so `code-reviewer.md` may hold `reviewer`: the file named after the
 * id first, else whichever file's name matches (KERNEL-397).
 */
async function fileOf(repoPath: string, id: string, o: { retired?: boolean } = {}): Promise<string | undefined> {
  const named = o.retired ? join(repoPath, '.claude', 'retired-agents', `${id}.md`) : agentPath(repoPath, id)
  const src = await readFile(named, 'utf8').catch(() => undefined)
  if (src !== undefined && agentFromFile(named, src).id === id) return named
  return (await loadAgents(repoPath, o)).find((a) => a.id === id)?.file
}

/** Kernel's own agents and the files a room already has keep their names (KERNEL-397). */
async function freeId(repoPath: string, id: string) {
  if (RESERVED_AGENT_IDS.includes(id)) throw new Error(`${id} is the name of Kernel's own ${id === KERNEL_LEAD ? 'Lead' : 'reviewer'}. Pick another name.`)
  if (await fileOf(repoPath, id) || await exists(agentPath(repoPath, id))) throw new Error(`${titleCase(id)} is already on the team. Pick another name or edit the file.`)
}

/** hire_agent's file. It never replaces an agent the room already has. */
export async function saveAgent(repoPath: string, agent: Parameters<typeof renderAgentFile>[0]): Promise<string> {
  await freeId(repoPath, agent.id)
  const dir = join(repoPath, '.claude', 'agents')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${agent.id}.md`)
  await writeFile(file, renderAgentFile(agent))
  return file
}

/**
 * Saving the profile rewrites the file with the edited fields. Fields the patch leaves out or doesn't change, and
 * frontmatter Kernel does not know, are kept as written.
 */
export async function updateAgent(repoPath: string, id: string, patch: AgentEdit): Promise<AgentDef> {
  const file = await fileOf(repoPath, id)
  let src: string
  try { src = await readFile(file ?? agentPath(repoPath, id), 'utf8') } catch { throw new Error(`${id} is not in .claude/agents.`) }
  const path = file ?? agentPath(repoPath, id)
  const cur = agentFromFile(path, src)
  // A rewrite keeps the lines it doesn't manage as written, so it would keep whatever broke the file too.
  if (isUnreadable(cur)) throw new Error(`Kernel can't read ${basename(path)}: ${cur.warnings![0].detail}. Fix the file, then save again.`)
  const role = text(parseFrontmatter(src).meta.role)
  const description = patch.description ?? cur.description
  if (!oneLine(description)) throw new Error('Add a description so Rowan knows what to hand this agent.')
  // The name is the file stem, so the display name follows it. Role is the only label that can change.
  const next = {
    description, role: patch.role ?? role,
    model: patch.model ?? cur.model, effort: patch.effort ?? cur.effort,
    // Clearing the model clears the provider with it, so the agent follows its role's default again (KERNEL-406).
    provider: patch.model === '' ? undefined : patch.provider ?? cur.provider,
    tools: patch.tools ?? cur.tools, skills: patch.skills ?? cur.skills
  }
  const was: Record<keyof typeof next, unknown> = { description: cur.description, role, model: cur.model, effort: cur.effort, provider: cur.provider, tools: cur.tools, skills: cur.skills }
  const changed = new Set(Object.keys(next).filter((k) => JSON.stringify(next[k as keyof typeof next] ?? null) !== JSON.stringify(was[k as keyof typeof next] ?? null)))
  await writeFile(path, rewriteAgentFile(src, cur.id, { ...next, prompt: patch.prompt ?? cur.prompt }, changed))
  return agentFromFile(path, await readFile(path, 'utf8'))
}

const ROLES: { match: RegExp; role: string; tools: string[] }[] = [
  { match: /secur|review|audit/i, role: 'Reviewer', tools: ['Read', 'Grep', 'Glob'] },
  { match: /design/i, role: 'Designer', tools: ['Read', 'Grep', 'Glob', 'Bash'] },
  { match: /doc|writer|copy/i, role: 'Docs', tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'] },
  { match: /data|sql|schema|migrat/i, role: 'Data', tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'] }
]

/** The slug a name or a description becomes: "Security reviewer" is security-reviewer. */
export const agentSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '')

/**
 * New agent > Describe. Builds the file from the description alone, so it works offline and the same way every time.
 * The review step edits the text, and "Refine it in a chat with Rowan" hands it to the Lead for anything smarter.
 */
export function draftAgent(o: { description: string; name?: string; model?: string }): AgentDraft {
  const description = oneLine(o.description)
  if (!description) throw new Error('Describe what the agent should do.')
  const kind = ROLES.find((r) => r.match.test(`${o.name ?? ''} ${description}`))
  const id = (o.name?.trim() ? agentSlug(o.name) : '') || (kind ? agentSlug(kind.role) : '') || agentSlug(description.split(' ').slice(0, 2).join(' ')) || 'new-agent'
  const name = titleCase(id)
  const sentence = description.charAt(0).toUpperCase() + description.slice(1).replace(/[.!?]*$/, '.')
  const model = o.model || 'sonnet'
  const tools = kind?.tools ?? ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']
  const prompt = `You are ${name}. ${sentence} Work in your own worktree, keep changes small, and tell Rowan what you did and what is left when you finish.`
  const text = renderAgentFile({ id, description: sentence, model, tools, role: kind?.role, prompt })
  return { id, name, description: sentence, model, tools, text, file: `.claude/agents/${id}.md` }
}

/** New agent > Create agent. Writes the reviewed text as it is, after checking Claude Code can read it. */
export async function createAgent(repoPath: string, draft: AgentDraft): Promise<AgentDef> {
  const { meta, body, error } = parseFrontmatter(draft.text)
  if (error) throw new Error(`Claude Code can't read this file: ${error}.`)
  const id = text(meta.name) || draft.id
  if (!ID.test(id)) throw new Error('The name in the file must be lowercase letters, numbers and dashes, starting with a letter.')
  if (!text(meta.description)) throw new Error('The file needs a description line so Rowan knows what to hand this agent.')
  if (!body.trim()) throw new Error('The file needs instructions under the second ---.')
  await freeId(repoPath, id)
  const file = agentPath(repoPath, id)
  await mkdir(join(repoPath, '.claude', 'agents'), { recursive: true })
  await writeFile(file, draft.text.endsWith('\n') ? draft.text : `${draft.text}\n`)
  return { ...agentFromFile(file, draft.text), joinedAt: Date.now() }
}

/**
 * Retiring moves the file out of .claude/agents instead of deleting it, so it can come back.
 * It goes to .claude/retired-agents, not a subfolder, so Claude Code stops loading it. The file keeps its own name.
 */
export async function retireAgent(repoPath: string, id: string): Promise<string> {
  const from = await fileOf(repoPath, id)
  if (!from) throw new Error(`${id} is not in .claude/agents.`)
  const to = join(repoPath, '.claude', 'retired-agents', basename(from))
  await mkdir(join(repoPath, '.claude', 'retired-agents'), { recursive: true })
  // An older retired file with the same name is an earlier version of this agent, and the newer one replaces it.
  await rename(from, to)
  return to
}

/** Bring a retired agent back. Refuses when a new file took the name. */
export async function restoreAgent(repoPath: string, id: string): Promise<string> {
  const from = await fileOf(repoPath, id, { retired: true })
  if (!from) throw new Error(`${id} is not in .claude/retired-agents.`)
  const to = join(repoPath, '.claude', 'agents', basename(from))
  if (await fileOf(repoPath, id) || await exists(to)) throw new Error(`There is already an agent named ${id}. Rename one of the files first.`)
  await mkdir(join(repoPath, '.claude', 'agents'), { recursive: true })
  await rename(from, to)
  return to
}

/**
 * Calls `onChange` (debounced) when a file in .claude/agents is added, edited, renamed or removed, so edits made outside
 * Kernel show up. Works before the folder exists: it waits on `.claude` and arms itself when `agents` appears.
 */
export function watchAgents(repoPath: string, onChange: () => void, delay = 150): () => void {
  return watchFolder(join(repoPath, '.claude', 'agents'), onChange, { delay })
}

/** The same for `~/.claude/agents`, whose files join every room's team (KERNEL-463). */
export function watchPersonalAgents(home: string, onChange: () => void, delay = 150): () => void {
  return watchFolder(join(home, '.claude', 'agents'), onChange, { delay })
}

/** The same for the room's `.kernel/settings*.toml`, whose `[team]` decides who leads and reviews (KERNEL-397). */
export function watchTeamSettings(repoPath: string, onChange: () => void, delay = 150): () => void {
  return watchFolder(join(repoPath, '.kernel'), onChange, { delay, only: (name) => /^settings(\.local)?\.toml$/.test(name) })
}

/** Watches `dir`, or its parent until `dir` appears. `only` picks the file names that count. */
function watchFolder(dir: string, onChange: () => void, o: { delay: number; only?: (name: string) => boolean }): () => void {
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  let parent: FSWatcher | undefined
  let closed = false
  const fire = () => { clearTimeout(timer); timer = setTimeout(() => { if (!closed) onChange() }, o.delay) }
  const arm = () => {
    if (closed || watcher) return
    try {
      watcher = watch(dir, { persistent: false }, (_e, name) => { if (!o.only || !name || o.only(String(name))) fire() })
      watcher.on('error', () => { watcher?.close(); watcher = undefined })
    } catch { watcher = undefined }
    if (watcher) { parent?.close(); parent = undefined; return }
    if (parent) return
    try {
      parent = watch(dirname(dir), { persistent: false }, (_e, name) => { if (!name || name === basename(dir)) { arm(); if (name || watcher) fire() } })
      parent.on('error', () => { parent?.close(); parent = undefined })
    } catch { parent = undefined }
  }
  arm()
  return () => { closed = true; clearTimeout(timer); watcher?.close(); parent?.close() }
}
