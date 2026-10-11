import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ChatItem, ChatPart } from '@shared/types'
import { packagedClaude, sessionEnv } from './sessions'

/** The model that names chats. Small and fast: a name is a few words (KERNEL-202). */
export const TITLE_MODEL = 'claude-haiku-4-5-20251001'

const PROMPT = [
  'You name chats in a coding app. Read the conversation and reply with a name for it and nothing else.',
  'The name is 3 to 6 words, in sentence case, in plain words, with no quotes and no trailing period.',
  'When a current name is given, keep it unless the subject of the conversation has changed.'
].join(' ')

function partText(p: ChatPart): string {
  if (p.type === 'text') return p.text
  if (p.type === 'issue') return `[issue ${p.name}: ${p.title}]`
  if (p.type === 'file' || p.type === 'image' || p.type === 'skill' || p.type === 'workspace') return `[${p.type} ${p.name}]`
  return ''
}

/**
 * The conversation a name is picked from, at most `max` characters: the first user message, then the most recent user
 * messages and replies that fit. Thinking, tools, notes and results are left out.
 */
export function titleText(items: ChatItem[], max = 8000): string {
  const lines: string[] = []
  for (const i of items) {
    if (i.kind === 'user') lines.push(`User: ${i.parts.map(partText).filter(Boolean).join(' ').trim()}`)
    else if (i.kind === 'text') lines.push(`Assistant: ${i.text.trim()}`)
  }
  const first = lines.findIndex((l) => l.startsWith('User: '))
  if (first < 0) return ''
  // The first message and each later line are clipped, so one long report or pasted log can't crowd out the rest.
  const cap = Math.min(1500, Math.floor(max / 4))
  const head = lines[first].slice(0, cap)
  const tail: string[] = []
  // Room for the "..." that marks the lines left out, and its separator.
  let room = max - head.length - 5
  for (let n = lines.length - 1; n > first; n--) {
    const line = lines[n].slice(0, cap)
    if (line.length + 2 > room) break
    tail.unshift(line)
    room -= line.length + 2
  }
  return [head, ...(tail.length && lines.length - 1 - first > tail.length ? ['...'] : []), ...tail].join('\n\n')
}

/** The model's answer as a tab name: its first line, without quotes, markdown, a "Title:" prefix or a closing period. */
export function cleanTitle(raw: string): string | undefined {
  let t = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  // Markdown markers only: `parse_args` keeps its underscore.
  t = t.replace(/^#+\s*/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]*)`/g, '$1')
  t = t.replace(/^(chat\s+)?(title|name)\s*:\s*/i, '')
  t = t.replace(/^["'“”‘’*_`\s]+/, '').replace(/["'“”‘’*_`.!?,;:\s]+$/, '')
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '').trim() || t.slice(0, 60)
  if (!t || t.toLowerCase() === 'new chat') return undefined
  return t
}

/**
 * A name for a conversation from Haiku. Claude Code starts with no settings, no tools and no saved session, so the request
 * never shows in its session list. It gives up after 30 seconds. Undefined when there is no usable answer.
 */
export async function askTitle(text: string, o: { cwd: string; current?: string }): Promise<string | undefined> {
  if (!text.trim()) return undefined
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  const prompt = `${o.current ? `Current name: ${o.current}\n\n` : ''}Conversation:\n\n${text}`
  try {
    const q = query({
      prompt,
      options: {
        cwd: o.cwd, model: TITLE_MODEL, maxTurns: 1, tools: [], systemPrompt: PROMPT, settingSources: [], persistSession: false,
        abortController: abort, env: sessionEnv(process.env, {}), pathToClaudeCodeExecutable: packagedClaude()
      }
    })
    for await (const msg of q) {
      if (msg.type === 'result') return msg.subtype === 'success' && !msg.is_error ? cleanTitle(msg.result) : undefined
    }
    return undefined
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}
