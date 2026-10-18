import { REVIEW_KINDS, type AgentDef, type Chat, type ChatPart, type Provider, type ReviewConfig, type ReviewKind, type BaseUpdate, type ReviewRound, type ReviewVerdict, type ResolvedPick, type TeamConfig, type Workspace } from '@shared/types'
import { kindStates, lensOf, reviewsText, reviewVerdicts, sameHeads } from '@shared/merge'
import { KERNEL_REVIEWER, NO_REVIEWER } from '@shared/team'
import { providerOf } from '@shared/providers'
import { buildsHere } from '@shared/leadMode'
import { bus } from '../bus'
import type { ReviewState } from '../services/leadUpdates'
import type { ReviewInput } from '../services/reviewMcp'
import { reviewRule } from '../services/handoff'
import { remoteOf, reviewPolicyOf, saveAlwaysReview, saveReviewSettings } from '../services/settings'
import { fetchOrigin, resolveBaseRef } from '../services/worktrees'
import { exec } from '../services/exec'
import { isUnreadable } from '../services/agents'
import { inPaths, kindLabel, kindsFor, lensAgent } from '../services/lenses'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/**
 * One kind of review a PR gets, as Kernel settles it when the review starts (KERNEL-549): the project agent that runs it, none
 * for Kernel's own prompt, whether its approval counts toward a merge, the model its chat runs on, and its `paths`.
 */
export interface PlannedReview { kind: ReviewKind; agent?: AgentDef; optional: boolean; model?: string; provider?: Provider; paths: string[] }

/** Whether changed `files` touch a kind's `paths`. Empty `paths` cover every file, as `kindsFor` reads them. */
const touches = (paths: string[], files: string[]) => (paths.length ? files.some((f) => inPaths(f, paths)) : files.length > 0)

/** A PR's base branch's review policy, and the ref Kernel read it from, none when no ref for the base resolves. */
interface Policy { review: ReviewConfig; team: TeamConfig; base?: string }

/**
 * Review workspaces: where they start, the rule they get, and the verdicts they send (KERNEL-130, KERNEL-330). Since
 * KERNEL-549 Kernel starts them itself when a PR passes checks: one review workspace per PR, with one chat for each kind of
 * review the project's `[review]` asks for, as the PR's base branch has it.
 */
export class Reviews extends Feature {
  /** PRs whose reviews Kernel is starting, by workspace id, so an update meanwhile reads them as in progress. */
  private starting = new Set<string>()
  /** Workspace id to the PR head where only automatic review being off kept a review round from starting. */
  private notStarted = new Map<string, string>()

  /** Where a review worktree starts: the reviewed workspace's branch, or its copy on the remote when the local one is gone. */
  async reviewBase(repo: string, branch: string, remote: string): Promise<string> {
    try { return await resolveBaseRef(repo, branch, { strict: true, remote }) } catch { return resolveBaseRef(repo, `${remote}/${branch}`, { fetch: true, strict: true, remote }) }
  }

  /** The rule appended to a review chat's prompt, naming the work it reviews and, for a chat Kernel started, its kind of review. */
  reviewRuleFor(ws: Workspace, chat?: Chat): string | undefined {
    const of = ws.reviewOf ? this.store.workspace(ws.reviewOf) : undefined
    if (!of) return undefined
    const author = this.agentsSync(ws.projectId).find((a) => a.id === of.agentId)?.name ?? of.agentId
    // With a PR, the review is of what the PR holds on GitHub, the commit verdicts are checked against. Before one, it is
    // of the author's local branch, or the remote's copy when the local one was gone (reviewBase).
    const project = this.store.project(ws.projectId)
    const remote = remoteOf({ workspace: { remote: project && this.k.config['projectRemotes'].get(project.path) } }, this.settings)
    const resetTo = of.prNumber ? `${remote}/${of.branch}` : ws.baseRef
    const lens = chat?.lens?.kind
    const others = lens ? [...new Set(this.chatTabs(ws.id).flatMap((c) => (c.lens && c.lens.kind !== lens ? [c.lens.kind] : [])))] : []
    return reviewRule({ author, task: of.title ?? of.name, workspaceId: of.id, branch: of.branch, resetTo, base: of.baseRef, ...(of.prNumber ? { pr: { number: of.prNumber, url: of.prUrl } } : {}), ...(lens ? { lens, others } : {}) }, remote)
  }

  /**
   * The agent a review chat runs (KERNEL-549): the project agent its kind named when it started, else Kernel's own prompt for the
   * kind. One whose agent has left the team runs Kernel's prompt. Undefined for any other chat, which runs its workspace's agent.
   */
  agentForChat(ws: Workspace, chat: Chat): AgentDef | undefined {
    if (!ws.reviewOf || !chat.lens) return undefined
    const own = chat.lens.agent ? this.k.team.agentOf(ws.projectId, chat.lens.agent) : undefined
    return own && !own.retired && !isUnreadable(own) ? own : lensAgent(chat.lens.kind)
  }

