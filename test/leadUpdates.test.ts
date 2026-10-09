import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef, Chat, PrState, TeamEventKind, TeamUpdate, Workspace } from '../src/shared/types'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { decide, LeadUpdates, type ReviewState, type TeamEvent, type WakeContext } from '../src/main/services/leadUpdates'
import { UPDATE_HEADER } from '../src/main/services/handoff'
import { capText } from '../src/main/services/text'

// KERNEL-72: Kernel tells the Lead what its teammates did, batched, only when the Lead can take it.
// KERNEL-105: each Lead chat hears about the work it handed off, and a closed chat's work goes to the first one.
// KERNEL-117: one block per workspace, in plain words, with the full reply and the card's data.
// KERNEL-121: only what needs the Lead starts a turn; the rest rides along with the next update that does.

const open: LeadUpdates[] = []
afterEach(() => { open.forEach((u) => u.detach()); open.length = 0 })
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const done = { ok: true, interrupted: false, lead: false, queued: false, by: 'lead' as const }
const NAMES: Record<string, string> = { rowan: 'Rowan', noor: 'Noor', kai: 'Kai' }
const REPLY = 'Linked node_modules into the worktree.\n\nTests pass.'

async function setup(o: { leadChat?: boolean; delayMs?: number } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-lu-')), 'k.db'))
  store.saveRoom({ id: 'r', name: 'Kernel', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
  // Teammate workspaces were handed off in the Lead chat "lc" unless a test says otherwise.
  const ws = (id: string, agentId: string, extra: Partial<Workspace> = {}) => store.saveWorkspace({ id, roomId: 'r', name: id, branch: id, baseRef: 'main', path: `/x/${id}`, mode: 'worktree', agentId, port: 1, status: 'ready', prState: 'none', createdAt: 1, ...(agentId === 'rowan' ? {} : { leadChatId: 'lc' }), ...extra } as Workspace)
  const chat = (id: string, workspaceId: string) => store.saveChat({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } as Chat)
  ws('lead', 'rowan', { mode: 'current' })
  ws('w1', 'noor', { title: 'Symlink node_modules' })
  ws('w2', 'kai', { title: 'Inbox actions' })
  chat('lc', 'lead'); chat('lc2', 'lead'); chat('nc', 'w1'); chat('kc', 'w2')
  store.saveItem('nc', { kind: 'text', id: 't1', ts: 1, text: REPLY })
  const s = { enabled: true, hasLead: o.leadChat ?? true, accept: true, busy: new Set<string>(), posts: [] as string[], updates: [] as TeamUpdate[], to: [] as string[], delivered: [] as TeamUpdate[], reviewer: undefined as AgentDef | undefined, review: undefined as ReviewState | undefined }
  const deps: ConstructorParameters<typeof LeadUpdates>[0] = {
    store, enabled: () => s.enabled,
    // Kernel's rule in small: the owner while it's open, else the first Lead chat ("lc"), flagged as closed.
    target: (_r, owner) => {
      if (!s.hasLead) return undefined
      const was = owner ? store.chat(owner) : undefined
      return was && !was.closed ? { chat: was } : { chat: store.chat('lc')!, closed: was }
    },
    isLead: (w) => w.agentId === 'rowan',
    agentName: (_r, a) => NAMES[a],
    post: (chatId, text, update) => { if (!s.accept || s.busy.has(chatId)) return false; s.posts.push(text); s.updates.push(update); s.to.push(chatId); return true },
    delivered: (_r, _c, update) => { s.delivered.push(update) },
    reviewer: () => s.reviewer,
    reviewState: () => s.review,
    delayMs: o.delayMs ?? 20
  }
  const make = () => { const x = new LeadUpdates(deps); x.attach(); open.push(x); return x }
  const u = make()
  /** Kernel quits and opens again on the same database. */
  const restart = () => { u.detach(); return make() }
  const pr = (id: string, state: PrState, number = 54) => {
    store.saveWorkspace({ ...store.workspace(id)!, prState: state, prNumber: number, prTitle: 'feat(workspace): symlink node_modules' })
    bus.push({ type: 'pr', workspaceId: id, state })
  }
  /** Who handed the workspace off. */
  const own = (id: string, leadChatId: string) => store.saveWorkspace({ ...store.workspace(id)!, leadChatId })
  return { store, u, s, pr, own, ws, chat, restart, w1: store.workspace('w1')!, nc: store.chat('nc')!, kc: store.chat('kc')!, lead: store.workspace('lead')!, lc: store.chat('lc')! }
}

const NOOR = 'Noor (noor) · Symlink node_modules · workspace w1'
const KAI = 'Kai (kai) · Inbox actions · workspace w2'
const OPENED_54 = '- Opened PR #54 "feat(workspace): symlink node_modules".'
const OPENED_60 = '- Opened PR #60 "feat(workspace): symlink node_modules".'
const QUOTED = ["- Noor's last reply:", '  > Linked node_modules into the worktree.', '  >', '  > Tests pass.']
const READY = (pr: string) => `- ${pr} passed checks and has no conflicts. No reviewer is on this team, so tell the user it is ready for them to review and merge.`
const READ = (name: string, id: string) => `- Read ${name}'s reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed (workspace ${id}).`
const ALL_MERGED = '- Every task you handed off in this chat has merged. Tell the user in one line.'
const THEO: AgentDef = { id: 'theo', name: 'Theo', role: 'Reviewer', description: 'Reviews PRs', lead: false, prompt: '', file: '.claude/agents/theo.md' }

/** The lines of a message, split into its blocks and its To do list. */
const parts = (post: string) => {
  const lines = post.split('\n')
  const at = lines.indexOf('To do:')
  return { header: lines[0], body: lines.slice(2, at < 0 ? undefined : at - 1), todo: at < 0 ? [] : lines.slice(at + 1) }
}

describe('teammate updates to the Lead', () => {
  it('sends one block per workspace for a PR opening, passing checks and a finished turn, with the reply, the card and what to do', async () => {
    const { u, s, pr, w1, nc } = await setup()
    pr('w1', 'checks')
    pr('w1', 'ready')
    u.turnDone(w1, nc, done)
    expect(s.posts).toEqual([])
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0].split('\n')).toEqual([
      UPDATE_HEADER,
      '',
      NOOR,
      OPENED_54,
      '- PR #54 passed checks and has no conflicts.',
      // The reply says the turn ended, so there is no "Finished a turn." line above it.
      ...QUOTED,
      '',
      'To do:',
      READY('PR #54'),
      READ('Noor', 'w1')
    ])
    expect(s.updates[0]).toEqual({
      rows: [{
        workspaceId: 'w1', agentId: 'noor', name: 'Noor', task: 'Symlink node_modules', prNumber: 54, reply: REPLY,
        events: [
          { kind: 'pr.opened', text: 'Opened PR #54', actionable: false },
          { kind: 'pr.ready', text: 'Passed checks, no conflicts', actionable: true },
          { kind: 'turn', text: 'Finished a turn', actionable: true }
        ]
      }]
    })
    expect(s.delivered).toEqual(s.updates)
  })

  it('says each PR state in plain words, with what to do about it', async () => {
    const { store, s, pr } = await setup()
    pr('w1', 'checks')
    await wait()
    // An opening alone doesn't need the Lead. It rides along with the next update that does.
    expect(s.posts).toEqual([])
    const said: [PrState, string, string][] = [
      ['cifail', '- Checks failed on PR #54.', '- Tell Noor about the failed checks on PR #54 with message_agent (workspace w1).'],
      ['changes', '- Changes were requested on PR #54.', '- Tell Noor about the changes requested on PR #54 with message_agent (workspace w1).'],
      ['conflict', '- PR #54 has conflicts with its base branch.', '- Ask Noor to resolve the conflicts on PR #54 with message_agent (workspace w1).'],
      ['ready', '- PR #54 passed checks and has no conflicts.', READY('PR #54')]
    ]
    for (const [i, [state, line, todo]] of said.entries()) {
      pr('w1', state)
      await wait()
      expect(parts(s.posts.pop()!)).toEqual({ header: UPDATE_HEADER, body: i ? [NOOR, line] : [NOOR, OPENED_54, line], todo: [todo] })
    }
    store.saveWorkspace({ ...store.workspace('w2')!, leadChatId: 'other' })
    pr('w1', 'merged')
    await wait()
    expect(parts(s.posts.pop()!)).toEqual({ header: UPDATE_HEADER, body: [NOOR, '- PR #54 was merged.'], todo: [ALL_MERGED] })
    store.saveWorkspace({ ...store.workspace('w2')!, leadChatId: 'lc' })
    pr('w2', 'open', 60)
    pr('w2', 'closed', 60)
    await wait()
    expect(parts(s.posts.pop()!)).toEqual({ header: UPDATE_HEADER, body: [KAI, OPENED_60, '- PR #60 was closed without merging.'], todo: ["- PR #60 was closed without merging. Ask the user whether Kai's work is still wanted."] })
  })

  it("leaves out a PR state the PR has left by the time the update goes out, and sends nothing when that's all there was", async () => {
    const { s, pr, own } = await setup()
    own('w2', 'lc2')
    pr('w1', 'checks')
    await wait()
    // Checks failed, then a fix started them again: the failure is old news.
    pr('w1', 'cifail')
    pr('w1', 'checks')
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'cifail')
    pr('w1', 'changes')
    pr('w1', 'merged')
    await wait()
    expect(parts(s.posts.pop()!)).toEqual({ header: UPDATE_HEADER, body: [NOOR, OPENED_54, '- PR #54 was merged.'], todo: [ALL_MERGED] })
  })

  it('keeps only the last turn of a workspace, with its reply', async () => {
    const { store, u, s, w1, nc } = await setup()
    u.turnDone(w1, nc, done)
    store.saveItem('nc', { kind: 'text', id: 't2', ts: 2, text: 'Should the link be relative?' })
    u.turnDone(w1, nc, done)
    await wait()
    expect(parts(s.posts[0])).toEqual({ header: UPDATE_HEADER, body: [NOOR, "- Noor's last reply:", '  > Should the link be relative?'], todo: [READ('Noor', 'w1')] })
  })

  it('holds updates while the Lead is busy and sends them when its turn ends, losing none', async () => {
    const { u, s, pr, w1, nc, lead, lc } = await setup()
    s.accept = false
    pr('w1', 'checks')
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'ready')
    await wait()
    s.accept = true
    u.turnDone(lead, lc, { ...done, lead: true })
    expect(s.posts).toHaveLength(1)
    // The turn ended while checks ran, so passing them speaks for it.
    expect(parts(s.posts[0])).toEqual({ header: UPDATE_HEADER, body: [NOOR, OPENED_54, '- PR #54 passed checks and has no conflicts.', ...QUOTED], todo: [READY('PR #54')] })
  })

  it('sends held updates on the next poll too, for a Lead that was paused', async () => {
    const { u, s, pr } = await setup()
    s.accept = false
    pr('w1', 'ready')
    await wait()
    s.accept = true
    u.flushAll()
    expect(s.posts).toHaveLength(1)
  })

  it("drops updates when the room's Lead was never briefed, and never starts a Lead chat", async () => {
    const { u, s, pr } = await setup({ leadChat: false })
    pr('w1', 'ready')
    await wait()
    s.hasLead = true
    u.flushAll()
    expect(s.posts).toEqual([])
  })

  it("never reports the Lead's own turns or PRs, and skips interrupted and queued turns", async () => {
    const { u, s, pr, w1, nc, lead, lc } = await setup()
    pr('lead', 'ready')
    u.turnDone(lead, lc, { ...done, lead: true })
    u.turnDone(w1, nc, { ...done, interrupted: true })
    u.turnDone(w1, nc, { ...done, queued: true })
    await wait()
    expect(s.posts).toEqual([])
    u.turnDone(w1, nc, { ...done, ok: false })
    await wait()
    expect(parts(s.posts[0])).toEqual({ header: UPDATE_HEADER, body: [NOOR, '- Stopped with an error. Open the workspace to see it.'], todo: ['- Noor stopped with an error. Ask Noor what happened with message_agent (workspace w1), or tell the user.'] })
  })

  it('sends nothing with the setting off', async () => {
    const { u, s, pr, w1, nc } = await setup()
    s.enabled = false
    pr('w1', 'ready')
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toEqual([])
  })

  it('carries at most 8 workspaces, the newest, and says how many it left out', async () => {
    const { store, u, s, ws, chat } = await setup()
    for (let i = 1; i <= 10; i++) {
      const w = ws(`x${i}`, 'kai', { title: `Task ${i}` })
      chat(`xc${i}`, w.id)
      u.turnDone(w, store.chat(`xc${i}`)!, done)
    }
    await wait()
    const lines = s.posts[0].split('\n')
    expect(lines.filter((l) => l.startsWith('Kai (kai) · '))).toEqual([3, 4, 5, 6, 7, 8, 9, 10].map((i) => `Kai (kai) · Task ${i} · workspace x${i}`))
    expect(lines).toContain('Kernel left out updates on 2 more workspaces. Call list_workspaces to see where they stand.')
    expect(s.updates[0].omitted).toBe(2)
    expect(s.updates[0].rows).toHaveLength(8)
    expect(parts(s.posts[0]).todo).toHaveLength(8)
  })

  it('cuts a long reply near 1,500 characters and never in the middle of a link', async () => {
    const { store, u, s, w1, nc } = await setup()
    const link = 'https://github.com/cjjutba/kernel/pull/108#issuecomment-6071731'
    store.saveItem('nc', { kind: 'text', id: 't2', ts: 2, text: `${'word '.repeat(298)}${link} and more` })
    u.turnDone(w1, nc, done)
    await wait()
    const [noor] = s.updates[0].rows
    expect(noor.reply!.endsWith('…')).toBe(true)
    expect(noor.reply).not.toContain('https://')
    expect(noor.reply!.length).toBeLessThanOrEqual(1501)
  })

  it("shares 6,000 characters between one message's replies", async () => {
    const { store, u, s, ws, chat } = await setup()
    for (let i = 1; i <= 5; i++) {
      const w = ws(`y${i}`, 'kai', { title: `Reply ${i}` })
      chat(`yc${i}`, w.id)
      store.saveItem(`yc${i}`, { kind: 'text', id: `y${i}`, ts: 2, text: 'word '.repeat(800) })
      u.turnDone(w, store.chat(`yc${i}`)!, done)
    }
    await wait()
    const lengths = s.updates[0].rows.map((r) => r.reply!.length)
    expect(lengths).toHaveLength(5)
    for (const n of lengths) { expect(n).toBeLessThanOrEqual(1201); expect(n).toBeGreaterThan(1100) }
  })

  it('waits again when the PR moves on before the update goes out', async () => {
    const { u, s, pr, w1, nc } = await setup({ delayMs: 200 })
    pr('w1', 'checks')
    await wait(260)
    u.turnDone(w1, nc, { ...done, ok: false })
    await wait(120)
    // The PR moves 120ms into the 200ms wait, so the update waits another 200ms from here.
    pr('w1', 'resolving')
    await wait(140)
    expect(s.posts).toEqual([])
    await wait(160)
    expect(s.posts).toHaveLength(1)
  })
})

