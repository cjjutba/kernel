import { join } from 'node:path'
import type { Chat, ChatPart, Effort, ModelId, Room, ScriptTrust, Workspace, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { newId } from '../db'
import { bus } from '../bus'
import { DEFAULT_BASE_REF, loadRepoSettings, type RepoSettings } from '../services/settings'
import { clock, worktreeTree, writeTree } from '../services/checkpoints'
import { branchName, branchType, capBranch, changedFiles, createWorktree, currentBranch, defaultBranch, diffText, fetchOrigin, folderGone, freeBranch, leadBase, mergeBase, onRemote, removeWorktree, resolveBaseRef, reviewBranch, shortSlug, slugify, snapshotBaseline, taskBranch, validBranchName } from '../services/worktrees'
import { linkNodeModules, portBlock } from '../services/scripts'
import { exec } from '../services/exec'
import { listTree, readImage, readWorkspaceFile, searchFiles } from '../services/files'
import { commitHunks, listHunks } from '../services/hunks'
import { head, messageOf, NEW_TAB } from './shared'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** When origin was last fetched, for a workspace that started from it after a fetch failed: "Oct 10, 2:05 PM (3 hours ago)". */
export function fetchedAt(ts: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ts) / 60000))
  const [n, unit] = min < 60 ? [min, 'minute'] : min < 60 * 48 ? [Math.round(min / 60), 'hour'] : [Math.round(min / 1440), 'day']
  const ago = n === 0 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`
  return `${new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${ago})`
}

/** What `cutWorkspace` takes. `lead` makes a chat with Rowan's own workspace for the chat `threadId` (KERNEL-405). */
export interface CutWorkspace {
  prompt: string; parts?: ChatPart[]; source?: WorkspaceSource; agentId?: string; mode?: WorkspaceMode; baseRef?: string; title?: string; branch?: string
  model?: ModelId; effort?: Effort; plan?: boolean; taskFor?: (ws: Workspace) => string | undefined; leadChatId?: string; reviewOf?: string; linkReviewOf?: string
  labels?: string[]; waitFor?: string[]; lead?: { threadId: string }
  /** Start from the remote as last fetched, as the chats with Rowan that move at startup do (KERNEL-405). */
  noFetch?: boolean
}

/** Creating workspaces, their ports, and what they changed (KERNEL-328). */
export class Workspaces extends Feature {
  /** Ports handed out to workspaces not saved yet, so two hand-offs in one turn never share a block (KERNEL-244). */
  readonly reservedPorts = new Set<number>()

  /** A workspace for the room's work: `cutWorkspace` makes it, then `setUpWorkspace` copies files, runs setup and sends the brief. */
  async createWorkspace(roomId: string, o: Omit<CutWorkspace, 'lead'>): Promise<Workspace> {
    const { ws, room, repo, chat } = await this.cutWorkspace(roomId, o)
    // A brief from the Lead's hand-off is the Lead's message in the teammate's chat, not the user's (KERNEL-116).
    return this.setUpWorkspace(ws, room, repo, chat, { brief: messageOf(o.prompt, o.parts), prompt: o.prompt, from: o.leadChatId ? 'lead' : undefined, leadChatId: o.leadChatId })
  }

  /**
   * Makes a workspace and its first chat, in `setup`: the ports, the fetch, the worktree on a new branch, and the record. A chat
   * with Rowan (`lead`) gets one too (KERNEL-405), always a worktree whatever "Default workspace type" says, on a branch named by
   * the Lead branch pattern, from `<remote>/<default>` or the target branch picked in New chat. A room with no commit keeps Rowan
   * on the checkout. Nothing from the repo's settings runs here.
   */
  async cutWorkspace(roomId: string, o: CutWorkspace): Promise<{ ws: Workspace; room: Room; repo: RepoSettings; chat: Chat }> {
    const room = this.mustRoom(roomId)
    const repo = await loadRepoSettings(room.path)
    const s = this.settings
    const agents = await this.k.team.agents(roomId)
    const lead = o.lead ? agents.find((a) => a.lead) : undefined
    if (o.lead && !lead) throw new Error('No Lead in this room. Mark one agent with "lead: true", or pick one in Settings, Agents.')
    const agent = lead ?? agents.find((a) => a.id === o.agentId) ?? agents.find((a) => a.lead) ?? agents[0]
    if (!agent) throw new Error('This room has no agents. Add one to .claude/agents first.')
    // A review gets its own worktree started from the work it reviews (KERNEL-130).
    // The branch the author is on now, which may not be the one the workspace started on (KERNEL-68).
    const reviewed = o.reviewOf && this.store.workspace(o.reviewOf) ? await this.k.prs.syncBranch(o.reviewOf) : undefined
    if (o.reviewOf && (!reviewed || reviewed.roomId !== roomId || reviewed.status === 'archived')) throw new Error('The workspace to review is not open in this room.')
    const remote = await this.k.config.remoteFor(room.path, repo)
    const mode = reviewed ? 'worktree' : o.lead ? (await leadBase(room.path, remote) ? 'worktree' : 'current') : o.mode ?? repo.workspace.mode ?? s.workspace.mode
    if (o.waitFor?.length && (mode === 'current' || reviewed)) throw new Error(reviewed ? 'A review never waits for another PR.' : "A workspace on the main checkout can't wait for a PR. Pass mode worktree.")
    const title = o.title ?? o.prompt.split(/\s+/).slice(0, 6).join(' ')
    // A base nobody set is the repo's default branch, the one PRs go into (KERNEL-400). Rowan starts from it or the branch picked
    // in New chat, never the workspace base from Settings (KERNEL-405).
    const set = o.baseRef ?? (o.lead ? undefined : repo.workspace.baseRef ?? (s.workspace.baseRef === DEFAULT_BASE_REF ? undefined : s.workspace.baseRef))
    // `origin/` in a base from Settings, the Lead or a PR means the room's remote. A branch picked from the list is a real ref.
    const wanted = set ?? `${remote}/${await defaultBranch(room.path, remote).catch(() => 'main')}`
    const picked = o.source?.kind === 'branch' || (!!o.lead && !!o.baseRef)
    const want = picked ? wanted : onRemote(wanted, remote)
    // A failed fetch still starts the workspace, from the remote as last fetched, and says so (KERNEL-179). A folder
    // without that remote has nothing to fetch, so it says nothing.
    const fetched = !reviewed && !o.noFetch && mode === 'worktree' && want.startsWith(`${remote}/`) && (await exec('git', ['-C', room.path, 'remote', 'get-url', remote])).code === 0
      ? await fetchOrigin(room.path, remote) : undefined
    const baseRef = reviewed ? await this.k.reviews.reviewBase(room.path, reviewed.branch, remote)
      : mode === 'current' && o.lead ? room.defaultBranch
      : await resolveBaseRef(room.path, want, { strict: o.source?.kind === 'pr' || picked, remote })
    // A local branch the base fell back to wasn't fetched, so a failed fetch says nothing about it.
    const stale = fetched?.ok === false && baseRef.startsWith(`${remote}/`) ? { error: fetched.error, when: fetched.lastFetch === undefined ? undefined : fetchedAt(fetched.lastFetch) } : undefined
    // The ports come first, so running out of them leaves no worktree or branch behind (KERNEL-244).
    const ws: Workspace = await this.withPort(async (port) => {
      let path: string, branch: string, baselineRef: string | undefined
      if (mode === 'worktree') {
        // Kernel names the branch from the issue key and a few words of the title, and the Lead can name it instead, cut to
        // 60 characters (KERNEL-275), for a review too (KERNEL-265). A taken name gets a suffix. A chat with Rowan's follows
        // the Lead branch pattern, `rowan/<a few words>` (KERNEL-405).
        const asked = o.branch ? capBranch(o.branch) : undefined
        if (asked && !(await validBranchName(room.path, asked))) throw new Error(`${asked} is not a valid branch name.`)
        const issue = o.source?.kind === 'issue' ? o.source : undefined
        const labels = o.labels ?? (issue && !issue.id.startsWith('#') && !asked && !reviewed && !o.lead ? await this.k.integrations.issueLabels(issue.id) : [])
        branch = await freeBranch(room.path, asked || (reviewed ? reviewBranch(reviewed.title ?? reviewed.name, reviewed.source?.kind === 'issue' ? reviewed.source.id : undefined)
          : o.lead ? branchName(repo.workspace.leadBranchPattern || s.workspace.leadBranchPattern, { slug: shortSlug(title || 'chat'), lead: agent.name })
          : taskBranch(repo.workspace.branchPattern ?? s.workspace.branchPattern, issue ? issue.title : title, issue?.id, branchType(labels))))
        path = await createWorktree({ repo: room.path, root: join(s.worktreeRoot, slugify(room.name)), branch, baseRef })
        // Local files are copied later, once the room's text is trusted (KERNEL-209).
        if (repo.files.symlinkNodeModules) await linkNodeModules(room.path, path)
      } else if (o.lead) {
        // A room with no commit to start from keeps Rowan on the checkout, with no baseline, as before KERNEL-355.
        path = room.path
        branch = await currentBranch(room.path).catch(() => room.defaultBranch)
      } else {
        if (s.workspace.oneCurrentBranchPerRoom && this.store.workspaces(roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== agent.id))
          throw new Error('Another workspace is already working on the current branch in this room.')
        path = room.path
        branch = await currentBranch(room.path)
        if (s.workspace.baselineCurrentBranch) baselineRef = (await snapshotBaseline(room.path)).ref
      }

      // The Lead chat goes in the first record, so it's there before the teammate's first turn can end (KERNEL-105), with the Lead
      // chat that tab belongs to, which outlasts the tab (KERNEL-337). A review the Lead started with base_ref keeps the Lead's
      // base and branch, and is only linked (KERNEL-299). A chat with Rowan's own workspace carries that chat (KERNEL-405).
      const reviewOf = reviewed?.id ?? (mode === 'worktree' ? o.linkReviewOf : undefined)
      const threadId = o.lead?.threadId ?? (o.leadChatId ? this.store.chat(o.leadChatId)?.threadId : undefined)
      const w: Workspace = { id: newId(), roomId, name: slugify(title || 'chat'), branch, baseRef, ...(stale ? { fetchFailed: `Fetching ${remote} failed (${stale.error}), so it started from ${baseRef} as of ${stale.when ?? 'its last fetch'}.` } : {}), path, mode, agentId: agent.id, ...(o.lead ? { lead: true as const } : {}), port, status: 'setup', baselineRef, source: o.source, title, leadChatId: o.leadChatId, ...(threadId ? { threadId } : {}), ...(reviewOf ? { reviewOf } : {}), ...(o.waitFor?.length ? { waitsFor: { on: o.waitFor, held: true } } : {}), prState: 'none', createdAt: Date.now() }
      this.store.saveWorkspace(w)
      return w
    })
    // Until its brief has gone out, the Lead's messages to it wait here (KERNEL-118). Nobody messages Rowan's own workspace.
    if (!o.lead) this.k.setup.setSetup(ws.id, { later: [] })
    bus.push({ type: 'workspace', workspace: ws })
    bus.activity({ kind: 'workspace.created', roomId, workspaceId: ws.id, agentId: agent.id, text: 'started', object: ws.name })
    if (!o.lead) bus.track({ name: 'workspace.created', by: o.leadChatId ? 'lead' : 'user', review: !!(o.reviewOf ?? o.linkReviewOf) })
    if (stale) bus.activity({ kind: 'note', roomId, workspaceId: ws.id, agentId: agent.id, actor: 'kernel', text: `started ${ws.name} from ${baseRef} as last fetched${stale.when ? ` ${stale.when}` : ''}, because fetching ${remote} failed:`, object: stale.error, warn: true })
    // A Linear issue goes to In Progress. A GitHub issue ("#41") is left to GitHub.
    if (!o.lead && o.source?.kind === 'issue' && o.source.id && !o.source.id.startsWith('#')) void this.k.integrations.startIssue(ws, o.source.id)
    // Rowan's hand-off: the board task this workspace builds moves to Building now, not when the turn ends.
    const taskId = o.taskFor?.(ws)
    if (taskId) { ws.taskId = taskId; this.saveWs(ws) }

    const pick = { model: o.model ?? this.k.team.modelFor(agent), effort: o.effort ?? agent.effort ?? s.models.effort, plan: o.plan ?? (agent.lead && s.models.leadPlanMode) }
    // A chat with Rowan's first tab is auto-named, and the chat takes its name (KERNEL-337).
    const chat = o.lead ? this.newChat(ws.id, NEW_TAB, { ...pick, threadId: o.lead.threadId }) : this.newChat(ws.id, title, pick)
    if (stale) this.note(ws.id, `Couldn't fetch ${remote} (${stale.error}), so this workspace started from ${baseRef} as of ${stale.when ?? 'its last fetch'}. It may be missing recent merges.`)
    return { ws, room, repo, chat }
  }

  /**
   * A new workspace's setup: trust first, then files.copy and setup, then ready, the start checkpoint and the run script.
   *
   * With a `brief` (a hand-off or New workspace), the brief waits in the chat's queue until setup passes, then goes out with the
   * Lead's messages that came while it ran (KERNEL-118). A hand-off awaits it all, so create_workspace reports a failed setup
   * (KERNEL-122). With none (a fork, a chat with Rowan, a restore), the caller already holds the chat, and what waits in its tabs
   * goes out when setup passes, or after Run again or trusting the room. `checkpoint: false` takes no start checkpoint, for a
   * restore (KERNEL-77).
   */
  async setUpWorkspace(ws: Workspace, room: Room, repo: RepoSettings, chat: Chat, o: { brief?: ChatPart[]; prompt?: string; from?: 'lead'; leadChatId?: string; checkpoint?: boolean } = {}): Promise<Workspace> {
    if (!o.brief) {
      // `recoverSetups` leaves it alone, should it run while this setup does, as for a chat that moves at startup.
      this.k.setup.fresh.add(ws.id)
      try { return await this.setUpHeld(ws, room, repo, chat, o.checkpoint) } finally { this.k.setup.fresh.delete(ws.id) }
    }
    const parts = o.brief
    const from = o.from
    this.k.setup.setSetup(ws.id, { ...this.k.setup.setups.get(ws.id), chatId: chat.id, brief: parts, ...(from ? { from } : {}), later: this.k.setup.setups.get(ws.id)?.later ?? [] })
    // The Lead's messages sent before the brief went out follow it, never go before it (KERNEL-118). Messages that
    // arrive while the brief is sent are still caught here, and the mark goes only once the list is empty.
    const after = async (send: (m: ChatPart[]) => Promise<unknown> | void) => {
      for (let held = this.k.setup.setups.get(ws.id); held?.later.length; held = this.k.setup.setups.get(ws.id)) { const m = held.later.shift()!; this.k.setup.saveSetups(); await send(m) }
      this.k.setup.setSetup(ws.id, undefined)
    }
    // Nothing from the repo's settings runs or copies until the user trusts that text for the room (KERNEL-209). The
    // brief waits in the chat's queue, the way it does for a failed setup, and `rooms.trust` sends it.
    let pending: ScriptTrust | null
    try { pending = await this.k.trust.untrusted(room, repo) } catch (e) { this.k.setup.setSetup(ws.id, undefined); throw e }
    if (pending) {
      this.sessions.hold(chat.id, parts, { from })
      await after((m) => this.sessions.hold(chat.id, m, { from: 'lead' }))
      return this.k.trust.holdForTrust(ws.id)
    }
    let ready: boolean
    try { ready = await this.k.setup.prepare(ws, room, repo) } catch (e) { this.k.setup.setSetup(ws.id, undefined); throw e }
    // Archived while setup ran: archive stopped the script, and the workspace stays archived.
    if (this.mustWs(ws.id).status === 'archived') { this.k.setup.setSetup(ws.id, undefined); return this.mustWs(ws.id) }
    // The first prompt waits in the chat's queue until setup passes (WorkspaceSetupFailed.png, "Run again").
    if (!ready) {
      this.sessions.hold(chat.id, parts, { from })
      await after((m) => this.sessions.hold(chat.id, m, { from: 'lead' }))
      const failed = this.updateWs(ws.id, { status: 'failed' })
      // The Lead's create_workspace says so in its result while the Lead's turn still waits for it, so this event doesn't
      // wake the Lead a second time (KERNEL-126). A setup that was stopped, by archive or quit, isn't a failure to report.
      const code = this.k.setup.setupFailures.get(ws.id)
      if (code !== null && failed.status !== 'archived') this.leadUpdates.setup(failed, false, { told: !!o.leadChatId && this.sessions.isRunning(o.leadChatId), code })
      return failed
    }
    // Read again: wait_for_merge may have set or cleared the wait while setup ran (KERNEL-259).
    const wait = this.mustWs(ws.id).waitsFor
    if (wait?.held && wait.on.length) {
      // The brief and the Lead's messages wait in the chat, and only then does the workspace count as ready, so a quit
      // between them finds a ready waiter that Sessions.restore holds again. No checkpoint, run script or turn yet.
      const base = await head(ws.path)
      this.sessions.hold(chat.id, parts, { from })
      await after((m) => this.sessions.hold(chat.id, m, { from: 'lead' }))
      const now = this.mustWs(ws.id)
      if (now.status === 'archived') return now
      const held = this.updateWs(ws.id, { status: 'ready', waitsFor: { ...(now.waitsFor ?? wait), held: true, ...(base ? { base } : {}) } })
      const label = this.k.waits.waitLabelOf(held)
      this.note(ws.id, `Waiting for ${label} to merge. Kernel sends this brief then. Send now starts it sooner.`, undefined, this.k.waits.waitRefsOf(held))
      // The Lead reads it in create_workspace's result while its turn still waits for it (KERNEL-126's pattern).
      this.leadUpdates.waits(held, 'wait.started', { on: held.waitsFor!.on, label, held: true, ...(o.leadChatId && this.sessions.isRunning(o.leadChatId) ? { told: true } : {}) })
      // Something it waits for may have merged while setup ran.
      void this.k.waits.settleWait(ws.id).catch(() => undefined)
      return held
    }
    return this.k.setup.setupDone(ws, room, chat, o.prompt ?? chat.title, async () => {
      // A wait set while the brief was on its way is now a started teammate's (KERNEL-259).
      const late = this.mustWs(ws.id).waitsFor
      if (late?.held) this.updateWs(ws.id, { waitsFor: { ...late, held: false } })
      // The Lead's messages sent before the brief went out go in its first turn, after it (KERNEL-393). One that arrives while
      // it is sent is still caught by `after`.
      const later = this.k.setup.setups.get(ws.id)?.later.splice(0) ?? []
      this.k.setup.saveSetups()
      await this.sessions.sendAll(chat.id, [{ parts, from }, ...later.map((m) => ({ parts: m, from: 'lead' as const }))])
      await after((m) => this.sessions.send(chat.id, m, { from: 'lead' }))
    })
  }

  /** `setUpWorkspace` for a workspace whose chats are already held: a fork, a chat with Rowan, or a restore. */
  private async setUpHeld(ws: Workspace, room: Room, repo: RepoSettings, chat: Chat, checkpoint?: boolean): Promise<Workspace> {
    const untrusted = !!(await this.k.trust.untrusted(room, repo))
    const ready = !untrusted && await this.k.setup.prepare(ws, room, repo)
    for (const m of this.k.setup.setups.get(ws.id)?.later ?? []) this.sessions.hold(chat.id, m, { from: 'lead' })
    if (this.k.setup.setups.has(ws.id)) this.k.setup.setSetup(ws.id, undefined)
    if (untrusted) return this.k.trust.holdForTrust(ws.id)
    if (this.mustWs(ws.id).status === 'archived') return this.mustWs(ws.id)
    if (!ready) {
      const failed = this.updateWs(ws.id, { status: 'failed' })
      const code = this.k.setup.setupFailures.get(ws.id)
      // Rowan's own setup failing is for the user, in the chat. Nobody else handed it off.
      if (code !== null && failed.status !== 'archived' && !failed.lead) this.k.leadUpdates.setup(failed, false, { code })
      return failed
    }
    return this.k.setup.setupDone(ws, room, chat, chat.title, async () => this.k.setup.releaseTabs(ws.id, chat.id), { checkpoint })
  }

  /**
   * Fork into new workspace (KERNEL-346). A worktree on a new branch from the chat's workspace's HEAD, holding that workspace's
   * files as they are now, uncommitted and untracked ones too, with the same agent and base. The chat is forked into it up to
   * `itemId`, the way Fork into new chat does it. Kernel sends nothing: setup runs as for any new workspace, then the user
   * writes the next message. Answers once the workspace and its chat exist, so the window can open it while setup runs.
   */
  async forkWorkspace(chatId: string, itemId?: string): Promise<Workspace> {
    const chat = this.mustChat(chatId)
    if (chat.kind === 'terminal') throw new Error('A big terminal cannot be forked.')
    const src = this.mustWs(chat.workspaceId)
    // Current-branch workspaces share the main checkout, whose changes aren't only the agent's.
    if (src.mode !== 'worktree') throw new Error('Only a workspace with its own worktree can fork into a new workspace.')
    // A chat with Rowan plans and hands off. Its work isn't a task to fork (KERNEL-355, KERNEL-405).
    if (this.isLeadWorkspace(src)) throw new Error("A chat with the Lead can't fork into a new workspace. Fork into a new chat instead.")
    if (src.status === 'archived') throw new Error('Restore the workspace from History to fork it.')
    const room = this.mustRoom(src.roomId)
    const repo = await loadRepoSettings(room.path)
    const from = await head(src.path)
    if (!from) throw new Error(`${src.name} has no commit to fork from.`)
    // Read before anything else changes, so the files are the ones the source had when Fork was pressed.
    const files = await worktreeTree(src.path)
    let ws!: Workspace
    const fork = await this.k.chats.forkChat(chatId, itemId, async () => (ws = await this.forkTree(src, room, repo, from, files)).id)
    this.k.setup.setSetup(ws.id, { chatId: fork.id, later: this.k.setup.setups.get(ws.id)?.later ?? [] })
    // Nothing goes out before setup passes, a message typed while the room waits for trust included.
    this.sessions.hold(fork.id)
    this.note(ws.id, `Forked from ${src.name}, with its files as they were at ${clock(Date.now())}.`)
    void this.setUpWorkspace(ws, room, repo, fork).catch((e) => {
      // A Kernel that stopped meanwhile has closed its database. The next launch finds the workspace in setup and fails it.
      if (this.stopped) return
      console.warn(`[fork] setting up ${ws.name} failed`, e)
      if (this.store.workspace(ws.id)?.status === 'setup') this.updateWs(ws.id, { status: 'failed' })
    })
    return ws
  }

  /** The fork's worktree and record: a branch at `from` whose files are made to match `files`, and the workspace in setup. */
  private async forkTree(src: Workspace, room: Room, repo: RepoSettings, from: string, files: string): Promise<Workspace> {
    const ws = await this.withPort(async (port) => {
      const branch = await freeBranch(room.path, `${capBranch(src.branch, 55)}-fork`)
      const path = await createWorktree({ repo: room.path, root: join(this.settings.worktreeRoot, slugify(room.name)), branch, baseRef: from })
      try {
        await writeTree(path, `${from}^{tree}`, files)
        if (repo.files.symlinkNodeModules) await linkNodeModules(room.path, path)
      } catch (e) {
        await removeWorktree(room.path, path, { deleteBranch: branch, force: true }).catch(() => undefined)
        throw e
      }
      // The sidebar shows the name, so the fork's says what it is and takes the branch's number: kernel-155-home-fork-2.
      const name = `${slugify(src.name, 40)}-fork${/-fork(-\d+)$/.exec(branch)?.[1] ?? ''}`
      const w: Workspace = { id: newId(), roomId: room.id, name, title: src.title ?? src.name, branch, baseRef: src.baseRef, path, mode: 'worktree', agentId: src.agentId, port, status: 'setup', prState: 'none', createdAt: Date.now() }
      this.store.saveWorkspace(w)
      return w
    })
    // The Lead's messages that arrive during setup wait here, as for a hand-off's workspace (KERNEL-118).
    this.k.setup.setSetup(ws.id, { later: [] })
    bus.push({ type: 'workspace', workspace: ws })
    bus.activity({ kind: 'workspace.created', actor: 'you', roomId: room.id, workspaceId: ws.id, agentId: ws.agentId, text: `forked ${src.name} into`, object: ws.name })
    return ws
  }

  /** The first port of every open workspace's block. */
  openPorts() { return this.store.workspaces().filter((w) => w.status !== 'archived').map((w) => w.port) }

  /**
   * The one way a workspace gets ports: a free block (`portBlock`), held in memory while `use` runs, through its awaits,
   * until it has stored the workspace that uses it, so a second hand-off in the same turn can't pick it too (KERNEL-244).
   * The block goes back if `use` throws.
   */
  async withPort<T>(use: (port: number) => T | Promise<T>): Promise<T> {
    const port = await portBlock(() => this.openPorts(), this.reservedPorts)
    try { return await use(port) } finally { this.reservedPorts.delete(port) }
  }

  /**
   * Whether a worktree workspace's folder was deleted outside Kernel (KERNEL-291). The flag is set or cleared to match, and pushed
   * when it changes. A current-branch workspace is the room's own checkout, so it is never flagged. An archived one has no folder.
   */
  async checkFolder(id: string): Promise<boolean> {
    const ws = this.mustWs(id)
    if (ws.mode !== 'worktree' || ws.status === 'archived') return false
    const gone = await folderGone(ws.path).catch(() => false)
    if (gone !== !!this.mustWs(id).folderGone) this.updateWs(id, { folderGone: gone ? true : undefined })
    return gone
  }

  /** The files a workspace changed. Their totals are saved on the workspace too, for the sidebar and Home (+412 -38). */
  async changes(id: string) {
    // A folder deleted outside Kernel has no changes to read, and the workspace says so (KERNEL-291).
    if (await this.checkFolder(id)) return []
    const ws = this.mustWs(id)
    const files = ws.mode === 'current'
      ? await changedFiles(ws.path, ws.baselineRef ?? 'HEAD')
      : await changedFiles(ws.path, await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef))
    const stat = { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }
    const old = this.mustWs(id).stat
    if (!old || old.files !== stat.files || old.added !== stat.added || old.removed !== stat.removed) this.updateWs(id, { stat })
    return files
  }

  /** What the diff compares against: the baseline for current-branch workspaces, the merge base with the base branch otherwise. */
  private async since(ws: Workspace) {
    return ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)
  }

  private async diff(id: string, file?: string) {
    const ws = this.mustWs(id)
    return diffText(ws.path, await this.since(ws), file)
  }

  private async hunks(id: string, path?: string) {
    const ws = this.mustWs(id)
    return listHunks(ws.path, { baselineRef: ws.mode === 'current' ? ws.baselineRef : undefined }, path)
  }

  /**
   * Diff totals for every live workspace, once at launch, so the sidebar has them before any turn ends. A worktree whose folder was
   * deleted while Kernel was closed is flagged here (KERNEL-291).
   */
  async countChanges() {
    for (const ws of this.store.workspaces()) {
      if (ws.status === 'archived') continue
      if (ws.status === 'setup') await this.checkFolder(ws.id).catch(() => undefined)
      else await this.changes(ws.id).catch(() => undefined)
    }
  }

  handlers() {
    return {
      'workspaces.list': async ({ roomId }) => this.store.workspaces(roomId),
      // Workspaces you start yourself follow "Start new workspaces in plan mode". The Lead's hand-offs call createWorkspace directly (KERNEL-74).
      'workspaces.create': async ({ roomId, ...o }) => this.createWorkspace(roomId, { ...o, plan: o.plan ?? this.settings.models.workspacePlanMode }),
      'workspaces.fork': async ({ chatId, itemId }) => this.forkWorkspace(chatId, itemId),
      'workspaces.changes': async ({ workspaceId }) => this.changes(workspaceId),
      'workspaces.diff': async ({ workspaceId, file }) => this.diff(workspaceId, file),
      'workspaces.tree': async ({ workspaceId }) => listTree(this.mustWs(workspaceId).path, await this.changes(workspaceId).catch(() => [])),
      'workspaces.readFile': async ({ workspaceId, path }) => readWorkspaceFile(this.mustWs(workspaceId).path, path),
      'workspaces.readImage': async ({ workspaceId, path, at }) => {
        const ws = this.mustWs(workspaceId)
        return readImage(ws.path, path, at === 'base' ? await this.since(ws) : undefined)
      },
      'workspaces.files': async ({ workspaceId, query, limit }) => searchFiles(this.mustWs(workspaceId).path, query, limit),
      'workspaces.hunks': async ({ workspaceId, path }) => this.hunks(workspaceId, path),
      'workspaces.commit': async ({ workspaceId, hunkIds, message }) => {
        const picked = (await this.hunks(workspaceId)).filter((h) => hunkIds.includes(h.id))
        if (picked.length !== hunkIds.length) throw new Error('Those changes moved on. Open the card again and pick again.')
        await commitHunks(this.mustWs(workspaceId).path, picked, message?.trim() || `Update ${[...new Set(picked.map((h) => h.path))].join(', ')}`)
        return { ok: true }
      }
    } satisfies Partial<Handlers>
  }
}