  /**
   * `[review]` and `[team]` as the PR's base branch has them, from `<remote>/<base>`, else the local base branch (KERNEL-549).
   * Never the PR's own head, so a PR that changes the review policy is reviewed by the one it would change. A base with no
   * settings file, or none Kernel can resolve, runs on the defaults.
   */
  async policyFor(of: Workspace): Promise<Policy> {
    const project = this.mustProject(of.projectId)
    const remote = await this.k.config.remoteFor(project.path)
    const name = of.baseRef.startsWith(`${remote}/`) ? of.baseRef.slice(remote.length + 1) : of.baseRef
    for (const ref of new Set([`${remote}/${name}`, of.baseRef, name])) {
      if (!(await this.resolves(project.path, ref))) continue
      const shown = await exec('git', ['-C', project.path, 'show', `${ref}:.kernel/settings.toml`])
      return { ...reviewPolicyOf(shown.code === 0 ? shown.stdout : undefined), base: ref }
    }
    return reviewPolicyOf(undefined)
  }

  private async resolves(repo: string, ref: string): Promise<boolean> {
    return (await exec('git', ['-C', repo, 'rev-parse', '--verify', '-q', `${ref}^{commit}`])).code === 0
  }

  /** The files the PR changes against its base, renames as both paths, or undefined when git can't say. */
  private async changedFiles(of: Workspace, base: string): Promise<string[] | undefined> {
    const project = this.mustProject(of.projectId)
    const remote = await this.k.config.remoteFor(project.path)
    for (const head of [of.prHead, `${remote}/${of.branch}`, of.branch]) {
      if (!head || !(await this.resolves(project.path, head))) continue
      const r = await exec('git', ['-C', project.path, 'diff', '--name-only', '--no-renames', '-z', `${base}...${head}`])
      return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : undefined
    }
    return undefined
  }

  /** The files that differ between two commits of a PR, or undefined when git can't say, as when one is gone after a force push. */
  private async filesBetween(of: Workspace, from: string, to: string): Promise<string[] | undefined> {
    const repo = this.mustProject(of.projectId).path
    if (!from || !to || !(await this.resolves(repo, from)) || !(await this.resolves(repo, to))) return undefined
    const r = await exec('git', ['-C', repo, 'diff', '--name-only', '--no-renames', '-z', from, to])
    return r.code === 0 ? r.stdout.split('\0').filter(Boolean) : undefined
  }

  /**
   * The reviews a PR gets, in REVIEW_KINDS' order (KERNEL-549): each kind its base branch's `[review]` turns on whose paths
   * the PR touches. A kind's `agent` runs it. The code review's is otherwise the project's reviewer, as the base branch's
   * `[team]` picks it, or Kernel's prompt when there is none. `[team] reviewer = "none"` leaves code review out unless
   * `[review.code]` names an agent. An agent never reviews its own PR: that kind runs Kernel's prompt instead. `rounds` is the
   * base branch's `[review] rounds` (KERNEL-552).
   */
  async planFor(of: Workspace): Promise<{ plan: PlannedReview[]; rounds: number }> {
    const policy = await this.policyFor(of)
    const files = policy.base ? await this.changedFiles(of, policy.base) : undefined
    const pool = this.agentsSync(of.projectId).filter((a) => !a.lead && !a.retired && !a.builtIn && !isUnreadable(a))
    const plan = kindsFor(policy.review, files).flatMap((kind): PlannedReview[] => {
      const c = policy.review.kinds[kind]
      let agent = c.agent ? pool.find((a) => a.id === c.agent) : undefined
      if (kind === 'code' && !c.agent) {
        const named = policy.team.reviewer
        if (named === NO_REVIEWER) return []
        // The reviewer `[team]` names, else the first agent whose role says review, as Team resolves it (KERNEL-397).
        agent = named === KERNEL_REVIEWER ? undefined : named ? pool.find((a) => a.id === named) : pool.find((a) => a.origin !== 'plugin' && /\breview/i.test(a.role))
      }
      if (agent?.id === of.agentId) agent = undefined
      return [{ kind, ...(agent ? { agent } : {}), optional: !c.required, ...(c.model ? { model: c.model } : {}), ...(c.provider ? { provider: c.provider } : {}), paths: c.paths }]
    })
    return { plan, rounds: policy.review.rounds }
  }

  /** The PR's latest review round, none when there is none yet or it was of another PR, as after Continue (KERNEL-552). */
  private roundOf(ws: Workspace): ReviewRound | undefined {
    return ws.reviewRound && ws.reviewRound.prNumber === ws.prNumber ? ws.reviewRound : undefined
  }

