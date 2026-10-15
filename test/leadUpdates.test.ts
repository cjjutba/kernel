import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '../src/shared/ipc'
import type { AgentDef, Chat, PrState, ReviewVerdict, SharedFile, SharedVersion, TeamEventKind, TeamUpdate, Workspace } from '../src/shared/types'
import { Store } from '../src/main/db'
import { bus } from '../src/main/bus'
import { collapse, decide, LeadUpdates, NO_AUTO_REVIEW, type LimitNews, type ReviewState, type TeamEvent, type WakeContext } from '../src/main/services/leadUpdates'
import { resetPhrase } from '../src/shared/usage'
import { UPDATE_HEADER } from '../src/main/services/handoff'
import { capText } from '../src/main/services/text'
import { Sessions } from '../src/main/services/sessions'
import { Approvals } from '../src/main/services/approvals'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import { Log } from '../src/main/services/log'
import { leadUpdateDeps, listen } from '../src/main/features/wiring'
import type { Kernel } from '../src/main/kernel'

// A chat with Kernel's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// KERNEL-72: Kernel tells the Lead what its teammates did, batched, only when the Lead can take it.
// KERNEL-105: each Lead chat hears about the work it handed off, and a closed chat's work goes to the first one.
// KERNEL-117: one block per workspace, in plain words, with the full reply and the card's data.
// KERNEL-121: only what needs the Lead starts a turn; the rest rides along with the next update that does.

const open: LeadUpdates[] = []
afterEach(() => { open.forEach((u) => u.detach()); open.length = 0 })
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const done = { ok: true, interrupted: false, lead: false, queued: false, by: 'lead' as const }
const NAMES: Record<string, string> = { kernel: 'Kernel', noor: 'Noor', kai: 'Kai' }
const REPLY = 'Linked node_modules into the worktree.\n\nTests pass.'

