import type { IssueTaken, ProjectTracker, Tracker, TrackerIssue, TrackerKind, Workspace, WorkspaceSource } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { ghAuth, ghUser as ghUserName, openIssues, openPrs, prsNaming } from '../services/github'
import { integrationRows, saveLinearToken, storedLinearToken } from '../services/integrations'
import { issueTaken, TAKEN_TIMEOUT_MS } from '../services/issueTaken'
import { loadRepoSettings, saveRepoSettings } from '../services/settings'
import { issueTracker, trackerKind, trackerName } from '../services/trackers'
import { githubKey, githubTracker } from '../services/trackers/github'
import { listGithubIssues, readGithubIssue } from '../services/trackers/githubIssues'
import { getIssue, getScope, linearToken, linearTracker, listIssues, planParts, searchIssues } from '../services/trackers/linear'
import { noneTracker } from '../services/trackers/none'
import { remoteBranches, remoteRepo } from '../services/worktrees'
import { Feature } from './feature'

/** An issue a workspace builds: its key and the tracker it came from. */
type IssueRef = { id: string; tracker?: TrackerKind }

/**
 * Whether a project's tracker reads the key `key` (KERNEL-504): GitHub reads `#41` and `41`, and Linear `KERNEL-31`. A key
 * from another tracker isn't asked about, so `#41` is GitHub's only (KERNEL-462) and a Linear key in a GitHub project adds no
 * failed check.
 */
function readsKey(kind: Tracker['kind'], key: string): boolean {
  if (kind === 'github') return !!githubKey(key)
  return kind === 'linear' && /^[a-z][a-z0-9]*-\d+$/i.test(key)
}

/**
 * The tracker an issue belongs to (KERNEL-933): its tag, else `#41` for GitHub, a bare number for GitHub in a project whose
 * tracker is GitHub, and any other key for Linear, as `issueTracker` reads an untagged source.
 */
function keyTracker(issue: IssueRef, project: Tracker['kind']): TrackerKind | undefined {
  if (!issue.tracker && project === 'github' && githubKey(issue.id)) return 'github'
  return issueTracker({ ...issue, id: issue.id.trim() })
}

/** Linear and GitHub, and the Integrations page that connects them (KERNEL-325). */
export class Integrations extends Feature {
  /** The Linear token every Linear call uses: the one saved in Settings > Integrations, else LINEAR_API_KEY (KERNEL-445). */
  private async linearKey() { return (await storedLinearToken(this.o.dataDir, this.o.cipher)) ?? linearToken() }
  private get linearFetch(): typeof fetch { return this.o.fetch ?? fetch }