describe('what wakes the Lead (KERNEL-121)', () => {
  it('asks for a review of a PR that passed checks when the team has a reviewer, unless one runs or approved it', async () => {
    const { s, pr } = await setup()
    s.reviewer = THEO
    pr('w1', 'ready')
    await wait()
    expect(parts(s.posts.pop()!).todo).toEqual(['- PR #54 needs a review. Theo (theo) reviews on this team: hand it over with create_workspace (agent "theo"), unless a review of it is already running.'])
    s.review = { approvedBy: [], blockers: false, inProgress: true }
    pr('w1', 'checks'); pr('w1', 'ready')
    await wait()
    expect(s.posts).toEqual([])
    s.review = { approvedBy: [], blockers: true, inProgress: false }
    pr('w1', 'checks'); pr('w1', 'ready')
    await wait()
    expect(s.posts).toEqual([])
    s.review = { approvedBy: ['Theo'], blockers: false, inProgress: false }
    pr('w1', 'checks'); pr('w1', 'ready')
    await wait()
    expect(parts(s.posts.pop()!).todo).toEqual(['- PR #54 passed checks, has no conflicts and Theo approved it. Tell the user it is ready to merge.'])
  })

  it('tells the Lead when the last task of its chat merges, and only then', async () => {
    const { s, pr } = await setup()
    pr('w1', 'merged')
    await wait()
    expect(s.posts).toEqual([])
    pr('w2', 'merged', 60)
    await wait()
    const last = parts(s.posts.pop()!)
    expect(last.body).toEqual([NOOR, '- PR #54 was merged.', '', KAI, '- PR #60 was merged.'])
    expect(last.todo).toEqual([ALL_MERGED])
    expect(s.updates.at(-1)?.allMerged).toBe(true)
  })

  it('leaves out review workspaces and archived unmerged work when it checks for the last merge', async () => {
    const { s, pr, ws } = await setup()
    ws('rv', 'kai', { title: 'Review PR #54', reviewOf: 'w1' })
    ws('gone', 'kai', { title: 'Dropped', status: 'archived' })
    ws('w2', 'kai', { title: 'Inbox actions', leadChatId: 'elsewhere' })
    pr('w1', 'merged')
    await wait()
    expect(parts(s.posts.pop()!).todo).toEqual([ALL_MERGED])
  })

  it("doesn't wake the Lead for a PR that was closed and opened again", async () => {
    const { s, pr } = await setup()
    pr('w1', 'closed')
    pr('w1', 'open')
    await wait()
    expect(s.posts).toEqual([])
  })

  it('wakes the Lead for a turn it or Kernel started, not for one the user started, nor one whose PR is being checked', async () => {
    const { store, u, s, pr, w1, nc } = await setup()
    u.turnDone(w1, nc, { ...done, by: 'user' })
    await wait()
    expect(s.posts).toEqual([])
    u.turnDone(w1, nc, { ...done, by: 'kernel' })
    await wait()
    expect(parts(s.posts.pop()!).todo).toEqual([READ('Noor', 'w1')])
    pr('w1', 'checks')
    u.turnDone(store.workspace('w1')!, nc, done)
    await wait()
    expect(s.posts).toEqual([])
  })

  it("doesn't wake the Lead for work no Lead chat handed off, which rides along with the next update that does", async () => {
    const { store, s, pr } = await setup()
    store.saveWorkspace({ ...store.workspace('w2')!, leadChatId: undefined })
    pr('w2', 'cifail', 60)
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'cifail')
    await wait()
    const sent = parts(s.posts.pop()!)
    expect(sent.body).toEqual([KAI, OPENED_60, '- Checks failed on PR #60.', '', NOOR, OPENED_54, '- Checks failed on PR #54.'])
    expect(sent.todo).toEqual(['- Tell Noor about the failed checks on PR #54 with message_agent (workspace w1).'])
    expect(s.updates.at(-1)?.rows.map((r) => r.events.map((e) => e.actionable))).toEqual([[false, false], [false, true]])
  })
})

