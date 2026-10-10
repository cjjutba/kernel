import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEEP_ACTIVITY_MS, KEEP_APPROVAL_INPUT_MS, Store } from '../src/main/db'
import { LATEST, migrate, migrations, NEWER_DATA, type Migration } from '../src/main/migrations'
import type { Approval } from '@shared/types'

const DAY = 24 * 60 * 60 * 1000
const dir = () => mkdtempSync(join(tmpdir(), 'kernel-db-'))
const TABLES = ['rooms', 'workspaces', 'chats', 'chat_items', 'approvals', 'notifications', 'activity', 'tasks', 'meta', 'overlaps']
const rows = (db: Database.Database, table: string) => db.prepare(`select * from ${table} order by rowid`).all() as Record<string, unknown>[]
const userVersion = (file: string) => { const db = new Database(file, { readonly: true }); try { return db.pragma('user_version', { simple: true }) } finally { db.close() } }
/** Every file in the folder with the hash of its bytes. */
const snapshot = (d: string) => Object.fromEntries(readdirSync(d).sort().map((n) => [n, createHash('sha256').update(readFileSync(join(d, n))).digest('hex')]))

/** A kernel.db as builds before KERNEL-210 left it: version 1 tables, WAL, nothing stamped, a row in every table. */
function oldDb(file: string) {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  migrations[0].up(db, 0)
  const now = Date.now()
  const put = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args)
  put('insert into rooms values (?, ?, ?)', 'r1', JSON.stringify({ id: 'r1', name: 'Invoices', createdAt: now }), now)
  put('insert into workspaces values (?, ?, ?, ?)', 'w1', 'r1', JSON.stringify({ id: 'w1', roomId: 'r1', status: 'active' }), now)
  put('insert into chats values (?, ?, ?, ?)', 'c1', 'w1', JSON.stringify({ id: 'c1', workspaceId: 'w1', title: 'Export' }), now)
  put('insert into chat_items values (?, ?, ?, ?)', 'i1', 'c1', 1, JSON.stringify({ kind: 'text', id: 'i1', ts: now, text: 'Done' }))
  put('insert into approvals values (?, ?, ?, ?, ?)', 'a1', 'r1', 'pending', JSON.stringify({ id: 'a1', kind: 'tool', status: 'pending', title: 'Run ls', createdAt: now }), now)
  put('insert into approvals values (?, ?, ?, ?, ?)', 'a2', 'r1', 'allowed', JSON.stringify({ id: 'a2', kind: 'tool', status: 'allowed', title: 'Run pwd', createdAt: now }), now)
  put('insert into notifications values (?, ?, ?, ?)', 'n1', 'r1', JSON.stringify({ id: 'n1', title: 'Finished' }), now)
  put('insert into activity values (?, ?, ?, ?)', 'e1', 'r1', now, JSON.stringify({ id: 'e1', ts: now, kind: 'chat.started' }))
  put('insert into tasks values (?, ?, ?, ?)', 'r1', 'T-1', JSON.stringify({ id: 'T-1', roomId: 'r1' }), now)
  put('insert into meta values (?, ?)', 'limits', JSON.stringify({ five: 1 }))
  put('insert into overlaps values (?, ?, ?)', 'o1', 'r1', JSON.stringify({ id: 'o1', roomId: 'r1' }))
  db.close()
}

const approval = (a: Partial<Approval> & Pick<Approval, 'id' | 'status'>): Approval => ({ kind: 'tool', source: 'sdk', roomId: 'r1', title: a.id, createdAt: Date.now(), ...a })