  /**
   * A workspace started on an issue: move it to In Progress in the project's tracker (D-140). Nobody waits for it, and a
   * failure is one note in the log, never a failed workspace. Linear without a token, GitHub and no tracker move nothing,
   * and neither does an issue from another tracker than the project's (KERNEL-470).
   */
  async startIssue(ws: Workspace, issue: IssueRef) {
    let tracker: Tracker | undefined
    try {
      tracker = await this.trackerFor(ws.projectId)
      if (tracker.kind === issueTracker(issue)) await tracker.start(issue.id)
    } catch (e) {
      const where = tracker ? ` in ${trackerName(tracker.kind === 'none' ? undefined : tracker.kind)}` : ''
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId, text: `could not move ${issue.id} to In Progress${where}:`, object: (e as Error).message, warn: true })
    }
  }

  /**
   * create_workspace's `issue`: the source to save, with the tracker it came from, the issue's labels, which pick the branch
   * type, and the issues that block it (KERNEL-263), or the task title and no labels when the tracker doesn't answer. The issue
   * is read from the tracker its key names (`trackerOf`), so a `#41` in a Linear project reads from GitHub (KERNEL-933). `issue`
   * is the issue as the tracker read it, with the tracker's kind, for the brief (KERNEL-473).
   */
  async issueSource(projectId: string, key: string, title: string): Promise<{ source: WorkspaceSource; labels: string[]; blockedBy?: string[]; issue?: { read: TrackerIssue; kind: TrackerKind } }> {
    const tracker = await this.trackerOf(projectId, { id: key })
    try {
      if (!tracker || tracker.kind === 'none') throw new Error('unread')
      const issue = await tracker.issue(key)
      return { source: { kind: 'issue', id: issue.id, title: issue.title, url: issue.url, tracker: tracker.kind }, labels: issue.labels, blockedBy: issue.blockedBy, issue: { read: issue, kind: tracker.kind } }
    } catch {
      // A `#41` stays GitHub's when GitHub can't read it, and a GitHub project's "41" is its #41.
      const gh = tracker?.kind === 'github' || key.trim().startsWith('#') ? (githubKey(key) ?? key) : undefined
      return { source: { kind: 'issue', id: gh ?? key, title, ...(gh ? { tracker: 'github' as const } : {}) }, labels: [] }
    }
  }

  /**
   * An issue source with the tracker it came from (KERNEL-462). The New workspace modal sends the project tracker's issues
   * without one. A `#41` key is GitHub's, and a GitHub project's other keys came from somewhere else, so they stay untagged.
   */
  async trackedSource(projectId: string, source: WorkspaceSource | undefined): Promise<WorkspaceSource | undefined> {
    if (source?.kind !== 'issue' || source.tracker) return source
    if (source.id.startsWith('#')) return { ...source, tracker: 'github' }
    const { kind } = await this.trackerFor(projectId)
    return kind === 'none' || kind === 'github' ? source : { ...source, tracker: kind }
  }

  /**
   * An issue's labels, for a workspace started from it in the New workspace modal. The tracker gets 5 seconds, and no
   * answer means no labels, so the branch starts with feat and the tracker never holds a workspace up (KERNEL-275). The
   * issue's own tracker is asked (KERNEL-933).
   */
  async issueLabels(projectId: string, issue: IssueRef): Promise<string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), 5000) })
    const read = this.trackerOf(projectId, issue).then(async (t) => (t ? (await t.issue(issue.id)).labels : [])).catch(() => [])
    try { return await Promise.race([read, late]) } finally { clearTimeout(timer) }
  }

  /**
   * Whether someone else may already be on the issue `key` (KERNEL-479): a branch on the project's remote named after it, an open
   * PR that names it, when the project's code host is GitHub, and an assignee other than the user, when the tracker the key names
   * is available to the project (KERNEL-933). The project's own workspaces don't count. Each check has `TAKEN_TIMEOUT_MS`, and a check that can't answer adds a
   * note. Never rejects, so nothing waits on a slow remote for long.
   */
  async issueTaken(projectId: string, key: string): Promise<IssueTaken> {
    const project = this.mustProject(projectId)
    try {
      const repo = await loadRepoSettings(project.path)
      const remote = await this.k.config.remoteFor(project.path, repo)
      const tracker = await this.trackerOf(projectId, { id: key.trim() })
      // GitHub reads "41" as #41, the way create_workspace links it (`issueSource`).
      const id = (tracker?.kind === 'github' ? githubKey(key) : undefined) ?? key.trim()
      const github = project.host !== 'local' && !!(project.repo ?? (await remoteRepo(project.path, remote)))
      const reads = !!tracker && readsKey(tracker.kind, id)
      const own = this.store.workspaces(projectId)
      return await issueTaken(id, {
        remote,
        branches: () => remoteBranches(project.path, remote, TAKEN_TIMEOUT_MS),
        ...(github ? { prs: () => prsNaming(project.path, id, TAKEN_TIMEOUT_MS) } : {}),
        ...(reads ? { assignees: async () => (await tracker.issue(id)).assignees ?? [], tracker: trackerName(tracker.kind === 'none' ? undefined : tracker.kind) } : {}),
        own: { branches: new Set(own.map((w) => w.branch)), prs: new Set(own.flatMap((w) => (w.prNumber ? [w.prNumber] : []))) }
      })
    } catch (e) {
      return { findings: [], notes: [`Couldn't check whether someone else is on ${key.trim()}: ${(e as Error).message.split('\n')[0].replace(/\.$/, '')}.`] }
    }
  }

  /**
   * What the project's tracker is, read on every call, so a change to the project's settings, a new token or a new remote applies
   * at once (KERNEL-462). `remote` is the project's GitHub `owner/repo`, when it has one.
   */
  private async detect(projectId: string) {
    const project = this.mustProject(projectId)
    const repo = await loadRepoSettings(project.path)
    const remote = project.repo ?? (await remoteRepo(project.path, await this.k.config.remoteFor(project.path, repo)))
    const linear = !!(await this.linearKey())
    const kind = trackerKind({ kind: repo.tracker?.kind, linearToken: linear, linearTeam: !!repo.linear?.team, githubRemote: !!remote })
    return { project, repo, kind, remote, linear }
  }

  /** The project's issue tracker. */
  async trackerFor(projectId: string): Promise<Tracker> {
    const { project, repo, kind } = await this.detect(projectId)
    if (kind === 'linear') return linearTracker(() => this.linearKey(), this.linearFetch, repo.linear?.team)
    if (kind === 'github') return githubTracker(project.path)
    return noneTracker()
  }

  /**
   * The Linear or GitHub tracker that reads `issue`, by its tag or else its key (`keyTracker`), whatever the project's own
   * tracker is (KERNEL-933). It is the project's tracker when the two agree, so a `[tracker] kind` without a token or a
   * github.com remote reads, and fails, as it did. Otherwise Linear needs a token and GitHub a github.com remote, and a project
   * set to `[tracker] kind = "none"` reads nothing. Undefined when the tracker can't read it.
   */
  async trackerOf(projectId: string, issue: IssueRef): Promise<Tracker | undefined> {
    const { project, repo, kind, remote, linear } = await this.detect(projectId)
    if (repo.tracker?.kind === 'none') return undefined
    const named = keyTracker(issue, kind)
    if (!named) return undefined
    if (named === kind) return this.trackerFor(projectId)
    if (named === 'linear') return linear ? linearTracker(() => this.linearKey(), this.linearFetch, repo.linear?.team) : undefined
    return remote ? githubTracker(project.path) : undefined
  }

  /**
   * The project's tracker as the screens that list its issues need it: the kind Kernel reads, GitHub's `owner/repo` (KERNEL-471),
   * and the trackers the Issues screen can switch between (KERNEL-933).
   */
  async trackerInfo(projectId: string): Promise<ProjectTracker> {
    const { repo, kind, remote, linear } = await this.detect(projectId)
    const off = repo.tracker?.kind === 'none'
    const available = { linear: !off && linear && !!repo.linear?.team, ...(!off && remote ? { github: { where: remote } } : {}) }
    if (kind === 'linear') return { kind, available }
    if (kind === 'github') return { kind, ...(remote ? { where: remote } : {}), available }
    return { kind: 'none', available }
  }

  private async integrations() {
    const [ghUser, linear] = await Promise.all([ghUserName().catch(() => null), this.linearKey()])
    return integrationRows({ ghUser, linear: !!linear })
  }

  handlers() {
    return {
      'github.auth': async () => ghAuth(),
      'github.prs': async ({ projectId, query }) => openPrs(this.mustProject(projectId).path, query),
      'github.issues': async ({ projectId, query }) => openIssues(this.mustProject(projectId).path, query),
      'issues.list': async ({ projectId, query }) => (await this.trackerFor(projectId)).search(query),
      'issues.next': async ({ projectId }) => {
        const tracker = await this.trackerFor(projectId)
        return tracker.next ? tracker.next() : tracker.search()
      },
      'issues.taken': async ({ projectId, issue }) => this.issueTaken(projectId, issue),
      'issues.tracker': async ({ projectId }) => this.trackerInfo(projectId),
      'github.issueList': async ({ projectId, query }) => listGithubIssues(this.mustProject(projectId).path, query, await ghUserName().catch(() => null)),
      'github.issue': async ({ projectId, id }) => readGithubIssue(this.mustProject(projectId).path, id, await ghUserName().catch(() => null)),
      'linear.issues': async ({ filter }) => listIssues(await this.linearKey(), filter, this.linearFetch),
      'linear.issue': async ({ id }) => getIssue(await this.linearKey(), id, this.linearFetch),
      'linear.scope': async () => getScope(await this.linearKey(), this.linearFetch),
      'linear.plan': async ({ id, projectId }) => {
        const issue = await getIssue(await this.linearKey(), id, this.linearFetch)
        const chat = await this.k.lead.startLeadChat(projectId, { prompt: '', parts: planParts(issue), plan: true })
        return { chatId: chat.id, workspaceId: chat.workspaceId }
      },
      'integrations.list': async () => this.integrations(),
      'integrations.connect': async ({ id, token }) => {
        if (id === 'linear') {
          const clean = (token ?? '').trim()
          if (clean) await searchIssues(clean, '', this.linearFetch)
          await saveLinearToken(this.o.dataDir, clean, this.o.cipher)
        } else throw new Error('GitHub signs in through the GitHub CLI. Run gh auth login in a terminal.')
        return (await this.integrations()).find((i) => i.id === id)!
      }
    } satisfies Partial<Handlers>
  }
}
