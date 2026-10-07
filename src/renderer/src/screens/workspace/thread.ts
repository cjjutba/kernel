import type { ChangedFile, ChatItem } from '@shared/types'

/** What the transcript draws. A finished turn folds its work into one `group` row. */
export type ThreadBlock =
  | { kind: 'item'; item: ChatItem }
  | { kind: 'group'; id: string; tools: Extract<ChatItem, { kind: 'tool' }>[]; messages: number; items: ChatItem[] }
  | { kind: 'files'; id: string; files: ChangedFile[] }
  | { kind: 'meta'; id: string; text: string }

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

export const fmtClock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

/** "14 tool calls, 3 messages". Messages are the thinking and text that came before the reply. */
export function groupLabel(tools: number, messages: number): string {
  const calls = `${tools} tool ${tools === 1 ? 'call' : 'calls'}`
  return messages ? `${calls}, ${messages} ${messages === 1 ? 'message' : 'messages'}` : calls
}

const work = (i: ChatItem) => i.kind === 'tool' || i.kind === 'thinking' || i.kind === 'text'

/**
 * Split items into turns at each user message. A turn that finished well (it has an ok `result`) shows
 * its reply, the files it changed and how long it took, and folds everything before the reply into one group.
 * A turn still running, stopped or failed shows every item, so nothing is hidden while it matters.
 */
export function buildThread(items: ChatItem[]): ThreadBlock[] {
  const blocks: ThreadBlock[] = []
  let turn: ChatItem[] = []
  const finish = () => {
    const result = turn.find((i): i is Extract<ChatItem, { kind: 'result' }> => i.kind === 'result')
    if (!result?.ok) {
      for (const item of turn) {
        if (item.kind === 'result') blocks.push({ kind: 'meta', id: item.id, text: `${fmtDuration(item.durationMs)}${item.ok ? '' : ` · ${item.error ?? 'stopped'}`}` })
        else blocks.push({ kind: 'item', item })
      }
      turn = []
      return
    }
    const body = turn.filter((i) => i.kind !== 'result')
    let lastText = -1
    body.forEach((i, n) => { if (i.kind === 'text') lastText = n })
    const before = body.slice(0, lastText < 0 ? body.length : lastText)
    const folded = before.filter(work)
    const rest = [...before.filter((i) => !work(i)), ...body.slice(lastText < 0 ? body.length : lastText)]
    const tools = folded.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool')
    if (tools.length) blocks.push({ kind: 'group', id: `group-${tools[0].id}`, tools, messages: folded.length - tools.length, items: folded })
    else for (const item of folded) blocks.push({ kind: 'item', item })
    for (const item of rest) blocks.push({ kind: 'item', item })
    if (result.files?.length) blocks.push({ kind: 'files', id: `files-${result.id}`, files: result.files })
    blocks.push({ kind: 'meta', id: result.id, text: `${fmtDuration(result.durationMs)} · ${fmtClock(result.ts)}` })
    turn = []
  }
  for (const item of items) {
    if (item.kind === 'user') { finish(); blocks.push({ kind: 'item', item }) } else turn.push(item)
  }
  finish()
  return blocks
}

/** The Changed chips under a reply: the first two files by name, then one chip for the rest. */
export function fileChips(files: ChangedFile[]): { name: string; added: number; removed: number }[] {
  const name = (f: ChangedFile) => f.path.split('/').pop() ?? f.path
  const shown = files.slice(0, 2).map((f) => ({ name: name(f), added: f.added, removed: f.removed }))
  const more = files.slice(2)
  if (more.length) shown.push({ name: `+${more.length} more`, added: more.reduce((n, f) => n + f.added, 0), removed: more.reduce((n, f) => n + f.removed, 0) })
  return shown
}