describe('kernel.db versions', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('upgrades a file from an earlier build, backs it up first and keeps every row', () => {
    const d = dir()
    const file = join(d, 'kernel.db')
    oldDb(file)
    const before = new Database(file, { readonly: true })
    const old = Object.fromEntries(TABLES.map((t) => [t, rows(before, t)]))
    before.close()

    const store = new Store(file)
    expect(store.db.pragma('user_version', { simple: true })).toBe(LATEST)
    expect(LATEST).toBe(2)
    for (const t of TABLES) {
      // Approvals gain two columns; the rest of each row stays as it was.
      const now = rows(store.db, t).map(({ settled_at: _s, pruned: _p, ...r }) => r)
      expect(now, t).toEqual(old[t])
    }
    const indexes = (store.db.prepare(`select name from sqlite_master where type = 'index'`).all() as { name: string }[]).map((r) => r.name)
    expect(indexes).toEqual(expect.arrayContaining(['approvals_by_room_status', 'chats_by_workspace', 'activity_by_ts']))
    const settled = store.db.prepare('select id, settled_at from approvals order by id').all() as { id: string; settled_at: number | null }[]
    expect(settled[0]).toEqual({ id: 'a1', settled_at: null })
    expect(settled[1].settled_at).toBeGreaterThan(Date.now() - 60_000)
    expect(store.rooms().map((r) => r.id)).toEqual(['r1'])
    store.db.close()

    // The copy is the file as it was: version 0, every row, none of the new columns.
    const backup = join(d, 'kernel.db.bak-v1')
    expect(userVersion(backup)).toBe(0)
    const copy = new Database(backup, { readonly: true })
    for (const t of TABLES) expect(rows(copy, t), t).toEqual(old[t])
    copy.close()

    // Opening again changes nothing and makes no second copy.
    const again = new Store(file)
    expect(again.approvals().map((a) => a.id).sort()).toEqual(['a1', 'a2'])
    again.db.close()
    expect(readdirSync(d).filter((n) => n.includes('.bak-'))).toEqual(['kernel.db.bak-v1'])
  })

  it('starts a new file at the latest version with no backup', () => {
    const d = dir()
    const store = new Store(join(d, 'kernel.db'))
    expect(store.db.pragma('user_version', { simple: true })).toBe(LATEST)
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(store.db.pragma('synchronous', { simple: true })).toBe(1)
    expect(store.db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(store.db.pragma('journal_size_limit', { simple: true })).toBe(64 * 1024 * 1024)
    store.db.close()
    expect(readdirSync(d).filter((n) => n.includes('.bak-'))).toEqual([])
  })

  it('replaces a leftover backup of the same version and keeps only the two newest', () => {
    const d = dir()
    const file = join(d, 'kernel.db')
    oldDb(file)
    writeFileSync(join(d, 'kernel.db.bak-v1'), 'left from a failed upgrade')
    writeFileSync(join(d, 'kernel.db.bak-v0'), 'older')
    const db = new Database(file)
    const step = (v: number): Migration => ({ version: v, up: (x) => x.exec(`create table t${v} (id text)`) })
    const list = [...migrations, step(3), step(4)]
    expect(migrate(db, file, Date.now(), list.slice(0, 2)).backup).toBe(join(d, 'kernel.db.bak-v1'))
    expect(migrate(db, file, Date.now(), list.slice(0, 3)).backup).toBe(join(d, 'kernel.db.bak-v2'))
    expect(migrate(db, file, Date.now(), list).backup).toBe(join(d, 'kernel.db.bak-v3'))
    db.close()
    expect(readdirSync(d).filter((n) => n.includes('.bak-')).sort()).toEqual(['kernel.db.bak-v2', 'kernel.db.bak-v3'])
    expect(userVersion(join(d, 'kernel.db.bak-v3'))).toBe(3)
  })

  it('keeps the copy it just made when a restored older file gives it the lowest version', () => {
    const d = dir()
    const file = join(d, 'kernel.db')
    oldDb(file)
    writeFileSync(join(d, 'kernel.db.bak-v2'), 'two')
    writeFileSync(join(d, 'kernel.db.bak-v3'), 'three')
    writeFileSync(join(d, 'kernel.db.bak-vX'), 'not a copy')
    new Store(file).db.close()
    expect(readdirSync(d).filter((n) => n.includes('.bak-')).sort()).toEqual(['kernel.db.bak-v1', 'kernel.db.bak-v3', 'kernel.db.bak-vX'])
    expect(userVersion(join(d, 'kernel.db.bak-v1'))).toBe(0)
  })

  it('opens its own file after a crash left committed rows in the -wal', () => {
    const d = dir()
    const src = join(d, 'live.db')
    const file = join(d, 'kernel.db')
    const live = new Store(src)
    live.saveRoom({ id: 'r1', name: 'Invoices', createdAt: 1 } as never)
    copyFileSync(src, file)
    copyFileSync(`${src}-wal`, `${file}-wal`)
    live.db.close()
    const store = new Store(file)
    expect(store.rooms().map((r) => r.id)).toEqual(['r1'])
    expect(store.db.pragma('user_version', { simple: true })).toBe(LATEST)
    store.db.close()
  })

  it('keeps the old file and its version when a migration fails', () => {
    const d = dir()
    const file = join(d, 'kernel.db')
    oldDb(file)
    const db = new Database(file)
    const broken: Migration = { version: 3, up: () => { throw new Error('boom') } }
    expect(() => migrate(db, file, Date.now(), [...migrations, broken])).toThrow('boom')
    expect(db.pragma('user_version', { simple: true })).toBe(0)
    expect((db.prepare(`select name from pragma_table_info('approvals')`).all() as { name: string }[]).map((c) => c.name)).not.toContain('settled_at')
    db.close()
    expect(existsSync(join(d, 'kernel.db.bak-v1'))).toBe(true)
  })

  describe('a file from a newer build', () => {
    const stamp99 = (file: string, wal: boolean) => {
      const db = new Database(file)
      if (wal) db.pragma('journal_mode = WAL')
      db.exec('create table rooms (id text primary key, data text not null, created_at integer not null)')
      db.prepare('insert into rooms values (?, ?, ?)').run('r1', '{"id":"r1"}', 1)
      db.pragma('user_version = 99')
      db.close()
    }

    for (const wal of [false, true]) {
      it(`refuses and leaves the folder byte for byte as it was (${wal ? 'WAL' : 'rollback journal'})`, () => {
        const d = dir()
        const file = join(d, 'kernel.db')
        stamp99(file, wal)
        const before = snapshot(d)
        expect(Object.keys(before)).toEqual(['kernel.db'])
        expect(() => new Store(file)).toThrow(NEWER_DATA)
        expect(snapshot(d)).toEqual(before)
      })
    }

    it('refuses when the newer stamp is still in the -wal file and leaves the database file as it was', () => {
      const d = dir()
      const src = join(d, 'live.db')
      const file = join(d, 'kernel.db')
      const live = new Database(src)
      live.pragma('journal_mode = WAL')
      live.pragma('wal_autocheckpoint = 0')
      live.exec('create table rooms (id text primary key, data text not null, created_at integer not null)')
      live.pragma('user_version = 99')
      // Copied while open: the header still says 0, the -wal holds version 99, as after a crash of a newer build.
      copyFileSync(src, file)
      copyFileSync(`${src}-wal`, `${file}-wal`)
      live.close()
      expect(readFileSync(file).readInt32BE(60)).toBe(0)
      const hash = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
      const main = hash(file)
      const wal = hash(`${file}-wal`)
      expect(() => new Store(file)).toThrow(NEWER_DATA)
      expect(hash(file)).toBe(main)
      expect(hash(`${file}-wal`)).toBe(wal)
      expect(readdirSync(d).filter((n) => n.startsWith('kernel.db')).sort()).toEqual(['kernel.db', 'kernel.db-wal'])
    })
  })
})

