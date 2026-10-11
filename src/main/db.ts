import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { migrate, refuseNewer } from './migrations'
import type { ActivityEvent, Approval, Chat, ChatItem, Notification, Overlap, Room, SharedFile, Task, Workspace } from '@shared/types'

// One file, plain SQL. Rows keep a JSON column so the schema stays flat while the app is young. The schema lives in
// migrations.ts, versioned with `PRAGMA user_version` (KERNEL-210).

const DAY = 24 * 60 * 60 * 1000
/** Activity rows older than this go. */
export const KEEP_ACTIVITY_MS = 30 * DAY
/** A tool approval settled longer ago than this keeps its row and a short summary of its input. */
export const KEEP_APPROVAL_INPUT_MS = 7 * DAY

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
  }

  // rooms
  rooms(): Room[] { return this.all('select data from rooms order by created_at') }
  room(id: string): Room | undefined { return this.one('select data from rooms where id = ?', id) }
  saveRoom(r: Room) { this.db.prepare('insert or replace into rooms (id, data, created_at) values (?, ?, ?)').run(r.id, JSON.stringify(r), r.createdAt); return r }

  /** Kernel's record of a room: the room, its workspaces, chats, approvals, activity and shared files. Nothing on disk. */
  deleteRoom(id: string) {
    this.db.transaction(() => {
      const ws = 'select id from workspaces where room_id = ?'
      this.db.prepare(`delete from chat_items where chat_id in (select id from chats where workspace_id in (${ws}))`).run(id)
      this.db.prepare(`delete from chats where workspace_id in (${ws})`).run(id)
      this.db.prepare('delete from workspaces where room_id = ?').run(id)
      this.db.prepare('delete from approvals where room_id = ?').run(id)
      this.db.prepare('delete from activity where room_id = ?').run(id)
      this.db.prepare('delete from notifications where room_id = ?').run(id)
      this.db.prepare('delete from tasks where room_id = ?').run(id)
      this.db.prepare('delete from overlaps where room_id = ?').run(id)
      this.db.prepare('delete from shared_files where room_id = ?').run(id)
      this.db.prepare('delete from rooms where id = ?').run(id)
    })()
  }

  // notifications
  notifications(): Notification[] { return this.all('select data from notifications order by created_at desc limit 500') }
  notification(id: string): Notification | undefined { return this.one('select data from notifications where id = ?', id) }
  saveNotification(n: Notification) { this.db.prepare('insert or replace into notifications (id, room_id, data, created_at) values (?, ?, ?, ?)').run(n.id, n.roomId ?? null, JSON.stringify(n), n.createdAt); return n }
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
  workspaces(roomId?: string): Workspace[] {
    return roomId ? this.all('select data from workspaces where room_id = ? order by created_at', roomId) : this.all('select data from workspaces order by created_at')
  }
  workspace(id: string): Workspace | undefined { return this.one('select data from workspaces where id = ?', id) }
  saveWorkspace(w: Workspace) { this.db.prepare('insert or replace into workspaces (id, room_id, data, created_at) values (?, ?, ?, ?)').run(w.id, w.roomId, JSON.stringify(w), w.createdAt); return w }

  // chats
  chats(workspaceId: string): Chat[] { return this.all('select data from chats where workspace_id = ? order by created_at', workspaceId) }
  chat(id: string): Chat | undefined { return this.one('select data from chats where id = ?', id) }
  saveChat(c: Chat) { this.db.prepare('insert or replace into chats (id, workspace_id, data, created_at) values (?, ?, ?, ?)').run(c.id, c.workspaceId, JSON.stringify(c), c.createdAt); return c }

  // transcript
  items(chatId: string): ChatItem[] { return this.all('select data from chat_items where chat_id = ? order by seq', chatId) }
  saveItem(chatId: string, item: ChatItem) {
    this.db.prepare('insert or replace into chat_items (id, chat_id, seq, data) values (?, ?, coalesce((select seq from chat_items where id = ?), ?), ?)')
      .run(item.id, chatId, item.id, Date.now() * 1000 + (this.seq++ % 1000), JSON.stringify(item))
    return item
  }
  clearItems(chatId: string) { this.db.prepare('delete from chat_items where chat_id = ?').run(chatId) }

  // approvals
  approvals(filter: { roomId?: string; workspaceId?: string; pendingOnly?: boolean } = {}): Approval[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.roomId) { where.push('room_id = ?'); args.push(filter.roomId) }
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
    this.db.prepare(`insert into approvals (id, room_id, status, data, created_at, settled_at) values (?, ?, ?, ?, ?, ?)
      on conflict (id) do update set room_id = excluded.room_id, status = excluded.status, data = excluded.data, created_at = excluded.created_at,
        settled_at = case when excluded.status = 'pending' then null else coalesce(approvals.settled_at, excluded.settled_at) end,
        pruned = case when excluded.status = 'pending' then 0 else approvals.pruned end`)
      .run(a.id, a.roomId ?? null, a.status, JSON.stringify(a), a.createdAt, a.status === 'pending' ? null : Date.now())
    return a
  }

  // tasks
  tasks(roomId: string): Task[] { return this.all('select data from tasks where room_id = ? order by created_at, id', roomId) }
  task(roomId: string, id: string): Task | undefined { return this.one('select data from tasks where room_id = ? and id = ?', roomId, id) }
  saveTask(t: Task) { this.db.prepare('insert or replace into tasks (room_id, id, data, created_at) values (?, ?, ?, ?)').run(t.roomId, t.id, JSON.stringify(t), t.createdAt); return t }

  // activity
  activity(roomId?: string, limit = 50): ActivityEvent[] {
    return roomId ? this.all('select data from activity where room_id = ? order by ts desc limit ?', roomId, limit) : this.all('select data from activity order by ts desc limit ?', limit)
  }
  /** By agent id, the time of each agent's newest event in the room, over the whole log. */
  lastActivity(roomId: string): Record<string, number> {
    const rows = this.db.prepare(`select json_extract(data, '$.agentId') as agent, max(ts) as ts from activity
      where room_id = ? and json_extract(data, '$.agentId') is not null group by agent`).all(roomId) as { agent: string; ts: number }[]
    return Object.fromEntries(rows.map((r) => [r.agent, r.ts]))
  }
  saveActivity(e: ActivityEvent) { this.db.prepare('insert or ignore into activity (id, room_id, ts, data) values (?, ?, ?, ?)').run(e.id, e.roomId ?? null, e.ts, JSON.stringify(e)); return e }

  // overlaps the floor flagged, so a restart doesn't flag them again
  overlaps(): Overlap[] { return this.all('select data from overlaps') }
  saveOverlap(o: Overlap) { this.db.prepare('insert or replace into overlaps (id, room_id, data) values (?, ?, ?)').run(o.id, o.roomId, JSON.stringify(o)); return o }
  deleteOverlap(id: string) { this.db.prepare('delete from overlaps where id = ?').run(id) }

  // files agents shared (KERNEL-302), newest first
  sharedFiles(f: { roomId?: string; workspaceId?: string; limit?: number } = {}): SharedFile[] {
    const where: string[] = []
    const args: unknown[] = []
    if (f.roomId) { where.push('room_id = ?'); args.push(f.roomId) }
    if (f.workspaceId) { where.push('workspace_id = ?'); args.push(f.workspaceId) }
    return this.all(`select data from shared_files ${where.length ? 'where ' + where.join(' and ') : ''} order by updated_at desc, rowid desc limit ?`, ...args, f.limit ?? -1)
  }
  sharedFile(id: string): SharedFile | undefined { return this.one('select data from shared_files where id = ?', id) }
  /** The file shared from this path in the workspace, relative to it. */
  sharedFileAt(workspaceId: string, source: string): SharedFile | undefined { return this.one('select data from shared_files where workspace_id = ? and source = ?', workspaceId, source) }
  saveSharedFile(f: SharedFile) {
    this.db.prepare('insert or replace into shared_files (id, room_id, workspace_id, source, data, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(f.id, f.roomId, f.workspaceId, f.source, JSON.stringify(f), f.createdAt, f.updatedAt)
    return f
  }

  // engine state that outlives a restart, one JSON value per key (usage limits, chats a limit stopped)
  meta<T>(key: string): T | undefined { return this.one('select data from meta where key = ?', key) }
  saveMeta<T>(key: string, value: T) { this.db.prepare('insert or replace into meta (key, data) values (?, ?)').run(key, JSON.stringify(value)); return value }

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
