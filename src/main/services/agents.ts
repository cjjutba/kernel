import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { AgentDef } from '@shared/types'

// Agents are plain Claude Code subagent files: .claude/agents/<name>.md with YAML-ish frontmatter.
// Kernel reads the same files Claude Code reads, so the team works outside the app too.
//
//   ---
//   name: kai
//   description: Frontend engineer. Builds UI from approved plans and follows DESIGN.md.
//   model: sonnet
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

const stripQuotes = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2')
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

export async function loadAgents(repoPath: string): Promise<AgentDef[]> {
  const dir = join(repoPath, '.claude', 'agents')
  let names: string[] = []
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.md')) } catch { return [] }
  const agents = await Promise.all(names.map(async (n) => agentFromFile(join(dir, n), await readFile(join(dir, n), 'utf8'))))
  // Lead first, then alphabetical, so the floor seats them in a stable order.
  return agents.sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name))
}

export function renderAgentFile(a: Pick<AgentDef, 'id' | 'description' | 'prompt'> & Partial<AgentDef>): string {
  const lines = ['---', `name: ${a.id}`, `description: ${a.description}`]
  if (a.model) lines.push(`model: ${a.model}`)
  if (a.tools?.length) lines.push(`tools: ${a.tools.join(', ')}`)
  if (a.role) lines.push(`role: ${a.role}`)
  if (a.lead) lines.push('lead: true')
  if (a.skills?.length) lines.push(`skills: ${a.skills.join(', ')}`)
  lines.push('---', '', a.prompt.trim(), '')
  return lines.join('\n')
}

export async function saveAgent(repoPath: string, agent: Parameters<typeof renderAgentFile>[0]): Promise<string> {
  const dir = join(repoPath, '.claude', 'agents')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${agent.id}.md`)
  await writeFile(file, renderAgentFile(agent))
  return file
}

/**
 * Retiring moves the file out of .claude/agents instead of deleting it, so it can come back.
 * It goes to .claude/retired-agents, not a subfolder, so Claude Code stops loading it.
 */
export async function retireAgent(repoPath: string, id: string): Promise<string> {
  const to = join(repoPath, '.claude', 'retired-agents', `${id}.md`)
  await mkdir(join(repoPath, '.claude', 'retired-agents'), { recursive: true })
  await rename(join(repoPath, '.claude', 'agents', `${id}.md`), to)
  return to
}