describe('what wakes the Lead, rule by rule (KERNEL-121)', () => {
  const ws = (prState: PrState): Workspace => ({ id: 'w1', roomId: 'r', name: 'w1', branch: 'b', baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'noor', port: 1, status: 'ready', prState, createdAt: 1, leadChatId: 'lc' })
  const ev = (kind: TeamEventKind, extra: Partial<TeamEvent> = {}): TeamEvent => ({ n: 1, workspaceId: 'w1', kind, pr: 54, ...extra })
  const at = '(workspace w1)'
  const NEEDS_REVIEW = 'PR #54 needs a review. Theo (theo) reviews on this team: hand it over with create_workspace (agent "theo"), unless a review of it is already running.'
  const rows: [string, TeamEvent[], PrState, Partial<WakeContext>, string[]][] = [
    ['an error in a turn Rowan started', [ev('error', { by: 'lead' })], 'none', {}, [`Noor stopped with an error. Ask Noor what happened with message_agent ${at}, or tell the user.`]],
    ['an error in a turn the user started', [ev('error', { by: 'user' })], 'none', {}, []],
    ['a crashed session', [ev('crash')], 'none', {}, ["Noor's session ended. Tell the user they can restart it from the workspace."]],
    ['a failed setup', [ev('setup.failed')], 'none', {}, ["Setup failed in Noor's workspace. Tell the user to fix it and click Run again there."]],
    ['a failed setup create_workspace already reported', [ev('setup.failed', { told: true })], 'none', {}, []],
    ['a setup that passed on retry', [ev('setup.passed')], 'none', {}, []],
    ['a review verdict', [ev('review')], 'none', {}, ["Read Noor's review and pass on what it found."]],
    ['failed checks', [ev('pr.cifail')], 'cifail', {}, [`Tell Noor about the failed checks on PR #54 with message_agent ${at}.`]],
    ['requested changes', [ev('pr.changes')], 'changes', {}, [`Tell Noor about the changes requested on PR #54 with message_agent ${at}.`]],
    ['conflicts', [ev('pr.conflict')], 'conflict', {}, [`Ask Noor to resolve the conflicts on PR #54 with message_agent ${at}.`]],
    ['a PR closed without merging', [ev('pr.closed')], 'closed', {}, ["PR #54 was closed without merging. Ask the user whether Noor's work is still wanted."]],
    ['a PR closed and opened again', [ev('pr.closed')], 'open', {}, []],
    ['a merge that leaves other tasks open', [ev('pr.merged')], 'merged', { allMerged: () => false }, []],
    ["the chat's last merge", [ev('pr.merged')], 'merged', { allMerged: () => true }, ['Every task you handed off in this chat has merged. Tell the user in one line.']],
    ['a PR opening', [ev('pr.opened')], 'checks', {}, []],
    ['a PR that passed checks, with a reviewer and no review', [ev('pr.ready')], 'ready', { reviewer: THEO }, [NEEDS_REVIEW]],
    ['a PR that passed checks while its review runs', [ev('pr.ready')], 'ready', { reviewer: THEO, review: { approvedBy: [], blockers: false, inProgress: true } }, []],
    ['a PR that passed checks with blockers found on it', [ev('pr.ready')], 'ready', { reviewer: THEO, review: { approvedBy: [], blockers: true, inProgress: false } }, []],
    ['a PR that passed checks and was approved', [ev('pr.ready')], 'ready', { reviewer: THEO, review: { approvedBy: ['Theo'], blockers: false, inProgress: false } }, ['PR #54 passed checks, has no conflicts and Theo approved it. Tell the user it is ready to merge.']],
    ['a PR that passed checks on a team with no reviewer', [ev('pr.ready')], 'ready', {}, ['PR #54 passed checks and has no conflicts. No reviewer is on this team, so tell the user it is ready for them to review and merge.']],
    ['a turn Rowan started, with no PR', [ev('turn', { by: 'lead', pr: undefined })], 'none', {}, [`Read Noor's reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`]],
    ['a turn Kernel started', [ev('turn', { by: 'kernel' })], 'ready', {}, [`Read Noor's reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`]],
    ['a turn the user started', [ev('turn', { by: 'user' })], 'none', {}, []],
    ['a turn while the PR is being created', [ev('turn', { by: 'lead' })], 'creating', {}, []],
    ['a turn while checks run', [ev('turn', { by: 'lead' })], 'checks', {}, []],
    ['a turn a newer PR event follows', [ev('turn', { by: 'lead' }), ev('pr.ready', { n: 2 })], 'ready', {}, ['PR #54 passed checks and has no conflicts. No reviewer is on this team, so tell the user it is ready for them to review and merge.']],
    ['a turn after an older PR event', [ev('pr.opened', { n: 0 }), ev('turn', { by: 'lead' })], 'ready', {}, [`Read Noor's reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`]]
  ]
  it.each(rows)('%s', (_label, events, prState, c, todo) => {
    const out = decide({ ws: ws(prState), name: 'Noor', events }, { allMerged: () => false, ...c })
    expect(out.todo).toEqual(todo)
    expect(out.wake.size).toBe(todo.length)
  })

  it("names the closed chat whose last task merged", () => {
    const out = decide({ ws: ws('merged'), name: 'Noor', events: [ev('pr.merged')], fromChat: 'Chat icons sizing' }, { allMerged: () => true })
    expect(out.todo).toEqual(['Every task handed off in the closed Lead chat "Chat icons sizing" has merged. Tell the user in one line.'])
  })
})

