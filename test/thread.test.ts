import { describe, expect, it } from 'vitest'
import type { ChangedFile, ChatItem } from '../src/shared/types'
import { tableItems } from '../fixtures/base'
import { buildThread, entriesOf, messageLabel, runLabel, summarize, turnFiles } from '../src/renderer/src/screens/workspace/thread'
import { parseDiff } from '../src/renderer/src/screens/workspace/diff'
import { parseBlocks } from '../src/renderer/src/screens/workspace/mdParse'
import { visibleRows } from '../src/renderer/src/screens/workspace/tree'

describe('transcript thread', () => {
  it("folds a finished turn's steps and in-between messages into one group, then the reply with the changed files and the duration under it (KERNEL-840)", () => {
    const blocks = buildThread(tableItems)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'reply'])
    const group = blocks[1]
    if (group.kind !== 'group') throw new Error('expected a group')
    expect(group.summary).toEqual({ text: 'Read 4 files, ran 6 commands, edited 2 files and 1 more', bad: '' })
    expect(group.items.filter((i) => i.kind === 'text').map((i) => i.id)).toEqual(['x0'])
    const reply = blocks[2]
    if (reply.kind !== 'reply') throw new Error('expected the reply')
    expect(reply.item.id).toBe('x1')
    expect(reply.files).toHaveLength(4)
    expect(reply.meta.startsWith('4m 12s · ')).toBe(true)
  })

  it("keeps the files and the duration on their own rows when the reply isn't the turn's last row (KERNEL-346)", () => {
    const end = tableItems.length - 1
    const late = { kind: 'tool' as const, id: 't-late', ts: tableItems[end].ts, toolUseId: 'tu-late', name: 'Bash', label: 'Run the linter', detail: 'pnpm lint', status: 'done' as const }
    const blocks = buildThread([...tableItems.slice(0, end), late, tableItems[end]])
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'item', 'item', 'files', 'meta'])
    // A turn with no reply at all ends in its duration alone.
    expect(buildThread(tableItems.filter((i) => i.kind !== 'text')).map((b) => b.kind)).toEqual(['item', 'group', 'files', 'meta'])
  })

  it('puts a note written after the turn ended below its duration', () => {
    const note = { kind: 'note' as const, id: 'n1', ts: tableItems[tableItems.length - 1].ts + 1, text: 'PR #42 was squashed into main.' }
    const blocks = buildThread([...tableItems, note])
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'reply', 'item'])
    const last = blocks[3]
    expect(last.kind === 'item' && last.item.id).toBe('n1')
  })

  it('keeps a note the turn began with above its folded work (KERNEL-569)', () => {
    const note = { kind: 'note' as const, id: 'n-account', ts: tableItems[0].ts, text: 'Now on Personal' }
    const blocks = buildThread([tableItems[0], note, ...tableItems.slice(1)])
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'item', 'group', 'reply'])
    const opening = blocks[1]
    expect(opening.kind === 'item' && opening.item.id).toBe('n-account')
    // With no work to fold, the note sits where it was written, ahead of the reply.
    const reply = tableItems.filter((i) => i.id === 'x1' || i.kind === 'result')
    expect(buildThread([tableItems[0], note, ...reply]).map((b) => b.kind)).toEqual(['item', 'item', 'reply'])
  })

  it('folds a turn that has no result and is not running, as a crashed or stopped turn is', () => {
    const cut = tableItems.filter((i) => i.kind !== 'result' && i.id !== 'x1')
    expect(buildThread(cut).map((b) => b.kind)).toEqual(['item', 'group', 'item', 'group', 'end'])
  })
})

const at = 1_700_000_000_000
let n = 0
const linear = (title: string, status: 'done' | 'failed' = 'done', input: Record<string, unknown> = {}): ChatItem =>
  ({ kind: 'tool', id: `ln${++n}`, ts: at, toolUseId: `tu${n}`, name: 'mcp__linear__save_issue', label: 'linear · save_issue', detail: '{}', status, input: { team: 'Kernel', title, ...input }, ...(status === 'failed' ? { output: 'Validation failed' } : {}) })
const handoff = (agent: string): ChatItem =>
  ({ kind: 'tool', id: `hw${++n}`, ts: at, toolUseId: `tu${n}`, name: 'mcp__kernel__create_workspace', label: 'kernel · create_workspace', detail: '{}', status: 'done', input: { agent, title: `Build ${n}` } })
const bash = (command: string, status: 'running' | 'done' | 'failed' = 'done'): ChatItem =>
  ({ kind: 'tool', id: `bs${++n}`, ts: at, toolUseId: `tu${n}`, name: 'Bash', label: 'Run', detail: command, status, input: { command } })
const read = (file: string): ChatItem =>
  ({ kind: 'tool', id: `rd${++n}`, ts: at, toolUseId: `tu${n}`, name: 'Read', label: 'Read', detail: file, status: 'done', input: { file_path: file } })
const think = (): ChatItem => ({ kind: 'thinking', id: `th${++n}`, ts: at, text: 'Next.' })
const say = (text: string): ChatItem => ({ kind: 'text', id: `tx${++n}`, ts: at, text })
const ask = (): ChatItem => ({ kind: 'user', id: `us${++n}`, ts: at, parts: [{ type: 'text', text: 'Go' }] })
const done = (): ChatItem => ({ kind: 'result', id: `rs${++n}`, ts: at, durationMs: 60_000, ok: true })