  /**
   * The review round Kernel starts on the PR's head (KERNEL-552), or none once `[review] rounds` rounds ran and the last one
   * left blockers. After a round, a kind that approved its head keeps that approval unless the new commits touch the kind's
   * paths, so after a fix only the kinds that blocked run again. Kernel doesn't know what changed when either commit is gone,
   * and then every kind runs. Near the usage limit an optional kind that would run is skipped. A round that runs nothing,
   * every kind kept or skipped, doesn't count toward `rounds`.
   */
  private async nextRound(of: Workspace, plan: PlannedReview[], rounds: number): Promise<ReviewRound | undefined> {
    const last = this.roundOf(of)
    const head = of.prHead ?? ''
    let kept: ReviewKind[] = []
    if (last) {
      const before = kindStates({ ...of, prHead: last.head })
      if (last.n >= rounds && before.blocking.length) return undefined
      const files = await this.filesBetween(of, last.head, head)
      kept = files ? plan.filter((p) => before.approved.includes(p.kind) && !touches(p.paths, files)).map((p) => p.kind) : []
    }
    const skipped = plan.filter((p) => !kept.includes(p.kind) && p.optional && !!this.k.account.nearLimit(this.modelFor(p, of).provider)).map((p) => p.kind)
    const runs = plan.length - kept.length - skipped.length
    const optional = plan.filter((p) => p.optional).map((p) => p.kind)
    return { n: (last?.n ?? 0) + (runs ? 1 : 0), rounds, head, prNumber: of.prNumber!, kinds: plan.map((p) => p.kind), ...(kept.length ? { kept } : {}), ...(skipped.length ? { skipped } : {}), ...(optional.length ? { optional } : {}) }
  }

  /**
   * Automatic review is off, so the ready PR gets no review round. Remembers the head when a round would have started, for
   * the Lead's update to say why none did (feat-automatic-review-off-by-default): `[review]` plans a review of the PR, its head
   * had no round, and no review workspace is open. Nothing is saved, so a restart forgets it and the next ready reads it again.
   */
  private async noteNotStarted(of: Workspace): Promise<void> {
    this.notStarted.delete(of.id)
    const head = of.prHead ?? ''
    if (this.roundOf(of)?.head === head || this.openReview(of)) return
    const { plan } = await this.planFor(of)
    const now = this.store.workspace(of.id)
    if (!plan.length || !now || now.status === 'archived' || now.prState !== 'ready' || (now.prHead ?? '') !== head || this.stopped) return
    this.notStarted.set(of.id, head)
  }

  /** No review covers the ready PR, so the chat's own ready row is the only sign its checks passed (KERNEL-990). */
  private noReview(id: string) {
    const ws = this.store.workspace(id)
    if (!ws || this.stopped) return
    const s = this.reviewState(ws)
    if (!s.inProgress && !s.approved.length && !s.blocking.length && !s.open) this.k.prs.readyNote(id)
  }

  /**
   * A teammate's PR passed checks (KERNEL-549). While `pr.autoReview` is on, Kernel starts a review round on its head
   * (KERNEL-552): a review workspace with a chat per kind the first time, and after that a new chat for a kind it lacks and
   * "review again" to each kind the round runs. One round per head commit, so a ready on a head that already had one, as
   * when the base moved, starts nothing, and a change to `[review]` meanwhile waits for the next. Except when the user
   * archived the review workspace before every kind reported: then the kinds with no verdict on the head run again in a new
   * review workspace, in the same round (KERNEL-633). A head Kernel updated from the base is the head it updated, so it
   * starts no round of its own (KERNEL-832). Reviews get none, and the Lead's own workspaces get none unless the chat
   * is in Build here, whose PR is reviewed as a teammate's (KERNEL-778). From the ready event
   * until the round is saved, the workspace's `reviewPending` names the head, so a PR waiting for its reviewer's approval
   * doesn't merge before Kernel knows which reviews it gets (KERNEL-717). A plan that comes back empty clears it.
   */
  async onReady(workspaceId: string): Promise<void> {
    const of = this.store.workspace(workspaceId)
    if (!of || of.status === 'archived' || of.reviewOf || of.prState !== 'ready' || !of.prNumber || (this.isLeadWorkspace(of) && !buildsHere(of))) return
    if (this.settings.pr.autoReview === false) {
      if (of.reviewPending !== undefined) this.updateWs(of.id, { reviewPending: undefined })
      await this.noteNotStarted(of)
      return this.noReview(of.id)
    }
    this.notStarted.delete(of.id)
    if (this.starting.has(of.id)) return
    // Never awaited, so the round below marks the review as starting before anything else reads it.
    void this.recheck(of).catch((e) => { if (!this.stopped) console.warn(`[reviews] asking ${of.name}'s review again failed`, e) })
    const last = this.roundOf(of)
    const again = last && sameHeads(of, of.prHead ?? '').has(last.head) ? last : undefined
    if (again && (this.openReview(of) || !this.unreported(of, again).length)) return
    // Before any await, so an update composed meanwhile reads the review as in progress, and no merge goes ahead meanwhile.
    this.starting.add(of.id)
    this.updateWs(of.id, { reviewPending: of.prHead ?? '' })
    try {
      await this.k.team.agents(of.projectId)
      const { plan, rounds } = await this.planFor(of)
      const now = this.store.workspace(of.id)
      if (!plan.length || !now || now.status === 'archived' || now.prState !== 'ready' || this.stopped) {
        if (!plan.length) this.noReview(of.id)
        return
      }
      if (again) {
        const run = plan.filter((p) => this.unreported(now, again).includes(p.kind))
        if (run.length && !this.openReview(now)) await this.startReview(now, run)
        return
      }
      const round = await this.nextRound(now, plan, rounds)
      if (this.stopped) return
      // Still blocked after the last round `[review] rounds` allows. The Lead's update brings it to the user, by the same
      // `rounds` this read, saved on the round so the two agree after `[review] rounds` changes (KERNEL-633).
      if (!round) {
        const at = this.roundOf(this.mustWs(of.id))
        if (at && at.rounds !== rounds) this.updateWs(of.id, { reviewRound: { ...at, rounds } })
        return
      }
      const run = plan.filter((p) => !round.kept?.includes(p.kind) && !round.skipped?.includes(p.kind))
      const open = this.openReview(of)
      if (open) await this.reviewAgain(open, now, run)
      else if (run.length) await this.startReview(now, run)
      // Read again after the awaits, so a verdict saved meanwhile isn't lost. A kept approval now counts for the new head.
      const fresh = this.mustWs(of.id)
      const last = this.roundOf(fresh)
      const reviews = fresh.reviews?.map((v) => (last && round.kept?.includes(lensOf(v)) && v.verdict === 'approved' && v.sha === last.head && (!v.prNumber || v.prNumber === fresh.prNumber) ? { ...v, sha: round.head, keptFrom: v.keptFrom ?? v.sha } : v))
      this.updateWs(of.id, { reviewRound: round, reviewPending: undefined, ...(reviews ? { reviews } : {}) })
    } catch (e) {
      if (this.stopped) return
      console.warn(`[reviews] starting the review of ${of.name} failed`, e)
      bus.activity({ kind: 'note', projectId: of.projectId, workspaceId: of.id, agentId: of.agentId, actor: 'kernel', text: "couldn't start the review of", object: `PR #${of.prNumber}`, warn: true })
    } finally {
      this.starting.delete(of.id)
      // A stopped Kernel's database is closed. The marker stays, and `start` takes it up at the next start.
      if (!this.stopped && this.store.workspace(of.id)?.reviewPending !== undefined) this.updateWs(of.id, { reviewPending: undefined })
    }
  }

