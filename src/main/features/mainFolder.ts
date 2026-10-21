import { join } from 'node:path'
import { bus } from '../bus'
import { exec, git } from '../services/exec'
import { loadRepoSettings } from '../services/settings'
import { linkNodeModules } from '../services/scripts'
import { createWorktree, fastForward, folderGone, isWorktreeOf, leadBase, projectWorktreeRoot, removeWorktree } from '../services/worktrees'
import { Feature } from './feature'

/** The hidden folder in the project's worktree root that chats from before one-lead-chat still share (KERNEL-1050). */
const MAIN_FOLDER = '.main'

/**
 * The project's one shared folder for chats with Kernel that started before one-lead-chat (KERNEL-1050): a detached worktree at
 * `<remote>/<default>`, made when an archived one is restored, with no setup, no copied files and no trust prompt. Kernel owns it.
 * It only ever moves by fast-forward, and never resets, cleans or checks out over a change.
 */
export class MainFolder extends Feature {
  /** The folder being made, by project, so chats starting together make it once. */
  private making = new Map<string, Promise<string>>()
  /** Syncs under way, by project, so two never run git in the folder at once. */
  private syncing = new Map<string, Promise<void>>()
  /** The last refusal logged, by project: the target's sha and the reason, so each is logged once per sha. */
  private refused = new Map<string, string>()

  /** Where the project's shared folder is, whether or not it exists yet. */
  path(projectId: string): string {
    return join(projectWorktreeRoot(this.settings.worktreeRoot, this.mustProject(projectId)), MAIN_FOLDER)
  }

  /** The shared folder, made when it isn't there. One creation per project at a time. Throws for a project with no commit. */
  ensure(projectId: string): Promise<string> {
    const running = this.making.get(projectId)
    if (running) return running
    const run = this.make(projectId).finally(() => { if (this.making.get(projectId) === run) this.making.delete(projectId) })
    this.making.set(projectId, run)
    return run
  }

  private async make(projectId: string): Promise<string> {
    const project = this.mustProject(projectId)
    const path = this.path(projectId)
    if (!(await folderGone(path))) {
      if (await isWorktreeOf(project.path, path)) return path
      throw new Error(`${path} is in the way of the shared folder for older chats, and it isn't a worktree of ${project.name}. Move or delete it, then try again.`)
    }
    // git still lists a worktree whose folder was deleted until a prune, and refuses to add one at that path (KERNEL-355).
    await git(project.path, 'worktree', 'prune')
    const repo = await loadRepoSettings(project.path)
    const base = await leadBase(project.path, await this.k.config.remoteFor(project.path, repo))
    if (!base) throw new Error(`${project.name} has no commit yet, so there is nothing to start a chat from.`)
    await createWorktree({ repo: project.path, root: join(path, '..'), branch: 'HEAD', baseRef: base, detach: true, path })
    if (repo.files.symlinkNodeModules) await linkNodeModules(project.path, path).catch(() => undefined)
    // A project removed, or a Kernel stopped, while git worked leaves nothing behind.
    if (this.stopped || !this.store.project(projectId)) await removeWorktree(project.path, path, { force: true }).catch(() => undefined)
    return path
  }

  /** Removes the shared folder as its project goes. A folder that is already gone only needs git's record pruned. */
  async remove(projectId: string): Promise<void> {
    const project = this.store.project(projectId)
    // Settings load at start, so a Kernel that never started has made no folder.
    if (!project || !this.settings) return
    await this.making.get(projectId)?.catch(() => undefined)
    await this.syncing.get(projectId)
    await removeWorktree(project.path, this.path(projectId), { force: true }).catch((e) => { if (!this.stopped) console.warn(`[main-folder] could not remove ${this.path(projectId)}`, e) })
  }

  /**
   * Fast-forwards the shared folder to `<remote>/<default>` as last fetched, while no chat on it is busy. Tracked changes,
   * commits of its own or a refused fast-forward leave it as it is, with one warning per sha. A folder that is gone, with chats
   * still on it, is made again.
   */
  sync(projectId: string): Promise<void> {
    const next = (this.syncing.get(projectId) ?? Promise.resolve()).then(() => this.syncNow(projectId))
    const settled = next.catch(() => undefined)
    this.syncing.set(projectId, settled)
    void settled.finally(() => { if (this.syncing.get(projectId) === settled) this.syncing.delete(projectId) })
    return next
  }

  private async syncNow(projectId: string) {
    if (this.stopped) return
    const project = this.store.project(projectId)
    if (!project || project.archived) return
    const chats = this.store.workspaces(projectId).filter((w) => w.shared && w.status !== 'archived')
    const path = this.path(projectId)
    if (await folderGone(path).catch(() => true)) {
      if (chats.length) await this.ensure(projectId)
      return
    }
    // Read again after each step that waits on git: a turn can start while git runs, and the files mustn't move under it.
    const held = () => this.stopped || chats.some((w) => this.k.lead.folderBusy(w.id))
    if (held()) return
    const target = await leadBase(project.path, await this.k.config.remoteFor(project.path))
    if (!target) return
    const count = async (range: string) => Number((await git(path, 'rev-list', '--count', range)).trim())
    const behind = await count(`HEAD..${target}`)
    if (!behind) return
    const sha = (await git(project.path, 'rev-parse', target)).trim()
    const own = await count(`${target}..HEAD`)
    const changed = !own && (await git(path, 'status', '--porcelain', '--untracked-files=no')).trim() !== ''
    if (held()) return
    const why = own ? `it has ${own === 1 ? 'a commit' : `${own} commits`} of its own` : changed ? 'tracked files have changes' : !(await fastForward(path, target)) ? 'git refused the fast-forward' : undefined
    if (this.stopped) return
    const lead = this.agentsSync(projectId).find((a) => a.lead)
    if (why) {
      if (this.refused.get(projectId) === `${sha} ${why}`) return
      this.refused.set(projectId, `${sha} ${why}`)
      bus.activity({ kind: 'note', projectId, workspaceId: chats[0]?.id, agentId: lead?.id, actor: 'kernel', text: `didn't update the shared main folder to ${target}:`, object: why, warn: true })
      return
    }
    this.refused.delete(projectId)
    bus.activity({ kind: 'note', projectId, workspaceId: chats[0]?.id, agentId: lead?.id, actor: 'kernel', text: `updated the shared main folder to ${target}, ${behind === 1 ? '1 new commit' : `${behind} new commits`}` })
  }
}
