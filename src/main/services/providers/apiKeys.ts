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
  if (res.status === 401) throw new Error(`${c.name} didn't accept that key. Check that you copied all of it.`)
  if (res.status === 403) throw new Error(`${c.name} says that key isn't allowed to use the API.`)
  if (res.status === 429) throw new Error(`${c.name} is limiting requests for that key. Try again in a minute.`)
  throw new Error(`${c.name} answered ${res.status} when Kernel checked the key. Try again in a minute.`)
}