  /**
   * Takes up the reviews Kernel was working out when it last quit (KERNEL-717): a ready PR whose `reviewPending` still names its
   * head gets its ready again, since no ready event comes for a PR already ready. The marker holds its merge until then.
   */
  start(): void {
    for (const ws of this.store.workspaces()) {
      if (ws.reviewPending === undefined || ws.status === 'archived') continue
      if (ws.prState === 'ready' && ws.reviewPending === (ws.prHead ?? '')) void this.onReady(ws.id).catch(() => undefined)
      else this.updateWs(ws.id, { reviewPending: undefined })
    }
  }

  /**
   * Records that Kernel updated the PR's branch from its base, moving its head from `from` to `to` (KERNEL-832), so the
   * reviews of `from` count on `to` and `to` starts no new review. Call it after the update, as after `gh pr update-branch`.
   * Kernel fetches, then records only when git shows `to` is a merge of `from` with a commit of the base that brings in nothing
   * else: its first parent is `from`, its second is on the base, and its tree is the one git's own merge of the two makes. A
   * head that also carries a teammate's push, or conflicts someone resolved by hand, isn't recorded. True when it was recorded.
   */
  async recordBaseUpdate(workspaceId: string, from: string, to: string): Promise<boolean> {
    const of = this.store.workspace(workspaceId)
    if (!of || !from || !to || from === to) return false
    if (of.baseUpdates?.some((u) => u.from === from && u.to === to)) return true
    const repo = this.mustProject(of.projectId).path
    const remote = await this.k.config.remoteFor(repo)
    await fetchOrigin(repo, remote, { fresh: true })
    const update = await this.mergesBaseOnly(repo, remote, of.baseRef, from, to)
    const now = this.store.workspace(workspaceId)
    if (!update || !now || this.stopped) return false
    this.updateWs(now.id, { baseUpdates: [...(now.baseUpdates ?? []).filter((u) => u.to !== update.to), update] })
    return true
  }

  /**
   * `from` and `to` as full commit ids when `to` is git's merge of `from` with a commit of `base`, as `<remote>/<base>` or else
   * the local branch has it, and nothing else. Undefined otherwise.
   */
  private async mergesBaseOnly(repo: string, remote: string, base: string, from: string, to: string): Promise<BaseUpdate | undefined> {
    const name = base.startsWith(`${remote}/`) ? base.slice(remote.length + 1) : base
    const parents = await exec('git', ['-C', repo, 'rev-list', '--parents', '-n', '1', `${to}^{commit}`])
    const [self, first, second, ...more] = parents.stdout.trim().split(' ')
    if (parents.code !== 0 || !self || !second || more.length) return undefined
    const full = await exec('git', ['-C', repo, 'rev-parse', '--verify', '-q', `${from}^{commit}`])
    if (full.code !== 0 || full.stdout.trim() !== first) return undefined
    let onBase = false
    for (const ref of new Set([`${remote}/${name}`, name])) {
      if (!(await this.resolves(repo, ref))) continue
      onBase = (await exec('git', ['-C', repo, 'merge-base', '--is-ancestor', second, ref])).code === 0
      break
    }
    if (!onBase) return undefined
    // A merge with conflicts exits 1: whoever resolved them wrote changes of their own.
    const merged = await exec('git', ['-C', repo, 'merge-tree', '--write-tree', first, second])
    const tree = await exec('git', ['-C', repo, 'rev-parse', '--verify', '-q', `${to}^{tree}`])
    return merged.code === 0 && tree.code === 0 && merged.stdout.split('\n')[0].trim() === tree.stdout.trim() ? { from: first, to: self } : undefined
  }