describe('pruning', () => {
  const now = Date.now()
  const settle = (store: Store, id: string, at: number) => store.db.prepare('update approvals set settled_at = ? where id = ?').run(at, id)

  it('drops old activity and settled tool input, and keeps pending approvals, plans and transcripts', () => {
    const store = new Store(':memory:')
    const old = now - KEEP_ACTIVITY_MS - DAY
    store.saveActivity({ id: 'old', ts: old, roomId: 'r1', kind: 'chat.started', text: '' } as never)
    store.saveActivity({ id: 'new', ts: now - DAY, roomId: 'r1', kind: 'chat.started', text: '' } as never)
    const write = { file_path: '/repo/src/big.ts', content: 'x'.repeat(50_000), lines: 400, edits: [{ a: 1 }] }
    store.saveApproval(approval({ id: 'settled', status: 'allowed', toolName: 'Write', input: write, createdAt: old }))
    store.saveApproval(approval({ id: 'bash', status: 'denied', toolName: 'Bash', input: { command: `echo ${'y'.repeat(300)}` }, createdAt: old }))
    store.saveApproval(approval({ id: 'recent', status: 'allowed', toolName: 'Write', input: write }))
    store.saveApproval(approval({ id: 'pending', status: 'pending', toolName: 'Write', input: write, createdAt: old }))
    store.saveApproval(approval({ id: 'plan', kind: 'plan', status: 'allowed', toolName: 'ExitPlanMode', input: { plan: 'p'.repeat(5000) }, createdAt: old }))
    for (const id of ['settled', 'bash', 'plan']) settle(store, id, now - KEEP_APPROVAL_INPUT_MS - DAY)
    store.saveChat({ id: 'c1', workspaceId: 'w1', title: 'Old chat', createdAt: old } as never)
    store.saveItem('c1', { kind: 'text', id: 'i1', ts: old, text: 'From long ago' })

    expect(store.prune(now)).toEqual({ activity: 1, approvals: 2 })
    expect(store.activity().map((e) => e.id)).toEqual(['new'])
    expect(store.approval('settled')?.input).toEqual({ file_path: '/repo/src/big.ts', content: `${'x'.repeat(200)}…`, lines: 400 })
    expect(store.approval('settled')?.title).toBe('settled')
    expect(store.approval('bash')?.input).toEqual({ command: `echo ${'y'.repeat(195)}…` })
    expect(store.approval('recent')?.input).toEqual(write)
    expect(store.approval('pending')?.input).toEqual(write)
    expect(store.approval('plan')?.input).toEqual({ plan: 'p'.repeat(5000) })
    expect(store.chats('w1').map((c) => c.id)).toEqual(['c1'])
    expect(store.items('c1')).toEqual([{ kind: 'text', id: 'i1', ts: old, text: 'From long ago' }])
    // A row is pruned once.
    expect(store.prune(now)).toEqual({ activity: 0, approvals: 0 })
  })

  it('counts the week from when an approval settled, not when it was asked', () => {
    const store = new Store(':memory:')
    const a = approval({ id: 'a', status: 'pending', toolName: 'Write', input: { content: 'z'.repeat(500) }, createdAt: now - 30 * DAY })
    store.saveApproval(a)
    store.saveApproval({ ...a, status: 'allowed' })
    expect(store.prune(now)).toEqual({ activity: 0, approvals: 0 })
    // Saving it again later, as linking a plan step does, keeps the first settle time.
    settle(store, 'a', now - KEEP_APPROVAL_INPUT_MS - DAY)
    store.saveApproval({ ...a, status: 'allowed', title: 'renamed' })
    expect(store.prune(now).approvals).toBe(1)
  })
})