describe('waiting updates (KERNEL-121)', () => {
  it('keeps a block that needs the Lead over newer ones that do not, when it has to leave some out', async () => {
    const { store, u, s, pr, ws, chat } = await setup()
    pr('w1', 'cifail')
    for (let i = 1; i <= 8; i++) { const w = ws(`q${i}`, 'kai', { title: `Quiet ${i}` }); chat(`qc${i}`, w.id); u.turnDone(w, store.chat(`qc${i}`)!, { ...done, by: 'user' }) }
    await wait()
    const tasks = s.posts[0].split('\n').filter((l) => / · workspace /.test(l)).map((l) => l.split(' · ')[1])
    expect(tasks).toEqual(['Symlink node_modules', 'Quiet 2', 'Quiet 3', 'Quiet 4', 'Quiet 5', 'Quiet 6', 'Quiet 7', 'Quiet 8'])
    expect(s.updates[0].omitted).toBe(1)
  })

  it('keeps only what could still be sent while it waits, however long that is', async () => {
    const { store, u, w1, nc } = await setup()
    store.saveWorkspace({ ...w1, leadChatId: undefined })
    for (let i = 0; i < 50; i++) u.turnDone(store.workspace('w1')!, nc, { ...done, by: 'user' })
    await wait()
    const pending = [...(u as unknown as { pending: Map<string, { events: TeamEvent[] }> }).pending.values()].flatMap((p) => p.events)
    expect(pending.map((e) => e.kind)).toEqual(['turn'])
  })

  it('wakes the Lead for a turn once a PR it was creating comes to nothing', async () => {
    const { store, u, s, nc } = await setup()
    store.saveWorkspace({ ...store.workspace('w1')!, prState: 'creating' })
    u.turnDone(store.workspace('w1')!, nc, done)
    await wait()
    expect(s.posts).toEqual([])
    store.saveWorkspace({ ...store.workspace('w1')!, prState: 'none', prNumber: undefined })
    bus.push({ type: 'pr', workspaceId: 'w1', state: 'none' })
    await wait()
    expect(parts(s.posts.pop()!).todo).toEqual([READ('Noor', 'w1')])
  })
})

