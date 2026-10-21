import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { migrate, refuseNewer } from './migrations'
import type { ActivityEvent, Approval, Chat, ChatItem, Notification, OpenItem, Overlap, Project, SharedComment, SharedFile, Task, Thread, Workspace } from '@shared/types'

// One file, plain SQL. Rows keep a JSON column so the schema stays flat while the app is young. The schema lives in
// migrations.ts, versioned with `PRAGMA user_version` (KERNEL-210).

const DAY = 24 * 60 * 60 * 1000
/** Activity rows older than this go. */
export const KEEP_ACTIVITY_MS = 30 * DAY
/** A tool approval settled longer ago than this keeps its row and a short summary of its input. */
export const KEEP_APPROVAL_INPUT_MS = 7 * DAY
/** A tool receipt older than this goes. A call is only repeated within minutes, so this is generous. */
export const KEEP_RECEIPT_MS = 30 * DAY
/** The file compacts at start when free pages hold more than this many bytes and more than this share of it (KERNEL-333). */
export const COMPACT_MIN_FREE_BYTES = 32 * 1024 * 1024
export const COMPACT_MIN_FREE_SHARE = 0.2

export class Store {
  readonly db: Database.Database
  private seq = 0

  private pruneTimer: NodeJS.Timeout

  /** Throws NEWER_DATA, leaving the file as it was, when a newer build wrote it. */
  constructor(file: string) {
    refuseNewer(file)
    this.db = new Database(file)
    try {
      this.db.pragma('busy_timeout = 5000')
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = NORMAL')
      this.db.pragma(`journal_size_limit = ${64 * 1024 * 1024}`)
      migrate(this.db, file)
    } catch (err) {
      this.db.close()
      throw err
    }
    this.safePrune()
    this.safeCompact()
    // kernel.ts closes `db` itself on stop, so the timer checks it is still open.
    this.pruneTimer = setInterval(() => { if (this.db.open) this.safePrune() }, DAY)
    this.pruneTimer.unref()
  }

  /**
   * At start and once a day (KERNEL-210): activity older than 30 days goes, and a tool approval settled more than 7 days
   * ago keeps its row with only the short string fields of its input (command, file path, URL). Pending approvals,
   * plans, questions, hires, chats and chat items are never pruned.
   */
  prune(now = Date.now()): { activity: number; approvals: number } {
    return this.db.transaction(() => {
      const activity = this.db.prepare('delete from activity where ts < ?').run(now - KEEP_ACTIVITY_MS).changes
      const rows = this.db.prepare(`select id, data from approvals where status != 'pending' and pruned = 0 and coalesce(settled_at, created_at) < ?`).all(now - KEEP_APPROVAL_INPUT_MS) as { id: string; data: string }[]
      const mark = this.db.prepare('update approvals set data = ?, pruned = 1 where id = ?')
      let approvals = 0
      for (const r of rows) {
        let a: Approval
        try { a = JSON.parse(r.data) } catch { continue }
        const trim = a.kind === 'tool' && a.toolName !== 'ExitPlanMode' && a.toolName !== 'AskUserQuestion' && a.input !== undefined
        if (trim) approvals++
        mark.run(trim ? JSON.stringify({ ...a, input: summarize(a.input) }) : r.data, r.id)
      }
      return { activity, approvals }
    })()
  }

  private safePrune() {
    try { this.prune() } catch (err) { console.warn('[db] prune failed', err) }
    try { this.pruneReceipts() } catch (err) { console.warn('[db] receipt prune failed', err) }
  }

  // tool receipts (docs/decisions/durable-tool-calls.md)
  /** What a chat's tool call with this provider call id returned, when it ran before. */
  toolReceipt(chatId: string, callId: string): { tool: string; result: string } | undefined {
    return this.db.prepare('select tool, result from tool_receipts where chat_id = ? and call_id = ?').get(chatId, callId) as { tool: string; result: string } | undefined
  }
  /** Keeps the first result for a call id: a second save for the same call is ignored. */
  saveToolReceipt(r: { chatId: string; callId: string; tool: string; result: string; createdAt?: number }) {
    this.db.prepare('insert or ignore into tool_receipts (chat_id, call_id, tool, result, created_at) values (?, ?, ?, ?, ?)').run(r.chatId, r.callId, r.tool, r.result, r.createdAt ?? Date.now())
  }
  /** Receipts older than 30 days go, at start and once a day. Returns how many. */
  pruneReceipts(now = Date.now()): number {
    return this.db.prepare('delete from tool_receipts where created_at < ?').run(now - KEEP_RECEIPT_MS).changes
  }

