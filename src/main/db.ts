import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ActivityEvent, Approval, Chat, ChatItem, Notification, Overlap, Room, Task, Workspace } from '@shared/types'

// One file, plain SQL. Rows keep a JSON column so the schema stays flat while the app is young.
// Swap for Drizzle with drizzle-kit migrations once the shapes settle (see docs/ARCHITECTURE.md).

const SCHEMA = `
create table if not exists rooms (id text primary key, data text not null, created_at integer not null);
create table if not exists workspaces (id text primary key, room_id text not null, data text not null, created_at integer not null);
create table if not exists chats (id text primary key, workspace_id text not null, data text not null, created_at integer not null);
create table if not exists chat_items (id text primary key, chat_id text not null, seq integer not null, data text not null);
create index if not exists chat_items_by_chat on chat_items (chat_id, seq);
create table if not exists approvals (id text primary key, room_id text, status text not null, data text not null, created_at integer not null);
create table if not exists notifications (id text primary key, room_id text, data text not null, created_at integer not null);
create table if not exists activity (id text primary key, room_id text, ts integer not null, data text not null);
create index if not exists activity_by_room on activity (room_id, ts);
create table if not exists tasks (room_id text not null, id text not null, data text not null, created_at integer not null, primary key (room_id, id));
create table if not exists meta (key text primary key, data text not null);
create table if not exists overlaps (id text primary key, room_id text not null, data text not null);
`

export class Store {
  readonly db: Database.Database
  private seq = 0

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  // rooms
  rooms(): Room[] { return this.all('select data from rooms order by created_at') }
  room(id: string): Room | undefined { return this.one('select data from rooms where id = ?', id) }
  saveRoom(r: Room) { this.db.prepare('insert or replace into rooms (id, data, created_at) values (?, ?, ?)').run(r.id, JSON.stringify(r), r.createdAt); return r }

  /** Kernel's record of a room: the room, its workspaces, chats, approvals and activity. Nothing on disk. */
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
      this.db.prepare('delete from rooms where id = ?').run(id)
    })()
  }

  // notifications
  notifications(): Notification[] { return this.all('select data from notifications order by created_at desc limit 500') }
  notification(id: string): Notification | undefined { return this.one('select data from notifications where id = ?', id) }
  saveNotification(n: Notification) { this.db.prepare('insert or replace into notifications (id, room_id, data, created_at) values (?, ?, ?, ?)').run(n.id, n.roomId ?? null, JSON.stringify(n), n.createdAt); return n }

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
  approvals(filter: { roomId?: string; pendingOnly?: boolean } = {}): Approval[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.roomId) { where.push('room_id = ?'); args.push(filter.roomId) }
    if (filter.pendingOnly) where.push("status = 'pending'")
    return this.all(`select data from approvals ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at desc`, ...args)
  }
  saveApproval(a: Approval) { this.db.prepare('insert or replace into approvals (id, room_id, status, data, created_at) values (?, ?, ?, ?, ?)').run(a.id, a.roomId ?? null, a.status, JSON.stringify(a), a.createdAt); return a }

  // tasks
  tasks(roomId: string): Task[] { return this.all('select data from tasks where room_id = ? order by created_at, id', roomId) }
  task(roomId: string, id: string): Task | undefined { return this.one('select data from tasks where room_id = ? and id = ?', roomId, id) }
  saveTask(t: Task) { this.db.prepare('insert or replace into tasks (room_id, id, data, created_at) values (?, ?, ?, ?)').run(t.roomId, t.id, JSON.stringify(t), t.createdAt); return t }

  // activity
  activity(roomId?: string, limit = 50): ActivityEvent[] {
    return roomId ? this.all('select data from activity where room_id = ? order by ts desc limit ?', roomId, limit) : this.all('select data from activity order by ts desc limit ?', limit)
  }
  saveActivity(e: ActivityEvent) { this.db.prepare('insert or ignore into activity (id, room_id, ts, data) values (?, ?, ?, ?)').run(e.id, e.roomId ?? null, e.ts, JSON.stringify(e)); return e }

  // overlaps the floor flagged, so a restart doesn't flag them again
  overlaps(): Overlap[] { return this.all('select data from overlaps') }
  saveOverlap(o: Overlap) { this.db.prepare('insert or replace into overlaps (id, room_id, data) values (?, ?, ?)').run(o.id, o.roomId, JSON.stringify(o)); return o }
  deleteOverlap(id: string) { this.db.prepare('delete from overlaps where id = ?').run(id) }

  // engine state that outlives a restart, one JSON value per key (usage limits, chats a limit stopped)
  meta<T>(key: string): T | undefined { return this.one('select data from meta where key = ?', key) }
  saveMeta<T>(key: string, value: T) { this.db.prepare('insert or replace into meta (key, data) values (?, ?)').run(key, JSON.stringify(value)); return value }

  private all<T>(sql: string, ...args: unknown[]): T[] { return (this.db.prepare(sql).all(...args) as { data: string }[]).map((r) => JSON.parse(r.data)) }
  private one<T>(sql: string, ...args: unknown[]): T | undefined { const r = this.db.prepare(sql).get(...args) as { data: string } | undefined; return r ? JSON.parse(r.data) : undefined }
}

export const newId = () => randomUUID()
