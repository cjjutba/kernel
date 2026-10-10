import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import { tempRepo } from './helpers'
import { bus } from '../src/main/bus'
import { git } from '../src/main/services/exec'
import type { ExecResult } from '../src/main/services/exec'
import { AVATAR_FAILED, checkImage, githubAvatar, githubOwner, ICON_MAX_BYTES, imageType, NOT_AN_IMAGE, TOO_BIG } from '../src/main/services/roomIcons'
import { Kernel } from '../src/main/kernel'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8])
const AVATAR_URL = 'https://avatars.githubusercontent.com/u/123?v=4'

/** gh that answers `api users/<owner>` with the avatar URL, and records each call. */
function stubGh(calls: string[][], answer: ExecResult = { code: 0, stdout: `${AVATAR_URL}\n`, stderr: '' }) {
  return async (args: string[]) => { calls.push(args); return answer }
}

/** fetch that serves `body` and records the URL it was asked for. */
function stubFetch(urls: string[], body: Buffer = PNG) {
  return (async (url: string | URL | Request) => { urls.push(String(url)); return new Response(new Uint8Array(body)) }) as typeof fetch
}

const offline = (async () => { throw new TypeError('fetch failed') }) as typeof fetch

describe('room icon checks', () => {
  it('knows a PNG and a JPEG by their first bytes and nothing else', () => {
    expect(imageType(PNG)).toBe('png')
    expect(imageType(JPEG)).toBe('jpg')
    expect(imageType(Buffer.from('GIF89a'))).toBeNull()
    expect(imageType(Buffer.from([0x89, 0x50]))).toBeNull()
  })

  it('rejects a file that is not PNG or JPEG, or is over 2 MB, with a plain error', () => {
    expect(() => checkImage(Buffer.from('<svg/>'))).toThrow(NOT_AN_IMAGE)
    const big = Buffer.alloc(ICON_MAX_BYTES + 1)
    PNG.copy(big)
    expect(() => checkImage(big)).toThrow(TOO_BIG)
    expect(checkImage(big.subarray(0, ICON_MAX_BYTES))).toBe('png')
  })

  it('takes the owner from owner/repo, and none from a room off GitHub', () => {
    expect(githubOwner('samrivera/client-a')).toBe('samrivera')
    expect(githubOwner(undefined)).toBeNull()
    expect(githubOwner('')).toBeNull()
  })
})

describe('GitHub avatar (gh and fetch stubbed)', () => {
  it('asks gh for the avatar URL and downloads it at 128 px', async () => {
    const calls: string[][] = []
    const urls: string[] = []
    const buf = await githubAvatar('acme', { gh: stubGh(calls), fetch: stubFetch(urls) })
    expect(calls).toEqual([['api', 'users/acme', '--jq', '.avatar_url']])
    expect(urls).toEqual([`${AVATAR_URL}&s=128`])
    expect(buf.equals(PNG)).toBe(true)
  })

  it('throws the plain error without gh, offline, or when GitHub sends something that is not an image', async () => {
    const noGh = stubGh([], { code: 127, stdout: '', stderr: 'spawn gh ENOENT' })
    await expect(githubAvatar('acme', { gh: noGh, fetch: stubFetch([]) })).rejects.toThrow(AVATAR_FAILED)
    await expect(githubAvatar('acme', { gh: stubGh([]), fetch: offline })).rejects.toThrow(AVATAR_FAILED)
    await expect(githubAvatar('acme', { gh: stubGh([]), fetch: stubFetch([], Buffer.from('<html>')) })).rejects.toThrow(AVATAR_FAILED)
    const notFound = stubGh([], { code: 1, stdout: '', stderr: 'HTTP 404' })
    await expect(githubAvatar('nobody', { gh: notFound, fetch: stubFetch([]) })).rejects.toThrow(AVATAR_FAILED)
  })
})

