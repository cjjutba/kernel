import type { IssueSummary } from '@shared/types'

// Linear issues for the new workspace modal. The token comes from Settings > Integrations (KERNEL-26).
// Until that page stores one, LINEAR_API_KEY in the environment is the token.

export const LINEAR_URL = 'https://api.linear.app/graphql'

export const NO_LINEAR_TOKEN = 'Connect Linear in Settings > Integrations to search issues.'

const QUERY = `query Issues($filter: IssueFilter) {
  issues(first: 30, filter: $filter, orderBy: updatedAt) { nodes { identifier title url } }
}`

export function linearToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LINEAR_API_KEY?.trim() || undefined
}

/** Open issues, newest first. `query` matches the title or the identifier ("KERNEL-16" or "16"). */
export async function searchIssues(token: string | undefined, query = '', fetchImpl: typeof fetch = fetch): Promise<IssueSummary[]> {
  if (!token) throw new Error(NO_LINEAR_TOKEN)
  const q = query.trim()
  const open = { state: { type: { nin: ['completed', 'canceled'] } } }
  const number = /(\d+)$/.exec(q)?.[1]
  const filter = q
    ? { and: [open, { or: [{ title: { containsIgnoreCase: q } }, ...(number ? [{ number: { eq: Number(number) } }] : [])] }] }
    : open
  let res: Response
  try {
    res = await fetchImpl(LINEAR_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: token }, body: JSON.stringify({ query: QUERY, variables: { filter } }) })
  } catch { throw new Error('Could not reach Linear. Check your connection.') }
  if (res.status === 401 || res.status === 403) throw new Error('Linear rejected the token. Reconnect it in Settings > Integrations.')
  const body = (await res.json().catch(() => null)) as { data?: { issues?: { nodes?: { identifier: string; title: string; url?: string }[] } }; errors?: { message: string }[] } | null
  if (!res.ok || body?.errors?.length || !body?.data) throw new Error(body?.errors?.[0]?.message ?? `Linear answered ${res.status}.`)
  return (body.data.issues?.nodes ?? []).map((n) => ({ id: n.identifier, title: n.title, url: n.url }))
}