  /**
   * Deleting rows leaves free pages and the file keeps its size. When they pass both thresholds, `vacuum` rewrites the file
   * without them (KERNEL-333). It runs at start, before any session, so nothing waits on it; it reclaims what Delete in
   * History and pruning freed. Returns whether it ran.
   */
  compact(minBytes = COMPACT_MIN_FREE_BYTES, minShare = COMPACT_MIN_FREE_SHARE): boolean {
    const pages = (name: string) => Number(this.db.pragma(name, { simple: true }))
    const free = pages('freelist_count')
    if (free * pages('page_size') <= minBytes || free <= pages('page_count') * minShare) return false
    this.db.exec('vacuum')
    // In WAL mode the vacuumed pages sit in the log until a checkpoint copies them in and the files shrink.
    this.db.pragma('wal_checkpoint(truncate)')
    return true
  }

  private safeCompact() {
    try { this.compact() } catch (err) { console.warn('[db] compact failed', err) }
  }

  // projects
  projects(): Project[] { return this.all('select data from projects order by created_at') }
  project(id: string): Project | undefined { return this.one('select data from projects where id = ?', id) }
  saveProject(r: Project) { this.db.prepare('insert or replace into projects (id, data, created_at) values (?, ?, ?)').run(r.id, JSON.stringify(r), r.createdAt); return r }

  /** Kernel's record of a project: the project, its workspaces, chats, approvals, activity and shared files. Nothing on disk. */
  deleteProject(id: string) {
    this.db.transaction(() => {
      const ws = 'select id from workspaces where project_id = ?'
      this.db.prepare(`delete from chat_items where chat_id in (select id from chats where workspace_id in (${ws}))`).run(id)
      this.db.prepare(`delete from tool_receipts where chat_id in (select id from chats where workspace_id in (${ws}))`).run(id)
      this.db.prepare(`delete from chats where workspace_id in (${ws})`).run(id)
      this.db.prepare('delete from workspaces where project_id = ?').run(id)
      this.db.prepare('delete from approvals where project_id = ?').run(id)
      this.db.prepare('delete from activity where project_id = ?').run(id)
      this.db.prepare('delete from notifications where project_id = ?').run(id)
      this.db.prepare('delete from tasks where project_id = ?').run(id)
      this.db.prepare('delete from overlaps where project_id = ?').run(id)
      this.db.prepare('delete from shared_comments where shared_id in (select id from shared_files where project_id = ?)').run(id)
      this.db.prepare('delete from shared_files where project_id = ?').run(id)
      this.db.prepare('delete from threads where project_id = ?').run(id)
      this.db.prepare('delete from open_items where project_id = ?').run(id)
      this.db.prepare('delete from projects where id = ?').run(id)
    })()
  }

  /**
   * Kernel's record of workspaces, for Delete in History (KERNEL-333): their chats and chat items, shared files, and the
   * approvals, activity and notifications that name them. Nothing on disk, and nothing in the project. The ids go in once as
   * JSON, so deleting many is one statement per table.
   */
  deleteWorkspaces(ids: string[]) {
    if (!ids.length) return
    const json = JSON.stringify(ids)
    const mine = 'select value from json_each(?)'
    this.db.transaction(() => {
      this.db.prepare(`delete from chat_items where chat_id in (select id from chats where workspace_id in (${mine}))`).run(json)
      this.db.prepare(`delete from tool_receipts where chat_id in (select id from chats where workspace_id in (${mine}))`).run(json)
      this.db.prepare(`delete from chats where workspace_id in (${mine})`).run(json)
      this.db.prepare(`delete from workspaces where id in (${mine})`).run(json)
      this.db.prepare(`delete from shared_comments where shared_id in (select id from shared_files where workspace_id in (${mine}))`).run(json)
      this.db.prepare(`delete from shared_files where workspace_id in (${mine})`).run(json)
      for (const table of ['approvals', 'activity', 'notifications', 'open_items']) this.db.prepare(`delete from ${table} where json_extract(data, '$.workspaceId') in (${mine})`).run(json)
    })()
  }

