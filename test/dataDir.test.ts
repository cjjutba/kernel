import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_FOLDER, DEV_FOLDER, dataDirs, moveToDev, openBy, removeJiraAccount, unshareHookToken } from '../src/main/dataDir'

// KERNEL-408: a dev run moves the data from Kernel to Kernel Dev on its first launch. Every test works in a temp folder
// standing in for ~/Library/Application Support.

/** A temp appData with a Kernel folder holding a database of `rows` and the files a running Kernel keeps. */
function appData(rows = 3) {
  const root = mkdtempSync(join(tmpdir(), 'kernel-datadir-'))
  const from = join(root, APP_FOLDER)
  mkdirSync(from)
  const db = new Database(join(from, 'kernel.db'))
  db.pragma('journal_mode = WAL')
  db.exec('create table projects (id text primary key)')
  for (let i = 0; i < rows; i++) db.prepare('insert into projects values (?)').run(`project-${i}`)
  db.close()
  writeFileSync(join(from, 'settings.json'), '{"hookPort":51234}')
  writeFileSync(join(from, 'hook-token'), 'a'.repeat(64))
  writeFileSync(join(from, 'trust.json'), '{}')
  writeFileSync(join(from, 'integrations.json'), '{}')
  writeFileSync(join(from, 'env.json'), '{}')
  mkdirSync(join(from, 'room-icons'))
  writeFileSync(join(from, 'room-icons', 'r1.png'), 'png')
  mkdirSync(join(from, 'shared', 'w1'), { recursive: true })
  writeFileSync(join(from, 'shared', 'w1', 'plan.html'), '<p>plan</p>')
  mkdirSync(join(from, 'Local Storage', 'leveldb'), { recursive: true })
  writeFileSync(join(from, 'Local Storage', 'leveldb', '000003.log'), 'drafts')
  // Left behind on purpose.
  writeFileSync(join(from, 'update.json'), '{}')
  writeFileSync(join(from, 'telemetry.json'), '{}')
  writeFileSync(join(from, 'telemetry-queue.json'), '[]')
  mkdirSync(join(from, 'logs'))
  mkdirSync(join(from, 'Cache'))
  return { root, from, to: join(root, DEV_FOLDER) }
}

const projects = (file: string) => {
  const db = new Database(file, { readonly: true })
  try { return (db.prepare('select id from projects order by id').all() as { id: string }[]).map((r) => r.id) } finally { db.close() }
}

/** A Chromium lock as a running Kernel leaves it. */
const lock = (dir: string, target: string) => symlinkSync(target, join(dir, 'SingletonLock'))

describe('dataDirs', () => {
  it('gives the installed app Kernel and a dev run Kernel Dev', () => {
    expect(dataDirs('/AS', true)).toEqual({ own: '/AS/Kernel', other: '/AS/Kernel Dev', name: 'Kernel', otherName: 'Kernel Dev' })
    expect(dataDirs('/AS', false)).toEqual({ own: '/AS/Kernel Dev', other: '/AS/Kernel', name: 'Kernel Dev', otherName: 'Kernel' })
  })

  it('gives a dev run started inside a workspace a folder of its own, and never the installed app (KERNEL-679)', () => {
    const id = 'b9e166a7-cd54-4995-87af-0340e54eec38'
    expect(dataDirs('/AS', false, id)).toEqual({ own: `/AS/Kernel Dev Runs/${id}`, other: '/AS/Kernel Dev', name: 'Kernel Dev Runs', otherName: 'Kernel Dev', run: true })
    // The installed app opened from a workspace's terminal is still the installed app.
    expect(dataDirs('/AS', true, id)).toEqual(dataDirs('/AS', true))
    // No id, or one that is no folder name, is a plain dev run.
    for (const bad of [undefined, '', '../Kernel', 'a/b', '.', '-x']) expect(dataDirs('/AS', false, bad)).toEqual(dataDirs('/AS', false))
  })
})

