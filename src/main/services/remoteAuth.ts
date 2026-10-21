import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { RemoteDeviceRow, Store } from '../db'

/** How long a pairing code works. */
export const PAIR_CODE_MS = 5 * 60_000
/** How long a device stays paired without pairing again. */
export const SESSION_MS = 30 * 24 * 3600_000
/** A device's `lastSeenAt` is written at most this often. */
const TOUCH_MS = 60_000
/** Failed pair attempts allowed per address, and in all, in `FAIL_WINDOW_MS`. */
const FAILS_PER_ADDRESS = 5
const FAILS_IN_ALL = 20
const FAIL_WINDOW_MS = 60_000
/** Codes that wait to be used. A new code past this drops the oldest. */
const MAX_OPEN_CODES = 5
const NAME_MAX = 60

const sha256 = (text: string) => createHash('sha256').update(text).digest()

export type PairResult =
  | { ok: true; token: string; device: RemoteDeviceRow }
  | { ok: false; status: 400 | 401 | 429; error: string; retryAfterSec?: number }

/**
 * Pairing codes and session tokens for Remote access (remote-access-server).
 *
 * A code is 160 random bits, good for 5 minutes and once. It is kept only as its SHA-256, so the lookup compares nothing the
 * caller can time. A token is 256 random bits and goes to the device once. The database keeps its SHA-256 only, and `verify`
 * compares the hash of what a caller sent with every live device's hash in constant time, so a stolen kernel.db can't
 * be used to connect.
 */
export class RemoteAuth {
  /** Hash of a code (hex) to when it ends. */
  private codes = new Map<string, number>()
  private fails = new Map<string, number[]>()
  private touched = new Map<string, number>()

  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  /** A new code and when it ends. */
  newCode(): { code: string; expiresAt: number } {
    this.prune()
    while (this.codes.size >= MAX_OPEN_CODES) this.codes.delete(this.codes.keys().next().value as string)
    const code = randomBytes(20).toString('base64url')
    const expiresAt = this.now() + PAIR_CODE_MS
    this.codes.set(sha256(code).toString('hex'), expiresAt)
    return { code, expiresAt }
  }

  /** Forgets every code that has not been used, as the server stops. */
  clearCodes() { this.codes.clear() }

  /** Exchanges a code for a session. The code is spent on the first try that finds it, so it works once. */
  pair(code: unknown, name: unknown, address: string): PairResult {
    const wait = this.waitFor(address)
    if (wait) return { ok: false, status: 429, error: 'Too many attempts. Try again in a minute.', retryAfterSec: wait }
    if (typeof code !== 'string' || !code || code.length > 200) return this.fail(address, 400, 'A pairing code is needed')
    const key = sha256(code).toString('hex')
    const ends = this.codes.get(key)
    this.codes.delete(key)
    if (ends === undefined || ends <= this.now()) return this.fail(address, 401, 'That code is wrong or has expired')
    const token = randomBytes(32).toString('base64url')
    const at = this.now()
    const device: RemoteDeviceRow = { id: randomUUID(), tokenHash: sha256(token).toString('hex'), name: cleanName(name), createdAt: at, lastSeenAt: at, expiresAt: at + SESSION_MS }
    this.store.addRemoteDevice(device)
    return { ok: true, token, device }
  }

  /** The device a token belongs to, or undefined for no token, a wrong one, a revoked one and an expired one. */
  verify(token: unknown): RemoteDeviceRow | undefined {
    if (typeof token !== 'string' || !token || token.length > 200) return undefined
    const given = sha256(token)
    const now = this.now()
    let found: RemoteDeviceRow | undefined
    // Every row is compared, so how long this takes doesn't say which one matched.
    for (const d of this.store.remoteDevices()) {
      if (timingSafeEqual(given, Buffer.from(d.tokenHash, 'hex')) && d.expiresAt > now) found = d
    }
    return found
  }

  /** Records that a device was seen, at most once a minute. */
  seen(id: string) {
    const at = this.now()
    if (at - (this.touched.get(id) ?? 0) < TOUCH_MS) return
    this.touched.set(id, at)
    this.store.touchRemoteDevice(id, at)
  }

  devices(): RemoteDeviceRow[] {
    this.store.deleteExpiredRemoteDevices(this.now())
    return this.store.remoteDevices()
  }

  revoke(id: string): boolean {
    this.touched.delete(id)
    return this.store.deleteRemoteDevice(id)
  }

  private prune() {
    const now = this.now()
    for (const [k, ends] of this.codes) if (ends <= now) this.codes.delete(k)
  }

  /** Seconds to wait when the address, or every address together, has used up its failures. */
  private waitFor(address: string): number | undefined {
    const now = this.now()
    for (const [a, times] of this.fails) {
      const live = times.filter((t) => now - t < FAIL_WINDOW_MS)
      if (live.length) this.fails.set(a, live)
      else this.fails.delete(a)
    }
    const mine = this.fails.get(address) ?? []
    const all = [...this.fails.values()].flat()
    const blocked = mine.length >= FAILS_PER_ADDRESS ? mine : all.length >= FAILS_IN_ALL ? all : undefined
    return blocked ? Math.max(1, Math.ceil((Math.min(...blocked) + FAIL_WINDOW_MS - now) / 1000)) : undefined
  }

  private fail(address: string, status: 400 | 401, error: string): PairResult {
    this.fails.set(address, [...(this.fails.get(address) ?? []), this.now()])
    return { ok: false, status, error }
  }
}

/** A device name from the client: printable text, trimmed and capped. */
function cleanName(name: unknown): string {
  // eslint-disable-next-line no-control-regex
  const text = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : ''
  return text || 'Paired device'
}