  // notifications
  notifications(): Notification[] { return this.all('select data from notifications order by created_at desc limit 500') }
  notification(id: string): Notification | undefined { return this.one('select data from notifications where id = ?', id) }
  saveNotification(n: Notification) { this.db.prepare('insert or replace into notifications (id, project_id, data, created_at) values (?, ?, ?, ?)').run(n.id, n.projectId ?? null, JSON.stringify(n), n.createdAt); return n }
  /** Approval rows that still ask for an answer, however old. `notifications()` stops at 500. */
  openApprovalNotifications(): Notification[] {
    return this.all(`select data from notifications where json_extract(data, '$.approvalId') is not null and json_extract(data, '$.needsYou') = 1`)
  }
  /** Deletes a workspace's rows and returns their ids. */
  deleteWorkspaceNotifications(workspaceId: string): string[] {
    return this.ids(`delete from notifications where json_extract(data, '$.workspaceId') = ? returning id`, workspaceId)
  }
  /** Deletes the rows of workspaces that are archived or no longer exist, and returns their ids (D-137). */
  deleteOrphanNotifications(): string[] {
    return this.ids(`delete from notifications where json_extract(data, '$.workspaceId') is not null and not exists (
      select 1 from workspaces w where w.id = json_extract(notifications.data, '$.workspaceId') and json_extract(w.data, '$.status') != 'archived') returning id`)
  }
  /**
   * Deletes rows created before `before` that no longer need you, and returns their ids (D-137). A row that needs you
   * stays however old, and so does a row whose approval is still pending.
   */
  deleteSettledNotifications(before: number): string[] {
    return this.ids(`delete from notifications where created_at < ? and coalesce(json_extract(data, '$.needsYou'), 0) = 0 and not exists (
      select 1 from approvals a where a.id = json_extract(notifications.data, '$.approvalId') and a.status = 'pending') returning id`, before)
  }

  // workspaces
  workspaces(projectId?: string): Workspace[] {
    return projectId ? this.all('select data from workspaces where project_id = ? order by created_at', projectId) : this.all('select data from workspaces order by created_at')
  }
  workspace(id: string): Workspace | undefined { return this.one('select data from workspaces where id = ?', id) }
  saveWorkspace(w: Workspace) { this.db.prepare('insert or replace into workspaces (id, project_id, data, created_at) values (?, ?, ?, ?)').run(w.id, w.projectId, JSON.stringify(w), w.createdAt); return w }

  // chats
  chats(workspaceId: string): Chat[] { return this.all('select data from chats where workspace_id = ? order by created_at', workspaceId) }
  chat(id: string): Chat | undefined { return this.one('select data from chats where id = ?', id) }
  // An upsert, not insert or replace, so a saved chat keeps its rowid, which orders tabs made in the same millisecond (KERNEL-337)
  /** Chats and their items, as the first tab a Lead chat's workspace was cut with when its own tabs move in (KERNEL-405). */
  deleteChats(ids: string[]) {
    const json = JSON.stringify(ids)
    this.db.transaction(() => {
      this.db.prepare('delete from chat_items where chat_id in (select value from json_each(?))').run(json)
      this.db.prepare('delete from tool_receipts where chat_id in (select value from json_each(?))').run(json)
      this.db.prepare('delete from chats where id in (select value from json_each(?))').run(json)
    })()
  }
  saveChat(c: Chat) { this.db.prepare('insert into chats (id, workspace_id, data, created_at) values (?, ?, ?, ?) on conflict(id) do update set workspace_id = excluded.workspace_id, data = excluded.data, created_at = excluded.created_at').run(c.id, c.workspaceId, JSON.stringify(c), c.createdAt); return c }

  // Lead chats, each holding one or more Lead tabs (KERNEL-337), oldest first
  threads(projectId?: string): Thread[] {
    return projectId ? this.all('select data from threads where project_id = ? order by created_at, rowid', projectId) : this.all('select data from threads order by created_at, rowid')
  }
  thread(id: string): Thread | undefined { return this.one('select data from threads where id = ?', id) }
  /**
   * A Lead chat whose workspace is deleted from History, or that never got one (KERNEL-405). Its tabs go with their workspace,
   * and what it owes goes with it (KERNEL-791).
   */
  deleteThread(id: string) {
    this.db.transaction(() => {
      this.db.prepare('delete from open_items where thread_id = ?').run(id)
      this.db.prepare('delete from threads where id = ?').run(id)
    })()
  }
  saveThread(t: Thread) { this.db.prepare('insert or replace into threads (id, project_id, data, created_at) values (?, ?, ?, ?)').run(t.id, t.projectId, JSON.stringify(t), t.createdAt); return t }
  // open items (KERNEL-749)
  openItems(threadId: string): OpenItem[] { return this.all('select data from open_items where thread_id = ? order by created_at, rowid', threadId) }
  openItem(id: string): OpenItem | undefined { return this.one('select data from open_items where id = ?', id) }
  /** Saves the item, in place of the thread's item with the same `key`. */
  saveOpenItem(i: OpenItem, key: string) {
    this.db.prepare('insert or replace into open_items (id, thread_id, project_id, key, data, created_at) values (?, ?, ?, ?, ?, ?)').run(i.id, i.threadId, i.projectId, key, JSON.stringify(i), i.createdAt)
    return i
  }
  /** Updates items in place, keeping their keys. */
  updateOpenItems(items: OpenItem[]) {
    const update = this.db.prepare('update open_items set data = ? where id = ?')
    this.db.transaction(() => { for (const i of items) update.run(JSON.stringify(i), i.id) })()
  }
  deleteOpenItems(ids: string[]) {
    if (ids.length) this.db.prepare('delete from open_items where id in (select value from json_each(?))').run(JSON.stringify(ids))
  }