describe('runs of the same call (KERNEL-784)', () => {
  it('folds two or more calls with the same service and verb into one run, and says how many', () => {
    const [run] = entriesOf([linear('A'), linear('B'), linear('C')])
    if (run.kind !== 'run') throw new Error('expected a run')
    expect(run.run.tools).toHaveLength(3)
    expect(runLabel(run.run)).toEqual({ text: 'Filed 3 issues in Linear', bad: '' })
    expect(entriesOf([linear('A')]).map((e) => e.kind)).toEqual(['item'])
  })

  it('says "Handed off 5 tasks" without a service, and counts kernel and other verbs apart', () => {
    const entries = entriesOf([...['christian', 'sean', 'christian', 'teng', 'sean'].map(handoff), bash('ls'), bash('pwd')])
    expect(entries.map((e) => e.kind)).toEqual(['run', 'run'])
    expect(entries.map((e) => (e.kind === 'run' ? runLabel(e.run).text : ''))).toEqual(['Handed off 5 tasks', 'Ran 2 commands'])
  })

  it('keeps the run going across thinking, and lists the thinking inside it', () => {
    const t = think()
    const entries = entriesOf([linear('A'), t, linear('B')])
    expect(entries).toHaveLength(1)
    const run = entries[0]
    if (run.kind !== 'run') throw new Error('expected a run')
    expect(run.run.items).toHaveLength(3)
    expect(run.run.items[1]).toBe(t)
  })

  it('breaks a run at a message or a different verb, and keeps filing and updating an issue apart', () => {
    expect(entriesOf([linear('A'), linear('B'), say('Now the rest.'), linear('C'), linear('D')]).map((e) => e.kind)).toEqual(['run', 'item', 'run'])
    expect(entriesOf([linear('A'), linear('B', 'done', { id: 'KERNEL-1' }), linear('C', 'done', { id: 'KERNEL-2' })]).map((e) => e.kind)).toEqual(['item', 'run'])
  })

  it('shows a partial failure in the run row', () => {
    const [run] = entriesOf([...['A', 'B', 'C', 'D', 'E', 'F'].map((t) => linear(t)), linear('G', 'failed')])
    if (run.kind !== 'run') throw new Error('expected a run')
    expect(runLabel(run.run)).toEqual({ text: 'Filed 6 of 7 issues in Linear', bad: '1 failed' })
  })

  it("says so when none of a run's calls worked, and when you denied them", () => {
    const denied = (c: string): ChatItem => ({ ...(bash(c, 'failed') as Extract<ChatItem, { kind: 'tool' }>), output: "The user doesn't want to proceed with this tool use. The tool use was rejected." })
    const [failed, refused] = [entriesOf([linear('A', 'failed'), linear('B', 'failed')])[0], entriesOf([denied('a'), denied('b')])[0]]
    if (failed.kind !== 'run' || refused.kind !== 'run') throw new Error('expected runs')
    expect(runLabel(failed.run)).toEqual({ text: "Couldn't file 2 issues in Linear", bad: '' })
    expect(runLabel(refused.run)).toEqual({ text: 'You denied 2 commands', bad: '' })
  })

  it("doesn't list calls the row hides", () => {
    const search: ChatItem = { kind: 'tool', id: 'ts1', ts: at, toolUseId: 'tsu', name: 'ToolSearch', label: 'ToolSearch', detail: '', status: 'done' }
    expect(entriesOf([search, linear('A'), search, linear('B')]).map((e) => e.kind)).toEqual(['run'])
  })
})

describe('the summary of a turn (KERNEL-784)', () => {
  it('lists what the turn did, in the order it first did it', () => {
    const items = [read('a'), read('b'), bash('x'), read('c'), ...['A', 'B'].map((t) => linear(t)), bash('y')]
    expect(summarize(items)).toEqual({ text: 'Read 3 files, ran 2 commands, filed 2 issues', bad: '' })
  })

  it('shows three phrases at most, then how many more', () => {
    const items = [read('a'), bash('x'), linear('A'), handoff('christian'), linear('B', 'done', { id: 'KERNEL-1' })]
    expect(summarize(items).text).toBe('Read 1 file, ran 1 command, filed 1 issue and 2 more')
  })

  it('counts what worked against what was tried, and puts the failures at the end', () => {
    const items = [read('a'), ...['A', 'B', 'C'].map((t) => linear(t)), linear('D', 'failed'), bash('x', 'failed')]
    expect(summarize(items)).toEqual({ text: "Read 1 file, filed 3 of 4 issues, couldn't run 1 command", bad: '1 failed' })
  })
})

describe('tools the labels do not know (KERNEL-800)', () => {
  const unknown = (name: string): ChatItem => ({ kind: 'tool', id: `un${++n}`, ts: at, toolUseId: `tu${n}`, name, label: name, detail: '', status: 'done', output: 'No such tool available' })

  it('tallies them as "used 1 tool" and never prints the name', () => {
    const items = [bash('a'), bash('b'), unknown('bash_placeholder'), read('c')]
    expect(summarize(items).text).toBe('Ran 2 commands, used 1 tool, read 1 file')
    expect(summarize([unknown('bash_placeholder'), unknown('Mystery')]).text).toBe('Used 2 tools')
    expect(summarize([...items, unknown('Other')]).text).not.toMatch(/placeholder|Mystery|Other/)
  })

  it('keeps an unknown MCP server humanised, and counts a Bash call with no description as a command', () => {
    const docs: ChatItem = { kind: 'tool', id: 'dq', ts: at, toolUseId: 'dq', name: 'mcp__context7__query_docs', label: '', detail: '', status: 'done' }
    expect(summarize([docs]).text).toBe('Query docs')
    expect(summarize([bash('a'), bash('b')]).text).toBe('Ran 2 commands')
  })
})

