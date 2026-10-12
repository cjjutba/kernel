import type { Provider } from '@shared/types'

// Checking an API key before Kernel keeps it (KERNEL-523): one request to the provider's models list, which costs nothing.
// Codex's own `account/login/start` with an API key checks nothing, so a Codex key is checked against OpenAI directly.

const CHECKS: Record<Provider, { name: string; url: string; headers: (key: string) => Record<string, string> }> = {
  claude: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/models?limit=1', headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }) },
  codex: { name: 'OpenAI', url: 'https://api.openai.com/v1/models', headers: (key) => ({ authorization: `Bearer ${key}` }) }
}

/** Resolves when the provider's API takes the key, else rejects with why, in words for the Add account sheet. No message carries the key. */
export async function checkApiKey(provider: Provider, key: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const c = CHECKS[provider]
  let res: Response
  try {
    res = await fetchImpl(c.url, { headers: c.headers(key), signal: AbortSignal.timeout(20_000) })
  } catch { throw new Error(`Kernel couldn't reach ${c.name} to check the key. Check your connection and try again.`) }
  if (res.ok) return
  const reason = await reasonFrom(res, key)
  const says = reason ? `${c.name} says: ${reason}` : ''
  const lead = res.status === 401 ? `${c.name} didn't accept that key. Check that you copied all of it.`
    : res.status === 403 ? `${c.name} says that key isn't allowed to use the API.`
    : res.status === 429 ? `${c.name} is limiting requests for that key. Try again in a minute.`
    : ''
  if (lead) throw new Error(says ? `${lead} ${says}` : lead)
  if (says) throw new Error(says)
  if (res.status === 400) throw new Error(`${c.name} turned the key down without saying why. Check the key and your ${c.name} account.`)
  throw new Error(`${c.name} answered ${res.status} when Kernel checked the key. Try again in a minute.`)
}

/**
 * The provider's own reason from a failed check (KERNEL-582): `error.message`, which Anthropic and OpenAI both send, on one
 * line and at most about 300 characters, with the key replaced in case the provider repeats it. Undefined when there is none.
 */
async function reasonFrom(res: Response, key: string): Promise<string | undefined> {
  let message: unknown
  try { message = ((await res.json()) as { error?: { message?: unknown } } | null)?.error?.message } catch { return undefined }
  if (typeof message !== 'string') return undefined
  const line = (key ? message.replaceAll(key, '[your key]') : message).replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return line.length > 300 ? `${line.slice(0, 299).trimEnd()}…` : line
}