/** `defaults`: Kernel's own delays, two seconds after the newest event and five after the oldest, for tests on fake timers. */
async function setup(o: { leadChat?: boolean; delayMs?: number; defaults?: boolean; log?: ConstructorParameters<typeof LeadUpdates>[0]['log']; ownChat?: (ws: Workspace) => string | undefined } = {}) {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'kernel-lu-')), 'k.db'))
  store.saveProject({ id: 'r', name: 'Kernel', path: '/x', defaultBranch: 'main', paused: false, createdAt: 1 })
  // Teammate workspaces were handed off in the Lead chat "lc" unless a test says otherwise.
  const ws = (id: string, agentId: string, extra: Partial<Workspace> = {}) => store.saveWorkspace({ id, projectId: 'r', name: id, branch: id, baseRef: 'main', path: `/x/${id}`, mode: 'worktree', agentId, port: 1, status: 'ready', prState: 'none', createdAt: 1, ...(agentId === 'kernel' ? {} : { leadChatId: 'lc' }), ...extra } as Workspace)
  const chat = (id: string, workspaceId: string) => store.saveChat({ id, workspaceId, title: id, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'low', plan: false, createdAt: 1 } as Chat)
  ws('lead', 'kernel', { mode: 'current' })
  ws('w1', 'noor', { title: 'Symlink node_modules' })
  ws('w2', 'kai', { title: 'Inbox actions' })
  chat('lc', 'lead'); chat('lc2', 'lead'); chat('nc', 'w1'); chat('kc', 'w2')
  store.saveItem('nc', { kind: 'text', id: 't1', ts: 1, text: REPLY })
  const s = { enabled: true, hasLead: o.leadChat ?? true, accept: true, busy: new Set<string>(), posts: [] as string[], updates: [] as TeamUpdate[], to: [] as string[], delivered: [] as TeamUpdate[], reviewer: undefined as AgentDef | undefined, review: undefined as ReviewState | undefined, autoReview: true,
    /** Why the Lead chat can't take a message, as `Sessions.postHold` says it. Unset takes it. */
    hold: undefined as ((chatId: string) => string | undefined) | undefined, logs: [] as string[], times: [] as number[] }
  const deps: ConstructorParameters<typeof LeadUpdates>[0] = {
    store, enabled: () => s.enabled,
    // Kernel's rule in small: the owner while it's open, else the first Lead chat ("lc"), saying where the work came from:
    // a closed tab of the same Lead chat (KERNEL-337), or another Lead chat.
    target: (_r, owner) => {
      if (!s.hasLead) return undefined
      const was = owner ? store.chat(owner) : undefined
      if (was && !was.closed) return { chat: was }
      const lc = store.chat('lc')!
      return { chat: lc, ...(was ? { from: { title: was.title, ...(was.threadId && was.threadId === lc.threadId ? { tab: true } : {}) } } : {}) }
    },
    isLead: (w) => w.agentId === 'kernel',
    agentName: (_r, a) => NAMES[a],
    post: (chatId, text, update) => { if (!s.accept || s.busy.has(chatId) || s.hold?.(chatId)) return false; s.posts.push(text); s.updates.push(update); s.to.push(chatId); s.times.push(Date.now()); return true },
    holdOf: (chatId) => s.hold?.(chatId) ?? (s.busy.has(chatId) ? 'busy' : undefined),
    log: (level, line) => { s.logs.push(line); o.log?.(level, line) },
    delivered: (_r, _c, update) => { s.delivered.push(update) },
    reviewer: () => s.reviewer,
    reviewState: () => s.review,
    autoReview: () => s.autoReview,
    ...(o.ownChat ? { ownChat: o.ownChat } : {}),
    ...(o.defaults ? {} : { delayMs: o.delayMs ?? 20 })
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
const READY = (pr: string) => `- ${pr} passed checks and has no conflicts. No review runs on it, so tell the user it is ready for them to review and merge.`
const READ = (name: string, id: string) => `- Read ${name}'s reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed (workspace ${id}).`
const ALL_MERGED = '- Every task you handed off in this chat has merged. Tell the user in one line.'
const THEO: AgentDef = { id: 'theo', name: 'Theo', role: 'Reviewer', description: 'Reviews PRs', lead: false, prompt: '', file: '.claude/agents/theo.md' }
/** A PR's reviews as Kernel knows them, kind by kind (KERNEL-549): nothing ran, unless `o` says. */
const rs = (o: Partial<ReviewState> = {}): ReviewState => ({ approved: [], blocking: [], blockers: false, reviewing: [], inProgress: false, waiting: [], ...o })
/** The To do line for a PR nobody reviewed while Kernel starts reviews itself (KERNEL-549). */
const UNREVIEWED = 'PR #54 passed checks and has no conflicts. No review runs on it, so tell the user it is ready for them to review and merge.'

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
          { kind: 'pr.ready', text: 'Ready to merge', actionable: true },
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

  it("drops updates when the project's Lead was never briefed, and never starts a Lead chat", async () => {
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
    expect(lines).toContain("Updates on 2 more workspaces didn't fit here. Kernel sends them in its next update.")
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

  it('says nothing when a PR it said was ready reads as checks and ready again on the same commit (KERNEL-283)', async () => {
    const { store, s, pr } = await setup()
    const head = (prHead: string) => store.saveWorkspace({ ...store.workspace('w1')!, prHead })
    const readyLine = '- PR #54 passed checks and has no conflicts.'
    head('abc')
    pr('w1', 'checks')
    pr('w1', 'ready')
    await wait()
    expect(parts(s.posts.pop()!).body).toEqual([NOOR, OPENED_54, readyLine])
    // Main moved, and GitHub checked the PR for conflicts again.
    pr('w1', 'checks')
    pr('w1', 'ready')
    await wait()
    expect(s.posts).toEqual([])
    // A conflict on the way is news, and so is ready after it.
    pr('w1', 'conflict')
    await wait()
    s.posts.length = 0
    pr('w1', 'checks')
    pr('w1', 'ready')
    await wait()
    expect(parts(s.posts.pop()!).body).toEqual([NOOR, readyLine])
    // So is ready on a new commit.
    head('def')
    pr('w1', 'checks')
    pr('w1', 'ready')
    await wait()
    expect(parts(s.posts.pop()!).body).toEqual([NOOR, readyLine])
  })
})

describe('what wakes the Lead (KERNEL-121)', () => {
  it("never asks the Lead to start a review of a PR that passed checks: Kernel starts it, and the Lead hears what it found (KERNEL-549)", async () => {
    const { s, pr } = await setup()
    s.reviewer = THEO
    // Kernel is starting the reviews, or they run.
    s.review = rs({ inProgress: true })
    pr('w1', 'ready')
    await wait()
    expect(s.posts).toEqual([])
    s.review = rs({ inProgress: true, reviewing: ['code', 'ux'] })
    pr('w1', 'checks'); pr('w1', 'ready')
    await wait()
    expect(s.posts).toEqual([])
    s.review = rs({ blockers: true, blocking: ['security'] })
    pr('w1', 'checks'); pr('w1', 'ready')
    await wait()
    expect(s.posts).toEqual([])
    s.review = rs({ approved: ['code', 'security'] })
    pr('w1', 'checks'); pr('w1', 'ready')
    await wait()
    expect(parts(s.posts.pop()!).todo).toEqual(['- PR #54 passed checks, has no conflicts and the code and security reviews approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.'])
    // No review covers what it changes.
    s.review = rs()
    pr('w1', 'checks'); pr('w1', 'ready')
    await wait()
    const sent = s.posts.pop()!
    expect(parts(sent).todo).toEqual([`- ${UNREVIEWED}`])
    expect(sent).not.toContain('create_workspace')
  })

  it('with auto review off, tells the Lead a PR that passed checks is ready to merge instead of asking for a review (KERNEL-115)', async () => {
    const { s, pr } = await setup()
    s.reviewer = THEO
    s.autoReview = false
    pr('w1', 'ready')
    await wait()
    const sent = s.posts.pop()!
    expect(parts(sent).todo).toEqual(['- PR #54 passed checks and has no conflicts. Tell the user it is ready to merge.'])
    expect(sent).not.toContain('create_workspace')
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
  const ws = (prState: PrState): Workspace => ({ id: 'w1', projectId: 'r', name: 'w1', branch: 'b', baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'noor', port: 1, status: 'ready', prState, createdAt: 1, leadChatId: 'lc' })
  const ev = (kind: TeamEventKind, extra: Partial<TeamEvent> = {}): TeamEvent => ({ n: 1, workspaceId: 'w1', kind, pr: 54, ...extra })
  const at = '(workspace w1)'
  const BEHIND = "Ask Noor to update PR #54: fetch, rebase onto main, re-run the tests and force push, with message_agent (workspace w1). GitHub won't merge it while its branch is behind."

  const rows: [string, TeamEvent[], PrState, Partial<WakeContext>, string[]][] = [
    ['an error in a turn Kernel started', [ev('error', { by: 'lead' })], 'none', {}, [`Noor stopped with an error. Ask Noor what happened with message_agent ${at}, or tell the user.`]],
    ['an error in a turn the user started', [ev('error', { by: 'user' })], 'none', {}, []],
    ['a crashed session', [ev('crash')], 'none', {}, ["Noor's session ended. Tell the user they can restart it from the workspace."]],
    ['a crash a waiting message already restarted', [ev('crash', { resumed: true })], 'none', {}, []],
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
    ['a wait the Lead set itself (KERNEL-259)', [ev('wait.started', { wait: { on: ['w2'], label: 'PR #60 by Kai', held: true, told: true } })], 'none', {}, []],
    ['a held brief the Lead heard nothing about', [ev('wait.started', { wait: { on: ['w2'], label: 'PR #60 by Kai', held: true } })], 'none', {}, ['Noor is waiting for PR #60 by Kai. Kernel sends Noor the brief when it merges. Tell the user in one line that merging it unblocks Noor.']],
    ['a wait the teammate set itself (KERNEL-262)', [ev('wait.started', { wait: { on: ['w2'], label: 'PR #60 by Kai', held: false } })], 'none', {}, ['Noor is waiting for PR #60 by Kai. Kernel starts Noor again when it merges. Tell the user in one line that merging it unblocks Noor.']],
    ['the turn that set its own wait (KERNEL-262)', [ev('wait.started', { wait: { on: ['w2'], label: 'PR #60 by Kai', held: false } }), ev('turn', { n: 2, by: 'lead', pr: undefined })], 'none', {}, ['Noor is waiting for PR #60 by Kai. Kernel starts Noor again when it merges. Tell the user in one line that merging it unblocks Noor.']],
    ['a turn after a wait the Lead set', [ev('wait.started', { wait: { on: ['w2'], label: 'PR #60 by Kai', held: false, told: true } }), ev('turn', { n: 2, by: 'lead', pr: undefined })], 'none', {}, [`Read Noor's reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`]],
    ['a merge that released a wait', [ev('wait.released', { wait: { on: ['w2'], label: 'PR #60 by Kai', held: true } })], 'none', {}, []],
    ['a wait whose PR closed without merging', [ev('wait.broken', { wait: { on: ['w2'], label: 'PR #60 by Kai', held: true, target: 'w2', gone: 'closed' } })], 'none', { workspace: () => ({ ...ws('closed'), id: 'w2', prNumber: 60 }) }, ["Noor is waiting for PR #60 by Kai, which was closed without merging. Ask the user whether Noor should start anyway (wait_for_merge with an empty list) or archive Noor's workspace."]],
    ['a wait whose PR closed and opened again', [ev('wait.broken', { wait: { on: ['w2'], label: 'PR #60 by Kai', held: true, target: 'w2', gone: 'closed' } })], 'none', { workspace: () => ({ ...ws('open'), id: 'w2', prNumber: 60 }) }, []],
    ['a started teammate whose wait broke', [ev('wait.broken', { wait: { on: ['w2'], label: "Kai's work", held: false, target: 'w2', gone: 'archived' } })], 'none', { workspace: () => ({ ...ws('none'), id: 'w2', status: 'archived' }) }, ["Noor is waiting for Kai's work, which was archived without merging. Ask the user whether Noor should carry on without it (wait_for_merge with an empty list) or archive Noor's workspace."]],
    ["the chat's last merge", [ev('pr.merged')], 'merged', { allMerged: () => true }, ['Every task you handed off in this chat has merged. Tell the user in one line.']],
    ['a PR opening', [ev('pr.opened')], 'checks', {}, []],
    ['a PR that passed checks that no review covers (KERNEL-549)', [ev('pr.ready')], 'ready', { reviewer: THEO, review: rs() }, [UNREVIEWED]],
    ['a PR that passed checks while Kernel starts its reviews (KERNEL-549)', [ev('pr.ready')], 'ready', { reviewer: THEO, review: rs({ inProgress: true }) }, []],
    ['a PR that passed checks while its review runs', [ev('pr.ready')], 'ready', { reviewer: THEO, review: rs({ inProgress: true, reviewing: ['code'] }) }, []],
    ['a PR that passed checks with blockers found on it', [ev('pr.ready')], 'ready', { reviewer: THEO, review: rs({ blockers: true, blocking: ['code'] }) }, []],
    ['a PR that passed checks and was approved', [ev('pr.ready')], 'ready', { reviewer: THEO, review: rs({ approved: ['code'] }) }, ['PR #54 passed checks, has no conflicts and the code review approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.']],
    ['a PR that passed checks and every kind of review approved (KERNEL-549)', [ev('pr.ready')], 'ready', { review: rs({ approved: ['code', 'security', 'ux'] }) }, ['PR #54 passed checks, has no conflicts and the code, security and UX reviews approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.']],
    ['a PR that passed checks with no review state at all', [ev('pr.ready')], 'ready', {}, [UNREVIEWED]],
    ['a PR that passed checks with an idle review workspace open', [ev('pr.ready')], 'ready', { reviewer: THEO, review: rs({ open: { workspaceId: 'rv', agentId: 'theo', name: 'Theo' } }) }, ['PR #54 needs a review. Ask Theo to review it with message_agent (workspace rv).']],
    ['a PR whose review was of an earlier commit', [ev('pr.ready')], 'ready', { reviewer: THEO, review: rs({ stale: true, open: { workspaceId: 'rv', agentId: 'theo', name: 'Theo' } }) }, ['PR #54 needs another review: the last one was of a different commit. Ask Theo to review it again with message_agent (workspace rv).']],
    ['a PR one kind approved while another still has to look at the latest commit (KERNEL-549)', [ev('pr.ready')], 'ready', { review: rs({ approved: ['code'], waiting: ['security'], open: { workspaceId: 'rv', agentId: 'kernel-reviewer', name: 'Theo' } }) }, ['PR #54 needs another review: the last one was of a different commit. Ask Theo to review it again with message_agent (workspace rv).']],
    ['a PR whose review workspace failed setup', [ev('pr.ready')], 'ready', { reviewer: THEO, review: rs({ open: { workspaceId: 'rv', agentId: 'theo', name: 'Theo', failed: true } }) }, ['PR #54 needs a review, and setup failed in its review workspace. Tell the user to fix it and click Run again there (workspace rv).']],
    ['a PR that passed checks with auto review off (KERNEL-115)', [ev('pr.ready')], 'ready', { reviewer: THEO, autoReview: false, review: rs() }, ['PR #54 passed checks and has no conflicts. Tell the user it is ready to merge.']],
    ['a PR that passed checks with auto review off, which alone kept a review from starting', [ev('pr.ready')], 'ready', { autoReview: false, review: rs({ notStarted: true }) }, [`PR #54 passed checks and has no conflicts. Tell the user it is ready to merge, and tell them: "${NO_AUTO_REVIEW}"`]],
    ['a PR that passed checks with auto review on, whatever the review state says', [ev('pr.ready')], 'ready', { autoReview: true, review: rs({ notStarted: true }) }, [UNREVIEWED]],
    ['a PR that passed checks with auto review off and no reviewer', [ev('pr.ready')], 'ready', { autoReview: false }, ['PR #54 passed checks and has no conflicts. Tell the user it is ready to merge.']],
    ['a PR the user had reviewed, approved, with auto review off', [ev('pr.ready')], 'ready', { reviewer: THEO, autoReview: false, review: rs({ approved: ['code'] }) }, ['PR #54 passed checks, has no conflicts and the code review approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.']],
    ['a PR reviewed at an earlier commit, with its review workspace closed', [ev('pr.ready')], 'ready', { autoReview: false, review: rs({ stale: true }) }, ['PR #54 passed checks and has no conflicts, but its last review was of an earlier commit and its review workspace is closed. Tell the user the review is out of date.']],
    ['a PR the user had reviewed, of an earlier commit, with auto review off', [ev('pr.ready')], 'ready', { reviewer: THEO, autoReview: false, review: rs({ stale: true, open: { workspaceId: 'rv', agentId: 'theo', name: 'Theo' } }) }, ['PR #54 needs another review: the last one was of a different commit. Ask Theo to review it again with message_agent (workspace rv).']],
    ['a review with blockers, from before review kinds', [ev('review', { review: { verdict: 'blockers', summary: 'Two issues.', blockers: [{ text: 'x' }], of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', {}, ["Send Noor's blockers to Kai with message_agent (workspace w2). When Kai is done, ask Noor to review again with message_agent (workspace w1)."]],
    // Kernel runs a review of a kind again once the fix passes checks, so the Lead only passes the blockers on (KERNEL-549).
    ['a security review with blockers (KERNEL-549)', [ev('review', { review: { verdict: 'blockers', lens: 'security', summary: 'One issue.', blockers: [{ text: 'x' }], of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', {}, ["Send the security review's blockers to Kai with message_agent (workspace w2)."]],
    // A kind's blockers wait for the rest of their review round, then go out together. Each verdict says the same line,
    // which the update lists once (KERNEL-552).
    ['security blockers while the UX review of the same commit still runs (KERNEL-552)', [ev('review', { review: { verdict: 'blockers', lens: 'security', summary: 'One issue.', blockers: [{ text: 'x' }], of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', { workspace: () => ({ ...ws('ready'), id: 'w2', prNumber: 60 }), stateOf: () => rs({ blockers: true, blocking: ['security'], inProgress: true, reviewing: ['ux'] }) }, []],
    ['blockers from two kinds of one review round (KERNEL-552)', [ev('review', { review: { verdict: 'blockers', lens: 'security', summary: 'One issue.', blockers: [{ text: 'x' }], of: 'w2', ofName: 'Kai', ofPr: 60, current: true } }), ev('review', { n: 2, review: { verdict: 'blockers', lens: 'ux', summary: 'One issue.', blockers: [{ text: 'y' }], of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', { workspace: () => ({ ...ws('ready'), id: 'w2', prNumber: 60 }), stateOf: () => rs({ blockers: true, blocking: ['security', 'ux'] }) }, Array(2).fill("Send the security and UX reviews' blockers to Kai in one message with message_agent (workspace w2). If blockers from two reviews contradict each other, don't pass both on: ask the user which to follow with ask_user first.")],
    ['blockers after the last review round Kernel runs (KERNEL-552)', [ev('review', { review: { verdict: 'blockers', lens: 'ux', summary: 'One issue.', blockers: [{ text: 'x' }], of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', { workspace: () => ({ ...ws('ready'), id: 'w2', prNumber: 60 }), stateOf: () => rs({ blockers: true, blocking: ['ux'], stillBlocked: { rounds: 2, kinds: ['ux'] } }) }, ["PR #60 is still blocked after 2 review rounds, so Kernel won't review it again by itself. Don't send it back to Kai: tell the user what the UX review found that is still open, and ask with ask_user how they want to go on."]],
    ['a PR with new commits after the last review round Kernel runs (KERNEL-552)', [ev('pr.ready')], 'ready', { review: rs({ stale: true, stillBlocked: { rounds: 2, kinds: ['code', 'ux'] }, open: { workspaceId: 'rv', agentId: 'kernel-reviewer', name: 'Code review' } }) }, ["PR #54 has new commits, but it was still blocked after 2 review rounds, so Kernel didn't review them. Don't send it back to Noor: tell the user what the code and UX reviews found that is still open, and ask with ask_user how they want to go on."]],
    ['a PR whose required review waits for usage (KERNEL-552)', [ev('pr.ready')], 'ready', { review: rs({ inProgress: true, held: ['code'], skipped: ['ux'] }) }, []],
    ['a PR every review that ran approved, one skipped to save usage (KERNEL-552)', [ev('pr.ready')], 'ready', { review: rs({ approved: ['code'], skipped: ['ux'] }) }, ["PR #54 passed checks, has no conflicts and the code review approved it. Kernel skipped the UX review to save usage. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran and that the UX review didn't, and anything they should know."]],
    ['a code review approval while the UX review still runs (KERNEL-549)', [ev('review', { review: { verdict: 'approved', lens: 'code', summary: 'Good.', of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', { workspace: () => ({ ...ws('ready'), id: 'w2', prNumber: 60 }), stateOf: () => rs({ approved: ['code'], inProgress: true, reviewing: ['ux'] }) }, []],
    ['a code review approval after another kind found blockers (KERNEL-549)', [ev('review', { review: { verdict: 'approved', lens: 'code', summary: 'Good.', of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', { workspace: () => ({ ...ws('ready'), id: 'w2', prNumber: 60 }), stateOf: () => rs({ approved: ['code'], blockers: true, blocking: ['security'] }) }, []],
    ['the last approval of a ready PR (KERNEL-549)', [ev('review', { review: { verdict: 'approved', lens: 'ux', summary: 'Good.', of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', { workspace: () => ({ ...ws('ready'), id: 'w2', prNumber: 60 }), stateOf: () => rs({ approved: ['code', 'ux'] }) }, ['PR #60 passed checks, has no conflicts and the code and UX reviews approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.']],
    ['an approval of an earlier commit, which Kernel asks for again (KERNEL-549)', [ev('review', { review: { verdict: 'approved', lens: 'code', summary: 'Good.', of: 'w2', ofName: 'Kai', ofPr: 60, current: false } })], 'none', { workspace: () => ({ ...ws('ready'), id: 'w2', prNumber: 60 }) }, []],
    ['an approval of work that merged before the verdict came', [ev('review', { review: { verdict: 'approved', summary: 'Good.', of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', { workspace: () => ({ ...ws('merged'), id: 'w2', prNumber: 60 }) }, []],
    ['blockers found after the work was closed', [ev('review', { review: { verdict: 'blockers', summary: 'Two issues.', blockers: [{ text: 'x' }], of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })], 'none', { workspace: () => ({ ...ws('closed'), id: 'w2', prNumber: 60 }) }, ['Noor found blockers in PR #60 after it was closed. Tell the user what they are in a line or two.']],
    ['blockers found in work the user archived', [ev('review', { review: { verdict: 'blockers', summary: 'Two issues.', blockers: [{ text: 'x' }], of: 'w2', ofName: 'Kai', current: true } })], 'none', { workspace: () => ({ ...ws('none'), id: 'w2', status: 'archived' }) }, ["Noor found blockers in Kai's work after it was archived. Tell the user what they are in a line or two."]],
    ['an approval of work with no PR yet', [ev('review', { review: { verdict: 'approved', summary: 'Good.', of: 'w2', ofName: 'Kai', current: true } })], 'none', {}, ["Noor approved Kai's work. Ask Kai to open a pull request with message_agent (workspace w2)."]],
    ['a turn Kernel started, with no PR', [ev('turn', { by: 'lead', pr: undefined })], 'none', {}, [`Read Noor's reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`]],
    ['a turn Kernel started', [ev('turn', { by: 'kernel' })], 'ready', {}, [`Read Noor's reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`]],
    ['a ready PR GitHub starts blocking for a review (KERNEL-401)', [ev('pr.blocked', { blocked: 'review' })], 'ready', {}, ["PR #54 can't merge until someone approves it on GitHub. Tell the user."]],
    ['a ready PR that falls behind its base (KERNEL-401)', [ev('pr.blocked', { blocked: 'behind' })], 'ready', { reviewer: THEO }, [BEHIND]],
    ["a ready PR GitHub's branch rules block (KERNEL-401)", [ev('pr.blocked', { blocked: 'rules' })], 'ready', {}, ["GitHub's branch rules block PR #54. Tell the user."]],
    ['a PR GitHub stops blocking, approved (KERNEL-401)', [ev('pr.unblocked')], 'ready', { reviewer: THEO, review: rs({ approved: ['code'] }) }, ['PR #54 passed checks, has no conflicts and the code review approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.']],
    ['a PR GitHub stops blocking, with auto review off (KERNEL-401)', [ev('pr.unblocked')], 'ready', { reviewer: THEO, autoReview: false, review: rs() }, ['GitHub no longer blocks PR #54, so it is ready to merge. Tell the user.']],
    ['a PR GitHub stops blocking while its review runs (KERNEL-401)', [ev('pr.unblocked')], 'ready', { reviewer: THEO, review: rs({ inProgress: true }) }, []],
    ['a PR GitHub stops blocking with a review open and no verdict yet (KERNEL-401)', [ev('pr.unblocked')], 'ready', { reviewer: THEO, review: rs({ open: { workspaceId: 'rv', agentId: 'theo', name: 'Theo' } }) }, []],
    ['a PR GitHub stops blocking that no review covers (KERNEL-549)', [ev('pr.unblocked')], 'ready', { reviewer: THEO, review: rs() }, ['GitHub no longer blocks PR #54, so it is ready to merge. Tell the user.']],
    ['a turn an unblock rides along with (KERNEL-401)', [ev('turn', { by: 'lead' }), ev('pr.unblocked', { n: 2 })], 'ready', { reviewer: THEO, review: rs({ inProgress: true }) }, [`Read Noor's reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`]],
    ['a turn the user started', [ev('turn', { by: 'user' })], 'none', {}, []],
    ['a turn while the PR is being created', [ev('turn', { by: 'lead' })], 'creating', {}, []],
    ['a turn while checks run', [ev('turn', { by: 'lead' })], 'checks', {}, []],
    ['a turn a newer PR event follows', [ev('turn', { by: 'lead' }), ev('pr.ready', { n: 2 })], 'ready', {}, [UNREVIEWED]],
    ['a turn after an older PR event', [ev('pr.opened', { n: 0 }), ev('turn', { by: 'lead' })], 'ready', {}, [`Read Noor's reply and decide the next step: answer a question from the plan or ask the user, or pass on what is needed ${at}.`]]
  ]
  it.each(rows)('%s', (_label, events, prState, c, todo) => {
    const out = decide({ ws: { ...ws(prState), waitsFor: { on: ['w2'], held: true } }, name: 'Noor', events }, { allMerged: () => false, workspace: () => undefined, ...c })
    expect(out.todo).toEqual(todo)
    expect(out.wake.size).toBe(todo.length)
  })

  it("says why a PR that passed checks can't merge yet when GitHub blocks it (KERNEL-388, KERNEL-401)", () => {
    const blocked = (prBlocked: NonNullable<Workspace['prBlocked']>) => ({ ...ws('ready'), prBlocked })
    const off = { allMerged: () => false, autoReview: false, review: rs() }
    expect(decide({ ws: blocked('review'), name: 'Noor', events: [ev('pr.ready')] }, off).todo)
      .toEqual(["PR #54 can't merge until someone approves it on GitHub. Tell the user."])
    // A branch behind its base is its agent's to update, approved or not.
    expect(decide({ ws: blocked('behind'), name: 'Noor', events: [ev('pr.ready')] }, { ...off, review: rs({ approved: ['code'] }) }).todo)
      .toEqual([BEHIND])
    // A reviewer's approval of a ready PR GitHub still blocks: the author's to update, or the user's to know.
    const approval = ev('review', { review: { verdict: 'approved', summary: 'Good.', of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })
    expect(decide({ ws: ws('none'), name: 'Noor', events: [approval] }, { allMerged: () => false, workspace: () => ({ ...blocked('rules'), id: 'w2', prNumber: 60 }) }).todo)
      .toEqual(["GitHub's branch rules block PR #60. Tell the user."])
    expect(decide({ ws: ws('none'), name: 'Noor', events: [approval] }, { allMerged: () => false, workspace: () => ({ ...blocked('behind'), id: 'w2', prNumber: 60 }) }).todo)
      .toEqual(['Ask Kai to update PR #60: fetch, rebase onto main, re-run the tests and force push, with message_agent (workspace w2). GitHub won\'t merge it while its branch is behind.'])
    // The review flow itself goes on as for any ready PR, except on a branch that is behind.
    expect(decide({ ws: blocked('review'), name: 'Noor', events: [ev('pr.ready')] }, { allMerged: () => false, reviewer: THEO, review: rs({ open: { workspaceId: 'rv', agentId: 'theo', name: 'Theo' } }) }).todo).toEqual(['PR #54 needs a review. Ask Theo to review it with message_agent (workspace rv).'])
    expect(decide({ ws: blocked('behind'), name: 'Noor', events: [ev('pr.ready')] }, { allMerged: () => false, reviewer: THEO }).todo).toEqual([BEHIND])
  })

  it('asks nothing of an archived workspace, and still says when the last task merged', () => {
    const archived = (prState: PrState) => ({ ...ws(prState), status: 'archived' as const })
    for (const [kind, prState] of [['pr.cifail', 'cifail'], ['pr.changes', 'changes'], ['pr.conflict', 'conflict'], ['pr.ready', 'ready'], ['error', 'none'], ['crash', 'none'], ['turn', 'none'], ['pr.closed', 'closed']] as [TeamEventKind, PrState][]) {
      expect(decide({ ws: archived(prState), name: 'Noor', events: [ev(kind, { by: 'lead' })] }, { allMerged: () => false, reviewer: THEO }).todo).toEqual([])
    }
    expect(decide({ ws: archived('merged'), name: 'Noor', events: [ev('pr.merged')] }, { allMerged: () => true }).todo).toEqual(['Every task you handed off in this chat has merged. Tell the user in one line.'])
  })

  it("still passes on a verdict from a review workspace the user archived, without asking it to review again", () => {
    const archived = { ...ws('none'), status: 'archived' as const }
    const blockers = ev('review', { review: { verdict: 'blockers', summary: 'Two issues.', blockers: [{ text: 'x' }], of: 'w2', ofName: 'Kai', ofPr: 60, current: true } })
    expect(decide({ ws: archived, name: 'Noor', events: [blockers] }, { allMerged: () => false, workspace: () => ({ ...ws('cifail'), id: 'w2', prNumber: 60 }) }).todo).toEqual(["Send Noor's blockers to Kai with message_agent (workspace w2)."])
  })

  it("names the closed chat whose last task merged", () => {
    const out = decide({ ws: ws('merged'), name: 'Noor', events: [ev('pr.merged')], fromChat: 'Chat icons sizing' }, { allMerged: () => true })
    expect(out.todo).toEqual(['Every task handed off in the closed Lead chat "Chat icons sizing" has merged. Tell the user in one line.'])
  })
})

describe('review rounds in Team updates (KERNEL-552)', () => {
  it('says a ready PR skipped a review to save usage and waits for usage for another, on the card and in the text', async () => {
    const { s, pr } = await setup()
    s.review = rs({ inProgress: true, held: ['code'], skipped: ['ux'] })
    pr('w1', 'ready')
    await wait()
    // A review waiting for usage is still to come, so nothing wakes the Lead yet.
    expect(s.posts).toEqual([])
    s.review = rs({ approved: ['code'], skipped: ['ux'] })
    pr('w1', 'checks'); pr('w1', 'ready')
    await wait()
    const sent = parts(s.posts.pop()!)
    expect(sent.body).toContain('- PR #54 passed checks and has no conflicts. The code review approved it. Skipped the UX review to save usage.')
    expect(s.updates.at(-1)?.rows[0].events.filter((e) => e.kind === 'pr.review')).toEqual([
      { kind: 'pr.review', text: 'Code approved', actionable: false },
      { kind: 'pr.review', text: 'Skipped the UX review to save usage', actionable: false }
    ])
  })

  it('says a PR is still blocked after the last review round, beside the blockers that are left', async () => {
    const { u, s, ws, store } = await setup()
    ws('rv', 'kernel-reviewer', { title: 'Review PR #54', reviewOf: 'w1' })
    store.saveWorkspace({ ...store.workspace('w1')!, prNumber: 54, prState: 'ready', prHead: 'abc' })
    s.review = rs({ blockers: true, blocking: ['ux'], stillBlocked: { rounds: 2, kinds: ['ux'] } })
    u.reviewed(store.workspace('rv')!, store.workspace('w1')!, { workspaceId: 'rv', agentId: 'kernel-reviewer', verdict: 'blockers', summary: 'Still unlabelled.', blockers: [{ text: 'The button has no label.' }], sha: 'abc', prNumber: 54, lens: 'ux', ts: 1 })
    await wait()
    const sent = parts(s.posts.pop()!)
    expect(sent.body[1]).toBe('- The UX review found 1 blocker in PR #54 by Noor (workspace w1), and it is still blocked after 2 review rounds:')
    expect(sent.todo).toEqual(["- PR #54 is still blocked after 2 review rounds, so Kernel won't review it again by itself. Don't send it back to Noor: tell the user what the UX review found that is still open, and ask with ask_user how they want to go on."])
    expect(s.updates.at(-1)?.rows[0].events).toEqual([
      { kind: 'review', text: 'UX review found 1 blocker in PR #54', actionable: true },
      { kind: 'pr.review', text: 'Still blocked after 2 review rounds', actionable: false }
    ])
  })
})

describe('a ready PR its review holds back (KERNEL-608)', () => {
  it('says its checks passed, not that it is ready to merge, while blockers stand on its head or the review rounds ran out', async () => {
    const { u, s, pr, store, nc } = await setup()
    const card = async (review: ReviewState) => {
      s.review = review
      pr('w1', 'checks'); pr('w1', 'ready')
      u.turnDone(store.workspace('w1')!, nc, done)
      await wait()
      return s.updates.at(-1)!.rows[0].events.filter((e) => e.kind === 'pr.ready' || e.kind === 'pr.review').map((e) => e.text)
    }
    expect(await card(rs({ blockers: true, blocking: ['ux'] }))).toEqual(['Checks passed', 'UX found blockers'])
    // A commit after the last round, which Kernel didn't review (KERNEL-558).
    expect(await card(rs({ stale: true, waiting: ['ux'], stillBlocked: { rounds: 3, kinds: ['ux'] } }))).toEqual(['Checks passed', 'Still blocked after 3 review rounds'])
    expect(await card(rs({ blockers: true, blocking: ['ux'], stillBlocked: { rounds: 3, kinds: ['ux'] } }))).toEqual(['Checks passed', 'UX found blockers', 'Still blocked after 3 review rounds'])
    expect(await card(rs({ approved: ['code', 'ux'] }))).toEqual(['Ready to merge', 'Code and UX approved'])
    expect(s.updates).toHaveLength(4)
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

  it("lets a release by trusting the project's scripts ride along, and says the user trusted them (KERNEL-261)", async () => {
    const { u, s, w1, pr } = await setup()
    u.setup(w1, true, { trusted: true })
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'cifail')
    await wait()
    expect(parts(s.posts.pop()!).body).toEqual([NOOR, "- The user trusted this project's scripts and setup passed, and Noor's brief was released.", OPENED_54, '- Checks failed on PR #54.'])
  })
})

describe('a teammate that waits for another PR (KERNEL-259)', () => {
  const KAI_60 = { on: ['w2'], label: 'PR #60 by Kai', held: true }
  async function waiting() {
    const t = await setup()
    t.store.saveWorkspace({ ...t.store.workspace('w1')!, waitsFor: { on: ['w2'], held: true } })
    return { ...t, w1: t.store.workspace('w1')! }
  }

  it("rides along when it starts and when it is released, and the setup that passed says it still waits", async () => {
    const { u, s, w1, pr } = await waiting()
    u.waits(w1, 'wait.started', { ...KAI_60, told: true })
    u.setup(w1, true, { wait: KAI_60 })
    u.waits(w1, 'wait.released', KAI_60)
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'cifail')
    await wait()
    expect(parts(s.posts.pop()!).body).toEqual([NOOR, '- Setup passed on Run again. Noor still waits for PR #60 by Kai to merge, and Kernel sends the brief then.', '- PR #60 by Kai merged, so Kernel sent Noor the brief.', OPENED_54, '- Checks failed on PR #54.'])
  })

  it('wakes the Lead when the PR it waits for closes, and says nothing once it opened again', async () => {
    const { u, s, w1, store } = await waiting()
    store.saveWorkspace({ ...store.workspace('w2')!, prState: 'closed', prNumber: 60 })
    u.waits(w1, 'wait.broken', { ...KAI_60, target: 'w2', gone: 'closed' })
    await wait()
    expect(parts(s.posts.pop()!)).toEqual({
      header: UPDATE_HEADER,
      body: [NOOR, '- Noor is waiting for PR #60 by Kai, which was closed without merging.'],
      todo: ["- Noor is waiting for PR #60 by Kai, which was closed without merging. Ask the user whether Noor should start anyway (wait_for_merge with an empty list) or archive Noor's workspace."]
    })
    s.accept = false
    u.waits(w1, 'wait.broken', { ...KAI_60, target: 'w2', gone: 'closed' })
    store.saveWorkspace({ ...store.workspace('w2')!, prState: 'open' })
    s.accept = true
    await wait()
    expect(s.posts).toEqual([])
  })

  it('wakes the Lead once when a teammate sets its own wait, with the turn that set it and no line to read the reply (KERNEL-262)', async () => {
    const { u, s, w1, nc } = await setup()
    u.waits(w1, 'wait.started', { on: ['w2'], label: 'PR #60 by Kai', held: false, why: 'It needs the inbox actions.' })
    // The turn runs on well past the update delay. Its wait goes out with its end, not before.
    await wait(120)
    expect(s.posts).toEqual([])
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(parts(s.posts[0])).toEqual({
      header: UPDATE_HEADER,
      body: [NOOR, '- Waits for PR #60 by Kai to merge. Noor says: It needs the inbox actions. Kernel tells Noor to rebase onto it when it does.', ...QUOTED],
      todo: ['- Noor is waiting for PR #60 by Kai. Kernel starts Noor again when it merges. Tell the user in one line that merging it unblocks Noor.']
    })
  })

  it("doesn't hold a teammate's wait, or the Lead chat's other updates, past a turn stopped by archive or close (KERNEL-262)", async () => {
    const { u, s, w1, pr } = await setup()
    u.waits(w1, 'wait.started', { on: ['w2'], label: 'PR #60 by Kai', held: false })
    pr('w2', 'cifail', 60)
    await wait(120)
    expect(s.posts).toEqual([])
    // Stopping the session ends the chat's run without a turn end.
    bus.push({ type: 'chat.running', chatId: 'nc', running: false })
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(parts(s.posts[0]).todo).toEqual([
      '- Noor is waiting for PR #60 by Kai. Kernel starts Noor again when it merges. Tell the user in one line that merging it unblocks Noor.',
      '- Tell Kai about the failed checks on PR #60 with message_agent (workspace w2).'
    ])
  })

  it("doesn't hold a teammate's wait past a crash (KERNEL-262)", async () => {
    const { u, s, w1 } = await setup()
    u.waits(w1, 'wait.started', { on: ['w2'], label: 'PR #60 by Kai', held: false })
    u.crashed(w1, 'exit 1')
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(parts(s.posts[0]).todo).toContain('- Noor is waiting for PR #60 by Kai. Kernel starts Noor again when it merges. Tell the user in one line that merging it unblocks Noor.')
  })
})

describe("a Build here chat's own PR (KERNEL-778)", () => {
  /** The chat "bc" builds in its own workspace "bh", in Build here. "lead" stays a chat in Hand off. */
  async function buildSetup() {
    const t = await setup({ ownChat: (w) => (w.id === 'bh' ? 'bc' : undefined) })
    t.ws('bh', 'kernel', { title: 'Retry button' })
    t.chat('bc', 'bh')
    return { ...t, bh: t.store.workspace('bh')!, bc: t.store.chat('bc')! }
  }
  const SELF = 'Kernel (kernel) · Retry button · workspace bh'

  it('tells the chat itself what to fix, in its own worktree, while a teammate\'s PR still goes through the teammate', async () => {
    const { s, pr } = await buildSetup()
    const said: [PrState, string][] = [
      ['cifail', "- Fix the failed checks on PR #54 in this chat's worktree, then push."],
      ['changes', "- Make the changes requested on PR #54 in this chat's worktree, then push."],
      ['conflict', "- Resolve the conflicts on PR #54 in this chat's worktree: fetch, rebase onto main, re-run the tests and force push."],
      ['merged', '- PR #54 merged. Tell the user in one line that the next change in this chat starts a new branch from main.']
    ]
    for (const [state, todo] of said) {
      pr('bh', state)
      await wait()
      expect(s.to.pop()).toBe('bc')
      const sent = parts(s.posts.pop()!)
      expect(sent.body[0]).toBe(SELF)
      expect(sent.todo).toEqual([todo])
    }
    pr('w1', 'cifail')
    await wait()
    expect(s.to.pop()).toBe('lc')
    expect(parts(s.posts.pop()!).todo).toEqual(['- Tell Noor about the failed checks on PR #54 with message_agent (workspace w1).'])
  })

  it("keeps sending a teammate's PR news to the chat that handed the work off, and the teammate gets the blockers and the fixes", async () => {
    const { s, pr, own, ws, chat, u, store } = await buildSetup()
    own('w1', 'bc')
    pr('w1', 'cifail')
    await wait()
    expect(s.to.pop()).toBe('bc')
    expect(parts(s.posts.pop()!).todo).toEqual(['- Tell Noor about the failed checks on PR #54 with message_agent (workspace w1).'])
    pr('bh', 'cifail')
    await wait()
    expect(s.to.pop()).toBe('bc')
    expect(parts(s.posts.pop()!).todo).toEqual(["- Fix the failed checks on PR #54 in this chat's worktree, then push."])
    ws('rv', 'theo', { title: 'Review PR #54', reviewOf: 'w1', leadChatId: 'bc' })
    chat('rv-c', 'rv')
    NAMES.theo = 'Theo'
    s.reviewer = THEO
    u.reviewed(store.workspace('rv')!, { ...store.workspace('w1')!, prNumber: 54 }, { workspaceId: 'rv', agentId: 'theo', verdict: 'blockers', summary: 'One thing.', blockers: [{ text: 'No test.' }], ts: 1 })
    await wait()
    expect(s.to.pop()).toBe('bc')
    expect(parts(s.posts.pop()!).todo).toEqual(["- Send Theo's blockers to Noor with message_agent (workspace w1). When Noor is done, ask Theo to review again with message_agent (workspace rv)."])
  })

  it("keeps a chat in Hand off silent about its own PR", async () => {
    const { s, pr } = await buildSetup()
    pr('lead', 'cifail')
    await wait()
    expect(s.posts).toEqual([])
  })

  it('waits while the chat is building and goes when its turn ends', async () => {
    const { u, s, pr, bh, bc } = await buildSetup()
    s.busy.add('bc')
    pr('bh', 'cifail')
    await wait()
    expect(s.posts).toEqual([])
    s.busy.delete('bc')
    u.turnDone(bh, bc, { ...done, lead: true })
    expect(s.to).toEqual(['bc'])
    expect(parts(s.posts[0]).todo).toEqual(["- Fix the failed checks on PR #54 in this chat's worktree, then push."])
  })

  it("sends a review's blockers on the chat's PR to the chat, to fix itself", async () => {
    const { u, s, ws, chat, store } = await buildSetup()
    ws('rv', 'theo', { title: 'Review PR #54', reviewOf: 'bh', leadChatId: 'bc' })
    chat('rvc', 'rv')
    NAMES.theo = 'Theo'
    s.reviewer = THEO
    u.reviewed(store.workspace('rv')!, { ...store.workspace('bh')!, prNumber: 54 }, { workspaceId: 'rv', agentId: 'theo', verdict: 'blockers', summary: 'One thing.', blockers: [{ text: 'No test.' }], ts: 1 })
    await wait()
    expect(s.to.pop()).toBe('bc')
    expect(parts(s.posts.pop()!).todo).toEqual(["- Fix Theo's blockers in this chat's worktree, then push. Then ask Theo to review again with message_agent (workspace rv)."])
    s.review = rs({ blocking: ['code'], blockers: true })
    u.reviewed(store.workspace('rv')!, { ...store.workspace('bh')!, prNumber: 54 }, { workspaceId: 'rv', agentId: 'theo', verdict: 'blockers', summary: 'Still one.', blockers: [{ text: 'No test.' }], lens: 'code', ts: 2 })
    await wait()
    expect(parts(s.posts.pop()!).todo[0]).toMatch(/^- Fix the code review's blockers in this chat's worktree, then push\. Kernel reviews the PR again once its checks pass\./)
  })
})

describe('reviews (KERNEL-130)', () => {
  const verdict = (o: Partial<ReviewVerdict> = {}): ReviewVerdict => ({ workspaceId: 'rv', agentId: 'theo', verdict: 'approved', summary: 'The Try rows are gone. No blockers.', ts: 1, ...o })
  async function reviewSetup() {
    const t = await setup()
    t.ws('rv', 'theo', { title: 'Review PR #54', reviewOf: 'w1' })
    t.chat('rvc', 'rv')
    NAMES.theo = 'Theo'
    t.s.reviewer = THEO
    return { ...t, rv: t.store.workspace('rv')!, rvc: t.store.chat('rvc')! }
  }
  const THEO_BLOCK = 'Theo (theo) · Review PR #54 · workspace rv'

  it("tells the Lead a PR that passed checks was approved, once, and folds the reviewer's turn into the verdict", async () => {
    const { u, s, pr, rv, rvc, store } = await reviewSetup()
    pr('w1', 'ready')
    s.review = rs({ inProgress: true, reviewing: ['code'], open: { workspaceId: 'rv', agentId: 'theo', name: 'Theo' } })
    await wait()
    // The review runs, so passing checks rides along, saying so.
    expect(s.posts).toEqual([])
    s.review = rs({ approved: ['code'], open: { workspaceId: 'rv', agentId: 'theo', name: 'Theo' } })
    u.reviewed(rv, { ...store.workspace('w1')!, prHead: 'abc' }, verdict({ sha: 'abc', prNumber: 54 }))
    u.turnDone(rv, rvc, done)
    await wait()
    const sent = parts(s.posts.pop()!)
    expect(sent.body).toEqual([
      NOOR, OPENED_54, '- PR #54 passed checks and has no conflicts. The code review approved it.', '',
      THEO_BLOCK, '- Approved PR #54 by Noor (workspace w1), at its latest commit.', "- Theo's summary:", '  > The Try rows are gone. No blockers.'
    ])
    expect(sent.todo).toEqual(['- PR #54 passed checks, has no conflicts and the code review approved it. Tell the user it is ready to merge, with a short merge summary: what it changes, which reviews ran, and anything they should know.'])
    expect(s.updates.at(-1)?.rows[1].events).toEqual([{ kind: 'review', text: 'Approved PR #54', actionable: true }])
    // On the card, Ready to merge is green on its own and the review follows as a segment of its own (KERNEL-411).
    expect(s.updates.at(-1)?.rows[0].events.slice(1, 3)).toEqual([
      { kind: 'pr.ready', text: 'Ready to merge', actionable: true },
      { kind: 'pr.review', text: 'Code approved', actionable: false }
    ])
  })

  it('lists the blockers a review found and says who fixes them and who reviews again', async () => {
    const { u, s, rv, store } = await reviewSetup()
    u.reviewed(rv, { ...store.workspace('w1')!, prNumber: 54 }, verdict({ verdict: 'blockers', summary: 'Two things block it.', blockers: [{ text: 'The Check hooks row still renders.', file: 'src/Sidebar.tsx', line: 212 }, { text: 'No test covers the removed rows.' }] }))
    await wait()
    const sent = parts(s.posts.pop()!)
    expect(sent.body).toEqual([
      THEO_BLOCK, '- Found 2 blockers in PR #54 by Noor (workspace w1):', '  1. src/Sidebar.tsx:212: The Check hooks row still renders.', '  2. No test covers the removed rows.',
      "- Theo's summary:", '  > Two things block it.'
    ])
    expect(sent.todo).toEqual(["- Send Theo's blockers to Noor with message_agent (workspace w1). When Noor is done, ask Theo to review again with message_agent (workspace rv)."])
  })

  it("asks for another review when the approval was of a different commit, even if the PR moved after the verdict", async () => {
    const { u, s, rv, store } = await reviewSetup()
    store.saveWorkspace({ ...store.workspace('w1')!, prNumber: 54, prState: 'ready', prHead: 'abc' })
    s.accept = false
    u.reviewed(rv, store.workspace('w1')!, verdict({ sha: 'abc', prNumber: 54 }))
    await wait()
    // A push lands before the update goes out.
    store.saveWorkspace({ ...store.workspace('w1')!, prHead: 'def' })
    s.accept = true
    u.flushAll()
    const sent = parts(s.posts.pop()!)
    expect(sent.body[1]).toBe('- Approved PR #54 by Noor (workspace w1).')
    expect(sent.todo).toEqual(['- PR #54 needs another review: the last one was of a different commit. Ask Theo to review it again with message_agent (workspace rv).'])
  })

  it('waits for checks when a current approval comes before they pass', async () => {
    const { u, s, rv, store } = await reviewSetup()
    store.saveWorkspace({ ...store.workspace('w1')!, prNumber: 54, prState: 'checks', prHead: 'abc' })
    u.reviewed(rv, store.workspace('w1')!, verdict({ sha: 'abc', prNumber: 54 }))
    await wait()
    expect(parts(s.posts.pop()!).todo).toEqual(["- Theo approved PR #54. Its checks haven't passed yet; tell the user it is ready to merge once they do."])
  })

  it("folds the reviewer's turn into its verdict even when the verdict already went out, and reports the next turn", async () => {
    const { u, s, rv, rvc, store } = await reviewSetup()
    u.reviewed(rv, { ...store.workspace('w1')!, prNumber: 54 }, verdict({ verdict: 'blockers', blockers: [{ text: 'x' }] }))
    await wait()
    expect(s.posts).toHaveLength(1)
    // Theo writes a closing reply long after the verdict went out: the turn's end still isn't news.
    u.turnDone(rv, rvc, done)
    await wait()
    expect(s.posts).toHaveLength(1)
    // Kernel asks Theo something, and that answer is.
    u.turnDone(rv, rvc, done)
    await wait()
    expect(s.posts).toHaveLength(2)
  })

  it("folds a verdict turn that ended with an error into the verdict too", async () => {
    const { u, s, rv, rvc, store } = await reviewSetup()
    u.reviewed(rv, { ...store.workspace('w1')!, prNumber: 54 }, verdict())
    u.turnDone(rv, rvc, { ...done, ok: false })
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(s.posts[0]).not.toContain('Stopped with an error')
  })

  it('reports each kind of review from one review workspace, and folds each chat\'s verdict turn into its verdict (KERNEL-549)', async () => {
    const { u, s, rv, rvc, store, chat } = await reviewSetup()
    chat('rvs', 'rv')
    const of = { ...store.workspace('w1')!, prNumber: 54, prState: 'cifail' as const }
    store.saveWorkspace(of)
    u.reviewed(rv, of, verdict({ lens: 'code', verdict: 'blockers', summary: 'One bug.', blockers: [{ text: 'The count is off by one.', file: 'a.ts', line: 3 }] }), 'rvc')
    u.reviewed(rv, of, verdict({ lens: 'security', verdict: 'blockers', summary: 'One hole.', blockers: [{ text: 'The path escapes the folder.' }] }), 'rvs')
    // Both chats' turns end after their verdicts. Neither is news of its own.
    u.turnDone(rv, rvc, done)
    u.turnDone(rv, store.chat('rvs')!, done)
    await wait()
    expect(s.posts).toHaveLength(1)
    const sent = parts(s.posts.pop()!)
    expect(sent.body).toEqual([
      THEO_BLOCK,
      '- The code review found 1 blocker in PR #54 by Noor (workspace w1):', '  1. a.ts:3: The count is off by one.',
      '- The security review found 1 blocker in PR #54 by Noor (workspace w1):', '  1. The path escapes the folder.',
      "- Theo's summary:", '  > Code review: One bug.', '  >', '  > Security review: One hole.'
    ])
    expect(sent.todo).toEqual([
      "- Send the code review's blockers to Noor with message_agent (workspace w1).",
      "- Send the security review's blockers to Noor with message_agent (workspace w1)."
    ])
    expect(s.updates.at(-1)?.rows[0].events.map((e) => e.text)).toEqual(['Code review found 1 blocker in PR #54', 'Security review found 1 blocker in PR #54'])
  })

  it('wakes the Lead with the reply to its own message, even for an approval while another kind blocks (feat-review-messages-reach-named)', async () => {
    const { u, s, rv, store, chat } = await reviewSetup()
    const rvc = store.saveChat({ ...store.chat('rvc')!, lens: { kind: 'code' } })
    chat('rvs', 'rv')
    const of = { ...store.workspace('w1')!, prNumber: 54, prState: 'ready' as const, prHead: 'abc' }
    store.saveWorkspace(of)
    s.review = rs({ approved: ['code'], blocking: ['security'], blockers: true })
    // A reply from an earlier turn isn't this turn's.
    store.saveItem('rvc', { kind: 'text', id: 'old', ts: 1, text: 'Reviewed it.' })
    store.saveItem('rvc', { kind: 'user', id: 'ask', ts: 2, parts: [{ type: 'text', text: 'Checks passed, review again.' }], from: 'lead' })
    store.saveItem('rvc', { kind: 'text', id: 'said', ts: 3, text: 'Approved again. You asked the code review: the security review is the one that blocked.' })
    u.reviewed(rv, of, verdict({ lens: 'code', sha: 'abc', prNumber: 54 }), 'rvc', { asked: true })
    // The verdict waits for the turn, which brings the reply.
    await wait()
    expect(s.posts).toEqual([])
    u.turnDone(rv, rvc, done)
    await wait()
    expect(s.posts).toHaveLength(1)
    const sent = parts(s.posts[0])
    expect(sent.body.slice(-4)).toEqual(["- Theo's summary:", '  > The Try rows are gone. No blockers.', '  >', '  > Reply to your message: Approved again. You asked the code review: the security review is the one that blocked.'])
    expect(s.posts[0]).not.toContain('Reviewed it.')
    expect(sent.todo).toEqual(['- Theo, in the code review, answered your message and approved PR #54. Tell the user what it replied. PR #54 is still blocked by the security review.'])
    // The same approval from a turn Kernel started stays quiet while the security review blocks.
    u.reviewed(rv, of, verdict({ lens: 'code', sha: 'abc', prNumber: 54 }), 'rvc')
    u.turnDone(rv, rvc, { ...done, by: 'kernel' })
    await wait()
    expect(s.posts).toHaveLength(1)
  })

  it('keeps the last verdict of each kind, not only the last one (KERNEL-549)', () => {
    const at = (n: number, lens: 'code' | 'ux', verdict: 'approved' | 'blockers'): TeamEvent => ({ n, workspaceId: 'rv', kind: 'review', review: { verdict, lens, summary: '', of: 'w1', ofName: 'Noor', current: true } })
    const kept = collapse([at(1, 'code', 'blockers'), at(2, 'ux', 'approved'), at(3, 'code', 'approved')], undefined)
    expect(kept.map((e) => [e.review?.lens, e.review?.verdict])).toEqual([['ux', 'approved'], ['code', 'approved']])
  })

  it('carries the first 10 blockers, each cut short, and counts the rest', async () => {
    const { u, s, rv, store } = await reviewSetup()
    const long = 'The row still renders. '.repeat(40)
    u.reviewed(rv, { ...store.workspace('w1')!, prNumber: 54 }, verdict({ verdict: 'blockers', blockers: Array.from({ length: 15 }, () => ({ text: long })) }))
    await wait()
    const body = parts(s.posts.pop()!).body
    expect(body[1]).toBe('- Found 15 blockers in PR #54 by Noor (workspace w1) (the first 10 below):')
    const listed = body.filter((l) => /^ {2}\d+\. /.test(l))
    expect(listed).toHaveLength(10)
    for (const l of listed) expect(l.length).toBeLessThan(320)
  })
})

describe("a teammate's turn and its PR (KERNEL-136)", () => {
  it('waits for Kernel to read the PR after a turn, so a PR the turn opened speaks for it however long GitHub takes', async () => {
    const { u, s, pr, w1, nc } = await setup()
    u.readingPr('w1')
    u.turnDone(w1, nc, done)
    await wait()
    // GitHub is slow: the read takes longer than the wait. Nothing goes out meanwhile.
    expect(s.posts).toEqual([])
    pr('w1', 'checks')
    u.readPr('w1')
    await wait()
    // The turn opened a PR whose checks run, so neither wakes Kernel.
    expect(s.posts).toEqual([])
  })

  it('waits for every read that started, when two turns end close together', async () => {
    const { u, s, w1, nc } = await setup()
    u.readingPr('w1')
    u.turnDone(w1, nc, done)
    u.readingPr('w1')
    u.readPr('w1')
    await wait()
    expect(s.posts).toEqual([])
    u.readPr('w1')
    await wait()
    expect(s.posts).toHaveLength(1)
  })

  it('ignores a read that ends after Kernel stopped', async () => {
    const { u, w1, nc } = await setup()
    u.readingPr('w1')
    u.turnDone(w1, nc, done)
    u.detach()
    expect(() => u.readPr('w1')).not.toThrow()
  })

  it('sends the turn once the read finds no PR news', async () => {
    const { u, s, w1, nc } = await setup()
    u.readingPr('w1')
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toEqual([])
    u.readPr('w1')
    await wait()
    expect(parts(s.posts.pop()!).todo).toEqual([READ('Noor', 'w1')])
  })

  it('says a crash a waiting message already restarted is over, without waking the Lead', async () => {
    const { u, s, pr, w1, store } = await setup()
    u.crashed(w1, 'exit 1', { resumed: true })
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'cifail')
    await wait()
    expect(s.posts.pop()).toContain("- Noor's session ended unexpectedly (exit 1), partway through a turn. A message waiting for Noor started a new session, so Noor is working again.")
    expect(store.workspace('w1')).toBeTruthy()
  })

  it('says a teammate Kernel quit or closed on carries on by itself, without calling it unexpected or working (KERNEL-215)', async () => {
    const { u, s, pr, w1 } = await setup()
    u.crashed(w1, 'Kernel quit', { resumed: true })
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'cifail')
    await wait()
    const post = s.posts.pop()!
    expect(post).toContain('- Kernel quit while Noor was partway through a turn. Noor carries on by itself once nothing holds it, such as a paused project or the agent limit.')
    expect(post).not.toMatch(/unexpectedly|working again/)
    expect(s.updates.at(-1)?.rows[0].events[0]).toEqual({ kind: 'crash', text: 'Stopped when Kernel quit', actionable: false })
    u.crashed(w1, 'Kernel closed unexpectedly', { resumed: true })
    pr('w1', 'conflict')
    await wait()
    expect(s.posts.pop()).toContain('- Kernel closed unexpectedly while Noor was partway through a turn.')
  })

  it('drops a close the PR left by opening again', async () => {
    const { s, pr, store } = await setup()
    s.accept = false
    pr('w1', 'closed')
    await wait()
    store.saveWorkspace({ ...store.workspace('w1')!, prState: 'open' })
    pr('w1', 'cifail')
    s.accept = true
    await wait()
    const sent = s.posts.pop()!
    expect(sent).not.toContain('closed without merging')
    expect(sent).toContain('Checks failed on PR #54.')
  })
})

describe('Stop on the Lead (KERNEL-122)', () => {
  it("holds a stopped Lead chat's updates through the wait and the poll, until its next turn ends normally", async () => {
    const { u, s, pr, lead, lc } = await setup()
    s.accept = false
    pr('w1', 'cifail')
    await wait()
    s.accept = true
    // The user stops Kernel: no Kernel turn may follow.
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
    // An event for a workspace that no longer exists, as after its project was removed.
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
    store.saveMeta('leadUpdates', { v: 1, seq: 3, pending: [['lc', { projectId: 'r', events: null }]], stopped: null })
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
    expect(lines).toContain("Updates on 2 more workspaces didn't fit here. Kernel sends them in its next update.")
  })

  it("names a closed tab of the same Lead chat apart from a closed Lead chat, in the text and on the card (KERNEL-337)", async () => {
    const { store, s, pr, own, chat } = await setup()
    store.saveChat({ ...store.chat('lc')!, threadId: 't1' })
    store.saveChat({ ...store.chat('lc2')!, title: 'Icons tab', threadId: 't1', closed: true })
    chat('lc3', 'lead')
    store.saveChat({ ...store.chat('lc3')!, title: 'Composer unit tests', threadId: 't2', closed: true })
    own('w1', 'lc2'); own('w2', 'lc3')
    pr('w1', 'ready')
    pr('w2', 'conflict', 60)
    await wait()
    expect(s.to).toEqual(['lc'])
    const lines = s.posts[0].split('\n')
    expect(lines).toContain('From "Icons tab", a tab you closed. This work is yours now.')
    expect(lines).toContain('From "Composer unit tests", a Lead chat that is now closed. This work is yours now.')
    expect(s.updates[0].rows.map((r) => [r.fromChat, r.fromTab])).toEqual([['Icons tab', true], ['Composer unit tests', undefined]])
  })

  it("counts every tab's tasks before saying all of a Lead chat's work merged (KERNEL-337)", async () => {
    const ALL = 'Every task you handed off in this chat has merged.'
    const { store, s, pr, own } = await setup()
    own('w1', 'lc'); own('w2', 'lc2')
    store.saveChat({ ...store.chat('lc')!, threadId: 't1' })
    store.saveChat({ ...store.chat('lc2')!, threadId: 't1' })
    // Alone, "lc" would hear that its only task merged. Its other tab's task is still open.
    pr('w1', 'merged')
    await wait()
    expect(s.posts).toEqual([])
    pr('w2', 'merged', 60)
    await wait()
    expect(s.to).toContain('lc2')
    expect(s.posts[s.to.indexOf('lc2')]).toContain(ALL)
  })
})

describe('shared files in Team updates (KERNEL-302)', () => {
  const file = (id: string, workspaceId: string, title: string, n: number, kind: SharedFile['kind'] = 'html'): [SharedFile, SharedVersion] => {
    const v: SharedVersion = { n, at: n, file: `${id}.html`, mime: 'text/html', bytes: 10, sha256: String(n) }
    return [{ id, projectId: 'r', workspaceId, agentId: 'noor', source: `.kernel/shared/${id}.html`, title, kind, versions: [v], createdAt: 1, updatedAt: n }, v]
  }
  const SHARED = (title: string, n: number, source: string, id: string, kind = 'HTML') => `- Shared "${title}" v${n} (${kind}, ${source}, id ${id}). The user can open it from this update.`

  it('never wakes the Lead on its own, and goes out with the next update that does, in row.shared rather than events', async () => {
    const { u, s, store, w1, nc } = await setup()
    u.shared(w1, ...file('f1', 'w1', 'Checkout mockup', 1))
    await wait()
    expect(s.posts).toEqual([])
    expect(store.meta<{ pending: [string, { events: TeamEvent[] }][] }>('leadUpdates')?.pending[0][1].events.map((e) => e.kind)).toEqual(['shared'])
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(parts(s.posts[0]).body).toEqual([NOOR, SHARED('Checkout mockup', 1, '.kernel/shared/f1.html', 'f1'), ...QUOTED])
    const [row] = s.updates[0].rows
    expect(row.shared).toEqual([{ sharedId: 'f1', version: 1, title: 'Checkout mockup', kind: 'html' }])
    expect(row.events.map((e) => e.kind)).toEqual(['turn'])
  })

  it('keeps the newest version of each file', async () => {
    const { u, s, w1, nc } = await setup()
    u.shared(w1, ...file('f1', 'w1', 'Checkout mockup', 1))
    u.shared(w1, ...file('f2', 'w1', 'Logo', 1, 'image'))
    u.shared(w1, ...file('f1', 'w1', 'Checkout, take two', 2))
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.updates[0].rows[0].shared).toEqual([
      { sharedId: 'f2', version: 1, title: 'Logo', kind: 'image' },
      { sharedId: 'f1', version: 2, title: 'Checkout, take two', kind: 'html' }
    ])
    expect(parts(s.posts[0]).body.filter((l) => l.startsWith('- Shared'))).toEqual([SHARED('Logo', 1, '.kernel/shared/f2.html', 'f2', 'image'), SHARED('Checkout, take two', 2, '.kernel/shared/f1.html', 'f1')])
  })

  it("adds nothing for the Lead's own workspace", async () => {
    const { u, s, store, lead, w1, nc } = await setup()
    u.shared(lead, ...file('f1', 'lead', 'Plan diagram', 1))
    expect(store.meta<{ pending: unknown[] }>('leadUpdates')?.pending ?? []).toEqual([])
    u.turnDone(w1, nc, done)
    await wait()
    expect(s.updates[0].rows.map((r) => r.shared)).toEqual([undefined])
  })
})

describe("GitHub's merge block on a ready PR (KERNEL-401)", () => {
  const BEHIND_LINE = "- GitHub won't merge PR #54 yet: the branch is behind its base."
  const BEHIND_TODO = "- Ask Noor to update PR #54: fetch, rebase onto main, re-run the tests and force push, with message_agent (workspace w1). GitHub won't merge it while its branch is behind."
  const UNBLOCKED_TODO = '- GitHub no longer blocks PR #54, so it is ready to merge. Tell the user.'
  const blocked = (store: Store, id: string, prBlocked?: Workspace['prBlocked']) => {
    store.saveWorkspace({ ...store.workspace(id)!, prBlocked })
    bus.push({ type: 'pr.blocked', workspaceId: id, ...(prBlocked ? { blocked: prBlocked } : {}) })
  }
  /** Noor's PR passed checks on h1, and the Lead heard it. */
  const told = async () => {
    const x = await setup()
    x.store.saveWorkspace({ ...x.store.workspace('w1')!, prHead: 'h1' })
    x.pr('w1', 'checks')
    x.pr('w1', 'ready')
    await wait()
    expect(x.s.posts).toHaveLength(1)
    return x
  }

  it('tells the Lead when GitHub starts blocking a ready PR, and asks the agent to update a branch behind its base', async () => {
    const { store, s } = await told()
    blocked(store, 'w1', 'behind')
    await wait()
    expect(s.posts).toHaveLength(2)
    expect(parts(s.posts[1])).toMatchObject({ body: [NOOR, BEHIND_LINE], todo: [BEHIND_TODO] })
    expect(s.updates[1].rows[0].events).toEqual([{ kind: 'pr.blocked', text: 'Blocked on GitHub: the branch is behind its base', actionable: true }])
  })

  it('hears a PR fall behind as it comes back ready on the same head after main moved (KERNEL-283)', async () => {
    const { store, s, pr } = await told()
    pr('w1', 'checks')
    store.saveWorkspace({ ...store.workspace('w1')!, prBlocked: 'behind' })
    pr('w1', 'ready')
    await wait()
    expect(s.posts).toHaveLength(2)
    expect(parts(s.posts[1]).todo).toEqual([BEHIND_TODO])
    // Ready again on the same head, still behind, is no news.
    pr('w1', 'checks')
    pr('w1', 'ready')
    await wait()
    expect(s.posts).toHaveLength(2)
  })

  it('tells the Lead when a block it heard about lifts, also after a restart, and says nothing of one it never heard', async () => {
    const { store, s, restart } = await told()
    blocked(store, 'w1', 'review')
    await wait()
    expect(parts(s.posts[1]).todo).toEqual(["- PR #54 can't merge until someone approves it on GitHub. Tell the user."])
    restart()
    blocked(store, 'w1', undefined)
    await wait()
    expect(s.posts).toHaveLength(3)
    expect(parts(s.posts[2])).toMatchObject({ body: [NOOR, '- GitHub no longer blocks PR #54.'], todo: [UNBLOCKED_TODO] })
    expect(s.updates[2].rows[0].events).toEqual([{ kind: 'pr.unblocked', text: 'GitHub no longer blocks it', actionable: true }])
    // A block that starts and lifts before the Lead hears it says nothing at all.
    blocked(store, 'w1', 'rules')
    blocked(store, 'w1', undefined)
    await wait()
    expect(s.posts).toHaveLength(3)
  })

  it('greys a lifted block and keeps ready to merge out of the To do line while a review holds the PR back (KERNEL-635)', async () => {
    const lifted = async (review: ReviewState) => {
      const { store, s, u, nc } = await told()
      blocked(store, 'w1', 'review')
      await wait()
      s.review = review
      blocked(store, 'w1', undefined)
      await wait()
      // An unblock that wakes nobody rides along with the next update, here a finished turn.
      if (s.posts.length === 2) { u.turnDone(store.workspace('w1')!, nc, done); await wait() }
      expect(s.posts).toHaveLength(3)
      return { todo: parts(s.posts[2]).todo, events: s.updates.at(-1)!.rows[0].events.filter((e) => e.kind === 'pr.unblocked') }
    }
    for (const review of [rs({ blockers: true, blocking: ['ux'] }), rs({ stale: true, waiting: ['ux'], stillBlocked: { rounds: 3, kinds: ['ux'] } }), rs({ stillBlocked: { rounds: 3, kinds: ['ux'] } })]) {
      const { todo, events } = await lifted(review)
      expect(todo.join('\n')).not.toMatch(/ready to merge/)
      expect(events).toEqual([{ kind: 'pr.unblocked', text: 'GitHub no longer blocks it', actionable: false, held: true }])
    }
    const free = await lifted(rs())
    expect(free.todo).toEqual([UNBLOCKED_TODO])
    expect(free.events).toEqual([{ kind: 'pr.unblocked', text: 'GitHub no longer blocks it', actionable: true }])
  })

  it("asks the author, not the reviewer, to update a PR that fell behind, in one line with the author's own news", () => {
    const of = { id: 'w2', projectId: 'r', name: 'w2', branch: 'b', baseRef: 'main', path: '/x', mode: 'worktree', agentId: 'kai', port: 1, status: 'ready', prState: 'ready', prNumber: 60, prBlocked: 'behind', createdAt: 1 } as Workspace
    const approval: TeamEvent = { n: 1, workspaceId: 'rv', kind: 'review', review: { verdict: 'approved', summary: 'Good.', of: 'w2', ofName: 'Kai', ofPr: 60, current: true } }
    const fromReview = decide({ ws: { ...of, id: 'rv', agentId: 'theo', prState: 'none', prBlocked: undefined }, name: 'Theo', events: [approval] }, { allMerged: () => false, workspace: () => of }).todo
    const fromAuthor = decide({ ws: of, name: 'Kai', events: [{ n: 2, workspaceId: 'w2', kind: 'pr.blocked', pr: 60, blocked: 'behind' }] }, { allMerged: () => false }).todo
    expect(fromReview).toEqual(fromAuthor)
    expect(fromAuthor).toEqual(["Ask Kai to update PR #60: fetch, rebase onto main, re-run the tests and force push, with message_agent (workspace w2). GitHub won't merge it while its branch is behind."])
  })
})

describe('updates reach the Lead as soon as it can take them (KERNEL-637)', () => {
  const kernel: AgentDef = { id: 'kernel', name: 'Kernel', role: 'Lead', description: '', lead: true, prompt: '', file: '' }
  /** The delivery log's fields, the last line first. */
  const logged = (s: { logs: string[] }) => s.logs.filter((l) => l.startsWith('[lead-updates] delivered ')).map((l) => JSON.parse(l.slice('[lead-updates] delivered '.length)))

  it("sends an update a paused, offline or setup-held Lead chat couldn't take the moment Sessions lifts the hold, and logs why it waited", async () => {
    const t = await setup()
    // Sessions' own rule for what holds the Lead chat. Sending is the harness's, so nothing starts a real turn.
    const sessions = new Sessions({ store: t.store, approvals: new Approvals(t.store), settings: () => DEFAULT_SETTINGS('/home/cj'), agentFor: (ws) => (ws.agentId === 'kernel' ? kernel : undefined), mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {}, onFreed: () => t.u.flushSoon() })
    t.s.hold = (chatId) => sessions.postHold(chatId)
    const holds: [string, () => void, () => void][] = [
      ['paused', () => sessions.pause('r'), () => sessions.resume('r')],
      ['offline', () => sessions.holdAll('offline'), () => sessions.releaseAll('offline')],
      ['setup', () => sessions.hold('lc'), () => sessions.release('lc')]
    ]
    for (const [why, start, lift] of holds) {
      start()
      expect(sessions.postHold('lc')).toBe(why)
      t.u.turnDone(t.store.workspace('w1')!, t.nc, done)
      await wait()
      const before = t.s.posts.length
      lift()
      expect(sessions.postHold('lc')).toBeUndefined()
      // Not at the PR poll 45 seconds later: within the next step.
      await wait(10)
      expect(t.s.posts).toHaveLength(before + 1)
      expect(logged(t.s).at(-1)).toMatchObject({ chatId: 'lc', heldBy: why, carried: 0 })
    }
  })

  it('sends an update a busy, queued, crashed, limit-held or full Lead chat refused once the chat stops running or its queue empties', async () => {
    const { store, u, s, nc } = await setup()
    const k = { chats: { onRunning: () => {} }, leadUpdates: u, store } as unknown as Kernel
    const off = listen(k)
    try {
      const frees: [string, PushEvent][] = [
        ['busy', { type: 'chat.running', chatId: 'lc', running: false }],
        ['queued', { type: 'chat.queue', chatId: 'lc', queue: [] }],
        ['crashed', { type: 'chat.running', chatId: 'lc', running: false }],
        ['limit', { type: 'chat.running', chatId: 'lc', running: false }],
        // A teammate's turn ending frees a slot.
        ['capacity', { type: 'chat.running', chatId: 'kc', running: false }]
      ]
      for (const [why, freed] of frees) {
        s.hold = () => why
        u.turnDone(store.workspace('w1')!, nc, done)
        await wait()
        const before = s.posts.length
        s.hold = undefined
        bus.push(freed)
        await wait(10)
        expect(s.posts, why).toHaveLength(before + 1)
        expect(logged(s).at(-1)).toMatchObject({ heldBy: why })
      }
      // A turn starting, or a queue that still holds messages, frees nothing.
      s.hold = () => 'busy'
      u.turnDone(store.workspace('w1')!, nc, done)
      await wait()
      s.hold = undefined
      bus.push({ type: 'chat.running', chatId: 'lc', running: true })
      await wait(10)
      expect(s.posts).toHaveLength(frees.length)
    } finally { off() }
  })

  it("sends an update a full Lead chat refused as soon as Settings, Models raises the agent limit (KERNEL-651)", async () => {
    const t = await setup()
    let settings = { ...DEFAULT_SETTINGS('/home/cj') }
    settings = { ...settings, models: { ...settings.models, agentLimit: 1 } }
    // No Lead agent, so "lc" takes a slot like any teammate's chat.
    const sessions = new Sessions({ store: t.store, approvals: new Approvals(t.store), settings: () => settings, agentFor: () => undefined, mcpFor: () => undefined, projectAllow: () => [], allowInProject: () => {}, onFreed: () => t.u.flushSoon() })
    // Kai's turn takes the only slot.
    ;(sessions as unknown as { live: Map<string, { running: boolean }> }).live.set('kc', { running: true })
    t.s.hold = (chatId) => sessions.postHold(chatId)
    expect(sessions.postHold('lc')).toBe('capacity')
    t.u.turnDone(t.store.workspace('w1')!, t.nc, done)
    await wait()
    expect(t.s.posts).toEqual([])
    const before = settings
    settings = { ...settings, models: { ...settings.models, agentLimit: 2 } }
    sessions.applySettings(before)
    // Not at the PR poll 45 seconds later: within the next step.
    await wait(10)
    expect(t.s.posts).toHaveLength(1)
    expect(logged(t.s).at(-1)).toMatchObject({ chatId: 'lc', heldBy: 'capacity' })
  })

  it("writes each delivery's timings to Kernel's log, and only to the console without one (KERNEL-651)", async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const log = new Log({ dir: await mkdtemp(join(tmpdir(), 'kernel-lu-log-')) })
      const deps = leadUpdateDeps({ o: { log } } as unknown as Kernel)
      const { u, w1, nc } = await setup({ log: deps.log })
      u.turnDone(w1, nc, done)
      await wait()
      const lines = (await readFile(log.file, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/ INFO \[lead-updates\] delivered \{"projectId":"r","chatId":"lc",.*"heldBy":"none"/)
      expect(lines[0]).not.toContain('Linked node_modules')
      expect(console.info).toHaveBeenCalledWith(expect.stringContaining('[lead-updates] delivered '))
      // A fixture run or a test has no log, and LeadUpdates falls back to the console.
      expect(leadUpdateDeps({ o: {} } as unknown as Kernel).log).toBeUndefined()
    } finally { vi.restoreAllMocks() }
  })

  it('logs timings and why each update waited, never what it says', async () => {
    const { u, s, w1, nc } = await setup()
    u.turnDone(w1, nc, done)
    await wait()
    expect(logged(s)).toEqual([{ projectId: 'r', chatId: 'lc', workspaces: 1, ageMs: expect.any(Number), heldMs: expect.any(Number), heldBy: 'none', carried: 0, leftOut: 0 }])
    expect(logged(s)[0].ageMs).toBeGreaterThanOrEqual(20)
    expect(s.logs.join('\n')).not.toContain('Linked node_modules')
  })

  it('sends the first update within 5 seconds of its oldest event while events keep coming every second for 30 seconds', async () => {
    const { store, u, s, nc, kc } = await setup({ defaults: true })
    vi.useFakeTimers()
    try {
      const start = Date.now()
      for (let i = 0; i < 30; i++) {
        if (i % 2) u.turnDone(store.workspace('w2')!, kc, done)
        else u.turnDone(store.workspace('w1')!, nc, done)
        await vi.advanceTimersByTimeAsync(1000)
      }
      expect(s.times.length).toBeGreaterThan(1)
      expect(s.times[0] - start).toBeLessThanOrEqual(5000)
      // Each later batch is bounded the same way.
      for (const [i, at] of s.times.entries()) if (i) expect(at - s.times[i - 1]).toBeLessThanOrEqual(5000)
    } finally { vi.useRealTimers() }
  })

  it('still sends a lone event 2 seconds after it, and waits for a PR read however long it takes', async () => {
    const { u, s, w1, nc } = await setup({ defaults: true })
    vi.useFakeTimers()
    try {
      u.turnDone(w1, nc, done)
      await vi.advanceTimersByTimeAsync(1990)
      expect(s.posts).toEqual([])
      await vi.advanceTimersByTimeAsync(20)
      expect(s.posts).toHaveLength(1)
      u.readingPr('w1')
      u.turnDone(w1, nc, done)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(s.posts).toHaveLength(1)
      u.readPr('w1')
      await vi.advanceTimersByTimeAsync(2010)
      expect(s.posts).toHaveLength(2)
      expect(logged(s).at(-1)).toMatchObject({ heldBy: 'reading' })
    } finally { vi.useRealTimers() }
  })

  it('sends 8 of 12 workspaces, keeps the other 4 for the next update across a restart, and sends nothing twice', async () => {
    const { store, u, s, ws, chat, lead, lc, restart } = await setup()
    for (let i = 1; i <= 12; i++) {
      const w = ws(`x${i}`, 'kai', { title: `Task ${i}` })
      chat(`xc${i}`, w.id)
      u.turnDone(w, store.chat(`xc${i}`)!, done)
    }
    await wait()
    const tasks = (n: number) => s.updates[n].rows.map((r) => r.task)
    expect(tasks(0)).toEqual([5, 6, 7, 8, 9, 10, 11, 12].map((i) => `Task ${i}`))
    expect(s.updates[0].omitted).toBe(4)
    expect(s.posts[0].split('\n')).toContain("Updates on 4 more workspaces didn't fit here. Kernel sends them in its next update.")
    expect(logged(s).at(-1)).toMatchObject({ workspaces: 8, carried: 4, leftOut: 4 })
    // The other 4 are saved, so a quit doesn't lose them.
    const saved = store.meta<{ pending: [string, { events: TeamEvent[] }][] }>('leadUpdates')!
    expect(saved.pending.flatMap(([, p]) => p.events.map((e) => e.workspaceId))).toEqual(['x1', 'x2', 'x3', 'x4'])
    const again = restart()
    // Kernel's turn on the first update ends: the rest go next, once.
    again.turnDone(lead, lc, { ...done, lead: true })
    expect(tasks(1)).toEqual([1, 2, 3, 4].map((i) => `Task ${i}`))
    expect(s.updates[1].omitted).toBeUndefined()
    again.turnDone(lead, lc, { ...done, lead: true })
    await wait()
    expect(s.updates).toHaveLength(2)
    expect(store.meta<{ pending: unknown[] }>('leadUpdates')!.pending).toEqual([])
  })

  it('still holds a Lead chat the user stopped when it stops running, until its next turn ends normally (KERNEL-122)', async () => {
    const { u, s, pr, lead, lc } = await setup()
    u.turnDone(lead, lc, { ...done, lead: true, interrupted: true })
    pr('w1', 'cifail')
    await wait()
    u.chatFreed()
    u.flushSoon()
    await wait(10)
    expect(s.posts).toEqual([])
    u.turnDone(lead, lc, { ...done, lead: true, by: 'user' })
    expect(s.posts).toHaveLength(1)
    expect(logged(s).at(-1)).toMatchObject({ heldBy: 'stopped' })
  })
})

describe('a teammate a usage limit stopped (KERNEL-777)', () => {
  const S = (ms: number) => Math.round(ms / 1000)
  const limited = { ...done, ok: false, limit: true as const }
  const L: LimitNews = { provider: 'claude', window: '5-hour limit', account: 'Account 3', resetsAt: S(Date.now() + 3600_000) }
  /** When it resets, as the limit banner says it, without the "at " of a time later today. */
  const until = (resetsAt: number) => resetPhrase(resetsAt, Date.now()).replace(/^at /, '')
  const PAUSED = (at: number) => `Noor is paused until ${until(at)} because every account is at its limit. If an account is signed out or waits for Keychain access, tell the user to sign in or allow it, and Kernel moves Noor there. Kernel carries Noor on by itself then, and any message you sent waits in its chat, so don't send it again.`
  const LIFTED = 'Noor is working again on Account 2. If you told the user it was paused, correct that in one line.'

  it('stays quiet while Kernel moves the teammate to another account, and the next update says it carried on there', async () => {
    const { u, s, pr, w1, nc } = await setup()
    u.turnDone(w1, nc, limited, { ...L, switching: {} })
    await wait()
    expect(s.posts).toEqual([])
    u.limitLifted(w1, { provider: 'claude', account: 'Account 2' })
    await wait()
    expect(s.posts).toEqual([])
    pr('w1', 'cifail')
    await wait()
    expect(s.posts).toHaveLength(1)
    const { body, todo } = parts(s.posts[0])
    expect(body).toEqual([NOOR, '- Hit its 5-hour limit on Account 3. Kernel moved it to Account 2 and it carries on.', OPENED_54, '- Checks failed on PR #54.'])
    expect(todo).toEqual(['- Tell Noor about the failed checks on PR #54 with message_agent (workspace w1).'])
    expect(s.updates[0].rows[0].events[0]).toEqual({ kind: 'limit', text: 'Hit its 5-hour limit, now on Account 2', actionable: false })
  })

  it('wakes the Lead once with the earliest reset when no account has project, and once more when the teammate carries on', async () => {
    const { u, s, w1, nc, restart } = await setup()
    u.turnDone(w1, nc, limited, { ...L, switching: {} })
    await wait()
    expect(s.posts).toEqual([])
    // Kernel read every account and none had project. The earliest reset across them is sooner than this account's.
    const earliest = S(Date.now() + 1800_000)
    u.limitStuck('claude', { stuck: 'full', resetsAt: earliest })
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(parts(s.posts[0]).body).toEqual([NOOR, `- Hit its 5-hour limit on Account 3. Every account is at its limit, so it is paused until ${until(earliest)}.`])
    expect(parts(s.posts[0]).todo).toEqual([`- ${PAUSED(earliest)}`])
    // A second reading that still finds no project says nothing new.
    u.limitStuck('claude', { stuck: 'full', resetsAt: earliest })
    await wait()
    expect(s.posts).toHaveLength(1)
    // The Lead told the user it was paused, and that survives a restart.
    const again = restart()
    again.limitLifted(w1, { provider: 'claude', account: 'Account 2' })
    await wait()
    expect(s.posts).toHaveLength(2)
    expect(parts(s.posts[1])).toMatchObject({ body: [NOOR, '- Working again on Account 2.'], todo: [`- ${LIFTED}`] })
    expect(s.updates[1].rows[0].events).toEqual([{ kind: 'limit.lifted', text: 'Working again on Account 2', actionable: true }])
    // Once corrected, a later carry-on rides along.
    again.limitLifted(w1, { provider: 'claude', account: 'Account 2' })
    await wait()
    expect(s.posts).toHaveLength(2)
  })

  it('says nothing for a limit and its carry-on that wait together, as while the Lead itself is held by the limit', async () => {
    const { u, s, w1, nc } = await setup()
    s.hold = () => 'limit'
    u.turnDone(w1, nc, limited, { ...L, stuck: 'full' })
    await wait()
    expect(s.posts).toEqual([])
    u.limitLifted(w1, { provider: 'claude', account: 'Account 2' })
    s.hold = undefined
    u.flush('r')
    expect(s.posts).toEqual([])
  })

  it('names the window and its reset day, and says so when the switch is off', async () => {
    const { u, s, w1, nc } = await setup()
    const weekly = S(Date.now() + 3 * 86_400_000)
    u.turnDone(w1, nc, limited, { provider: 'claude', window: 'weekly limit', account: 'Account 3', resetsAt: weekly, stuck: 'off' })
    await wait()
    expect(s.posts).toHaveLength(1)
    expect(until(weekly)).toMatch(/^\w+day at /)
    expect(parts(s.posts[0]).todo).toEqual([`- Noor is paused until ${until(weekly)} by its weekly limit on Account 3. Kernel carries Noor on by itself then, and any message you sent waits in its chat, so don't send it again.`])
    expect(s.updates[0].rows[0].events).toEqual([{ kind: 'limit', text: `Paused by its weekly limit until ${until(weekly)}`, actionable: true }])
  })

  it('asks for a sign-in when the switch failed, and names the model on a limit of the model alone', () => {
    const ws = { id: 'w1', status: 'ready', prState: 'none' } as Workspace
    const todo = (limit: LimitNews) => decide({ ws, name: 'Noor', events: [{ n: 1, workspaceId: 'w1', kind: 'limit', limit }] }, { allMerged: () => false }).todo
    expect(todo({ ...L, stuck: 'signIn' })).toEqual([`Noor is paused until ${until(L.resetsAt!)} by its 5-hour limit on Account 3. If an account is signed out or waits for Keychain access, tell the user to sign in or allow it, and Kernel moves Noor there. Kernel carries Noor on by itself then, and any message you sent waits in its chat, so don't send it again.`])
    expect(todo({ ...L, window: 'Opus limit', model: 'Opus 5.5', stuck: 'model' })).toEqual([`Noor is paused until ${until(L.resetsAt!)} because Opus 5.5 is at its limit on Account 3. Kernel carries Noor on by itself then, and any message you sent waits in its chat, so don't send it again.`])
    // A switch under way, and a limit the user's own message in the teammate's chat met, don't wake the Lead.
    expect(todo({ ...L, switching: { to: 'Account 2' } })).toEqual([])
  })
})