describe('a turn that is still running folds its finished steps (KERNEL-784)', () => {
  it('folds the step in flight with the finished ones, and words the running call in the present tense', () => {
    const items = [ask(), think(), read('a'), bash('x'), bash('y'), bash('z', 'running')]
    const blocks = buildThread(items, true)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group'])
    const group = blocks[1]
    if (group.kind !== 'group') throw new Error('expected a group')
    expect(group.entries.map((e) => e.kind)).toEqual(['item', 'item', 'item', 'item', 'item'])
    expect(group.items).toContain(items[5])
    expect(group.summary.text).toBe('Read 1 file, ran 2 commands, running 1 more')
  })

  it('reads "Running a command" for a first step alone, and counts up as steps arrive', () => {
    const first = buildThread([ask(), bash('x', 'running')], true)
    expect(first.map((b) => b.kind)).toEqual(['item', 'group'])
    expect(first[1].kind === 'group' && first[1].summary.text).toBe('Running a command')
    expect(summarize([bash('x')]).text).toBe('Ran a command')
    expect(summarize([bash('x'), bash('y', 'running')]).text).toBe('Ran 1 command, running 1 more')
    expect(summarize([bash('x', 'running'), bash('y', 'running')]).text).toBe('Running 2 commands')
    expect(summarize([bash('a'), bash('b'), bash('c'), bash('d'), bash('e', 'running'), think()]).text).toBe('Ran 4 commands, running 1 more')
    expect(summarize([read('a'), bash('x', 'running'), bash('y', 'failed')]).text).toBe("Read 1 file, couldn't run 1 command, running 1 more")
  })

  it('keeps the fold id through the turn as an empty thinking fills in and steps arrive', () => {
    const idOf = (items: ChatItem[]) => { const g = buildThread(items, true)[1]; return g.kind === 'group' ? g.id : undefined }
    const q = ask()
    const t = think()
    const empty = { ...t, text: '' }
    const filled = { ...t, text: 'Reading the table.' }
    const r = read('a')
    expect(idOf([q, empty, r])).toBe(idOf([q, filled, r]))
    expect(idOf([q, filled, r, bash('x', 'running')])).toBe(idOf([q, empty, r]))
  })

  it('reads the newest message of a running turn under its fold, and takes it into the fold once a step follows (KERNEL-1094)', () => {
    const blocks = buildThread([ask(), read('a'), say('Now the tests.')], true)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'item'])
    const group = blocks[1]
    expect(group.kind === 'group' && group.entries.map((e) => e.kind === 'item' && e.item.kind)).toEqual(['tool'])
    expect(group.kind === 'group' && group.summary.text).toBe('Read a file')
    const further = buildThread([ask(), read('a'), say('Now the tests.'), bash('x')], true)
    expect(further.map((b) => b.kind)).toEqual(['item', 'group'])
    expect(further[1].kind === 'group' && further[1].entries.map((e) => e.kind === 'item' && e.item.kind)).toEqual(['tool', 'text', 'tool'])
    // After a note or approval, text alone is a fold too, so none of it shows.
    const note: ChatItem = { kind: 'note', id: 'nt2', ts: at, text: 'PR #1 opened.' }
    const after = buildThread([ask(), read('a'), note, say('Waiting on checks.')], true)
    expect(after.map((b) => b.kind)).toEqual(['item', 'group', 'item', 'group'])
    expect(after[3].kind === 'group' && after[3].summary.text).toBe('Working')
    expect(buildThread([ask(), read('a'), note, think()], true)[3]).toMatchObject({ kind: 'group', summary: { text: 'Working' } })
  })

  it('never nests a run inside a fold, and lists same-kind calls as plain rows in one flat list (KERNEL-800)', () => {
    const items = [ask(), read('a'), bash('x'), bash('y'), bash('z'), think(), read('b'), read('c'), say('Done.'), done()]
    const group = buildThread(items)[1]
    if (group.kind !== 'group') throw new Error('expected a group')
    expect(group.entries.every((e) => e.kind === 'item')).toBe(true)
    expect(group.entries.map((e) => e.kind === 'item' && e.item.id)).toEqual(items.slice(1, 8).map((i) => i.id))
    expect(group.summary.text).toBe('Read 3 files, ran 3 commands')
    const same = buildThread([ask(), bash('x'), bash('y'), bash('z'), say('Done.'), done()])
    expect(same.map((b) => b.kind)).toEqual(['item', 'group', 'reply'])
  })

  it('drops thinking with no text from folds and runs, and keeps thinking with text (KERNEL-800)', () => {
    const empty = (): ChatItem => ({ kind: 'thinking', id: `th${++n}`, ts: at, text: '  ' })
    const kept = think()
    expect(entriesOf([bash('a'), empty(), bash('b'), kept]).flatMap((e) => (e.kind === 'run' ? e.run.items : [e.item]))).toHaveLength(3)
    const group = buildThread([ask(), empty(), read('a'), empty(), kept, bash('x'), say('Done.'), done()])[1]
    if (group.kind !== 'group') throw new Error('expected a group')
    expect(group.items).toHaveLength(3)
    expect(group.entries.map((e) => e.kind === 'item' && e.item.kind)).toEqual(['tool', 'thinking', 'tool'])
    expect(buildThread([ask(), empty(), empty(), say('Done.'), done()]).map((b) => b.kind)).toEqual(['item', 'reply'])
    expect(buildThread([ask(), read('a'), empty(), read('b')], true).map((b) => b.kind)).toEqual(['item', 'group'])
  })

  it('folds messages with the steps, and still breaks the fold at notes and approvals (KERNEL-840)', () => {
    const note: ChatItem = { kind: 'note', id: 'nt', ts: at, text: 'PR #1 opened.' }
    const approval: ChatItem = { kind: 'approval', id: 'ap', ts: at, approvalId: 'a1' } as ChatItem
    const items = [ask(), read('a'), bash('x'), say('Filing now.'), note, linear('A'), linear('B'), approval]
    const blocks = buildThread(items, true)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'item', 'item', 'group', 'item'])
    const group = blocks[1]
    expect(group.kind === 'group' && group.entries.map((e) => e.kind === 'item' && e.item.kind)).toEqual(['tool', 'tool'])
    expect(group.kind === 'group' && group.summary.text).toBe('Read 1 file, ran 1 command')
    // The message just before the note stays out of the fold, so it reads without opening it.
    expect(blocks.filter((b) => b.kind === 'item').map((b) => b.kind === 'item' && b.item.kind)).toEqual(['user', 'text', 'note', 'approval'])
  })

  it('streams the first message of a turn in full until the turn has a call (KERNEL-840)', () => {
    expect(buildThread([ask(), say('Looking.')], true).map((b) => b.kind)).toEqual(['item', 'item'])
  })

  it('folds a finished turn into one fold and its reply (KERNEL-840)', () => {
    const items = [ask(), think(), read('a'), say('I will build it first.'), bash('x'), think(), say('Moving on.'), bash('y'), say('Done.'), done()]
    const blocks = buildThread(items)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'reply'])
    const group = blocks[1]
    if (group.kind !== 'group') throw new Error('expected a group')
    expect(group.entries.map((e) => e.kind === 'item' && e.item.kind)).toEqual(['thinking', 'tool', 'text', 'tool', 'thinking', 'text', 'tool'])
    expect(group.summary.text).toBe('Read 1 file, ran 2 commands')
    // A message ending a run of one call keeps the stretch a fold, not a lone run.
    expect(buildThread([ask(), bash('x'), bash('y'), bash('z'), say('Checked.'), read('a'), say('Done.'), done()]).map((b) => b.kind)).toEqual(['item', 'group', 'reply'])
  })

  it('leaves a turn of messages with no call unfolded (KERNEL-840)', () => {
    expect(buildThread([ask(), say('One.'), say('Two.'), done()]).map((b) => b.kind)).toEqual(['item', 'item', 'reply'])
  })

  it('folds a stopped or cut-off turn, with its last message under the fold and one line that says how it ended (KERNEL-1094)', () => {
    const stopped: ChatItem = { kind: 'interrupted', id: 'in', ts: at }
    expect(buildThread([ask(), say('First.'), read('a'), say('Second.'), stopped]).map((b) => b.kind)).toEqual(['item', 'group', 'item', 'end'])
    expect(buildThread([ask(), say('First.'), read('a'), say('Second.')]).map((b) => b.kind)).toEqual(['item', 'group', 'item', 'end'])
    expect(buildThread([ask(), say('First.'), read('a'), say('Second.'), stopped]).at(-1)).toMatchObject({ kind: 'end', why: 'stopped' })
    expect(buildThread([ask(), say('First.'), read('a'), say('Second.')]).at(-1)).toMatchObject({ kind: 'end', why: 'cut' })
  })

  it('draws no end line for a turn a quit note already speaks for, nor for one that has done nothing yet', () => {
    const quit: ChatItem = { kind: 'note', id: 'q', ts: at, text: 'Kernel quit while this agent was working.' }
    expect(buildThread([ask(), read('a'), quit]).map((b) => b.kind)).toEqual(['item', 'group', 'item'])
    expect(buildThread([ask()]).map((b) => b.kind)).toEqual(['item'])
  })

  it('keeps the last step in view under the fold of a turn that ended on it', () => {
    const over: ChatItem = { kind: 'result', id: 'ro', ts: at, durationMs: 60_000, ok: true }
    const ended = buildThread([ask(), read('a'), bash('x'), over])
    expect(ended.find((b) => b.kind === 'group')).toMatchObject({ ends: true })
    const replied = buildThread([ask(), read('a'), bash('x'), say('Done.'), over])
    expect(replied.find((b) => b.kind === 'group')).not.toHaveProperty('ends')
  })

  it('labels a message with its first line, Markdown taken off (KERNEL-840)', () => {
    expect(messageLabel('**I will build the table first**, then the tests.\n\n- loading')).toBe('I will build the table first, then the tests.')
    expect(messageLabel('\n## Plan\nText')).toBe('Plan')
    expect(messageLabel('- [x] Read the [plan](https://x.dev) and `ship`')).toBe('Read the plan and ship')
    expect(messageLabel('```\ncode\n```')).toBe('code')
  })

  it('keeps thinking in flight inside the fold, and adds nothing to the summary', () => {
    expect(buildThread([ask(), read('a'), bash('x')], true).map((b) => b.kind)).toEqual(['item', 'group'])
    const blocks = buildThread([ask(), read('a'), bash('x'), think()], true)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group'])
    expect(blocks[1].kind === 'group' && blocks[1].summary.text).toBe('Read 1 file, ran 1 command')
  })

  it('never returns a live block, and keeps notes and approvals outside the folds', () => {
    const approval: ChatItem = { kind: 'approval', id: 'ap2', ts: at, approvalId: 'a2' } as ChatItem
    const blocks = buildThread([ask(), read('a'), bash('x', 'running'), approval], true)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'item'])
    const between = buildThread([ask(), read('a'), approval, bash('y', 'running')], true)
    expect(between.map((b) => b.kind)).toEqual(['item', 'group', 'item', 'group'])
    expect(between.some((b) => (b.kind as string) === 'live')).toBe(false)
  })

  it('keeps the fold, and what is in it, when the turn ends', () => {
    const steps = [read('a'), bash('x'), bash('y')]
    const during = buildThread([ask(), ...steps, bash('z', 'running')], true)
    const finished = buildThread([ask(), ...steps, bash('z'), say('Done.'), done()])
    const a = during[1]
    const b = finished[1]
    expect(a.kind === 'group' && b.kind === 'group' && a.id === b.id).toBe(true)
  })

  it('folds a stopped turn and a failed one, and ends each on one quiet line', () => {
    const stopped: ChatItem = { kind: 'interrupted', id: 'in', ts: at }
    expect(buildThread([ask(), read('a'), bash('x'), bash('y'), stopped], true).map((b) => b.kind)).toEqual(['item', 'group', 'end'])
    const failed: ChatItem = { kind: 'result', id: 'rf', ts: at, durationMs: 1000, ok: false, error: 'Boom' }
    const blocks = buildThread([ask(), read('a'), bash('x', 'failed'), failed])
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'end', 'meta'])
    expect(blocks.at(-2)).toMatchObject({ kind: 'end', why: 'failed', ms: 1000 })
  })

  it('stays fast for a 500-step turn', () => {
    const steps = Array.from({ length: 500 }, (_, i): ChatItem => (i % 3 === 0 ? read(`f${i}`) : i % 3 === 1 ? bash(`c${i}`) : think()))
    const items = [ask(), ...steps, bash('last', 'running')]
    const t = performance.now()
    buildThread(items, true)
    for (let i = 0; i < 20; i++) buildThread(items, true)
    expect((performance.now() - t) / 21).toBeLessThan(25)
    expect(buildThread(items, true).map((b) => b.kind)).toEqual(['item', 'group'])
  })
})

