import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// kernel.db carries its schema version in `PRAGMA user_version` (KERNEL-210, amends D-005). Each migration runs once, in
// order, inside one transaction with the version it sets. Add a migration to the end; never edit one that has shipped.

export const NEWER_DATA = 'This data was written by a newer version of Kernel. Update Kernel to open it.'

export type Migration = { version: number; up: (db: Database.Database, now: number) => void }

/** Version 1 is the schema every build before KERNEL-210 created, with no version stamped. */
const V1 = `
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

export const migrations: Migration[] = [
  { version: 1, up: (db) => db.exec(V1) },
  {
    // Indexes for the inbox, the sidebar and the global activity list. `settled_at` is when an approval stopped being
    // pending, which pruning needs. Rows already settled get the migration time, so their input waits the full week.
    version: 2,
    up: (db, now) => {
      db.exec(`
        create index if not exists approvals_by_room_status on approvals (room_id, status);
        create index if not exists chats_by_workspace on chats (workspace_id);
        create index if not exists activity_by_ts on activity (ts);
        alter table approvals add column settled_at integer;
        alter table approvals add column pruned integer not null default 0;
      `)
      db.prepare(`update approvals set settled_at = ? where status != 'pending'`).run(now)
    }
  },
  {
    // Files agents shared (KERNEL-302). One row per workspace and source path, with every version in `data`.
    version: 3,
    up: (db) => db.exec(`
      create table if not exists shared_files (id text primary key, room_id text not null, workspace_id text not null, source text not null, data text not null, created_at integer not null, updated_at integer not null);
      create unique index if not exists shared_files_by_source on shared_files (workspace_id, source);
      create index if not exists shared_files_by_room on shared_files (room_id, updated_at);
    `)
  },
  {
    // comments on shared files, per version (KERNEL-310)
    version: 4,
    up: (db) => db.exec(`
      create table if not exists shared_comments (id text primary key, shared_id text not null, version integer not null, data text not null, created_at integer not null);
      create index if not exists shared_comments_by_version on shared_comments (shared_id, version);
    `)
  },
  {
    // Lead chats that hold several tabs (KERNEL-337). Every Lead tab there is, open or closed, becomes the only tab of its own
    // thread, titled like the tab and closed with it, so nothing moves on upgrade. The Lead's workspace is the room's
    // `current` workspace named "lead"; a chat with no kind predates terminals and is a chat.
    version: 5,
    up: (db, now) => {
      db.exec(`
        create table if not exists threads (id text primary key, room_id text not null, data text not null, created_at integer not null);
        create index if not exists threads_by_room on threads (room_id, created_at);
      `)
      const tabs = db.prepare(`
        select c.id, c.data, w.room_id from chats c join workspaces w on w.id = c.workspace_id
        where json_extract(w.data, '$.mode') = 'current' and json_extract(w.data, '$.name') = 'lead'
          and coalesce(json_extract(c.data, '$.kind'), 'chat') = 'chat' and json_extract(c.data, '$.threadId') is null
      `).all() as { id: string; data: string; room_id: string }[]
      const thread = db.prepare('insert into threads (id, room_id, data, created_at) values (?, ?, ?, ?)')
      const chat = db.prepare('update chats set data = ? where id = ?')
      for (const t of tabs) {
        let c: { title?: string; closed?: boolean; createdAt?: number }
        try { c = JSON.parse(t.data) } catch { continue }
        const id = randomUUID()
        const createdAt = c.createdAt ?? now
        thread.run(id, t.room_id, JSON.stringify({ id, roomId: t.room_id, title: c.title ?? '', createdAt, ...(c.closed ? { closedAt: now } : {}) }), createdAt)
        chat.run(JSON.stringify({ ...c, threadId: id }), t.id)
      }
      // A handed-off workspace keeps the Lead chat of the tab that handed it off. One with no Lead tab gets none.
      db.exec(`
        update workspaces set data = json_set(data, '$.threadId', (select json_extract(c.data, '$.threadId') from chats c where c.id = json_extract(workspaces.data, '$.leadChatId')))
        where json_extract(data, '$.threadId') is null
          and (select json_extract(c.data, '$.threadId') from chats c where c.id = json_extract(workspaces.data, '$.leadChatId')) is not null
      `)
    }
  },
  {
    // What each Lead chat owes until the Lead acts on it (KERNEL-749). `key` is what a newer item of the same kind replaces:
    // one question per workspace, one set of blockers per reviewed workspace, one mention per tab and teammate.
    version: 6,
    up: (db) => db.exec(`
      create table if not exists open_items (id text primary key, thread_id text not null, room_id text not null, key text not null, data text not null, created_at integer not null);
      create unique index if not exists open_items_by_key on open_items (thread_id, key);
    `)
  },
  {
    // Deleting a Lead chat left its open items behind (KERNEL-791). Its items go now, and with the chat from here on.
    version: 7,
    up: (db) => db.exec('delete from open_items where thread_id not in (select id from threads)')
  },
  {
    // Rooms are projects (KERNEL-880). The table, each room_id column and the indexes named after rooms take the new name,
    // and so do `roomId` in each row's data, the room.paused and room.resumed activity kinds, and `roomId` anywhere in meta.
    version: 8,
    up: (db) => {
      db.exec(`
        drop index if exists activity_by_room;
        drop index if exists approvals_by_room_status;
        drop index if exists shared_files_by_room;
        drop index if exists threads_by_room;
        alter table rooms rename to projects;
        ${PROJECT_TABLES.map((t) => `alter table ${t} rename column room_id to project_id;`).join('\n')}
        create index if not exists activity_by_project on activity (project_id, ts);
        create index if not exists approvals_by_project_status on approvals (project_id, status);
        create index if not exists shared_files_by_project on shared_files (project_id, updated_at);
        create index if not exists threads_by_project on threads (project_id, created_at);
      `)
      for (const t of PROJECT_TABLES) {
        db.exec(`update ${t} set data = json_remove(json_set(data, '$.projectId', json_extract(data, '$.roomId')), '$.roomId') where json_valid(data) and json_type(data, '$.roomId') is not null`)
      }
      db.exec(`update activity set data = json_set(data, '$.kind', 'project.' || substr(json_extract(data, '$.kind'), 6)) where json_valid(data) and json_extract(data, '$.kind') in ('room.paused', 'room.resumed')`)
      // Meta holds roomId deeper down, as in leadUpdates' pending entries, so each row that has one is rewritten whole.
      const rows = db.prepare(`select key, data from meta where data like '%"roomId"%'`).all() as { key: string; data: string }[]
      const save = db.prepare('update meta set data = ? where key = ?')
      for (const r of rows) {
        let v: unknown
        try { v = JSON.parse(r.data) } catch { continue }
        save.run(JSON.stringify(renameKey(v, 'roomId', 'projectId')), r.key)
      }
    }
  },
  {
    // Terminal seats were deleted (KERNEL-1037). Their rows go: the transcript rows read from a terminal's Claude Code session,
    // the seat fields on a terminal chat, its inbox rows, the Team updates and messages kept for one, and the folder of
    // per-tab launch files. A terminal chat stays as a plain big terminal.
    version: 9,
    up: (db) => {
      db.exec(`
        delete from chat_items where json_valid(data) and (json_extract(data, '$.source') = 'terminal' or json_extract(data, '$.kind') = 'plan');
        update chats set data = json_remove(data, '$.seat', '$.terminal.role', '$.terminal.sessionId', '$.terminal.transcriptPath', '$.terminal.handoff') where json_valid(data) and json_extract(data, '$.kind') = 'terminal';
        delete from notifications where id like 'n-seat-%' or id like 'n-ask-%';
        delete from meta where key = 'seatMessages';
        update meta set data = json_remove(data, '$.seatQueue') where key = 'leadUpdates' and json_valid(data);
      `)
      if (db.name && db.name !== ':memory:') rmSync(join(dirname(db.name), 'seats'), { recursive: true, force: true })
    }
  }
]

/** The tables with a room_id column before version 8. */
const PROJECT_TABLES = ['workspaces', 'threads', 'open_items', 'approvals', 'notifications', 'activity', 'tasks', 'overlaps', 'shared_files']

/** `v` with every object key `from` renamed `to`, at any depth. */
function renameKey(v: unknown, from: string, to: string): unknown {
  if (Array.isArray(v)) return v.map((x) => renameKey(x, from, to))
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k === from ? to : k, renameKey(x, from, to)]))
}

export const LATEST = migrations[migrations.length - 1].version

/**
 * Throws NEWER_DATA when the file was written by a newer build, before SQLite opens it. Opening it would add -wal and
 * -shm files, and closing would checkpoint into the file. The version comes from the file header, or from a leftover
 * -wal when that holds a newer committed copy of the header, as after a newer build crashed.
 */
export function refuseNewer(file: string) {
  if (file === ':memory:' || !existsSync(file)) return
  const wal = `${file}-wal`
  const v = (existsSync(wal) ? walVersion(wal) : undefined) ?? headerVersion(file) ?? 0
  if (v > LATEST) throw new Error(NEWER_DATA)
}

/**
 * Brings the database to LATEST. A file at 0 that already has tables is a version 1 file from an earlier build. Before
 * an existing file changes, its copy goes to `<file>.bak-v<from>` and only the two newest copies stay.
 */
export function migrate(db: Database.Database, file: string, now = Date.now(), list = migrations): { from: number; to: number; backup?: string } {
  const latest = list[list.length - 1].version
  const stamped = version(db)
  if (stamped > latest) throw new Error(NEWER_DATA)
  const existing = stamped > 0 || hasTables(db)
  const from = stamped === 0 && existing ? 1 : stamped
  if (stamped === latest) return { from, to: latest }
  const backup = existing && file !== ':memory:' ? backUp(db, file, from) : undefined
  db.transaction(() => {
    // A file from an earlier build runs version 1 again: every statement is `if not exists`, so a current file is unchanged.
    for (const m of list) if (m.version > stamped) { m.up(db, now); db.pragma(`user_version = ${m.version}`) }
  })()
  return { from, to: latest, backup }
}

/** VACUUM INTO writes a consistent copy, WAL included, synchronously. It refuses a target that exists, so that goes first. */
export function copyDatabase(db: Database.Database, target: string) {
  rmSync(target, { force: true })
  db.prepare('vacuum into ?').run(target)
}

/** The new copy always stays, with the newest other one, even when a restored older file gives it the lowest version. */
function backUp(db: Database.Database, file: string, from: number): string {
  const target = `${file}.bak-v${from}`
  copyDatabase(db, target)
  const name = basename(file)
  const copies = readdirSync(dirname(file))
    .flatMap((n) => (n !== basename(target) && n.startsWith(`${name}.bak-v`) && /^\d+$/.test(n.slice(name.length + 6)) ? [{ n, v: Number(n.slice(name.length + 6)) }] : []))
    .sort((a, b) => b.v - a.v)
  for (const c of copies.slice(1)) rmSync(join(dirname(file), c.n), { force: true })
  return target
}

const version = (db: Database.Database) => db.pragma('user_version', { simple: true }) as number
const hasTables = (db: Database.Database) => !!db.prepare(`select 1 from sqlite_master where type = 'table' and name not like 'sqlite_%' limit 1`).get()

/**
 * `user_version` from the newest committed copy of page 1 in a -wal file (sqlite.org/fileformat.html, WAL format), or
 * undefined when it holds none. Frames count only up to the first one whose salts or running checksum don't match.
 */
function walVersion(wal: string): number | undefined {
  const b = readFileSync(wal)
  if (b.length < 32) return undefined
  const magic = b.readUInt32BE(0)
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return undefined
  const word = magic === 0x377f0683 ? (o: number) => b.readUInt32BE(o) : (o: number) => b.readUInt32LE(o)
  const sum = (from: number, to: number, [s0, s1]: number[]) => {
    for (let o = from; o < to; o += 8) { s0 = (s0 + word(o) + s1) >>> 0; s1 = (s1 + word(o + 4) + s0) >>> 0 }
    return [s0, s1]
  }
  let s = sum(0, 24, [0, 0])
  if (s[0] !== b.readUInt32BE(24) || s[1] !== b.readUInt32BE(28)) return undefined
  const size = b.readUInt32BE(8)
  let latest: number | undefined
  let committed: number | undefined
  for (let o = 32; o + 24 + size <= b.length; o += 24 + size) {
    if (b.readUInt32BE(o + 8) !== b.readUInt32BE(16) || b.readUInt32BE(o + 12) !== b.readUInt32BE(20)) break
    s = sum(o + 24, o + 24 + size, sum(o, o + 8, s))
    if (s[0] !== b.readUInt32BE(o + 16) || s[1] !== b.readUInt32BE(o + 20)) break
    if (b.readUInt32BE(o) === 1) latest = b.readInt32BE(o + 24 + 60)
    if (b.readUInt32BE(o + 4) !== 0) committed = latest
  }
  return committed
}

/** `user_version` sits at byte 60 of the 100-byte header, big-endian. Undefined when the file isn't a database yet. */
function headerVersion(file: string): number | undefined {
  const fd = openSync(file, 'r')
  try {
    const h = Buffer.alloc(100)
    if (readSync(fd, h, 0, 100, 0) < 100 || h.toString('latin1', 0, 16) !== 'SQLite format 3\0') return undefined
    return h.readInt32BE(60)
  } finally { closeSync(fd) }
}