  /**
   * Checks finished on a commit a kind blocked while they still ran (feat-review-messages-reach-named). That kind is asked once
   * to review again. Other kinds, approvals, and a kind already asked are left alone, so a second block on the commit goes to
   * the user through the Lead's update. A verdict saved before Kernel recorded running checks has no record and isn't asked.
   */
  private async recheck(of: Workspace): Promise<void> {
    const head = of.prHead
    const rws = this.openReview(of)
    if (!head || !rws || rws.status === 'archived') return
    const heads = sameHeads(of, head)
    const overruled = of.overruled?.head === head ? of.overruled.kinds : []
    const due = (of.reviews ?? []).filter((v) => v.workspaceId === rws.id && v.verdict === 'blockers' && v.checksRunning && !v.checksRetried && !!v.sha && heads.has(v.sha)
      && (!v.prNumber || v.prNumber === of.prNumber) && !overruled.includes(lensOf(v)))
    if (!due.length) return
    // Marked before the sends, so a ready that comes again meanwhile asks nobody twice.
    this.updateWs(of.id, { reviews: (this.mustWs(of.id).reviews ?? []).map((v) => (due.some((d) => d.workspaceId === v.workspaceId && lensOf(d) === lensOf(v)) ? { ...v, checksRetried: true as const } : v)) })
    for (const v of due) {
      const chat = this.kindChat(rws, lensOf(v))
      if (!chat) continue
      const text = `The checks on PR #${of.prNumber} have finished. Review it again as your rule says, and call submit_review again.`
      if (rws.status === 'ready') await this.sessions.send(chat.id, [{ type: 'text', text }], { from: 'kernel' })
      else this.sessions.hold(chat.id, [{ type: 'text', text }], { from: 'kernel' })
    }
  }

  /** The kinds of review a review workspace runs, one per chat Kernel started for a kind, closed tabs included, in REVIEW_KINDS' order. */
  kindsOf(rws: Workspace): ReviewKind[] {
    const kinds = new Set(this.store.chats(rws.id).flatMap((c) => (c.kind === 'chat' && c.lens ? [c.lens.kind] : [])))
    return REVIEW_KINDS.map((k) => k.id).filter((k) => kinds.has(k))
  }

  /**
   * The chat that runs `kind` in a review workspace, put back on the strip when the user closed it, so a message for the kind
   * never lands in another kind's chat or in a chat with no kind (feat-review-messages-reach-named). Undefined when the
   * workspace runs no such kind.
   */
  kindChat(rws: Workspace, kind: ReviewKind): Chat | undefined {
    const chats = this.store.chats(rws.id).filter((c) => c.kind === 'chat' && c.lens?.kind === kind)
    const chat = chats.find((c) => !c.closed) ?? chats.at(-1)
    if (!chat?.closed) return chat
    const { closed: _closed, ...open } = chat
    return this.saveChat(open)
  }