describe("a teammate's session that dies (KERNEL-124)", () => {
  it('tells the Lead, with what Claude Code said, and leaves out the Lead\'s own sessions', async () => {
    const { u, s, w1, lead } = await setup()
    u.crashed(lead, 'gone')
    u.crashed(w1, 'Claude Code process exited with code 1. stderr: stack trace here')
    await wait()
    expect(parts(s.posts.pop()!)).toEqual({
      header: UPDATE_HEADER,
      body: [NOOR, "- Noor's session ended unexpectedly (Claude Code process exited with code 1), partway through a turn. The worktree and chat are saved; the user can restart it from the workspace."],
      todo: ["- Noor's session ended. Tell the user they can restart it from the workspace."]
    })
    expect(s.updates.at(-1)?.rows[0].events).toEqual([{ kind: 'crash', text: 'Session ended unexpectedly', actionable: true }])
    expect(s.posts).toEqual([])
  })
})

describe("a teammate's setup (KERNEL-126)", () => {
  it('wakes the Lead for a failure nothing told it about, with the exit code, and lets the rest ride along', async () => {
    const { u, s, w1 } = await setup()
    u.setup(w1, false, { code: 1, told: true })
    await wait()
    expect(s.posts).toEqual([])
    u.setup(w1, false, { code: 2 })
    await wait()
    expect(parts(s.posts.pop()!)).toEqual({
      header: UPDATE_HEADER,
      body: [NOOR, "- Setup failed with exit code 2, so Noor hasn't started. The brief waits until the user fixes setup and clicks Run again in that workspace."],
      todo: ["- Setup failed in Noor's workspace. Tell the user to fix it and click Run again there."]
    })
    u.setup(w1, true)
    await wait()
    expect(s.posts).toEqual([])
  })
})

