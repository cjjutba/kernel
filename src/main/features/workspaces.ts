import { join } from 'node:path'
import type { Chat, ChatPart, Effort, ModelId, Room, ScriptTrust, Workspace, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { newId } from '../db'
import { bus } from '../bus'
import { loadRepoSettings, type RepoSettings } from '../services/settings'
import { clock, worktreeTree, writeTree } from '../services/checkpoints'
import { branchType, capBranch, changedFiles, createWorktree, currentBranch, diffText, fetchOrigin, freeBranch, mergeBase, onRemote, removeWorktree, resolveBaseRef, reviewBranch, slugify, snapshotBaseline, taskBranch, validBranchName } from '../services/worktrees'
import { linkNodeModules, portBlock } from '../services/scripts'
import { exec } from '../services/exec'
import { listTree, readWorkspaceFile, searchFiles } from '../services/files'
import { commitHunks, listHunks } from '../services/hunks'
import { head, messageOf } from './shared'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** When origin was last fetched, for a workspace that started from it after a fetch failed: "Oct 10, 2:05 PM (3 hours ago)". */
export function fetchedAt(ts: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ts) / 60000))
  const [n, unit] = min < 60 ? [min, 'minute'] : min < 60 * 48 ? [Math.round(min / 60), 'hour'] : [Math.round(min / 1440), 'day']
  const ago = n === 0 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`
  return `${new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${ago})`
}

/** Creating workspaces, their ports, and what they changed (KERNEL-328). */
export class Workspaces extends Feature {
  /** Ports handed out to workspaces not saved yet, so two hand-offs in one turn never share a block (KERNEL-244). */
  readonly reservedPorts = new Set<number>()

  async createWorkspace(roomId: string, o: { prompt: string; parts?: ChatPart[]; source?: WorkspaceSource; agentId?: string; mode?: WorkspaceMode; baseRef?: string; title?: string; branch?: string; model?: ModelId; effort?: Effort; plan?: boolean; taskFor?: (ws: Workspace) => string | undefined; leadChatId?: string; reviewOf?: string; linkReviewOf?: string; labels?: string[]; waitFor?: string[] }): Promise<Workspace> {
    const room = this.mustRoom(roomId)
    const repo = await loadRepoSettings(room.path)
    const s = this.settings
    const agents = await this.k.team.agents(roomId)
    const agent = agents.find((a) => a.id === o.agentId) ?? agents.find((a) => a.lead) ?? agents[0]
    if (!agent) throw new Error('This room has no agents. Add one to .claude/agents first.')
    // A review gets its own worktree started from the work it reviews (KERNEL-130).
    // The branch the author is on now, which may not be the one the workspace started on (KERNEL-68).
    const reviewed = o.reviewOf && this.store.workspace(o.reviewOf) ? await this.k.prs.syncBranch(o.reviewOf) : undefined
    if (o.reviewOf && (!reviewed || reviewed.roomId !== roomId || reviewed.status === 'archived')) throw new Error('The workspace to review is not open in this room.')
    const mode = reviewed ? 'worktree' : o.mode ?? repo.workspace.mode ?? s.workspace.mode
    if (o.waitFor?.length && (mode === 'current' || reviewed)) throw new Error(reviewed ? 'A review never waits for another PR.' : "A workspace on the main checkout can't wait for a PR. Pass mode worktree.")
    const title = o.title ?? o.prompt.split(/\s+/).slice(0, 6).join(' ')
    const remote = await this.k.config.remoteFor(room.path, repo)
    // `origin/` in a base from Settings, the Lead or a PR means the room's remote. A branch picked from the list is a real ref.
    const wanted = o.baseRef ?? repo.workspace.baseRef ?? s.workspace.baseRef
    const want = o.source?.kind === 'branch' ? wanted : onRemote(wanted, remote)
    // A failed fetch still starts the workspace, from the remote as last fetched, and says so (KERNEL-179). A folder
    // without that remote has nothing to fetch, so it says nothing.
    const fetched = !reviewed && mode === 'worktree' && want.startsWith(`${remote}/`) && (await exec('git', ['-C', room.path, 'remote', 'get-url', remote])).code === 0
      ? await fetchOrigin(room.path, remote) : undefined
    const baseRef = reviewed ? await this.k.reviews.reviewBase(room.path, reviewed.branch, remote)
      : await resolveBaseRef(room.path, want, { strict: o.source?.kind === 'pr' || o.source?.kind === 'branch', remote })
    // A local branch the base fell back to wasn't fetched, so a failed fetch says nothing about it.
    const stale = fetched?.ok === false && baseRef.startsWith(`${remote}/`) ? { error: fetched.error, when: fetched.lastFetch === undefined ? undefined : fetchedAt(fetched.lastFetch) } : undefined
    // The ports come first, so running out of them leaves no worktree or branch behind (KERNEL-244).
    const ws: Workspace = await this.withPort(async (port) => {
      let path: string, branch: string, baselineRef: string | undefined
      if (mode === 'worktree') {
        // Kernel names the branch from the issue key and a few words of the title, and the Lead can name it instead, cut to
        // 60 characters (KERNEL-275), for a review too (KERNEL-265). A taken name gets a suffix.
        const asked = o.branch ? capBranch(o.branch) : undefined
        if (asked && !(await validBranchName(room.path, asked))) throw new Error(`${asked} is not a valid branch name.`)
        const issue = o.source?.kind === 'issue' ? o.source : undefined
        const labels = o.labels ?? (issue && !issue.id.startsWith('#') && !asked && !reviewed ? await this.k.integrations.issueLabels(issue.id) : [])
        branch = await freeBranch(room.path, asked || (reviewed ? reviewBranch(reviewed.title ?? reviewed.name, reviewed.source?.kind === 'issue' ? reviewed.source.id : undefined)
          : taskBranch(repo.workspace.branchPattern ?? s.workspace.branchPattern, issue ? issue.title : title, issue?.id, branchType(labels))))
        path = await createWorktree({ repo: room.path, root: join(s.worktreeRoot, slugify(room.name)), branch, baseRef })
        // Local files are copied later, once the room's text is trusted (KERNEL-209).
        if (repo.files.symlinkNodeModules) await linkNodeModules(room.path, path)
      } else {
        if (s.workspace.oneCurrentBranchPerRoom && this.store.workspaces(roomId).some((w) => w.mode === 'current' && w.status !== 'archived' && w.agentId !== agent.id))
          throw new Error('Another workspace is already working on the current branch in this room.')
        path = room.path
        branch = await currentBranch(room.path)
        if (s.workspace.baselineCurrentBranch) baselineRef = (await snapshotBaseline(room.path)).ref
      }

      // The Lead chat goes in the first record, so it's there before the teammate's first turn can end (KERNEL-105), with the Lead
      // chat that tab belongs to, which outlasts the tab (KERNEL-337). A review the Lead started with base_ref keeps the Lead's
      // base and branch, and is only linked (KERNEL-299).
      const reviewOf = reviewed?.id ?? (mode === 'worktree' ? o.linkReviewOf : undefined)
      const threadId = o.leadChatId ? this.store.chat(o.leadChatId)?.threadId : undefined
      const w: Workspace = { id: newId(), roomId, name: slugify(title), branch, baseRef, ...(stale ? { fetchFailed: `Fetching ${remote} failed (${stale.error}), so it started from ${baseRef} as of ${stale.when ?? 'its last fetch'}.` } : {}), path, mode, agentId: agent.id, port, status: 'setup', baselineRef, source: o.source, title, leadChatId: o.leadChatId, ...(threadId ? { threadId } : {}), ...(reviewOf ? { reviewOf } : {}), ...(o.waitFor?.length ? { waitsFor: { on: o.waitFor, held: true } } : {}), prState: 'none', createdAt: Date.now() }
      this.store.saveWorkspace(w)
      return w
    })
    // Until its brief has gone out, the Lead's messages to it wait here (KERNEL-118).
    this.k.setup.setSetup(ws.id, { later: [] })
    bus.push({ type: 'workspace', workspace: ws })
    bus.activity({ kind: 'workspace.created', roomId, workspaceId: ws.id, agentId: agent.id, text: 'started', object: ws.name })
    if (stale) bus.activity({ kind: 'note', roomId, workspaceId: ws.id, agentId: agent.id, actor: 'kernel', text: `started ${ws.name} from ${baseRef} as last fetched${stale.when ? ` ${stale.when}` : ''}, because fetching ${remote} failed:`, object: stale.error, warn: true })
    // A Linear issue goes to In Progress. A GitHub issue ("#41") is left to GitHub.
    if (o.source?.kind === 'issue' && o.source.id && !o.source.id.startsWith('#')) void this.k.integrations.startIssue(ws, o.source.id)
    // Rowan's hand-off: the board task this workspace builds moves to Building now, not when the turn ends.
    const taskId = o.taskFor?.(ws)
    if (taskId) { ws.taskId = taskId; this.saveWs(ws) }

    const chat = this.newChat(ws.id, title, { model: o.model ?? this.k.team.modelFor(agent), effort: o.effort ?? agent.effort ?? s.models.effort, plan: o.plan ?? (agent.lead && s.models.leadPlanMode) })
    if (stale) this.note(ws.id, `Couldn't fetch ${remote} (${stale.error}), so this workspace started from ${baseRef} as of ${stale.when ?? 'its last fetch'}. It may be missing recent merges.`)
    const parts = messageOf(o.prompt, o.parts)
    // A brief from the Lead's hand-off is the Lead's message in the teammate's chat, not the user's (KERNEL-116).
    const from = o.leadChatId ? 'lead' as const : undefined
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
    return this.k.setup.setupDone(ws, room, chat, o.prompt, async () => {
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
    // The Lead and current-branch workspaces share the main checkout, whose changes aren't only the agent's.
    if (src.mode !== 'worktree') throw new Error('Only a workspace with its own worktree can fork into a new workspace.')
    if (src.status === 'archived') throw new Error('Restore the workspace from History to fork it.')
    const room = this.mustRoom(src.roomId)
    const repo = await loadRepoSettings(room.path)
    const from = await head(src.path)
    if (!from) throw new Error(`${src.name} has no commit to fork from.`)
    // Read before anything else changes, so the files are the ones the source had when Fork was pressed.
    const files = await worktreeTree(src.path)
    let ws!: Workspace
    const fork = await this.k.chats.forkChat(chatId, itemId, async () => (ws = await this.forkTree(src, room, repo, from, files)).id)
    this.k.setup.setSetup(ws.id, { chatId: fork.id, later: this.k.setup['setups'].get(ws.id)?.later ?? [] })
    // Nothing goes out before setup passes, a message typed while the room waits for trust included.
    this.sessions.hold(fork.id)
    this.note(ws.id, `Forked from ${src.name}, with its files as they were at ${clock(Date.now())}.`)
    void this.setUpFork(ws, room, repo, fork).catch((e) => {
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

  /**
   * A fork's setup, the way a new workspace's goes, with no brief: trust first, then files.copy and setup, then ready. The chat
   * is held until then, and what waits in it, the Lead's messages from setup included, goes out when setup passes, or after Run
   * again or trusting the room.
   */
  private async setUpFork(ws: Workspace, room: Room, repo: RepoSettings, chat: Chat) {
    const untrusted = !!(await this.k.trust.untrusted(room, repo))
    const ready = !untrusted && await this.k.setup['prepare'](ws, room, repo)
    for (const m of this.k.setup['setups'].get(ws.id)?.later ?? []) this.sessions.hold(chat.id, m, { from: 'lead' })
    this.k.setup.setSetup(ws.id, undefined)
    if (untrusted) { await this.k.trust.holdForTrust(ws.id); return }
    if (this.mustWs(ws.id).status === 'archived') return
    if (!ready) {
      const failed = this.updateWs(ws.id, { status: 'failed' })
      const code = this.k.setup['setupFailures'].get(ws.id)
      if (code !== null && failed.status !== 'archived') this.k.leadUpdates.setup(failed, false, { code })
      return
    }
    await this.k.setup['setupDone'](ws, room, chat, chat.title, async () => this.sessions.release(chat.id))
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

  /** The files a workspace changed. Their totals are saved on the workspace too, for the sidebar and Home (+412 -38). */
  async changes(id: string) {
    const ws = this.mustWs(id)
    const files = ws.mode === 'current'
      ? await changedFiles(ws.path, ws.baselineRef ?? 'HEAD')
      : await changedFiles(ws.path, await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef))
    const stat = { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }
    const old = this.mustWs(id).stat
    if (!old || old.files !== stat.files || old.added !== stat.added || old.removed !== stat.removed) this.updateWs(id, { stat })
    return files
  }

  private async diff(id: string, file?: string) {
    const ws = this.mustWs(id)
    const since = ws.mode === 'current' ? ws.baselineRef ?? 'HEAD' : await mergeBase(ws.path, ws.baseRef).catch(() => ws.baseRef)
    return diffText(ws.path, since, file)
  }

  private async hunks(id: string, path?: string) {
    const ws = this.mustWs(id)
    return listHunks(ws.path, { baselineRef: ws.mode === 'current' ? ws.baselineRef : undefined }, path)
  }

  /** Diff totals for every live workspace, once at launch, so the sidebar has them before any turn ends. */
  async countChanges() {
    for (const ws of this.store.workspaces()) if (ws.status !== 'archived' && ws.status !== 'setup') await this.changes(ws.id).catch(() => undefined)
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
