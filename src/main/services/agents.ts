import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename } from 'node:path'
import type { AgentDef, AgentDraft, AgentEdit, Effort } from '@shared/types'

// Agents are plain Claude Code subagent files: .claude/agents/<name>.md with YAML-ish frontmatter.
// Kernel reads the same files Claude Code reads, so the team works outside the app too.
//
//   ---
//   name: kai
//   description: Frontend engineer. Builds UI from approved plans and follows DESIGN.md.
//   model: sonnet
//   effort: high            (optional, Kernel only)
//   tools: Read, Edit, Write, Bash, Grep, Glob
//   role: Frontend          (optional, Kernel only)
//   lead: false             (optional, Kernel only)
//   skills: /feature, /verify  (optional, Kernel only)
//   ---
//   You are Kai, the frontend engineer in this room...

export function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const text = src.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { meta: {}, body: text.trim() }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { meta: {}, body: text.trim() }
  const head = text.slice(3, end).replace(/^\r?\n/, '')
  const body = text.slice(end + 4).replace(/^\r?\n/, '').trim()
  const meta: Record<string, string> = {}
  let last: string | null = null
  for (const raw of head.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (m && !/^\s/.test(raw)) {
      last = m[1]
      meta[last] = stripQuotes(m[2].trim())
    } else if (last && /^\s+/.test(raw)) {
      const piece = raw.trim().replace(/^-\s+/, '')
      meta[last] = (meta[last] ? meta[last] + (raw.trim().startsWith('-') ? ', ' : ' ') : '') + stripQuotes(piece)
    }
  }
  return { meta, body }
}