describe('turn files card', () => {
  const file = (path: string, status: ChangedFile['status'], added: number, removed: number): ChangedFile => ({ path, status, added, removed })

  it('names a row by path, what happened and the counts, and marks new, deleted and renamed files', () => {
    const v = turnFiles([
      file('src/main/features/inbox.ts', 'M', 31, 12), file('test/inboxStale.test.ts', 'A', 68, 0), file('notes.md', '?', 3, 0),
      file('src/main/services/inboxPoll.ts', 'D', 0, 54), { ...file('src/b.ts', 'R', 0, 0), from: 'src/a.ts' }
    ])
    expect(v.shown.map((r) => r.label)).toEqual([
      'src/main/features/inbox.ts, edited, 31 added, 12 removed', 'test/inboxStale.test.ts, new, 68 added', 'notes.md, new, 3 added',
      'src/main/services/inboxPoll.ts, deleted, 54 removed', 'src/b.ts, renamed'
    ])
    expect(v.shown.map((r) => r.marker)).toEqual([undefined, 'New', 'New', 'Deleted', 'Renamed'])
    expect(v.shown.map((r) => r.deleted)).toEqual([false, false, false, true, false])
    expect(v.shown.map((r) => [r.name, r.dir])).toEqual([['inbox.ts', 'src/main/features'], ['inboxStale.test.ts', 'test'], ['notes.md', ''], ['inboxPoll.ts', 'src/main/services'], ['b.ts', 'src']])
  })

  it('titles the card with the file count and totals every file', () => {
    expect(turnFiles([file('a.ts', 'M', 1, 2)]).title).toBe('1 file changed')
    const v = turnFiles([file('a.ts', 'M', 31, 12), file('b.ts', 'D', 0, 54), file('c.ts', 'A', 68, 0)])
    expect(v.title).toBe('3 files changed')
    expect(v).toMatchObject({ added: 99, removed: 66 })
  })

  it('shows up to 6 files in full and from 7 folds all but the first 5, with the hidden files totals', () => {
    const files = Array.from({ length: 7 }, (_, i) => file(`f${i}.ts`, 'M', i + 1, 1))
    expect(turnFiles(files.slice(0, 6))).toMatchObject({ hidden: [] })
    const v = turnFiles(files)
    expect(v.shown.map((r) => r.name)).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'])
    expect(v.hidden.map((r) => r.name)).toEqual(['f5.ts', 'f6.ts'])
    expect(v).toMatchObject({ hiddenAdded: 13, hiddenRemoved: 2, added: 28, removed: 7 })
  })
})