  /** Every tab of the chat's thread, closed ones too, oldest first. Just the chat when it has no thread, none when it is gone. */
  threadTabs(chatId: string): Chat[] {
    const c = this.chat(chatId)
    if (!c?.threadId) return c ? [c] : []
    return this.all(`select data from chats where workspace_id = ? and json_extract(data, '$.threadId') = ? order by created_at, rowid`, c.workspaceId, c.threadId)
  }

  // transcript
  /** The chats that have a tool row still marked running, for the start to close the rows a crash left. */
  chatsWithRunningTools(): string[] {
    const rows = this.db.prepare(`select distinct chat_id from chat_items where json_valid(data) and json_extract(data, '$.kind') = 'tool' and json_extract(data, '$.status') = 'running'`).all() as { chat_id: string }[]
    return rows.map((r) => r.chat_id)
  }
  items(chatId: string): ChatItem[] { return this.all('select data from chat_items where chat_id = ? order by seq', chatId) }
  saveItem(chatId: string, item: ChatItem) {
    this.db.prepare('insert or replace into chat_items (id, chat_id, seq, data) values (?, ?, coalesce((select seq from chat_items where id = ?), ?), ?)')
      .run(item.id, chatId, item.id, Date.now() * 1000 + (this.seq++ % 1000), JSON.stringify(item))
    return item
  }
  clearItems(chatId: string) { this.db.prepare('delete from chat_items where chat_id = ?').run(chatId) }

