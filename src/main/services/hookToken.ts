import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = /^[0-9a-f]{64}$/
const cache = new Map<string, string>()

export const hookTokenFile = (dataDir: string) => join(dataDir, 'hook-token')

/**
 * The secret the installed hook command sends as X-Kernel-Token (KERNEL-206). Made once per data folder with 32 random bytes
 * and kept in a file only the user can read. A missing or damaged file gets a new token, and the hooks then count as not
 * installed until Install writes it.
 */
export function hookToken(dataDir: string): string {
  const hit = cache.get(dataDir)
  if (hit) return hit
  const file = hookTokenFile(dataDir)
  let token = read(file)
  if (!token) {
    mkdirSync(dataDir, { recursive: true })
    token = randomBytes(32).toString('hex')
    writeFileSync(file, token + '\n', { mode: 0o600 })
  }
  // A file restored from a backup or copied by hand may have lost its mode.
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
  cache.set(dataDir, token)
  return token
}

function read(file: string): string | null {
  try { const t = readFileSync(file, 'utf8').trim(); return TOKEN.test(t) ? t : null } catch { return null }
}