describe('workspace views', () => {
  it('parses a unified diff into numbered lines', () => {
    const [file] = parseDiff(['diff --git a/p.ts b/p.ts', '--- a/p.ts', '+++ b/p.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n'))
    expect(file).toMatchObject({ path: 'p.ts', added: 1, removed: 1 })
    expect(file.lines.slice(1).map((l) => [l.a, l.b, l.mark])).toEqual([['1', '1', ' '], ['2', '', '-'], ['', '2', '+']])
  })

  it('splits markdown into paragraphs, lists and code', () => {
    expect(parseBlocks('Hi **there**\n\n- a\n- b\n\n```ts\nx\n```').map((b) => b.type)).toEqual(['p', 'ul', 'code'])
  })

  it('reads a plan as a document: headings by level, rules, quotes, tables and tilde fences', () => {
    const blocks = parseBlocks('# Title\n## Context\nWhy.\n---\n> Note\n> more\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n| 3 |\n~~~\ncode\n~~~')
    expect(blocks.map((b) => b.type)).toEqual(['h', 'h', 'p', 'hr', 'quote', 'table', 'code'])
    expect(blocks.slice(0, 2)).toEqual([{ type: 'h', level: 1, text: 'Title' }, { type: 'h', level: 2, text: 'Context' }])
    expect(blocks[4]).toEqual({ type: 'quote', blocks: [{ type: 'p', text: 'Note\nmore' }] })
    expect(blocks[5]).toEqual({ type: 'table', align: ['left', 'right'], head: ['A', 'B'], rows: [['1', '2'], ['3', '']] })
  })

  it('nests indented lists under their item and keeps numbering across a break', () => {
    const blocks = parseBlocks('1. Sean\n- a\n2. Christian\n   - c\n     - d\n3. Teng')
    expect(blocks.map((b) => b.type)).toEqual(['ol', 'ul', 'ol'])
    const christian = blocks[2]
    if (christian.type !== 'ol') throw new Error('expected a list')
    expect(christian.start).toBe(2)
    expect(christian.items.map((i) => i.text)).toEqual(['Christian', 'Teng'])
    expect(christian.items[0].children).toEqual([{ type: 'ul', items: [{ text: 'c', children: [{ type: 'ul', items: [{ text: 'd', children: [] }] }] }] }])
  })

  it('keeps a list going over blank lines and reads task boxes', () => {
    const [list, after] = parseBlocks('- [ ] todo\n\n- [x] done\n  more about it\n\nAfter')
    expect(list).toEqual({ type: 'ul', items: [
      { text: 'todo', checked: false, children: [] },
      { text: 'done', checked: true, children: [{ type: 'p', text: 'more about it' }] }
    ] })
    expect(after).toEqual({ type: 'p', text: 'After' })
  })

  it('shows a folder\'s children only while it is open', () => {
    const tree = [{ path: 'src', dir: true }, { path: 'src/a.ts', dir: false }, { path: 'README.md', dir: false }]
    expect(visibleRows(tree, new Set()).map((r) => r.entry.path)).toEqual(['src', 'README.md'])
    expect(visibleRows(tree, new Set(['src'])).map((r) => r.entry.path)).toEqual(['src', 'src/a.ts', 'README.md'])
  })

  describe('reply actions per turn state (KERNEL-828)', () => {
    const user = tableItems[0]
    const text = (id: string): ChatItem => ({ kind: 'text', id, ts: 1, text: id })
    const step = (id: string, status: 'done' | 'running' | 'failed' = 'done'): ChatItem => ({ kind: 'tool', id, ts: 1, toolUseId: id, name: 'Bash', label: 'Run', detail: 'ls', status, durationMs: 1 })
    const result = (extra: Partial<Extract<ChatItem, { kind: 'result' }>> = {}): ChatItem => ({ kind: 'result', id: 'r', ts: 1, durationMs: 1000, ok: true, ...extra })
    const withActions = (blocks: ReturnType<typeof buildThread>) => blocks.filter((b) => (b.kind === 'item' && b.actions) || (b.kind === 'meta' && b.actions) || b.kind === 'reply').map((b) => (b.kind === 'item' ? b.item.id : b.kind === 'reply' ? b.id : b.id))

    it('offers no actions in a running turn', () => {
      expect(withActions(buildThread([user, text('a'), step('t1'), text('b'), step('t2', 'running')], true))).toEqual([])
    })

    it('gives the actions to the reply when a finished turn ends on text, and to the time line when it ends on a step', () => {
      expect(withActions(buildThread([user, text('a'), step('t1'), text('b'), result()]))).toEqual(['b'])
      const blocks = buildThread([user, text('a'), step('t1'), result({ files: [{ path: 'a.ts', status: 'M', added: 1, removed: 0 }], checkpointId: 'c1' })])
      expect(withActions(blocks)).toEqual(['r'])
      const meta = blocks[blocks.length - 1]
      expect(meta.kind === 'meta' && meta.actions).toEqual({ copy: 'a', files: true, checkpointId: 'c1' })
      const bare = buildThread([user, step('t1'), result()]).at(-1)
      expect(bare?.kind === 'meta' && bare.actions).toEqual({ files: false })
    })

    it('gives a stopped or failed turn the actions on its time line, and a cut-off one none', () => {
      expect(withActions(buildThread([user, text('a'), step('t1'), text('b'), step('t2'), { kind: 'interrupted', id: 'i', ts: 1 }, result({ ok: false })]))).toEqual(['r'])
      expect(withActions(buildThread([user, text('a'), step('t1'), text('b'), step('t2')]))).toEqual([])
      expect(withActions(buildThread([user, text('a'), step('t1', 'failed'), result({ ok: false, error: 'x' })]))).toEqual(['r'])
    })
  })
})

