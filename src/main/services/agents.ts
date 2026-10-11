import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import type { AgentDef, AgentDraft, AgentEdit, Effort } from '@shared/types'
import { EFFORT_LABELS } from '@shared/types'
import { KERNEL_LEAD, RESERVED_AGENT_IDS } from '@shared/team'

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
  // The last line before `---` keeps its `\r` in a file saved on Windows.
  const lines = head.split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (m && !/^\s/.test(raw)) {
      last = m[1]
      // `description: >-` and `|`: the indented lines under it are the value, folded or kept as lines (KERNEL-397).
      const block = /^([|>])[+-]?\d?[+-]?\s*(#.*)?$/.exec(m[2].trim())
      if (block) {
        const taken: string[] = []
        while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) taken.push(lines[++i])
        meta[last] = blockScalar(taken, block[1] === '>')
        continue
      }
      meta[last] = stripQuotes(plain(m[2].trim()))
    } else if (last && /^\s+/.test(raw)) {
      const piece = raw.trim().replace(/^-\s+/, '')
      meta[last] = (meta[last] ? meta[last] + (raw.trim().startsWith('-') ? ', ' : ' ') : '') + stripQuotes(plain(piece))
    }
  }
  return { meta, body }
}

/** A plain YAML value without its comment: `sonnet # cheap` is `sonnet`. A quoted value keeps its `#`. */
const plain = (v: string) => (/^['"]/.test(v) ? v : v.replace(/(^|\s+)#.*$/, '').trim())

/** The lines of a `|` or `>` value, their shared indent taken off. `>` joins each paragraph's lines with spaces. */
function blockScalar(lines: string[], folded: boolean): string {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length))
  const out = lines.map((l) => (l.trim() ? l.slice(Number.isFinite(indent) ? indent : 0) : ''))
  const text = folded ? out.join('\n').split(/\n{2,}/).map((p) => p.split('\n').join(' ')).join('\n') : out.join('\n')
  return text.trim()
}

/** Every effort a file may name. A Codex agent can take `max` or `ultra`, which only some of Codex's models offer (KERNEL-406). */
const EFFORT_IDS = Object.keys(EFFORT_LABELS) as Effort[]
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
  const role = meta.role || roleFrom(description, id) || 'Agent'
  // Only the file says who leads: `lead: true`, or a `role:` that says Lead. A description that does is a warning on Team (KERNEL-397).
  const lead = meta.lead ? /^true$/i.test(meta.lead) : !!meta.role && /\blead\b/i.test(meta.role)
  return {
    id, name: titleCase(id), role, description, lead,
    model: meta.model || undefined,
    // `provider:` pins the provider `model:` runs on. Without it Kernel tells by the model id (KERNEL-406).
    provider: meta.model && (meta.provider === 'codex' || meta.provider === 'claude') ? meta.provider : undefined,
    effort: EFFORT_IDS.includes(meta.effort as Effort) ? (meta.effort as Effort) : undefined,
    tools: list(meta.tools),
    skills: list(meta.skills),
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
  const { meta } = parseFrontmatter(src)
  const description = patch.description ?? cur.description
  if (!oneLine(description)) throw new Error('Add a description so Rowan knows what to hand this agent.')
  // The name is the file stem, so the display name follows it. Role is the only label that can change.
  const next = {
    description, role: patch.role ?? meta.role,
    model: patch.model ?? cur.model, effort: patch.effort ?? cur.effort,
    // Clearing the model clears the provider with it, so the agent follows its role's default again (KERNEL-406).
    provider: patch.model === '' ? undefined : patch.provider ?? cur.provider,
    tools: patch.tools ?? cur.tools, skills: patch.skills ?? cur.skills
  }
  const was: Record<keyof typeof next, unknown> = { description: cur.description, role: meta.role, model: cur.model, effort: cur.effort, provider: cur.provider, tools: cur.tools, skills: cur.skills }
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
  const { meta, body } = parseFrontmatter(draft.text)
  const id = meta.name || draft.id
  if (!ID.test(id)) throw new Error('The name in the file must be lowercase letters, numbers and dashes, starting with a letter.')
  if (!meta.description?.trim()) throw new Error('The file needs a description line so Rowan knows what to hand this agent.')
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
