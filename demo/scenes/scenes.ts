// The scenes behind the landing page's feature clips. Each starts from a `pnpm shots` fixture (or the hero demo's story)
// a moment before the part worth watching, and moves on through the same push events the engine sends, so the real
// renderer draws every frame. demo/clips.ts drives them with a cursor and records them.
import { fixtures, type Fixture } from '../../fixtures'
import { ids } from '../../fixtures/base'
import { bus } from '../../src/main/bus'
import { f as storyFixture, fixtureAnswers as storyAnswers, storyHandlers } from '../story'
import type { AccountProfile, Approval, Chat, ChatItem, PrInfo, RateLimit, SharedAnchor, SharedComment, SharedFile, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'

type Handler = (req: never) => Promise<unknown>
export type Scene = { fixture: Fixture; answers?: unknown; handlers?: Record<string, Handler>; steps?: Record<string, () => void> }

// ---------- Shared helpers

const now = () => Date.now()
const later = (ms: number, fn: () => void) => setTimeout(fn, ms)
const push = (e: PushEvent) => bus.push(e)

/** A fixture copy with sample names only: no real person's name or Linear workspace shows in a clip. */
function sample(name: string): Fixture {
  const json = JSON.stringify(fixtures[name])
    .replaceAll('CJ Jutba', 'Sam Rivera')
    .replaceAll('cj-jutba', 'acme')
    .replaceAll('cj@example.com', 'sam@example.com')
    .replaceAll('cj@jutba.example', 'sam@rivera.example')
  return JSON.parse(json) as Fixture
}

function tools(f: Fixture) {
  const item = (chatId: string, it: ChatItem) => {
    const list = (f.items[chatId] ??= [])
    const i = list.findIndex((x) => x.id === it.id)
    if (i >= 0) list[i] = it
    else list.push(it)
    push({ type: 'chat.item', chatId, item: it })
  }
  const approval = (a: Approval) => {
    const i = f.approvals.findIndex((x) => x.id === a.id)
    if (i >= 0) f.approvals[i] = a
    else f.approvals.unshift(a)
    push({ type: 'approval', approval: a })
  }
  const workspace = (w: Workspace) => {
    const i = f.workspaces.findIndex((x) => x.id === w.id)
    if (i >= 0) f.workspaces[i] = w
    else f.workspaces.push(w)
    push({ type: 'workspace', workspace: w })
  }
  const patch = (id: string, p: Partial<Workspace>) => workspace({ ...f.workspaces.find((w) => w.id === id)!, ...p })
  const chat = (c: Chat) => {
    const i = f.chats.findIndex((x) => x.id === c.id)
    if (i >= 0) f.chats[i] = c
    else f.chats.push(c)
    push({ type: 'chat', chat: c })
  }
  const running = (chatId: string, on: boolean) => push({ type: 'chat.running', chatId, running: on })
  const status = (projectId: string, agentId: string, s: 'idle' | 'working' | 'needs' | 'planning') => {
    ;((f.status[projectId] ??= {}) as Record<string, string>)[agentId] = s
    push({ type: 'agent.status', projectId, agentId, status: s })
  }
  return { item, approval, workspace, patch, chat, running, status }
}

type Tool = Extract<ChatItem, { kind: 'tool' }>
const tool = (id: string, label: string, detail: string, extra: Partial<Tool> = {}): Tool =>
  ({ kind: 'tool', id, ts: now(), toolUseId: `toolu_${id}`, name: 'Bash', label, detail, status: 'running', ...extra })
const say = (id: string, text: string): ChatItem => ({ kind: 'text', id, ts: now(), text })
const think = (id: string, text: string): ChatItem => ({ kind: 'thinking', id, ts: now(), text })
const result = (id: string, startedAt: number): ChatItem => ({ kind: 'result', id, ts: now(), durationMs: now() - startedAt, ok: true })

/** Items one after another, `gap` ms apart. A tool shows running, then done after its `ms`. */
type Step = ChatItem | { run: Tool; ms: number; output?: string } | (() => void)
function play(item: (chatId: string, it: ChatItem) => void, chatId: string, steps: Step[], gap: number, then?: () => void) {
  let t = 0
  for (const s of steps) {
    later(t, () => {
      if (typeof s === 'function') return s()
      if ('run' in s) {
        const r = { ...s.run, ts: now() }
        item(chatId, r)
        later(s.ms, () => item(chatId, { ...r, status: 'done', durationMs: s.ms, ...(s.output ? { output: s.output } : {}) }))
        return
      }
      item(chatId, { ...s, ts: now() } as ChatItem)
    })
    t += typeof s === 'object' && 'run' in s ? s.ms + gap : gap
  }
  if (then) later(t, then)
}

// ---------- The scenes

/** The hero demo's story, for the clip of the team building in parallel workspaces. */
const team = (): Scene => ({ fixture: storyFixture, answers: storyAnswers, handlers: storyHandlers as Record<string, Handler> })

/**
 * Noor finishes the renderer and asks to write outside the workspace: Allow once. Then a bigger export: Always allow here.
 * Then a third export in the same folder runs without asking, since that kind of command is now allowed in this workspace.
 */
function permissions(): Scene {
  const f = sample('WorkspacePermReason')
  const t = tools(f)
  const chatId = ids.tableChat
  const asked = f.approvals.find((a) => a.id === 'ap-tool-noor')!
  const reply = f.items[chatId]!.find((i) => i.id === 'p-reply')!
  // The brief was just sent, so the turn's clock starts near zero and its steps stay open while it runs.
  const brief = f.items[chatId]!.find((i) => i.id === 'p1')!
  f.items[chatId] = [{ ...brief, ts: now() - 2_000 }]
  f.approvals = f.approvals.filter((a) => a.id !== asked.id)
  let start = 0
  const ask = (id: string, command: string, detail: string) => {
    const a: Approval = { ...asked, id, title: `Run ${command}`, detail, input: { command }, status: 'pending', createdAt: now() }
    t.approval(a)
    t.item(chatId, { kind: 'approval', id: `approval-${id}`, ts: now(), approvalId: id })
    t.status(ids.projectA, 'noor', 'needs')
  }
  const finish = () => {
    t.item(chatId, result('pm-res', start))
    t.running(chatId, false)
    t.status(ids.projectA, 'noor', 'idle')
  }
  return {
    fixture: f,
    steps: {
      ask: () => {
        start = now()
        t.running(chatId, true)
        t.status(ids.projectA, 'noor', 'working')
        play(t.item, chatId, [
          think('pm-th', 'The renderer is in. A few sample PDFs will show whether the fonts embed.'),
          { run: tool('pm-t1', 'Render a sample invoice', 'pnpm pdf:render --sample', { name: 'Bash' }), ms: 800 },
          { run: tool('pm-t1b', 'Check the embedded fonts', 'pdffonts out/sample.pdf', { name: 'Bash', output: 'Inter-Regular  embedded\nInter-Semibold embedded' }), ms: 700 },
          { ...reply, ts: now() },
          () => ask(asked.id, 'pnpm pdf:export --out ~/Documents/invoices', 'Saves three sample invoices as PDF.')
        ], 650)
      }
    },
    handlers: {
      'approvals.decide': (async ({ id, decision }: { id: string; decision: { behavior: string; always?: boolean } }) => {
        const a = f.approvals.find((x) => x.id === id)!
        const next: Approval = { ...a, status: decision.behavior === 'allow' ? 'allowed' : 'denied' }
        t.approval(next)
        t.status(ids.projectA, 'noor', 'working')
        if (id === asked.id) {
          play(t.item, chatId, [
            { run: tool('pm-t2', 'Run pnpm pdf:export --out ~/Documents/invoices', 'pnpm pdf:export --out ~/Documents/invoices', { name: 'Bash' }), ms: 1200, output: 'INV-0412.pdf\nINV-0413.pdf\nINV-0414.pdf' },
            say('pm-s1', 'The three samples look right. Next I want every invoice in the seed data, to catch long names and multi-page totals.'),
            () => ask('ap-tool-noor-2', 'pnpm pdf:export --out ~/Documents/invoices --all', 'Exports all 380 seed invoices as PDF.')
          ], 700)
        } else {
          play(t.item, chatId, [
            { run: tool('pm-t3', 'Run pnpm pdf:export --out ~/Documents/invoices --all', 'pnpm pdf:export --out ~/Documents/invoices --all', { name: 'Bash' }), ms: 1800, output: '380 PDFs in 41s' },
            say('pm-s2', 'Two invoices ran onto a second page. I tightened the line items and exported October again to check.'),
            { run: tool('pm-t4', 'Run pnpm pdf:export --out ~/Documents/invoices --since 2026-10-01', 'pnpm pdf:export --out ~/Documents/invoices --since 2026-10-01', { name: 'Bash' }), ms: 1300, output: '42 PDFs in 5s' },
            say('pm-done', 'Every invoice fits on one page now, with the fonts embedded. The PDFs are in ~/Documents/invoices.')
          ], 700, finish)
        }
        return next
      }) as Handler
    }
  }
}

/**
 * A team update arrives one row at a time: merged on its own, held by blockers, approved. Merge #161. Kernel sends the
 * blockers back to Noor, a second update says both are fixed and approved, and #158 merges too.
 */
function reviews(): Scene {
  const f = sample('TeamUpdateReview')
  const t = tools(f)
  const chatId = ids.leadChat
  const card = f.items[chatId]!.find((i) => i.id === 'tur-1') as Extract<ChatItem, { kind: 'user' }>
  const rows = card.update!.rows
  f.items[chatId] = f.items[chatId]!.filter((i) => i.id !== 'tur-1' && i.id !== 'tur-res1')
  const merged: string[] = []
  const merge = (workspaceId: string) => {
    push({ type: 'pr.pending', workspaceId, action: 'merge' })
    later(1300, () => {
      t.patch(workspaceId, { prState: 'merged', mergedAt: now() })
      const info = f.prs?.[workspaceId] as PrInfo | undefined
      if (info) {
        const done = { ...info, state: 'merged' as const }
        ;(f.prs ??= {})[workspaceId] = done
        push({ type: 'pr.info', info: done })
      }
      push({ type: 'pr', workspaceId, state: 'merged' })
      push({ type: 'pr.pending', workspaceId })
      merged.push(workspaceId)
      if (merged.length === 1) afterFirst()
      else later(900, () => t.item(chatId, say('tur-k3', 'Merged PR #158. Everything from this plan is in main.')))
    })
  }
  /** Kernel sends Theo's blockers to Noor, and Noor's fix comes back approved. */
  const afterFirst = () => {
    later(900, () => t.item(chatId, say('tur-k1', "Merged PR #161. I sent Theo's two blockers on #158 back to Noor.")))
    later(3600, () => {
      const head = 'h158b'
      const verdict = (lens: 'security' | 'code', ws: string) => ({ workspaceId: ws, agentId: 'theo', verdict: 'approved' as const, lens, summary: 'No blockers.', sha: head, prNumber: 158, ts: now() })
      t.patch('ws-172', { prHead: head, prState: 'ready', reviews: [verdict('security', 'ws-review-158-security'), verdict('code', 'ws-review-158-code')] })
      const info = f.prs?.['ws-172'] as PrInfo | undefined
      if (info) {
        const ready = { ...info, head, state: 'ready' as const }
        ;(f.prs ??= {})['ws-172'] = ready
        push({ type: 'pr.info', info: ready })
      }
      const row = { ...rows[1]!, events: [{ kind: 'pr.review' as const, text: 'Fixed both blockers', actionable: false }, { kind: 'pr.ready' as const, text: 'Checks passed', actionable: false }, { kind: 'pr.review' as const, text: 'Security and code approved', actionable: true }],
        reply: 'The route checks the project before it reads the issue, and dedupe() has a test for the retry.' }
      t.item(chatId, { ...card, id: 'tur-2', ts: now(), update: { rows: [row] } })
      later(800, () => t.item(chatId, say('tur-k2', 'PR #158 is ready to merge: both blockers are fixed and Theo approved the new commit.')))
    })
  }
  return {
    fixture: f,
    steps: {
      update: () => {
        const start = now()
        rows.forEach((_, n) => later(n * 1100, () => t.item(chatId, { ...card, ts: now(), update: { rows: rows.slice(0, n + 1) } })))
        later(rows.length * 1100, () => t.item(chatId, result('tur-res1', start)))
      }
    },
    handlers: {
      'pr.merge': (async ({ workspaceId }: { workspaceId: string }) => {
        merge(workspaceId)
        return f.workspaces.find((w) => w.id === workspaceId)
      }) as Handler
    }
  }
}

/**
 * Adding accounts, from Home: the account menu opens Settings, Accounts. A Claude API key is added and checked, then a
 * Codex subscription signs in through the browser. Both arrive the way the engine reports them.
 */
function accounts(): Scene {
  const f = sample('SettingsAccounts')
  const list = (f.accounts ?? []) as AccountProfile[]
  // Two accounts to start, one on each provider, so each one added shows.
  f.accounts = list.filter((a) => a.id === 'cli')
  f.usage = ((f.usage ?? []) as RateLimit[]).filter((l) => !l.accountId)
  f.ui = { ...f.ui, route: { name: 'leadNew', projectId: ((f.projects ?? [])[0] as { id: string } | undefined)?.id ?? '' } }
  const set = (next: AccountProfile[]) => {
    f.accounts = next
    push({ type: 'accounts', accounts: next })
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const resets = (h: number) => Math.round((now() + h * 3_600_000) / 1000)
  const limit = (provider: 'claude' | 'codex', accountId: string, type: RateLimit['type'], pct: number, h: number): RateLimit =>
    ({ type, status: 'allowed', utilization: pct / 100, resetsAt: resets(h), ...(provider === 'codex' ? { provider } : {}), accountId })
  return {
    fixture: f,
    handlers: {
      'accounts.addKey': (async ({ provider, label }: { provider: 'claude' | 'codex'; label: string }) => {
        // Kernel checks a key with one request to the provider before it keeps it.
        await sleep(1300)
        const acct: AccountProfile = { id: 'teamkey', provider, label, cli: false, auth: 'apiKey', active: false, signedIn: true }
        set([...(f.accounts as AccountProfile[]), acct])
        return acct
      }) as Handler,
      'accounts.add': (async ({ provider }: { provider: 'claude' | 'codex' }) => {
        push({ type: 'account.add', add: { provider, step: 'browser', url: 'https://auth.openai.com/oauth/authorize' } })
        await sleep(2100)
        const acct: AccountProfile = { id: 'work', provider, label: 'Work', email: 'work@example.com', plan: 'ChatGPT Pro', cli: false, auth: 'subscription', active: false, signedIn: true }
        f.usage = [...((f.usage ?? []) as RateLimit[]), limit(provider, 'work', 'five_hour', 12, 3), limit(provider, 'work', 'seven_day', 31, 90)]
        push({ type: 'usage', limits: f.usage as RateLimit[] })
        set([...(f.accounts as AccountProfile[]), acct])
        push({ type: 'account.add', add: { provider, step: 'done', account: acct } })
        return acct
      }) as Handler
    }
  }
}

/** The issues list: open the PDF export issue and plan it with Kernel, which reads it and proposes a plan in a new tab. */
function issues(): Scene {
  const f = sample('IssuesWorking')
  const t = tools(f)
  const lead = 'kernel-lead'
  return {
    fixture: f,
    handlers: {
      'linear.plan': (async ({ id, projectId }: { id: string; projectId: string }) => {
        const chatId = 'chat-issue-plan'
        const lw = f.workspaces.find((w) => w.id === ids.lead)!
        t.chat({ id: chatId, workspaceId: lw.id, title: 'Export invoices as PDF', kind: 'chat', model: 'claude-opus-5-5', effort: 'high', plan: true, createdAt: now() })
        f.items[chatId] = []
        later(100, () => {
          t.item(chatId, { kind: 'user', id: 'is-u', ts: now(), parts: [{ type: 'text', text: `Plan ${id}: Export invoices as PDF. Read the issue and its comments first.` }] })
          t.running(chatId, true)
          t.status(projectId, lead, 'planning')
          const start = now()
          play(t.item, chatId, [
            think('is-th', 'The issue and both comments agree: one page per invoice, the on-screen layout, no custom templates.'),
            { run: tool('is-t1', `Read ${id} and its comments`, `linear issue ${id}`, { name: 'mcp__linear__get_issue' }), ms: 800 },
            { run: tool('is-t2', 'Check for an open branch or pull request', `gh pr list --search ${id}`, { name: 'Bash' }), ms: 700 },
            () => {
              const ap = `ap-plan-issue-${now()}`
              t.approval({
                id: ap, kind: 'plan', source: 'sdk', projectId, workspaceId: lw.id, chatId, agentId: lead, title: 'Export invoices as PDF', status: 'pending', createdAt: now(),
                detail: '# Export invoices as PDF\n\nOne page per invoice, laid out like the invoice on screen, with a Download PDF action in each row. No custom templates yet, as Maya asked.\n\nThree tasks, run in parallel. Theo reviews each pull request as it lands.',
                steps: [{ title: 'PDF renderer with embedded fonts', taskId: id, agentId: 'noor' }, { title: 'Download PDF in the row menu', taskId: id, agentId: 'kai' }, { title: 'Snapshot tests for each state', taskId: id, agentId: 'ivy' }]
              })
              t.item(chatId, { kind: 'approval', id: `approval-${ap}`, ts: now(), approvalId: ap })
              t.item(chatId, result('is-res', start))
              t.running(chatId, false)
              t.status(projectId, lead, 'needs')
            }
          ], 700)
        })
        return { chatId }
      }) as Handler,
      'approvals.decide': (async ({ id }: { id: string }) => {
        const a = f.approvals.find((x) => x.id === id)!
        const chatId = a.chatId!
        const projectId = a.projectId ?? ids.projectA
        const tasks = [
          { agent: 'noor', name: 'kernel-31-pdf-renderer', title: 'PDF renderer with embedded fonts' },
          { agent: 'kai', name: 'kernel-31-download-pdf', title: 'Download PDF in the row menu' },
          { agent: 'ivy', name: 'kernel-31-snapshot-tests', title: 'Snapshot tests for each state' }
        ]
        const next: Approval = { ...a, status: 'allowed', steps: a.steps?.map((st, i) => ({ ...st, workspaceId: `ws-k31-${i}` })) }
        t.approval(next)
        const c = f.chats.find((x) => x.id === chatId)!
        t.chat({ ...c, plan: false })
        t.running(chatId, true)
        t.status(projectId, lead, 'working')
        play(t.item, chatId, [
          { run: tool('is-t4', 'kernel · start_tasks', 'Noor, Kai and Ivy, one workspace each, linked to KERNEL-31', { name: 'mcp__kernel__start_tasks' }), ms: 800 },
          say('is-go', 'Handed off. Noor has the renderer, Kai has the download action and Ivy has the tests. Each workspace links back to KERNEL-31, and Theo reviews each pull request as it lands.')
        ], 700, () => { t.running(chatId, false); t.status(projectId, lead, 'idle') })
        tasks.forEach((task, i) => later(900 + i * 650, () => {
          const wsId = `ws-k31-${i}`
          const cid = `chat-k31-${i}`
          t.workspace({ id: wsId, projectId: projectId, name: task.name, title: task.title, branch: `feat/${task.name}`, baseRef: 'origin/main', path: `/Users/you/kernel/worktrees/client-a/${task.name}`, mode: 'worktree', agentId: task.agent, port: 4371 + i, status: 'ready', prState: 'none', createdAt: now(), leadChatId: chatId, source: { kind: 'issue', id: 'KERNEL-31', title: 'Export invoices as PDF', url: 'https://linear.app/acme/issue/KERNEL-31' } })
          t.chat({ id: cid, workspaceId: wsId, title: task.title, kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: now() })
          f.items[cid] = [{ kind: 'user', id: `${cid}-u`, ts: now(), from: 'lead', parts: [{ type: 'text', text: `KERNEL-31: ${task.title}. Build it from the approved plan.` }] }]
          t.running(cid, true)
          t.status(projectId, task.agent, 'working')
        }))
        return next
      }) as Handler
    }
  }
}

/** Noor's pricing page in a tab: a comment pinned to Start free trial goes to Noor, who shares v3. */
function sharing(): Scene {
  const f = sample('WorkspaceSharedComment')
  const t = tools(f)
  const chatId = ids.tableChat
  return {
    fixture: f,
    handlers: {
      'shared.comment': (async ({ sharedId, version, note, anchor }: { sharedId: string; version: number; note: string; anchor: SharedAnchor }) => {
        const c: SharedComment = { id: 'cm-new', sharedId, version, at: now(), note, anchor, chatId, itemId: 'cm-new-item' }
        ;(f.sharedComments ??= []).push(c)
        push({ type: 'shared.comment', comment: c })
        t.item(chatId, { kind: 'user', id: 'cm-new-item', ts: now(), parts: [{ type: 'text', text: `Comment on "Pricing page draft" v${version}.\n> ${note}` }] })
        t.running(chatId, true)
        t.status(ids.projectA, 'noor', 'working')
        const start = now()
        play(t.item, chatId, [
          think('cm-th', 'The header is the brand blue. The button should use the same token.'),
          { run: tool('cm-t1', 'Edit pricing.html', '.kernel/shared/pricing.html', { name: 'Edit' }), ms: 900 },
          { run: tool('cm-t2', 'Share it again', 'kernel share .kernel/shared/pricing.html', { name: 'mcp__kernel__share' }), ms: 700 },
          say('cm-done', 'Start free trial now uses the header blue. I shared the page again as v3.')
        ], 600, () => t.item(chatId, result('cm-res', start)))
        later(3400, () => {
          const file = f.shared!.find((x) => x.id === sharedId)!
          const last = file.versions.at(-1)!
          const next: SharedFile = { ...file, updatedAt: now(), versions: [...file.versions, { ...last, n: last.n + 1, at: now(), file: `v${last.n + 1}`, sha256: `next-${last.n + 1}`, note: 'Start free trial uses the header blue' }] }
          f.shared = f.shared!.map((x) => (x.id === sharedId ? next : x))
          push({ type: 'shared', file: next })
          t.running(chatId, false)
          t.status(ids.projectA, 'noor', 'idle')
        })
        return { chatId, workspaceId: ids.table, queued: false }
      }) as Handler
    }
  }
}

export const SCENES: Record<string, () => Scene> = { team, permissions, reviews, accounts, issues, sharing }
