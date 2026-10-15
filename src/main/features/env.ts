import type { Project, Workspace } from '@shared/types'
import { BUILD_ENV } from '@shared/hookEntry'
import { loadRepoSettings, loadRepoSettingsSync, type RepoSettings } from '../services/settings'
import { buildEnv, ENV_KERNEL, envFileReadable, fileStamp, kernelVars, readEnvFiles, readSetupEnv, setupEnvPath, trackedSync, withoutClaudeNames } from '../services/env'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** The variables every session, script and terminal in a workspace gets (KERNEL-247, KERNEL-327). */
export class Env extends Feature {
  /**
   * Per project, `.env.kernel` in its checkout as last looked at: the file's stamp, and whether it is the user's own, which git
   * doesn't track (KERNEL-449). Checked again only when the stamp changes.
   */
  private envKernel = new Map<string, { stamp: string; own: boolean }>()

  /**
   * Every variable a session, script or terminal in the workspace gets: Kernel's defaults, the Mac's, the app's, the project's
   * env files, the project's, what the workspace's setup wrote to `$KERNEL_ENV` once it passed (KERNEL-405), then Kernel's
   * own (KERNEL-247). Synchronous, since a session starts synchronously. Scripts also get PORT, and run in a terminal of
   * their own, so they print colors (KERNEL-655). Sessions and terminals take `ANTHROPIC_*` and `CLAUDE_CODE_*` names from
   * the Mac only, and drop the API key afterwards, in `sessionEnv`. Scripts get every layer whole.
   */
  envFor(ws: Workspace, o: { script?: boolean } = {}): Record<string, string> {
    const project = this.store.project(ws.projectId)
    const keep = o.script ? (layer: Record<string, string>) => layer : withoutClaudeNames
    const settings = project ? loadRepoSettingsSync(project.path) : undefined
    // Each Lead chat has its own worktree with files.copy done, so it reads its own copies like a teammate (KERNEL-405).
    const files = project && settings ? this.envFiles(project, ws, settings).map(keep) : []
    // Setup's variables count once it passed, in a project whose scripts are trusted, the way setup itself only ran then.
    const setup = project && ws.status === 'ready' && this.k.trust.projectTrusted.get(project.id) ? keep(readSetupEnv(setupEnvPath(this.o.dataDir, ws.id)).vars) : {}
    // The build that started it, which the hook command sends, so the other build's hook server leaves it alone (KERNEL-675).
    const kernel: Record<string, string> = { ...kernelVars(ws, project), [BUILD_ENV]: this.o.build ?? 'app', ...(o.script ? { PORT: String(ws.port) } : {}) }
    // Each worktree is its own Compose project, so two workspaces' containers and volumes never meet. A current-branch
    // workspace is the project's own checkout and keeps the project the user's terminal gets there (KERNEL-449).
    const defaults: Record<string, string> = ws.mode === 'worktree' ? { COMPOSE_PROJECT_NAME: kernel.KERNEL_WORKSPACE_SLUG } : {}
    return buildEnv({ base: process.env, defaults, app: keep(this.envStore.values()), files, project: keep(this.envStore.values(ws.projectId)), setup, kernel })
  }

  /**
   * The env files' variables, in order. A project that sets `[env] files` reads that list from the workspace folder. A repo's
   * env file can set ZDOTDIR or BASH_ENV and run its code in every shell, so the list must be one the last trust check
   * allowed, and a list changed since then waits for the next check, which this starts (KERNEL-247). A project that sets
   * none reads `.env.kernel` from its checkout, when it is the user's own (KERNEL-449).
   */
  private envFiles(project: Project, ws: Workspace, settings: RepoSettings): Record<string, string>[] {
    if (!settings.sources['env.files']) return this.ownEnvKernel(project) ? readEnvFiles(project.path, [ENV_KERNEL]).map((f) => f.vars) : []
    const list = settings.env.files
    const allowed = this.k.trust.envFilesOk.get(project.id) === JSON.stringify(list)
    if (list.length && !allowed) void this.k.trust.untrusted(project).catch(() => null)
    return allowed ? readEnvFiles(ws.path, list).map((f) => f.vars) : []
  }

  /**
   * Whether the project's checkout has a `.env.kernel` that is the user's own: git doesn't track it, so no commit wrote it
   * (KERNEL-449). A tracked one is the repo's, which runs nothing without trust, so it counts only when `[env] files` lists
   * it. git is asked only when the file changed since the last look.
   */
  ownEnvKernel(project: Project): boolean {
    const stamp = fileStamp(project.path, ENV_KERNEL)
    if (!stamp) { this.envKernel.delete(project.id); return false }
    const seen = this.envKernel.get(project.id)
    if (seen?.stamp === stamp) return seen.own
    const own = !trackedSync(project.path, ENV_KERNEL)
    this.envKernel.set(project.id, { stamp, own })
    return own
  }

  handlers() {
    return {
      'env.get': async ({ projectId }) => {
        const project = projectId ? this.mustProject(projectId) : undefined
        // The project's files are checked in its main checkout, without reading them. A workspace reads its own copies when
        // something starts there.
        const settings = project ? await loadRepoSettings(project.path) : undefined
        const listed = project && settings?.sources['env.files'] ? settings.env.files.map((path) => ({ path, missing: !envFileReadable(project.path, path) })) : []
        // The fallback shows only when it is read, so a project without one lists nothing (KERNEL-449).
        const files = project && settings && !settings.sources['env.files'] && this.ownEnvKernel(project) ? [{ path: ENV_KERNEL, missing: false }] : listed
        return { names: this.envStore.names(projectId), files }
      },
      'env.set': async ({ projectId, name, value }) => {
        if (projectId) this.mustProject(projectId)
        this.envStore.set(projectId, name, value)
        return { ok: true }
      },
      'env.reveal': async ({ projectId, name }) => {
        if (projectId) this.mustProject(projectId)
        return this.envStore.reveal(projectId, name)
      }
    } satisfies Partial<Handlers>
  }
}