  /** The PR's newest review workspace still open. */
  private openReview(of: Workspace): Workspace | undefined {
    return this.store.workspaces(of.projectId).filter((r) => r.reviewOf === of.id && r.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  /** Kinds `round` ran, none it skipped, with no verdict on the PR's head, as after the review workspace was archived (KERNEL-633). */
  private unreported(of: Workspace, round: ReviewRound): ReviewKind[] {
    const { current } = reviewVerdicts(of)
    return round.kinds.filter((k) => !round.skipped?.includes(k) && !current.some((v) => lensOf(v) === k))
  }

  /** The review workspace for a PR: one worktree and one setup run, with a chat per kind, each held until setup passes. */
  private async startReview(of: Workspace, plan: PlannedReview[]): Promise<Workspace> {
    const [first] = plan
    const agent = first.agent ?? lensAgent(first.kind)
    // The verdicts go where the PR's news goes: the chat that handed it off, or the Build here chat it came from (KERNEL-778).
    const leadChatId = of.leadChatId ?? this.k.lead.buildTab(of)
    const { ws, project, repo, chat } = await this.k.workspaces.cutWorkspace(of.projectId, {
      prompt: this.brief(of, first.kind), title: `Review PR #${of.prNumber}`, agentId: agent.id, agent, reviewOf: of.id, ...(leadChatId ? { leadChatId } : {})
    })
    const chats = plan.map((p, i) => this.lensChat(ws, p, i === 0 ? chat : undefined))
    for (const [i, c] of chats.entries()) this.sessions.hold(c.id, this.briefParts(of, plan[i].kind), { from: 'kernel' })
    return this.k.workspaces.setUpWorkspace(ws, project, repo, chats[0])
  }

  /**
   * A new review round with the PR's review workspace open (KERNEL-552): each kind the round runs that has no chat gets one,
   * and each that has is asked to review again. A review workspace still setting up, or whose setup failed, holds the
   * messages until setup passes. A kind that turned required or optional since its chat started reads as the round has it.
   */
  private async reviewAgain(rws: Workspace, of: Workspace, run: PlannedReview[]) {
    const tabs = this.chatTabs(rws.id).filter((c) => c.kind === 'chat')
    for (const p of run) {
      // A review chat from before review kinds runs the code review.
      const chat = tabs.find((c) => (c.lens?.kind ?? 'code') === p.kind)
      if (!chat) {
        const made = this.lensChat(rws, p)
        if (rws.status === 'ready') await this.sessions.send(made.id, this.briefParts(of, p.kind), { from: 'kernel' })
        else this.sessions.hold(made.id, this.briefParts(of, p.kind), { from: 'kernel' })
        continue
      }
      if (chat.lens && !!chat.lens.optional !== p.optional) {
        const { optional: _optional, ...lens } = chat.lens
        this.saveChat({ ...chat, lens: { ...lens, ...(p.optional ? { optional: true as const } : {}) } })
      }
      const text = `PR #${of.prNumber} has new commits${of.prHead ? `, up to ${of.prHead.slice(0, 7)}` : ''}. Review it again as your rule says, and call submit_review again.`
      await this.sessions.send(chat.id, [{ type: 'text', text }], { from: 'kernel' })
    }
  }

  /** A review chat for one kind: `chat` made over, or a new one in the review workspace. */
  private lensChat(rws: Workspace, p: PlannedReview, chat?: Chat): Chat {
    const pick = this.k.team.announce(rws, this.modelFor(p, rws.reviewOf ? this.store.workspace(rws.reviewOf) : undefined))
    const title = `${kindLabel(p.kind)} review`
    const lens: NonNullable<Chat['lens']> = { kind: p.kind, ...(p.agent ? { agent: p.agent.id } : {}), ...(p.optional ? { optional: true as const } : {}) }
    const base = chat ?? this.newChat(rws.id, title, { ...pick, plan: false })
    const { provider: _provider, autoTitle: _autoTitle, ...rest } = base
    return this.saveChat({ ...rest, title, ...(pick.provider !== 'claude' ? { provider: pick.provider } : {}), model: pick.model, effort: pick.effort, plan: false, lens })
  }

  /**
   * What a review chat runs on: its kind's `model`, else its agent's pin, else the reviewer role's from Settings, Models. A kind
   * with no `provider` and no `model` runs on the provider that didn't build the PR when that one is signed in, has room
   * (no usage read yet counts) and its last usage read didn't fail, else on the builder's (KERNEL-1059).
   */
  private modelFor(p: PlannedReview, of?: Workspace): ResolvedPick {
    const side = p.provider ?? (p.model ? undefined : this.otherThanBuilder(of))
    const base = p.agent ? this.k.team.pickFor(p.agent, { role: 'reviewer', ...(side ? { chatProvider: side } : {}) }) : this.k.team.pickRole('reviewer', side ? { chatProvider: side } : {})
    if (!p.model) return base
    const want = p.provider ?? providerOf(p.model)
    const { use, fellBack } = this.k.team.route(want)
    if (!fellBack) return { provider: want, model: p.model, effort: base.effort }
    return { ...this.k.team.pickRole('reviewer', { chatProvider: use }), fellBack }
  }

  /** The provider that didn't run the PR's builder, when it can take a review now: signed in, not at or near its limit. No usage read yet counts as room; a failed read doesn't. */
  private otherThanBuilder(of?: Workspace): Provider | undefined {
    if (!of) return undefined
    const built = this.chatTabs(of.id).find((c) => c.kind === 'chat' && !c.lens)?.provider ?? 'claude'
    const other: Provider = built === 'claude' ? 'codex' : 'claude'
    const { providers, account } = this.k
    return providers.hasRoom(other) && !providers.usageReadFailed(other) && !account.nearLimit(other) ? other : undefined
  }

  /** The first message a review chat gets. Its rule says the rest: where the work is and how to report. */
  private brief(of: Workspace, kind: ReviewKind): string {
    const author = this.agentsSync(of.projectId).find((a) => a.id === of.agentId)?.name ?? of.agentId
    const criteria = this.k.evidence.criteriaOf(of)
    return `Run ${reviewsText([kind]).replace(/^The/, 'the')} of PR #${of.prNumber}${of.prTitle ? ` "${of.prTitle}"` : ''} by ${author}.`
      + (criteria.length ? `\nAcceptance criteria for this task, numbered from 0. Judge each one you can check in submit_review's criteria:\n${criteria.map((c, i) => `${i}. ${c}`).join('\n')}` : '')
  }

  private briefParts(of: Workspace, kind: ReviewKind): ChatPart[] { return [{ type: 'text', text: this.brief(of, kind) }] }

  /**
   * A reviewer's submit_review from the chat `chatId`. The verdict is saved on the reviewed workspace with the review worktree's
   * HEAD, so a later push makes it stale, and replaces that review workspace's earlier verdict of the same kind (KERNEL-549).
   * The Lead hears about it.
   */
  async submitReview(reviewWorkspaceId: string, review: ReviewInput, chatId?: string): Promise<string> {
    const rws = this.mustWs(reviewWorkspaceId)
    const of = rws.reviewOf ? this.store.workspace(rws.reviewOf) : undefined
    if (!of || of.status === 'archived') throw new Error('the work under review is no longer open.')
    const lens = (chatId ? this.store.chat(chatId) : undefined)?.lens
    const sha = (await exec('git', ['-C', rws.path, 'rev-parse', 'HEAD'])).stdout.trim()
    // Read again after the await, so a verdict another reviewer saved meanwhile isn't lost.
    const fresh = this.mustWs(of.id)
    const kind = lens?.kind ?? 'code'
    // A kind Kernel already asked again on this commit stays asked, so a second block isn't retried (feat-review-messages-reach-named).
    const retried = (fresh.reviews ?? []).some((v) => v.workspaceId === rws.id && lensOf(v) === kind && v.checksRetried && v.sha === sha)
    const running = review.verdict === 'blockers' && fresh.prState === 'checks' && !retried
    const verdict: ReviewVerdict = {
      workspaceId: rws.id, agentId: lens ? lens.agent ?? KERNEL_REVIEWER : rws.agentId, verdict: review.verdict, summary: review.summary.trim(),
      ...(review.verdict === 'blockers' && review.blockers?.length ? { blockers: review.blockers } : {}),
      ...(review.criteria?.length ? { criteria: review.criteria } : {}),
      ...(/^[0-9a-f]{40}$/.test(sha) ? { sha } : {}), ...(fresh.prNumber ? { prNumber: fresh.prNumber } : {}),
      provider: (chatId ? this.store.chat(chatId)?.provider : undefined) ?? 'claude',
      ...(lens ? { lens: lens.kind } : {}), ...(lens?.optional ? { optional: true as const } : {}),
      ...(running ? { checksRunning: true as const } : {}), ...(retried ? { checksRetried: true as const } : {}), ts: Date.now()
    }
    const saved = this.updateWs(of.id, { reviews: [...(fresh.reviews ?? []).filter((v) => v.workspaceId !== rws.id || lensOf(v) !== lensOf(verdict)), verdict] })
    // A turn the Lead started with message_agent: its reply goes out with the verdict, and wakes the Lead (feat-review-messages-reach-named).
    this.leadUpdates.reviewed(rws, saved, verdict, chatId, { asked: !!chatId && this.sessions.turnFrom(chatId) === 'lead' })
    const what = saved.prNumber ? `PR #${saved.prNumber}` : saved.name
    bus.activity({ kind: 'note', projectId: rws.projectId, workspaceId: saved.id, agentId: rws.agentId, text: review.verdict === 'approved' ? 'approved' : 'found blockers in', object: what })
    return review.verdict === 'approved' ? `Saved: you approved ${what}. The Lead hears about it.` : `Saved: ${verdict.blockers?.length ?? 0} blocker(s) in ${what}. The Lead passes them on.`
  }

  /**
   * What Kernel knows about reviews of a workspace's PR, kind by kind, for the Lead's updates (KERNEL-549), and of its review
   * rounds (KERNEL-552).
   */
  reviewState(ws: Workspace): ReviewState {
    // Kernel's own reviewer included, which isn't on the team when the project has a reviewer of its own.
    const name = (id: string) => this.k.team.agentOf(ws.projectId, id)?.name ?? id
    const s = kindStates(ws)
    const { verdicts, current } = reviewVerdicts(ws)
    const reviews = this.store.workspaces(ws.projectId).filter((r) => r.reviewOf === ws.id && r.status !== 'archived').sort((a, b) => b.createdAt - a.createdAt)
    // A review runs while its setup runs (KERNEL-261), or while its chat works on it or has messages waiting and hasn't sent a verdict on the head commit. A review whose setup failed isn't
    // running: it waits for the user. A chat from before review kinds runs the code review. One whose turn waits for usage
    // to drop is held, not running (KERNEL-552).
    const busy = (r: Workspace, c: Chat) => r.status === 'setup' || (r.status === 'ready' && (this.sessions.isRunning(c.id) || this.sessions.queued(c.id).length > 0))
    const reviewing = new Set<ReviewKind>()
    const held = new Set<ReviewKind>()
    for (const r of reviews) {
      for (const c of this.chatTabs(r.id).filter((c) => c.kind === 'chat')) {
        const kind = c.lens?.kind ?? 'code'
        if (!busy(r, c) || current.some((v) => v.workspaceId === r.id && lensOf(v) === kind)) continue
        if (this.sessions.queueReason(c.id) === 'limit') held.add(kind)
        else reviewing.add(kind)
      }
    }
    const ordered = (set: Set<ReviewKind>) => REVIEW_KINDS.map((k) => k.id).filter((k) => set.has(k))
    const open = reviews[0]
    // A held kind counts as in progress, so a merge waits for it, but nothing waits on it to say what the others found (KERNEL-633).
    const running = reviewing.size > 0 || this.starting.has(ws.id)
    const inProgress = running || held.size > 0
    // The last round reached `[review] rounds` with blockers on its head, which Kernel won't send back again.
    const round = this.roundOf(ws)
    const left = round && round.n >= round.rounds && !running ? kindStates({ ...ws, prHead: round.head }).blocking : []
    const skipped = round && round.head === ws.prHead ? round.skipped ?? [] : []
    return {
      approved: s.approved, blocking: s.blocking, blockers: s.blocking.length > 0,
      ...(s.overruled.length ? { overruled: s.overruled } : {}),
      reviewing: ordered(reviewing),
      inProgress,
      ...(this.starting.has(ws.id) ? { starting: true } : {}),
      waiting: s.waiting,
      stale: verdicts.length > 0 && current.length === 0,
      ...(held.size ? { held: ordered(held) } : {}),
      ...(skipped.length ? { skipped } : {}),
      ...(round && left.length ? { stillBlocked: { rounds: round.n, kinds: left } } : {}),
      // Only while the setting is still off and nobody asked for a review of this head meanwhile.
      ...(this.settings.pr.autoReview === false && this.notStarted.get(ws.id) === (ws.prHead ?? '') && !open && !verdicts.length && !inProgress ? { notStarted: true } : {}),
      ...(open ? { open: { workspaceId: open.id, agentId: open.agentId, name: name(open.agentId), ...(open.status === 'failed' ? { failed: true } : {}) } } : {})
    }
  }

  /**
   * Overrules the blockers the reviews found on the PR's head commit, or with `clear` takes the overrule back (KERNEL-732).
   * The user does it, or the Lead on the user's quoted words (`by`). It records the head and the kinds blocking it, together
   * with any kind already overruled on that head, so every read of the blockers lets a merge a person starts through until a
   * new commit. It refuses when nothing blocks the head or Kernel doesn't know it.
   */
  overrule(id: string, o: { by: 'user' | 'lead'; note?: string; clear?: boolean }): Workspace {
    const ws = this.mustWs(id)
    if (ws.status === 'archived') throw new Error(`${ws.name} is archived.`)
    const what = ws.prNumber ? `PR #${ws.prNumber}` : ws.name
    const lead = o.by === 'lead' ? this.agentsSync(ws.projectId).find((a) => a.lead) : undefined
    const who = { actor: o.by === 'lead' ? ('agent' as const) : ('you' as const), agentId: lead?.id ?? ws.agentId }
    if (o.clear) {
      if (!ws.overruled) return ws
      const { overruled: _overruled, ...rest } = ws
      const saved = this.saveWs(rest)
      bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, ...who, text: 'took back the overrule of the blockers in', object: what })
      return saved
    }
    if (!ws.prNumber || !ws.prHead) throw new Error(`Kernel doesn't know the latest commit of ${what} yet, so there is nothing to overrule.`)
    const s = kindStates(ws)
    if (!s.blocking.length) throw new Error(`No review found blockers on the latest commit of ${what}, so there is nothing to overrule.`)
    const kinds = REVIEW_KINDS.map((k) => k.id).filter((k) => s.blocking.includes(k) || s.overruled.includes(k))
    const note = o.note?.trim()
    const saved = this.updateWs(id, { overruled: { head: ws.prHead, kinds, by: o.by, ts: Date.now(), ...(note ? { note } : {}) } })
    const whose = `${reviewsText(s.blocking).replace(/^The/, 'the')}${s.blocking.length > 1 ? "'" : "'s"}`
    bus.activity({ kind: 'note', projectId: ws.projectId, workspaceId: ws.id, ...who, text: `overruled ${whose} ${s.count} ${s.count === 1 ? 'blocker' : 'blockers'} in`, object: what, ...(note ? { quote: note } : {}) })
    return saved
  }

  handlers() {
    return {
      // The PR header's Overrule and its Undo (KERNEL-732).
      'reviews.overrule': async ({ workspaceId, note, clear }) => this.overrule(workspaceId, { by: 'user', note, clear }),
      // Christian's Settings page for reviews writes through this (KERNEL-549).
      'settings.setReview': async ({ projectId, review }) => this.k.config.wrote(projectId, await saveReviewSettings(this.mustProject(projectId).path, review)),
      // The Reviews page's always-review box writes through this (KERNEL-594).
      'settings.setAlwaysReview': async ({ projectId, paths }) => this.k.config.wrote(projectId, await saveAlwaysReview(this.mustProject(projectId).path, paths))
    } satisfies Partial<Handlers>
  }
}