  // approvals
  approvals(filter: { projectId?: string; workspaceId?: string; pendingOnly?: boolean } = {}): Approval[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.projectId) { where.push('project_id = ?'); args.push(filter.projectId) }
    if (filter.pendingOnly) where.push("status = 'pending'")
    if (filter.workspaceId) { where.push("json_extract(data, '$.workspaceId') = ?"); args.push(filter.workspaceId) }
    return this.all(`select data from approvals ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at desc`, ...args)
  }
  approval(id: string): Approval | undefined { return this.one('select data from approvals where id = ?', id) }
  /**
   * `settled_at` is set the first time an approval is saved as no longer pending, and kept after that. A row an older
   * build saved has none, so pruning counts from `created_at` for it.
   */
  saveApproval(a: Approval) {
    this.db.prepare(`insert into approvals (id, project_id, status, data, created_at, settled_at) values (?, ?, ?, ?, ?, ?)
      on conflict (id) do update set project_id = excluded.project_id, status = excluded.status, data = excluded.data, created_at = excluded.created_at,
        settled_at = case when excluded.status = 'pending' then null else coalesce(approvals.settled_at, excluded.settled_at) end,
        pruned = case when excluded.status = 'pending' then 0 else approvals.pruned end`)
      .run(a.id, a.projectId ?? null, a.status, JSON.stringify(a), a.createdAt, a.status === 'pending' ? null : Date.now())
    return a
  }

  // tasks
  tasks(projectId: string): Task[] { return this.all('select data from tasks where project_id = ? order by created_at, id', projectId) }
  task(projectId: string, id: string): Task | undefined { return this.one('select data from tasks where project_id = ? and id = ?', projectId, id) }
  saveTask(t: Task) { this.db.prepare('insert or replace into tasks (project_id, id, data, created_at) values (?, ?, ?, ?)').run(t.projectId, t.id, JSON.stringify(t), t.createdAt); return t }

  // activity
  activity(projectId?: string, limit = 50): ActivityEvent[] {
    return projectId ? this.all('select data from activity where project_id = ? order by ts desc limit ?', projectId, limit) : this.all('select data from activity order by ts desc limit ?', limit)
  }
  /** By agent id, the time of each agent's newest event in the project, over the whole log. */
  lastActivity(projectId: string): Record<string, number> {
    const rows = this.db.prepare(`select json_extract(data, '$.agentId') as agent, max(ts) as ts from activity
      where project_id = ? and json_extract(data, '$.agentId') is not null group by agent`).all(projectId) as { agent: string; ts: number }[]
    return Object.fromEntries(rows.map((r) => [r.agent, r.ts]))
  }
  saveActivity(e: ActivityEvent) { this.db.prepare('insert or ignore into activity (id, project_id, ts, data) values (?, ?, ?, ?)').run(e.id, e.projectId ?? null, e.ts, JSON.stringify(e)); return e }

  // overlaps the Inbox already raised, so a restart doesn't raise them again
  overlaps(): Overlap[] { return this.all('select data from overlaps') }
  saveOverlap(o: Overlap) { this.db.prepare('insert or replace into overlaps (id, project_id, data) values (?, ?, ?)').run(o.id, o.projectId, JSON.stringify(o)); return o }
  deleteOverlap(id: string) { this.db.prepare('delete from overlaps where id = ?').run(id) }

  // files agents shared (KERNEL-302), newest first
  sharedFiles(f: { projectId?: string; workspaceId?: string; limit?: number } = {}): SharedFile[] {
    const where: string[] = []
    const args: unknown[] = []
    if (f.projectId) { where.push('project_id = ?'); args.push(f.projectId) }
    if (f.workspaceId) { where.push('workspace_id = ?'); args.push(f.workspaceId) }
    return this.all(`select data from shared_files ${where.length ? 'where ' + where.join(' and ') : ''} order by updated_at desc, rowid desc limit ?`, ...args, f.limit ?? -1)
  }
  sharedFile(id: string): SharedFile | undefined { return this.one('select data from shared_files where id = ?', id) }
  /** The file shared from this path in the workspace, relative to it. */
  sharedFileAt(workspaceId: string, source: string): SharedFile | undefined { return this.one('select data from shared_files where workspace_id = ? and source = ?', workspaceId, source) }
  saveSharedFile(f: SharedFile) {
    this.db.prepare('insert or replace into shared_files (id, project_id, workspace_id, source, data, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(f.id, f.projectId, f.workspaceId, f.source, JSON.stringify(f), f.createdAt, f.updatedAt)
    return f
  }

  // comments on shared files (KERNEL-310), oldest first
  sharedComments(sharedId: string, version?: number): SharedComment[] {
    return version === undefined
      ? this.all('select data from shared_comments where shared_id = ? order by created_at, rowid', sharedId)
      : this.all('select data from shared_comments where shared_id = ? and version = ? order by created_at, rowid', sharedId, version)
  }
  saveSharedComment(c: SharedComment) {
    this.db.prepare('insert or replace into shared_comments (id, shared_id, version, data, created_at) values (?, ?, ?, ?, ?)').run(c.id, c.sharedId, c.version, JSON.stringify(c), c.at)
    return c
  }

  // engine state that outlives a restart, one JSON value per key (usage limits, chats a limit stopped)
  meta<T>(key: string): T | undefined { return this.one('select data from meta where key = ?', key) }
  saveMeta<T>(key: string, value: T) { this.db.prepare('insert or replace into meta (key, data) values (?, ?)').run(key, JSON.stringify(value)); return value }
  deleteMeta(key: string) { this.db.prepare('delete from meta where key = ?').run(key) }

  /** A row whose JSON doesn't parse is skipped and logged, so one bad row doesn't empty its list. */
  private all<T>(sql: string, ...args: unknown[]): T[] {
    return (this.db.prepare(sql).all(...args) as { data: string }[]).flatMap((r) => parsed<T>(r.data, sql))
  }
  private ids(sql: string, ...args: unknown[]): string[] { return (this.db.prepare(sql).all(...args) as { id: string }[]).map((r) => r.id) }
  /** A row whose JSON doesn't parse reads as missing, and is logged. */
  private one<T>(sql: string, ...args: unknown[]): T | undefined { const r = this.db.prepare(sql).get(...args) as { data: string } | undefined; return r ? parsed<T>(r.data, sql)[0] : undefined }
}

function parsed<T>(data: string, sql: string): T[] {
  try { return [JSON.parse(data)] } catch { console.warn(`[db] skipped a row with bad JSON: ${sql.slice(0, 80)}`); return [] }
}

/** A pruned tool input: its string fields cut to 200 characters, numbers and booleans as they were, the rest dropped. */
function summarize(input: unknown): unknown {
  const cut = (v: string) => (v.length > 200 ? `${v.slice(0, 200)}…` : v)
  if (typeof input === 'string') return cut(input)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  return Object.fromEntries(Object.entries(input).flatMap(([k, v]): [string, unknown][] =>
    typeof v === 'string' ? [[k, cut(v)]] : typeof v === 'number' || typeof v === 'boolean' ? [[k, v]] : []))
}

export const newId = () => randomUUID()
