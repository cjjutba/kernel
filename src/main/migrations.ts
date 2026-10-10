import Database from 'better-sqlite3'
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
  }
]

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

/**
 * VACUUM INTO writes a consistent copy, WAL included, synchronously. It refuses a target that exists, so that goes first.
 * The new copy always stays, with the newest other one, even when a restored older file gives it the lowest version.
 */
function backUp(db: Database.Database, file: string, from: number): string {
  const target = `${file}.bak-v${from}`
  rmSync(target, { force: true })
  db.prepare('vacuum into ?').run(target)
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