describe('a fold shows its steps while the turn works and folds them when it ends', () => {
  const group = (blocks: ReturnType<typeof buildThread>, n = 0) => {
    const g = blocks.filter((b) => b.kind === 'group')[n]
    if (!g || g.kind !== 'group') throw new Error('expected a group')
    return g
  }
  const ok = (durationMs: number): ChatItem => ({ kind: 'result', id: `rs${++n}`, ts: at + durationMs, durationMs, ok: true })
  const stopped = (afterMs: number): ChatItem => ({ kind: 'interrupted', id: `in${++n}`, ts: at + afterMs })
  const approval: ChatItem = { kind: 'approval', id: 'ap1', ts: at, approvalId: 'a1' }

  it('marks a running turn live and a finished one not, with the turn start for the clock', () => {
    const running = group(buildThread([ask(), read('a'), bash('x', 'running')], true))
    expect(running.turn).toMatchObject({ live: true, timer: true, startedAt: at })
    const finished = group(buildThread([ask(), read('a'), bash('x'), say('Done.'), ok(134_000)], false))
    expect(finished.turn).toMatchObject({ live: false, timer: true, durationMs: 134_000, short: false })
  })

  it('keeps clocks and "Worked for" out of a fold summary, running or done', () => {
    const running = group(buildThread([ask(), read('a'), bash('x', 'running')], true))
    expect(running.summary.text).toMatch(/running/i)
    const finished = group(buildThread([ask(), read('a'), bash('x'), say('Done.'), ok(134_000)], false))
    for (const text of [running.summary.text, finished.summary.text]) expect(text).not.toMatch(/Worked for|Working ·|\d+m \d+s|\d+s\b/)
  })

  it('puts the duration on the first fold only, across stretches split by an approval', () => {
    const blocks = buildThread([ask(), read('a'), bash('x'), approval, bash('y'), bash('z'), say('Done.'), ok(90_000)], false)
    expect(group(blocks, 0).turn.timer).toBe(true)
    expect(group(blocks, 1).turn.timer).toBe(false)
    expect(blocks.map((b) => b.kind)).toEqual(['item', 'group', 'item', 'group', 'reply'])
    // While it runs, only the last fold is working. The one before it, which the approval split off, is done.
    const live = buildThread([ask(), read('a'), bash('x'), approval, bash('y', 'running')], true)
    expect(group(live, 0)).toMatchObject({ turn: { live: false, timer: true } })
    expect(group(live, 0)).not.toHaveProperty('current')
    expect(group(live, 1)).toMatchObject({ turn: { live: true, timer: false }, current: true })
  })

  it('flags a turn under 3 seconds, or of one step, as short', () => {
    expect(group(buildThread([ask(), read('a'), bash('x'), ok(2900)], false)).turn.short).toBe(true)
    expect(group(buildThread([ask(), read('a'), bash('x'), ok(3000)], false)).turn.short).toBe(false)
    expect(group(buildThread([ask(), bash('x'), ok(60_000)], false)).turn.short).toBe(true)
  })

  it('folds a failed turn, a stopped one and a cut-off one', () => {
    const failed: ChatItem = { kind: 'result', id: 'rf', ts: at, durationMs: 5000, ok: false, error: 'Boom' }
    expect(buildThread([ask(), read('a'), bash('x', 'failed'), failed], false).map((b) => b.kind)).toEqual(['item', 'group', 'end', 'meta'])
    const stop = buildThread([ask(), read('a'), bash('x'), stopped(12_000)], false)
    expect(group(stop).turn).toMatchObject({ live: false, durationMs: 12_000 })
    const cut = buildThread([ask(), read('a'), bash('x')], false)
    expect(group(cut).turn).toMatchObject({ live: false })
  })

  it('keeps a recovered failure in the finished fold as a red tail', () => {
    const g = group(buildThread([ask(), read('a'), bash('x', 'failed'), bash('y'), say('Fixed.'), ok(20_000)], false))
    expect(g.summary.bad).toBe('1 failed')
    expect(g.turn.live).toBe(false)
  })

  it('moves the streaming reply from the list to the reply block, never both', () => {
    const reply = say('All done.')
    const running = buildThread([ask(), read('a'), bash('x'), reply], true)
    expect(running.map((b) => b.kind)).toEqual(['item', 'group', 'item'])
    expect(group(running).items).not.toContain(reply)
    expect(running[2]).toMatchObject({ kind: 'item', item: reply })
    const ended = buildThread([ask(), read('a'), bash('x'), reply, ok(30_000)], false)
    expect(ended.map((b) => b.kind)).toEqual(['item', 'group', 'reply'])
    expect(group(ended).items).not.toContain(reply)
    expect(ended.filter((b) => b.kind === 'reply' && b.item === reply)).toHaveLength(1)
  })

  it('leaves a turn waiting on an approval open', () => {
    const waiting = buildThread([ask(), read('a'), bash('x'), approval], true)
    expect(waiting.map((b) => b.kind)).toEqual(['item', 'group', 'item'])
    expect(group(waiting).turn.live).toBe(true)
  })

  it('reads a running hidden tool as Working', () => {
    const hidden: ChatItem = { kind: 'tool', id: `h${++n}`, ts: at, toolUseId: 'h', name: 'TodoWrite', label: '', detail: '', status: 'running' }
    const g = group(buildThread([ask(), hidden], true))
    expect(g.summary.text).toBe('Working')
  })
})

