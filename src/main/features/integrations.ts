import type { Workspace, WorkspaceSource } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { ghUser as ghUserName, openIssues, openPrs } from '../services/github'
import { integrationRows, saveLinearToken, storedLinearToken } from '../services/integrations'
import { getIssue, getScope, linearToken, listIssues, moveToStarted, planParts, searchIssues } from '../services/linear'
import { Feature } from './feature'

/** Linear and GitHub, and the Integrations page that connects them (KERNEL-325). */
export class Integrations extends Feature {
  /** The Linear token every Linear call uses: the one saved in Settings > Integrations, else LINEAR_API_KEY. */
  private async linearKey() { return (await storedLinearToken(this.o.dataDir)) ?? linearToken() }
  private get linearFetch(): typeof fetch { return this.o.fetch ?? fetch }

  /**
   * A workspace started on a Linear issue: move the issue to In Progress (D-140). Nobody waits for it, and a failure is
   * one note in the log, never a failed workspace. Without a token there is nothing to do.
   */
  async startIssue(ws: Workspace, key: string) {
    try {
      const token = await this.linearKey()
      if (token) await moveToStarted(token, key, this.linearFetch)
    } catch (e) {
      bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: `could not move ${key} to In Progress in Linear:`, object: (e as Error).message, warn: true })
    }
  }

  /**
   * create_workspace's `issue`: the source to save, the issue's labels, which pick the branch type, and the issues that
   * block it (KERNEL-263), or the task title and no labels when Linear doesn't answer.
   */
  async issueSource(key: string, title: string): Promise<{ source: WorkspaceSource; labels: string[]; blockedBy?: string[] }> {
    if (key.startsWith('#')) return { source: { kind: 'issue', id: key, title }, labels: [] }
    try {
      const issue = await getIssue(await this.linearKey(), key, this.linearFetch)
      return { source: { kind: 'issue', id: issue.id, title: issue.title, url: issue.url }, labels: issue.labels, blockedBy: issue.blockedBy }
    } catch { return { source: { kind: 'issue', id: key, title }, labels: [] } }
  }

  /**
   * A Linear issue's labels, for a workspace started from it in the New workspace modal. Linear gets 5 seconds, and no
   * answer means no labels, so the branch starts with feat and Linear never holds a workspace up (KERNEL-275).
   */
  async issueLabels(key: string): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), 5000) })
    const read = this.linearKey().then((token) => getIssue(token, key, this.linearFetch)).then((i) => i.labels, () => [])
    try { return await Promise.race([read, late]) } finally { clearTimeout(timer) }
  }

  private async integrations() {
    const [ghUser, linear] = await Promise.all([ghUserName().catch(() => null), this.linearKey()])
    return integrationRows({ ghUser, linear: !!linear })
  }

  handlers() {
    return {
      'github.prs': async ({ roomId, query }) => openPrs(this.mustRoom(roomId).path, query),
      'github.issues': async ({ roomId, query }) => openIssues(this.mustRoom(roomId).path, query),
      'issues.list': async ({ query }) => searchIssues(await this.linearKey(), query, this.linearFetch),
      'linear.issues': async ({ filter }) => listIssues(await this.linearKey(), filter, this.linearFetch),
      'linear.issue': async ({ id }) => getIssue(await this.linearKey(), id, this.linearFetch),
      'linear.scope': async () => getScope(await this.linearKey(), this.linearFetch),
      'linear.plan': async ({ id, roomId }) => {
        const issue = await getIssue(await this.linearKey(), id, this.linearFetch)
        const chat = await this.k.lead.startLeadChat(roomId, { prompt: '', parts: planParts(issue), plan: true })
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      'integrations.list': async () => this.integrations(),
      'integrations.connect': async ({ id, token }) => {
        if (id === 'linear') {
          const clean = (token ?? '').trim()
          if (clean) await searchIssues(clean, '', this.linearFetch)
          await saveLinearToken(this.o.dataDir, clean)
        } else if (id === 'github') throw new Error('GitHub signs in through the GitHub CLI. Run gh auth login in a terminal.')
        else throw new Error(`${id === 'vercel' ? 'Vercel' : 'Remote Control'} is not available yet.`)
        return (await this.integrations()).find((i) => i.id === id)!
      }
    } satisfies Partial<Handlers>
  }
}