describe('Stop on the Lead (KERNEL-122)', () => {
  it("holds a stopped Lead chat's updates through the wait and the poll, until its next turn ends normally", async () => {
    const { u, s, pr, lead, lc } = await setup()
    s.accept = false
    pr('w1', 'cifail')
    await wait()
    s.accept = true
    // The user stops Rowan: no Kernel turn may follow.
    u.turnDone(lead, lc, { ...done, lead: true, interrupted: true })
    expect(s.posts).toEqual([])
    pr('w1', 'conflict')
    await wait()
    u.flushAll()
    expect(s.posts).toEqual([])
    // The user's next message ends normally, and the held update goes out.
    u.turnDone(lead, lc, { ...done, lead: true, by: 'user' })
    expect(parts(s.posts.pop()!).todo).toEqual(['- Ask Noor to resolve the conflicts on PR #54 with message_agent (workspace w1).'])
  })

  it("doesn't hold another Lead chat's updates", async () => {
    const { store, u, s, pr, own, lead } = await setup()
    own('w2', 'lc2')
    u.turnDone(lead, store.chat('lc')!, { ...done, lead: true, interrupted: true })
    pr('w1', 'cifail')
    pr('w2', 'cifail', 60)
    await wait()
    expect(s.to).toEqual(['lc2'])
  })
})

