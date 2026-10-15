import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ChatItem, ChatPart } from '@shared/types'
import { packagedClaude, sessionEnv } from './sessions'
import { withCodex } from './providers/codex/client'
import type { ModelListResponse } from './providers/codex/protocol/v2/ModelListResponse'
import type { ThreadStartParams } from './providers/codex/protocol/v2/ThreadStartParams'
import type { ThreadStartResponse } from './providers/codex/protocol/v2/ThreadStartResponse'
import type { Turn } from './providers/codex/protocol/v2/Turn'
import type { TurnStartParams } from './providers/codex/protocol/v2/TurnStartParams'

/** The model that names chats. Small and fast: a name is a few words (KERNEL-202). */
export const TITLE_MODEL = 'claude-haiku-5-5'

const PROMPT = [
  'You name chats in a coding app. Read the conversation and reply with a name for it and nothing else.',
  'The name is 3 to 6 words, in sentence case, in plain words, with no quotes and no trailing period.',
  'When a current name is given, keep it unless the subject of the conversation has changed.'
].join(' ')

function partText(p: ChatPart): string {
  if (p.type === 'text') return p.text
  if (p.type === 'issue') return `[issue ${p.name}: ${p.title}]`
  if (p.type === 'agent') return `@${p.name}`
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
  // Space for the "..." that marks the lines left out, and its separator.
  let project = max - head.length - 5
  for (let n = lines.length - 1; n > first; n--) {
    const line = lines[n].slice(0, cap)
    if (line.length + 2 > project) break
    tail.unshift(line)
    project -= line.length + 2
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

/** What a naming request sends: the current name, when there is one, then the conversation. */
function titlePrompt(text: string, current?: string) { return `${current ? `Current name: ${current}\n\n` : ''}Conversation:\n\n${text}` }

/** Why a naming request brought back no name, for the main log: a line at most, never a credential. */
function failed(why: string): Error { return new Error(why.replace(/\s+/g, ' ').trim().slice(0, 200) || 'no answer') }

/**
 * A name for a conversation from Haiku. Claude Code starts on `env`, the active Claude account's (`Providers.claudeEnv`,
 * KERNEL-624), with no settings, no tools and no saved session, so the request never shows in its session list. It gives
 * up after 30 seconds. Undefined when the answer is no usable name. Throws with the reason when no answer came.
 */
export async function askTitle(text: string, o: { cwd: string; current?: string; env?: Record<string, string>; bin?: string }): Promise<string | undefined> {
  if (!text.trim()) return undefined
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 30_000)
  try {
    const q = query({
      prompt: titlePrompt(text, o.current),
      options: {
        cwd: o.cwd, model: TITLE_MODEL, maxTurns: 1, tools: [], systemPrompt: PROMPT, settingSources: [], persistSession: false,
        abortController: abort, env: sessionEnv(process.env, o.env ?? {}), pathToClaudeCodeExecutable: o.bin ?? packagedClaude()
      }
    })
    for await (const msg of q) {
      if (msg.type !== 'result') continue
      // A login at its limit answers with a success that is an error, its text the limit's message (KERNEL-624).
      if (msg.subtype === 'success') { if (msg.is_error) throw failed(msg.result); return cleanTitle(msg.result) }
      throw failed(`${msg.subtype}: ${msg.errors.join('; ')}`)
    }
    throw failed('Claude Code ended without a result')
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

/** The Codex model that names chats when Claude can't: Codex's small, fast one. An account without it uses its default. */
export const CODEX_TITLE_MODEL = 'gpt-6-luna'

/**
 * A name for a conversation from Codex, for when no Claude account can name it (KERNEL-624). `codex app-server` starts on
 * the Codex account (`home`, `apiKey`), runs one turn on a thread it doesn't save, with low effort, a read-only sandbox and
 * nothing to approve, and stops. It gives up after 30 seconds. Undefined when the answer is no usable name. Throws with
 * the reason when no answer came.
 */
export async function askCodexTitle(text: string, o: { cwd: string; current?: string; bin: string; home?: string; apiKey?: string }): Promise<string | undefined> {
  if (!text.trim()) return undefined
  let reply = ''
  let done: (t: Turn) => void = () => undefined
  const ended = new Promise<Turn>((resolve) => { done = resolve })
  // The process runs this one thread, so every item and turn end is its own.
  const notify = (method: string, p: any) => {
    if (method === 'item/completed' && p?.item?.type === 'agentMessage') reply = p.item.text ?? ''
    else if (method === 'turn/completed' && p?.turn) done(p.turn)
  }
  return withCodex(o.bin, o.home, async (rpc) => {
    const models = await rpc.request<ModelListResponse>('model/list', {}).catch(() => undefined)
    const model = models?.data?.some((m) => m.id === CODEX_TITLE_MODEL) ? CODEX_TITLE_MODEL : undefined
    const r = await rpc.request<ThreadStartResponse>('thread/start', {
      cwd: o.cwd, model, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: PROMPT
    } satisfies ThreadStartParams)
    await rpc.request('turn/start', { threadId: r.thread.id, input: [{ type: 'text', text: titlePrompt(text, o.current), text_elements: [] }], effort: 'low' } satisfies TurnStartParams)
    const turn = await ended
    if (turn.status !== 'completed') throw failed(turn.error?.message ?? `turn ${turn.status}`)
    const last = [...(turn.items ?? [])].reverse().find((i) => i.type === 'agentMessage')
    return cleanTitle(last?.type === 'agentMessage' ? last.text : reply)
  }, { cwd: o.cwd, apiKey: o.apiKey, timeoutMs: 30_000, handlers: { notify } })
}