describe('openBy', () => {
  it('counts a lock held by a live process on this Mac', () => {
    const { from } = appData()
    lock(from, `${hostname()}-${process.pid}`)
    expect(openBy(from)).toBe(true)
  })

  it('ignores a stale lock, another host, a garbled lock and no lock', () => {
    const dead = appData().from
    lock(dead, `${hostname()}-99999999`)
    expect(openBy(dead)).toBe(false)
    const elsewhere = appData().from
    lock(elsewhere, `other-mac.local-${process.pid}`)
    expect(openBy(elsewhere)).toBe(false)
    const garbled = appData().from
    lock(garbled, 'nonsense')
    expect(openBy(garbled)).toBe(false)
    expect(openBy(appData().from)).toBe(false)
  })

  it('reads a host name that has dashes in it', () => {
    const { from } = appData()
    lock(from, `cjs-mac-mini.local-${process.pid}`)
    expect(openBy(from, 'cjs-mac-mini.local')).toBe(true)
  })
})

describe('moveToDev', () => {
  it('moves the database and the listed files, and leaves caches, logs, telemetry and the hook token behind', () => {
    const { from, to } = appData()
    expect(moveToDev({ from, to })).toBe('moved')
    expect(projects(join(to, 'kernel.db'))).toEqual(['project-0', 'project-1', 'project-2'])
    // Each build has its own token, so both can run at once (KERNEL-675).
    expect(existsSync(join(to, 'hook-token'))).toBe(false)
    expect(readFileSync(join(from, 'hook-token'), 'utf8')).toBe('a'.repeat(64))
    expect(readFileSync(join(to, 'settings.json'), 'utf8')).toBe('{"hookPort":51234}')
    expect(readFileSync(join(to, 'room-icons', 'r1.png'), 'utf8')).toBe('png')
    expect(readFileSync(join(to, 'shared', 'w1', 'plan.html'), 'utf8')).toBe('<p>plan</p>')
    expect(readFileSync(join(to, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe('drafts')
    expect(readdirSync(to).sort()).toEqual(['Local Storage', 'env.json', 'integrations.json', 'kernel.db', 'room-icons', 'settings.json', 'shared'])
    expect(existsSync(`${to}.partial`)).toBe(false)
  })

  it('carries rows that were only in the WAL', () => {
    const { from, to } = appData(1)
    // A Kernel that crashed leaves committed rows in kernel.db-wal. Copy the pair while a connection holds it open.
    const snapshot = join(from, 'snapshot')
    mkdirSync(snapshot)
    const live = new Database(join(from, 'kernel.db'))
    live.pragma('wal_autocheckpoint = 0')
    live.prepare('insert into projects values (?)').run('only-in-wal')
    expect(existsSync(join(from, 'kernel.db-wal'))).toBe(true)
    copyFileSync(join(from, 'kernel.db'), join(snapshot, 'kernel.db'))
    copyFileSync(join(from, 'kernel.db-wal'), join(snapshot, 'kernel.db-wal'))
    live.close()
    copyFileSync(join(snapshot, 'kernel.db'), join(snapshot, 'alone.db'))
    expect(projects(join(snapshot, 'alone.db'))).toEqual(['project-0'])
    copyFileSync(join(snapshot, 'kernel.db'), join(from, 'kernel.db'))
    copyFileSync(join(snapshot, 'kernel.db-wal'), join(from, 'kernel.db-wal'))
    expect(moveToDev({ from, to })).toBe('moved')
    expect(projects(join(to, 'kernel.db'))).toEqual(['only-in-wal', 'project-0'])
  })

  it('sets the old database aside as a backup that opens on its own, with no WAL left', () => {
    const { from, to } = appData()
    expect(moveToDev({ from, to })).toBe('moved')
    expect(existsSync(join(from, 'kernel.db'))).toBe(false)
    for (const end of ['-wal', '-shm']) {
      expect(existsSync(join(from, `kernel.db${end}`))).toBe(false)
      expect(existsSync(join(from, `kernel.db.moved-to-dev${end}`))).toBe(false)
    }
    expect(projects(join(from, 'kernel.db.moved-to-dev'))).toEqual(['project-0', 'project-1', 'project-2'])
    // Everything else in Kernel stays where it was.
    expect(readFileSync(join(from, 'hook-token'), 'utf8')).toBe('a'.repeat(64))
    expect(existsSync(join(from, 'update.json'))).toBe(true)
  })

  it('starts over after a crash halfway through', () => {
    const { from, to } = appData()
    // A crash after the copy began: a partial folder with junk, and some entries already renamed into Kernel Dev.
    mkdirSync(join(`${to}.partial`, 'shared'), { recursive: true })
    writeFileSync(join(`${to}.partial`, 'kernel.db'), 'half a database')
    mkdirSync(to)
    writeFileSync(join(to, 'settings.json'), '{"stale":true}')
    expect(moveToDev({ from, to })).toBe('moved')
    expect(projects(join(to, 'kernel.db'))).toEqual(['project-0', 'project-1', 'project-2'])
    expect(readFileSync(join(to, 'settings.json'), 'utf8')).toBe('{"hookPort":51234}')
    expect(existsSync(`${to}.partial`)).toBe(false)
  })

  it('keeps what Chromium put in Kernel Dev when it took the lock', () => {
    const { from, to } = appData()
    mkdirSync(to)
    lock(to, `${hostname()}-${process.pid}`)
    expect(moveToDev({ from, to })).toBe('moved')
    expect(openBy(to)).toBe(true)
  })

  it('moves nothing when Kernel Dev already has a database', () => {
    const { from, to } = appData()
    mkdirSync(to)
    writeFileSync(join(to, 'kernel.db'), '')
    expect(moveToDev({ from, to })).toBe('has-data')
    expect(projects(join(from, 'kernel.db'))).toHaveLength(3)
  })

  it('moves nothing when Kernel has no database', () => {
    const root = mkdtempSync(join(tmpdir(), 'kernel-datadir-'))
    expect(moveToDev({ from: join(root, APP_FOLDER), to: join(root, DEV_FOLDER) })).toBe('nothing')
    expect(existsSync(join(root, DEV_FOLDER))).toBe(false)
  })

  it('moves nothing while a running Kernel holds the folder', () => {
    const { from, to } = appData()
    lock(from, `${hostname()}-${process.pid}`)
    expect(moveToDev({ from, to })).toBe('in-use')
    expect(existsSync(to)).toBe(false)
    expect(existsSync(`${to}.partial`)).toBe(false)
    expect(existsSync(join(from, 'kernel.db'))).toBe(true)
    expect(existsSync(join(from, 'kernel.db.moved-to-dev'))).toBe(false)
  })

  it('moves past a stale lock a crash left behind', () => {
    const { from, to } = appData()
    lock(from, `${hostname()}-99999999`)
    expect(moveToDev({ from, to })).toBe('moved')
    expect(projects(join(to, 'kernel.db'))).toHaveLength(3)
  })
})

describe('unshareHookToken (KERNEL-675)', () => {
  it('removes the token Kernel Dev copied from Kernel before KERNEL-675, and leaves Kernel\'s', () => {
    const { from, to } = appData()
    mkdirSync(to)
    writeFileSync(join(to, 'hook-token'), 'a'.repeat(64) + '\n')
    expect(unshareHookToken({ own: to, other: from })).toBe(true)
    expect(existsSync(join(to, 'hook-token'))).toBe(false)
    expect(readFileSync(join(from, 'hook-token'), 'utf8')).toBe('a'.repeat(64))
    // Once is enough: nothing is shared after.
    expect(unshareHookToken({ own: to, other: from })).toBe(false)
  })

  it('keeps a token of its own, and does nothing when either build has none', () => {
    const { from, to } = appData()
    mkdirSync(to)
    expect(unshareHookToken({ own: to, other: from })).toBe(false)
    writeFileSync(join(to, 'hook-token'), 'b'.repeat(64))
    expect(unshareHookToken({ own: to, other: from })).toBe(false)
    expect(readFileSync(join(to, 'hook-token'), 'utf8')).toBe('b'.repeat(64))
    expect(unshareHookToken({ own: to, other: join(from, 'missing') })).toBe(false)
  })
})

describe('removeJiraAccount (remove-jira)', () => {
  it('deletes the Jira account file and leaves the rest of the data folder, and a folder without one is fine', () => {
    const { from } = appData()
    writeFileSync(join(from, 'jira.json'), JSON.stringify({ site: 'acme.atlassian.net', email: 'a@b.c', token: 'secret' }))
    removeJiraAccount(from)
    expect(existsSync(join(from, 'jira.json'))).toBe(false)
    expect(existsSync(join(from, 'integrations.json'))).toBe(true)
    expect(() => removeJiraAccount(from)).not.toThrow()
  })
})