describe('a quieter transcript (KERNEL-1025, KERNEL-1094)', () => {
  const at = (n: number) => 1_700_000_000_000 + n * 1000
  const user = (id: string, n: number): ChatItem => ({ kind: 'user', id, ts: at(n), parts: [{ type: 'text', text: 'Go' }] })
  const bash = (id: string, status: 'done' | 'denied' | 'failed', n: number): ChatItem => ({ kind: 'tool', id, ts: at(n), toolUseId: `tu-${id}`, name: 'Bash', label: 'Run', detail: 'pnpm test', status: status === 'denied' ? 'failed' : status, ...(status === 'denied' ? { output: "The user doesn't want to proceed with this tool use. The tool use was rejected." } : {}), input: { command: 'pnpm test' } })
  const note = (id: string, n: number, pr?: 'merged'): ChatItem => ({ kind: 'note', id, ts: at(n), text: `Note ${id}`, ...(pr ? { pr } : {}) })
  const turn = (id: string, n: number): ChatItem[] => [user(`u-${id}`, n), { kind: 'text', id: `x-${id}`, ts: at(n + 1), text: 'Done.' }, { kind: 'result', id: `r-${id}`, ts: at(n + 2), durationMs: 5000, ok: true }]

  it('says a denied or failed group once, and keeps the tail for mixed results', () => {
    const run = (statuses: ('done' | 'denied' | 'failed')[]) => entriesOf(statuses.map((s, i) => bash(`b${i}`, s, i)))
    const label = (e: ReturnType<typeof entriesOf>[number]) => (e.kind === 'run' ? runLabel(e.run) : undefined)
    expect(label(run(['denied', 'denied'])[0])).toEqual({ text: 'You denied 2 commands', bad: '' })
    expect(label(run(['failed', 'failed'])[0])).toEqual({ text: "Couldn't run 2 commands", bad: '' })
    expect(label(run(['done', 'done', 'done', 'denied', 'denied'])[0])).toEqual({ text: 'Ran 3 of 5 commands', bad: '2 denied' })
    expect(label(run(['failed', 'denied'])[0])).toEqual({ text: "Couldn't run 2 commands", bad: '1 failed, 1 denied' })
    expect(summarize([bash('a', 'denied', 1), bash('b', 'denied', 2)])).toEqual({ text: 'You denied 2 commands', bad: '' })
    expect(summarize([bash('a', 'done', 1), bash('b', 'denied', 2)]).bad).toBe('1 denied')
  })

  it('keeps the tail for a failed category that falls past the three shown phrases', () => {
    const call = (id: string, name: string, n: number, status: 'done' | 'failed' = 'done'): ChatItem => ({ kind: 'tool', id, ts: at(n), toolUseId: `tu-${id}`, name, label: name, detail: '', status, input: {} })
    const s = summarize([call('a', 'Read', 1), call('b', 'Edit', 2), call('c', 'Bash', 3), call('d', 'Write', 4, 'failed')])
    expect(s.text).toBe('Read 1 file, edited 1 file, ran 1 command and 1 more')
    expect(s.bad).toBe('1 failed')
  })

  it('keeps the time line of every turn in view, the last one and the ones before it (KERNEL-1094)', () => {
    const stopped: ChatItem[] = [user('u1', 0), { kind: 'text', id: 'x1', ts: at(1), text: 'Working' }, { kind: 'interrupted', id: 'i1', ts: at(2) }, { kind: 'result', id: 'r1', ts: at(3), durationMs: 3000, ok: false }]
    const metas = buildThread([...stopped, ...turn('2', 10), ...turn('3', 20)]).filter((b) => b.kind === 'meta' || b.kind === 'reply')
    expect(metas).toHaveLength(3)
    for (const b of metas) expect(b).not.toHaveProperty('quiet')
  })

  it('folds two or more grey notes in a row, and never a PR note or an error', () => {
    const kinds = (items: ChatItem[]) => buildThread(items).map((b) => b.kind)
    expect(kinds([note('a', 1)])).toEqual(['item'])
    expect(kinds([note('a', 1), note('b', 2), note('c', 3)])).toEqual(['notes'])
    const folded = buildThread([note('a', 1), note('b', 2), note('c', 3)])[0]
    expect(folded.kind === 'notes' && folded.items.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(kinds([note('a', 1), note('b', 2), note('p', 3, 'merged'), note('c', 4), note('d', 5)])).toEqual(['notes', 'item', 'notes'])
    expect(kinds([note('a', 1), user('u', 2), note('b', 3)])).toEqual(['item', 'item', 'item'])
    const failed: ChatItem[] = [user('u', 1), { kind: 'result', id: 'r', ts: at(2), durationMs: 1, ok: false, error: 'Boom' }]
    expect(kinds([note('a', 1), note('b', 2), ...failed, note('c', 3), note('d', 4)])).toEqual(['notes', 'item', 'end', 'meta', 'notes'])
  })

  it('folds two or more shared files in a row into one block, so their images are laid out together (KERNEL-1096)', () => {
    const shared = (id: string, n: number): ChatItem => ({ kind: 'shared', id, ts: at(n), sharedId: `s-${id}`, version: 1 })
    const kinds = (items: ChatItem[]) => buildThread(items).map((b) => b.kind)
    expect(kinds([shared('a', 1)])).toEqual(['item'])
    expect(kinds([shared('a', 1), shared('b', 2), shared('c', 3)])).toEqual(['shared'])
    const folded = buildThread([shared('a', 1), shared('b', 2)])[0]
    expect(folded.kind === 'shared' && folded.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(kinds([shared('a', 1), note('n', 2), shared('b', 3)])).toEqual(['item', 'item', 'item'])
  })
})