describe('pruning rows other builds saved', () => {
  it('counts from when it was asked for a settled approval with no settle time', () => {
    const store = new Store(':memory:')
    const old = Date.now() - KEEP_APPROVAL_INPUT_MS - DAY
    store.db.prepare('insert into approvals (id, room_id, status, data, created_at) values (?, ?, ?, ?, ?)')
      .run('a', 'r1', 'allowed', JSON.stringify(approval({ id: 'a', status: 'allowed', input: { content: 'z'.repeat(500) }, createdAt: old })), old)
    expect(store.prune().approvals).toBe(1)
    // Saved as pending again, it can be pruned again once it settles.
    store.saveApproval(approval({ id: 'a', status: 'pending', input: { content: 'z'.repeat(500) } }))
    expect(store.db.prepare('select pruned, settled_at from approvals').get()).toEqual({ pruned: 0, settled_at: null })
  })
})

describe('store reads', () => {
  it('skips a row whose JSON does not parse and keeps the rest of the list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new Store(':memory:')
    store.saveRoom({ id: 'a', name: 'A', createdAt: 1 } as never)
    store.db.prepare('insert into rooms values (?, ?, ?)').run('bad', '{"id": "bad", nope', 2)
    store.saveRoom({ id: 'c', name: 'C', createdAt: 3 } as never)
    expect(store.rooms().map((r) => r.id)).toEqual(['a', 'c'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad JSON'))
    expect(store.room('bad')).toBeUndefined()
    expect(store.room('a')?.id).toBe('a')
    vi.restoreAllMocks()
  })

  it('reads one approval by id', () => {
    const store = new Store(':memory:')
    store.saveApproval(approval({ id: 'one', status: 'pending' }))
    store.saveApproval(approval({ id: 'two', status: 'allowed' }))
    expect(store.approval('two')?.status).toBe('allowed')
    expect(store.approval('nope')).toBeUndefined()
  })
})
