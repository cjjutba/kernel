import type { Tracker, Workspace, WorkspaceSource } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { ghUser as ghUserName, openIssues, openPrs } from '../services/github'
import { integrationRows, saveLinearToken, storedLinearToken } from '../services/integrations'
import { loadRepoSettings } from '../services/settings'
import { trackerKind } from '../services/trackers'
import { githubKey, githubTracker } from '../services/trackers/github'
import { getIssue, getScope, linearToken, linearTracker, listIssues, planParts, searchIssues } from '../services/trackers/linear'
import { noneTracker } from '../services/trackers/none'
import { remoteRepo } from '../services/worktrees'
import { Feature } from './feature'

/** Linear and GitHub, and the Integrations page that connects them (KERNEL-325). */
export class Integrations extends Feature {
  /** The Linear token every Linear call uses: the one saved in Settings > Integrations, else LINEAR_API_KEY. */
  private async linearKey() { return (await storedLinearToken(this.o.dataDir)) ?? linearToken() }
  private get linearFetch(): typeof fetch { return this.o.fetch ?? fetch }

  /**
   * A workspace started on an issue: move it to In Progress in the room's tracker (D-140). Nobody waits for it, and a
   * failure is one note in the log, never a failed workspace. Linear without a token, GitHub and no tracker move nothing.
   */
  async startIssue(ws: Workspace, key: string) {
    try {
      await (await this.trackerFor(ws.roomId)).start(key)
    } catch (e) {
      bus.activity({ kind: 'note', roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId, text: `could not move ${key} to In Progress in Linear:`, object: (e as Error).message, warn: true })
    }
  }

  /**
   * create_workspace's `issue`: the source to save, with the tracker it came from, the issue's labels, which pick the branch
   * type, and the issues that block it (KERNEL-263), or the task title and no labels when the tracker doesn't answer. A
   * `#41` key is a GitHub issue in any room, and only a GitHub room's tracker reads it (KERNEL-462).
   */
  async issueSource(roomId: string, key: string, title: string): Promise<{ source: WorkspaceSource; labels: string[]; blockedBy?: string[] }> {
    const tracker = await this.trackerFor(roomId)
    if (key.startsWith('#') && tracker.kind !== 'github') return { source: { kind: 'issue', id: key, title, tracker: 'github' }, labels: [] }
    try {
      const issue = await tracker.issue(key)
      const kind = tracker.kind === 'none' ? undefined : tracker.kind
      return { source: { kind: 'issue', id: issue.id, title: issue.title, url: issue.url, ...(kind ? { tracker: kind } : {}) }, labels: issue.labels, blockedBy: issue.blockedBy }
    } catch {
      const gh = tracker.kind === 'github' ? githubKey(key) : undefined
      return { source: { kind: 'issue', id: gh ?? key, title, ...(gh ? { tracker: 'github' as const } : {}) }, labels: [] }
    }
  }

  /**
   * An issue source with the tracker it came from (KERNEL-462). The New workspace modal sends the room tracker's issues
   * without one. A `#41` key is GitHub's, and a GitHub room's other keys came from somewhere else, so they stay untagged.
   */
  async trackedSource(roomId: string, source: WorkspaceSource | undefined): Promise<WorkspaceSource | undefined> {
    if (source?.kind !== 'issue' || source.tracker) return source
    if (source.id.startsWith('#')) return { ...source, tracker: 'github' }
    const { kind } = await this.trackerFor(roomId)
    return kind === 'none' || kind === 'github' ? source : { ...source, tracker: kind }
  }

  /**
   * An issue's labels, for a workspace started from it in the New workspace modal. The tracker gets 5 seconds, and no
   * answer means no labels, so the branch starts with feat and the tracker never holds a workspace up (KERNEL-275).
   */
  async issueLabels(roomId: string, key: string): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), 5000) })
    const read = this.trackerFor(roomId).then((t) => t.issue(key)).then((i) => i.labels, () => [])
    try { return await Promise.race([read, late]) } finally { clearTimeout(timer) }
  }

  /**
   * The room's issue tracker, built on every call, so a change to the room's settings, a new token or a new remote applies
   * at once (KERNEL-462). Jira reads as no tracker until Kernel can read it (KERNEL-474).
   */
  async trackerFor(roomId: string): Promise<Tracker> {
    const room = this.mustRoom(roomId)
    const repo = await loadRepoSettings(room.path)
    const kind = trackerKind({
      kind: repo.tracker?.kind,
      linearToken: !!(await this.linearKey()),
      linearTeam: !!repo.linear?.team,
      githubRemote: !!(room.repo ?? (await remoteRepo(room.path, await this.k.config.remoteFor(room.path, repo))))
    })
    if (kind === 'linear') return linearTracker(() => this.linearKey(), this.linearFetch)
    if (kind === 'github') return githubTracker(room.path)
    return noneTracker()
  }

  private async integrations() {
    const [ghUser, linear] = await Promise.all([ghUserName().catch(() => null), this.linearKey()])
    return integrationRows({ ghUser, linear: !!linear })
  }

  handlers() {
    return {
      'github.prs': async ({ roomId, query }) => openPrs(this.mustRoom(roomId).path, query),
      'github.issues': async ({ roomId, query }) => openIssues(this.mustRoom(roomId).path, query),
      'issues.list': async ({ roomId, query }) => (await this.trackerFor(roomId)).search(query),
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