describe('waiting updates across a restart (KERNEL-123)', () => {
  it('delivers what waited before Kernel quit, and opening Kernel sends nothing by itself', async () => {
    const { u, s, pr, w1, nc, lead, lc, restart } = await setup()
    s.accept = false
    pr('w1', 'cifail')
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toEqual([])
    const again = restart()
    s.accept = true
    await wait()
    expect(s.posts).toEqual([])
    again.turnDone(lead, lc, { ...done, lead: true, by: 'user' })
    expect(parts(s.posts.pop()!).todo).toEqual(['- Tell Noor about the failed checks on PR #54 with message_agent (workspace w1).', READ('Noor', 'w1')])
  })

  it("drops what waited for a workspace that is gone, and keeps a stopped chat's mark", async () => {
    const { store, u, s, w1, nc, lead, lc, restart } = await setup()
    s.accept = false
    u.turnDone(w1, nc, done)
    u.turnDone(lead, lc, { ...done, lead: true, interrupted: true })
    await wait()
    // An event for a workspace that no longer exists, as after its room was removed.
    const saved = store.meta<{ pending: [string, { events: TeamEvent[] }][] }>('leadUpdates')!
    saved.pending[0][1].events.push({ n: 999, workspaceId: 'ghost', kind: 'error', by: 'lead' })
    store.saveMeta('leadUpdates', saved)
    const again = restart()
    // Loading drops the event for the missing workspace and saves what is left.
    expect(store.meta<{ pending: [string, { events: TeamEvent[] }][] }>('leadUpdates')!.pending[0][1].events.map((e) => e.workspaceId)).toEqual(['w1'])
    s.accept = true
    again.flushAll()
    // Still stopped: the user hasn't sent anything since.
    expect(s.posts).toEqual([])
    again.turnDone(lead, lc, { ...done, lead: true, by: 'user' })
    expect(parts(s.posts.pop()!).body).toEqual([NOOR, ...QUOTED])
    expect(store.meta<{ pending: unknown[] }>('leadUpdates')!.pending).toEqual([])
  })

  it("keeps counting after a restart, and drops the Lead's own work and a closed chat's stop mark", async () => {
    const { store, u, s, w1, nc, lead, restart } = await setup()
    s.accept = false
    u.turnDone(w1, nc, done)
    u.turnDone(lead, store.chat('lc2')!, { ...done, lead: true, interrupted: true })
    await wait()
    const saved = store.meta<{ seq: number; pending: [string, { events: TeamEvent[] }][]; stopped: string[] }>('leadUpdates')!
    expect(saved.stopped).toEqual(['lc2'])
    saved.pending[0][1].events.push({ n: 998, workspaceId: 'lead', kind: 'turn', by: 'lead' })
    store.saveMeta('leadUpdates', saved)
    store.saveChat({ ...store.chat('lc2')!, closed: true })
    restart()
    const loaded = store.meta<typeof saved>('leadUpdates')!
    expect(loaded.pending[0][1].events.map((e) => e.workspaceId)).toEqual(['w1'])
    expect(loaded.stopped).toEqual([])
    expect(loaded.seq).toBeGreaterThanOrEqual(saved.seq)
  })

  it('starts empty when the saved value is unreadable', async () => {
    const { store, restart } = await setup()
    store.saveMeta('leadUpdates', { v: 1, seq: 3, pending: [['lc', { roomId: 'r', events: null }]], stopped: null })
    expect(() => restart()).not.toThrow()
  })
})

describe('capText', () => {
  it('leaves a short text alone, keeping its paragraphs', () => {
    expect(capText('  One.\n\n\n\nTwo.  ', 50)).toBe('One.\n\nTwo.')
  })

  it('cuts between words and marks the cut', () => {
    expect(capText('alpha beta gamma delta', 13)).toBe('alpha beta…')
    expect(capText('alpha beta gamma delta', 10)).toBe('alpha beta…')
  })

  it('backs up to before a link the cut falls in, and keeps a first link longer than the limit whole', () => {
    const link = 'https://github.com/cjjutba/kernel/pull/108#issuecomment-6071731'
    expect(capText(`Posted it: ${link} done`, 30)).toBe('Posted it:…')
    expect(capText(`${link} done`, 20)).toBe(`${link}…`)
    expect(capText(link, 20)).toBe(link)
  })

  it('cuts a first word longer than any link where it stands, and reads Windows line ends', () => {
    expect(capText('x'.repeat(5000), 100)).toBe(`${'x'.repeat(2048)}…`)
    expect(capText('One.  \r\n\r\n\r\nTwo.', 50)).toBe('One.\n\nTwo.')
  })
})

