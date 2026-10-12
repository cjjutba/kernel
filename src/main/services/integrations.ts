import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Integration } from '@shared/types'
import type { Cipher } from './env'

// Settings > Integrations (KERNEL-26). The Linear token lives in its own file in the data folder, readable by the user only,
// so it never travels with settings.json or a repo's .kernel folder. With the Keychain the file holds it encrypted, and a
// token saved in plain text before is encrypted on its first read. Without the Keychain it stays plain text (KERNEL-445).

const file = (dataDir: string) => join(dataDir, 'integrations.json')

/** What `integrations.json` holds: one of the two, or neither when no token is saved. */
interface Stored { linearToken?: string; linearTokenEncrypted?: string }

/** The token as the file keeps it: encrypted when the cipher works, else the token itself. */
function sealed(token: string, cipher?: Cipher): Stored {
  if (cipher) { try { return { linearTokenEncrypted: cipher.encrypt(token) } } catch { /* the Keychain refused */ } }
  return { linearToken: token }
}

/** Writes through a temp file, so a crash mid-write never leaves the token half written. */
async function write(dataDir: string, data: Stored) {
  await mkdir(dataDir, { recursive: true })
  const tmp = `${file(dataDir)}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, file(dataDir))
  } catch (e) { await rm(tmp, { force: true }); throw e }
}

export async function storedLinearToken(dataDir: string, cipher?: Cipher): Promise<string | undefined> {
  let stored: Stored
  try { stored = JSON.parse(await readFile(file(dataDir), 'utf8')) as Stored } catch { return undefined }
  if (!stored || typeof stored !== 'object') return undefined
  const plain = typeof stored.linearToken === 'string' ? stored.linearToken.trim() : ''
  if (plain) {
    const next = sealed(plain, cipher)
    // A failed write leaves the plain text file as it was, and the next read tries again.
    if (next.linearTokenEncrypted) await write(dataDir, next).catch(() => {})
    return plain
  }
  if (typeof stored.linearTokenEncrypted !== 'string' || !cipher) return undefined
  // A token another Keychain encrypted reads as none, so LINEAR_API_KEY applies until the user saves it again.
  try { return cipher.decrypt(stored.linearTokenEncrypted).trim() || undefined } catch { return undefined }
}

/** An empty token removes it. */
export async function saveLinearToken(dataDir: string, token: string, cipher?: Cipher) {
  const trimmed = token.trim()
  await write(dataDir, trimmed ? sealed(trimmed, cipher) : {})
}

/** The rows of the page. GitHub is the signed-in `gh`. Vercel and Remote Control come back as rows once they are built (KERNEL-540). */
export function integrationRows(o: { ghUser: string | null; linear: boolean }): Integration[] {
  return [
    { id: 'github', name: 'GitHub', connected: !!o.ghUser, detail: o.ghUser ? `Through the GitHub CLI as ${o.ghUser}` : 'Sign in with gh auth login in a terminal' },
    { id: 'linear', name: 'Linear', connected: o.linear, detail: o.linear ? 'Token saved. Create workspaces from issues' : 'Create workspaces from issues' }
  ]
}