const EFFORT_IDS: Effort[] = ['low', 'medium', 'high', 'xhigh']
const stripQuotes = (s: string) => {
  const m = /^(['"])(.*)\1$/.exec(s)
  if (!m) return s
  return m[1] === '"' ? m[2].replace(/\\(["\\])/g, '$1') : m[2]
}
const list = (s?: string) => (s ? s.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean) : undefined)
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export function agentFromFile(file: string, src: string): AgentDef {
  const { meta, body } = parseFrontmatter(src)
  const id = meta.name || basename(file, '.md')
  const description = meta.description || ''
  const role = meta.role || roleFrom(description) || 'Agent'
  const lead = meta.lead ? meta.lead === 'true' : /\blead\b/i.test(role)
  return {
    id, name: titleCase(id), role, description, lead,
    model: meta.model || undefined,
    effort: EFFORT_IDS.includes(meta.effort as Effort) ? (meta.effort as Effort) : undefined,
    tools: list(meta.tools),
    skills: list(meta.skills),
    prompt: body,
    file
  }
}

/** "Frontend engineer. Builds UI..." becomes "Frontend". */
function roleFrom(description: string): string | undefined {
  const first = description.split(/[.,:]/)[0]?.trim()
  if (!first) return undefined
  const word = first.replace(/\b(engineer|developer|agent)\b/i, '').trim()
  return word ? titleCase(word.split(/\s+/).slice(0, 2).join(' ')) : undefined
}

export async function loadAgents(repoPath: string, o: { retired?: boolean } = {}): Promise<AgentDef[]> {
  const dir = join(repoPath, '.claude', o.retired ? 'retired-agents' : 'agents')
  let names: string[] = []
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.md')) } catch { return [] }
  const agents = (await Promise.all(names.map(async (n): Promise<AgentDef | null> => {
    const file = join(dir, n)
    try {
      const def = agentFromFile(file, await readFile(file, 'utf8'))
      const joinedAt = (await stat(file)).birthtimeMs
      return { ...def, joinedAt: joinedAt > 0 ? Math.round(joinedAt) : undefined, ...(o.retired ? { retired: true } : {}) }
    } catch { return null }
  }))).filter((a): a is AgentDef => !!a)
  // Lead first, then alphabetical, so the floor seats them in a stable order.
  return agents.sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name))
}

const MANAGED = ['name', 'description', 'model', 'effort', 'tools', 'role', 'lead', 'skills']
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** A frontmatter value Claude Code's YAML reader takes literally: quoted when it holds ": ", " #", or starts or ends with something YAML reads. */
export function yamlValue(v: string): string {
  const t = oneLine(v)
  if (/: |:$| #|^[#&*!|>'"%@`\[\]{},?-]/.test(t) || /^(true|false|null|yes|no|~)$/i.test(t)) return `"${t.replace(/[\\"]/g, '\\$&')}"`
  return t
}

type Managed = Partial<Pick<AgentDef, 'description' | 'model' | 'effort' | 'role' | 'lead'>> & { tools?: string[]; skills?: string[] }

const managedLines = (id: string, a: Managed & { description: string }): [string, string | undefined][] => [
  ['name', id], ['description', yamlValue(a.description)], ['model', a.model ? yamlValue(a.model) : undefined], ['effort', a.effort],
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
 * stays as it was, byte for byte, and so does the order of the lines that remain.
 */
export function rewriteAgentFile(src: string, id: string, a: Managed & { description: string; prompt: string }): string {
  const text = src.replace(/^\uFEFF/, '')
  const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1
  const head = end < 0 ? [] : text.slice(3, end).replace(/^\r?\n/, '').split(/\r?\n/)
  // `lead` is not editable here, so a lead: line stays as written.
  const want = new Map(managedLines(id, a).filter(([k]) => k !== 'lead'))
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

export async function saveAgent(repoPath: string, agent: Parameters<typeof renderAgentFile>[0]): Promise<string> {
  const dir = join(repoPath, '.claude', 'agents')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${agent.id}.md`)
  await writeFile(file, renderAgentFile(agent))
  return file
}

/** Saving the profile rewrites the file with the edited fields. Fields the patch leaves out and frontmatter Kernel does not know are kept. */
export async function updateAgent(repoPath: string, id: string, patch: AgentEdit): Promise<AgentDef> {
  const file = agentPath(repoPath, id)
  let src: string
  try { src = await readFile(file, 'utf8') } catch { throw new Error(`${id} is not in .claude/agents.`) }
  const cur = agentFromFile(file, src)
  const { meta } = parseFrontmatter(src)
  const description = patch.description ?? cur.description
  if (!oneLine(description)) throw new Error('Add a description so Rowan knows what to hand this agent.')
  // The name is the file stem, so the display name follows it. Role is the only label that can change.
  await writeFile(file, rewriteAgentFile(src, cur.id, {
    description,
    role: patch.role ?? meta.role,
    model: patch.model ?? cur.model, effort: patch.effort ?? cur.effort,
    tools: patch.tools ?? cur.tools, skills: patch.skills ?? cur.skills,
    prompt: patch.prompt ?? cur.prompt
  }))
  return agentFromFile(file, await readFile(file, 'utf8'))
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
  const { meta, body } = parseFrontmatter(draft.text)
  const id = meta.name || draft.id
  if (!ID.test(id)) throw new Error('The name in the file must be lowercase letters, numbers and dashes, starting with a letter.')
  if (!meta.description?.trim()) throw new Error('The file needs a description line so Rowan knows what to hand this agent.')
  if (!body.trim()) throw new Error('The file needs instructions under the second ---.')
  const file = agentPath(repoPath, id)
  if (await exists(file)) throw new Error(`${titleCase(id)} is already on the team. Pick another name or edit the file.`)
  await mkdir(join(repoPath, '.claude', 'agents'), { recursive: true })
  await writeFile(file, draft.text.endsWith('\n') ? draft.text : `${draft.text}\n`)
  return { ...agentFromFile(file, draft.text), joinedAt: Date.now() }
}

/**
 * Retiring moves the file out of .claude/agents instead of deleting it, so it can come back.
 * It goes to .claude/retired-agents, not a subfolder, so Claude Code stops loading it.
 */
export async function retireAgent(repoPath: string, id: string): Promise<string> {
  const to = join(repoPath, '.claude', 'retired-agents', `${id}.md`)
  if (!(await exists(agentPath(repoPath, id)))) throw new Error(`${id} is not in .claude/agents.`)
  await mkdir(join(repoPath, '.claude', 'retired-agents'), { recursive: true })
  // An older retired file with the same name is an earlier version of this agent, and the newer one replaces it.
  await rename(agentPath(repoPath, id), to)
  return to
}

/** Bring a retired agent back. Refuses when a new file took the name. */
export async function restoreAgent(repoPath: string, id: string): Promise<string> {
  const from = join(repoPath, '.claude', 'retired-agents', `${id}.md`)
  if (!(await exists(from))) throw new Error(`${id} is not in .claude/retired-agents.`)
  if (await exists(agentPath(repoPath, id))) throw new Error(`There is already an agent named ${id}. Rename one of the files first.`)
  await mkdir(join(repoPath, '.claude', 'agents'), { recursive: true })
  await rename(from, agentPath(repoPath, id))
  return agentPath(repoPath, id)
}

/**
 * Calls `onChange` (debounced) when a file in .claude/agents is added, edited, renamed or removed, so edits made outside
 * Kernel show up. Works before the folder exists: it waits on `.claude` and arms itself when `agents` appears.
 */
export function watchAgents(repoPath: string, onChange: () => void, delay = 150): () => void {
  const dir = join(repoPath, '.claude', 'agents')
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  let parent: FSWatcher | undefined
  let closed = false
  const fire = () => { clearTimeout(timer); timer = setTimeout(() => { if (!closed) onChange() }, delay) }
  const arm = () => {
    if (closed || watcher) return
    try { watcher = watch(dir, { persistent: false }, fire); watcher.on('error', () => { watcher?.close(); watcher = undefined }) } catch { watcher = undefined }
    if (watcher) { parent?.close(); parent = undefined; return }
    if (parent) return
    try {
      parent = watch(join(repoPath, '.claude'), { persistent: false }, (_e, name) => { if (!name || name === 'agents') { arm(); if (name || watcher) fire() } })
      parent.on('error', () => { parent?.close(); parent = undefined })
    } catch { parent = undefined }
  }
  arm()
  return () => { closed = true; clearTimeout(timer); watcher?.close(); parent?.close() }
}
