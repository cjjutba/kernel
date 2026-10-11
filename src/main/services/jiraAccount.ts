import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Cipher } from './env'
import type { JiraCredentials } from './trackers/jira'

// The Jira account from Settings (KERNEL-474): the site, email and API token, in their own file in the data folder, so they
// never travel with settings.json or a repo's .kernel folder. With the Keychain the file holds them encrypted. Without it
// they sit in plain text in a file only the user can read, as the Linear token does (KERNEL-445).

const file = (dataDir: string) => join(dataDir, 'jira.json')

/** What `jira.json` holds: the account encrypted, or the account itself. */
interface Stored { encrypted?: string; site?: unknown; email?: unknown; token?: unknown }

function account(v: unknown): JiraCredentials | undefined {
  const c = (v && typeof v === 'object' ? v : {}) as Stored
  const text = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  const [site, email, token] = [text(c.site), text(c.email), text(c.token)]
  return site && email && token ? { site, email, token } : undefined
}

export async function storedJiraAccount(dataDir: string, cipher?: Cipher): Promise<JiraCredentials | undefined> {
  let stored: Stored
  try { stored = JSON.parse(await readFile(file(dataDir), 'utf8')) as Stored } catch { return undefined }
  if (!stored || typeof stored !== 'object') return undefined
  if (typeof stored.encrypted !== 'string') return account(stored)
  // An account another Keychain encrypted reads as none, until the user connects again.
  if (!cipher) return undefined
  try { return account(JSON.parse(cipher.decrypt(stored.encrypted))) } catch { return undefined }
}

/** Saves the account, encrypted when the Keychain works. `null` removes it. The write goes through a temp file, so a crash never leaves half of it. */
export async function saveJiraAccount(dataDir: string, creds: JiraCredentials | null, cipher?: Cipher) {
  if (!creds) { await rm(file(dataDir), { force: true }); return }
  let data: Stored = { site: creds.site, email: creds.email, token: creds.token }
  if (cipher) { try { data = { encrypted: cipher.encrypt(JSON.stringify(data)) } } catch { /* the Keychain refused */ } }
  await mkdir(dataDir, { recursive: true })
  const tmp = `${file(dataDir)}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await rename(tmp, file(dataDir))
  } catch (e) { await rm(tmp, { force: true }); throw e }
}