describe('teammate updates with several Lead chats (KERNEL-105)', () => {
  it('sends each Lead chat only the updates about the work it handed off', async () => {
    const { s, pr, own } = await setup()
    own('w1', 'lc'); own('w2', 'lc2')
    pr('w1', 'ready')
    pr('w2', 'conflict', 60)
    await wait()
    expect(s.to.sort()).toEqual(['lc', 'lc2'])
    const of = (chatId: string) => parts(s.posts[s.to.indexOf(chatId)])
    expect(of('lc')).toEqual({ header: UPDATE_HEADER, body: [NOOR, OPENED_54, '- PR #54 passed checks and has no conflicts.'], todo: [READY('PR #54')] })
    expect(of('lc2')).toEqual({ header: UPDATE_HEADER, body: [KAI, OPENED_60, '- PR #60 has conflicts with its base branch.'], todo: ['- Ask Kai to resolve the conflicts on PR #60 with message_agent (workspace w2).'] })
    expect(s.delivered).toHaveLength(2)
  })

  it("holds a busy chat's updates without holding up another chat's", async () => {
    const { u, s, pr, own, lead, lc } = await setup()
    own('w1', 'lc'); own('w2', 'lc2')
    s.busy.add('lc')
    pr('w1', 'ready')
    pr('w2', 'ready', 60)
    await wait()
    expect(s.to).toEqual(['lc2'])
    s.busy.delete('lc')
    u.turnDone(lead, lc, { ...done, lead: true })
    expect(s.to).toEqual(['lc2', 'lc'])
    expect(s.posts[1]).toContain('- PR #54 passed checks and has no conflicts.')
    expect(s.posts[1]).not.toContain('PR #60')
  })

  it("sends a closed chat's updates to the first Lead chat in the same message, under the closed chat's name", async () => {
    const { store, s, pr, own } = await setup()
    own('w2', 'lc2')
    store.saveChat({ ...store.chat('lc2')!, title: 'Chat icons sizing', closed: true })
    pr('w1', 'ready')
    pr('w2', 'conflict', 60)
    await wait()
    expect(s.to).toEqual(['lc'])
    expect(s.posts[0].split('\n')).toEqual([
      UPDATE_HEADER,
      '',
      NOOR,
      OPENED_54,
      '- PR #54 passed checks and has no conflicts.',
      '',
      'From "Chat icons sizing", a Lead chat that is now closed. This work is yours now.',
      '',
      KAI,
      OPENED_60,
      '- PR #60 has conflicts with its base branch.',
      '',
      'To do:',
      READY('PR #54'),
      '- Ask Kai to resolve the conflicts on PR #60 with message_agent (workspace w2).'
    ])
    expect(s.updates[0].rows.map((r) => r.fromChat)).toEqual([undefined, 'Chat icons sizing'])
    expect(s.delivered).toHaveLength(1)
  })

  it("keeps each closed chat's work under its own name, and the card in the same order as the text", async () => {
    const { store, u, s, own, ws, chat } = await setup()
    store.saveChat({ ...store.chat('lc2')!, title: 'Chat icons sizing', closed: true })
    chat('lc3', 'lead')
    store.saveChat({ ...store.chat('lc3')!, title: 'Composer unit tests', closed: true })
    const turn = (id: string, owner: string, title: string) => { ws(id, 'kai', { title }); own(id, owner); chat(`${id}c`, id); u.turnDone(store.workspace(id)!, store.chat(`${id}c`)!, done) }
    turn('i1', 'lc2', 'Icons 1')
    turn('c1', 'lc3', 'Composer 1')
    turn('i2', 'lc2', 'Icons 2')
    await wait()
    const tasks = s.posts[0].split('\n').filter((l) => / · workspace /.test(l)).map((l) => l.split(' · ')[1])
    expect(tasks).toEqual(['Icons 1', 'Icons 2', 'Composer 1'])
    expect(s.updates[0].rows.map((r) => r.task)).toEqual(tasks)
    expect(s.updates[0].rows.map((r) => r.fromChat)).toEqual(['Chat icons sizing', 'Chat icons sizing', 'Composer unit tests'])
  })

  it('keeps the newest 8 workspaces across chats in one message', async () => {
    const { store, u, s, own, ws, chat } = await setup()
    store.saveChat({ ...store.chat('lc2')!, title: 'Composer unit tests', closed: true })
    for (let i = 1; i <= 6; i++) { const w = ws(`a${i}`, 'kai', { title: `Own ${i}` }); chat(`ac${i}`, w.id); u.turnDone(w, store.chat(`ac${i}`)!, done) }
    for (let i = 1; i <= 4; i++) { const w = ws(`b${i}`, 'noor', { title: `Closed ${i}`, leadChatId: 'lc2' }); chat(`bc${i}`, w.id); own(w.id, 'lc2'); u.turnDone(store.workspace(w.id)!, store.chat(`bc${i}`)!, done) }
    await wait()
    const lines = s.posts[0].split('\n')
    expect(lines.filter((l) => / · workspace /.test(l)).map((l) => l.split(' · ')[1])).toEqual(['Own 3', 'Own 4', 'Own 5', 'Own 6', 'Closed 1', 'Closed 2', 'Closed 3', 'Closed 4'])
    expect(lines).toContain('From "Composer unit tests", a Lead chat that is now closed. This work is yours now.')
    expect(lines).toContain('Kernel left out updates on 2 more workspaces. Call list_workspaces to see where they stand.')
  })
})