describe('room icons in the kernel', () => {
  const kernels: Kernel[] = []
  const listeners: ((e: PushEvent) => void)[] = []
  afterEach(() => {
    for (const k of kernels.splice(0)) k.store.db.close()
    for (const l of listeners.splice(0)) bus.off('push', l)
  })

  async function setup(o: { remote?: boolean } = { remote: true }) {
    const repo = await tempRepo()
    if (o.remote) await git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/client-a.git')
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const k = new Kernel({ dataDir })
    kernels.push(k)
    const gh: string[][] = []
    let fetchImpl: typeof fetch = stubFetch([])
    k.avatar = (owner) => githubAvatar(owner, { gh: stubGh(gh), fetch: (...a) => fetchImpl(...a) })
    const room = await k.addRoom(repo)
    const pushes: PushEvent[] = []
    const listen = (e: PushEvent) => { if (e.type === 'room' && e.room.id === room.id) pushes.push(e) }
    bus.on('push', listen)
    listeners.push(listen)
    const files = async () => (await readdir(join(dataDir, 'room-icons')).catch(() => [])).sort()
    const pick = async (name: string, body: Buffer) => { const p = join(dataDir, name); await writeFile(p, body); return p }
    return { k, h: k.handlers(), room, gh, pushes, files, pick, goOffline: () => { fetchImpl = offline } }
  }

  it('github: saves the owner avatar, pushes the room and serves it as a PNG data URL', async () => {
    const { k, h, room, gh, pushes, files } = await setup()
    const saved = await h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'github' } })
    expect(gh).toEqual([['api', 'users/acme', '--jq', '.avatar_url']])
    expect(saved.icon).toMatchObject({ kind: 'github', file: `${room.id}-${saved.icon?.at}.png` })
    expect(k.store.room(room.id)?.icon).toEqual(saved.icon)
    expect(pushes.map((e) => e.type === 'room' && e.room.icon)).toEqual([saved.icon])
    expect(await files()).toEqual([saved.icon?.file])
    expect(await h['rooms.icon']({ roomId: room.id })).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
  })

  it('image: saves a picked JPEG, deletes the old icon file and serves it as a JPEG data URL', async () => {
    const { h, room, pushes, files, pick } = await setup()
    const first = await h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'github' } })
    const saved = await h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'image', path: await pick('logo.jpeg', JPEG) } })
    expect(saved.icon).toMatchObject({ kind: 'image', file: `${room.id}-${saved.icon?.at}.jpg` })
    expect(saved.icon!.at).toBeGreaterThan(first.icon!.at)
    expect(await files()).toEqual([saved.icon?.file])
    expect(pushes).toHaveLength(2)
    expect(await h['rooms.icon']({ roomId: room.id })).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`)
  })

  it('letter: clears the icon, deletes the file, pushes the room and serves null', async () => {
    const { k, h, room, pushes, files, pick } = await setup()
    await h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'image', path: await pick('logo.png', PNG) } })
    const saved = await h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'letter' } })
    expect(saved.icon).toBeUndefined()
    expect(k.store.room(room.id)?.icon).toBeUndefined()
    expect(pushes.at(-1)).toEqual({ type: 'room', room: saved })
    expect(await files()).toEqual([])
    expect(await h['rooms.icon']({ roomId: room.id })).toBeNull()
  })

  it('rejects a picked file that is not PNG or JPEG, or is over 2 MB, and keeps the icon it had', async () => {
    const { k, h, room, pushes, files, pick } = await setup()
    const first = await h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'image', path: await pick('logo.png', PNG) } })
    await expect(h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'image', path: await pick('logo.gif', Buffer.from('GIF89a......')) } })).rejects.toThrow(NOT_AN_IMAGE)
    const big = Buffer.alloc(ICON_MAX_BYTES + 1)
    PNG.copy(big)
    await expect(h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'image', path: await pick('huge.png', big) } })).rejects.toThrow(TOO_BIG)
    expect(k.store.room(room.id)?.icon).toEqual(first.icon)
    expect(await files()).toEqual([first.icon?.file])
    expect(pushes).toHaveLength(1)
  })

  it('offline, without gh, or for a room off GitHub: a plain error, and the room keeps its letter', async () => {
    const offlineRoom = await setup()
    offlineRoom.goOffline()
    await expect(offlineRoom.h['rooms.setIcon']({ roomId: offlineRoom.room.id, icon: { kind: 'github' } })).rejects.toThrow(AVATAR_FAILED)
    expect(offlineRoom.k.store.room(offlineRoom.room.id)?.icon).toBeUndefined()
    expect(await offlineRoom.files()).toEqual([])
    expect(offlineRoom.pushes).toEqual([])
    expect(await offlineRoom.h['rooms.icon']({ roomId: offlineRoom.room.id })).toBeNull()

    const noGh = await setup()
    noGh.k.avatar = (owner) => githubAvatar(owner, { gh: stubGh([], { code: 127, stdout: '', stderr: 'spawn gh ENOENT' }), fetch: stubFetch([]) })
    await expect(noGh.h['rooms.setIcon']({ roomId: noGh.room.id, icon: { kind: 'github' } })).rejects.toThrow(AVATAR_FAILED)
    expect(noGh.k.store.room(noGh.room.id)?.icon).toBeUndefined()

    const local = await setup({ remote: false })
    expect(local.room.repo).toBeUndefined()
    await expect(local.h['rooms.setIcon']({ roomId: local.room.id, icon: { kind: 'github' } })).rejects.toThrow(AVATAR_FAILED)
    expect(local.gh).toEqual([])
    expect(local.k.store.room(local.room.id)?.icon).toBeUndefined()
  })

  it('removing the room deletes its icon file', async () => {
    const { h, room, files } = await setup()
    await h['rooms.setIcon']({ roomId: room.id, icon: { kind: 'github' } })
    expect(await files()).toHaveLength(1)
    await h['rooms.remove']({ roomId: room.id, deleteWorktrees: false })
    expect(await files()).toEqual([])
  })

  it('serves null when the icon file has gone from the data folder', async () => {
    const { k, h, room } = await setup()
    k.store.saveRoom({ ...room, icon: { kind: 'image', file: `${room.id}-1.png`, at: 1 } })
    expect(await h['rooms.icon']({ roomId: room.id })).toBeNull()
  })
})
