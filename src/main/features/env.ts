import type { Room, Workspace } from '@shared/types'
import { BUILD_ENV } from '@shared/hookEntry'
import { loadRepoSettings, loadRepoSettingsSync, type RepoSettings } from '../services/settings'
import { buildEnv, ENV_KERNEL, envFileReadable, fileStamp, kernelVars, readEnvFiles, readSetupEnv, setupEnvPath, trackedSync, withoutClaudeNames } from '../services/env'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** The variables every session, script and terminal in a workspace gets (KERNEL-247, KERNEL-327). */
export class Env extends Feature {
  /**
   * Per room, `.env.kernel` in its checkout as last looked at: the file's stamp, and whether it is the user's own, which git
   * doesn't track (KERNEL-449). Checked again only when the stamp changes.
   */
  private envKernel = new Map<string, { stamp: string; own: boolean }>()

  /**
   * Every variable a session, script or terminal in the workspace gets: Kernel's defaults, the Mac's, the app's, the room's
   * env files, the room's, what the workspace's setup wrote to `$KERNEL_ENV` once it passed (KERNEL-405), then Kernel's
   * own (KERNEL-247). Synchronous, since a session starts synchronously. Scripts also get PORT, and run in a terminal of
   * their own, so they print colors (KERNEL-655). Sessions and terminals take `ANTHROPIC_*` and `CLAUDE_CODE_*` names from
   * the Mac only, and drop the API key afterwards, in `sessionEnv`. Scripts get every layer whole.
   */
  envFor(ws: Workspace, o: { script?: boolean } = {}): Record<string, string> {
    const room = this.store.room(ws.roomId)
    const keep = o.script ? (layer: Record<string, string>) => layer : withoutClaudeNames
    const settings = room ? loadRepoSettingsSync(room.path) : undefined
    // Each chat with Rowan has its own worktree with files.copy done, so it reads its own copies like a teammate (KERNEL-405).
    const files = room && settings ? this.envFiles(room, ws, settings).map(keep) : []
    // Setup's variables count once it passed, in a room whose scripts are trusted, the way setup itself only ran then.
    const setup = room && ws.status === 'ready' && this.k.trust.roomTrusted.get(room.id) ? keep(readSetupEnv(setupEnvPath(this.o.dataDir, ws.id)).vars) : {}
    // The build that started it, which the hook command sends, so the other build's hook server leaves it alone (KERNEL-675).
    const kernel: Record<string, string> = { ...kernelVars(ws, room), [BUILD_ENV]: this.o.build ?? 'app', ...(o.script ? { PORT: String(ws.port) } : {}) }
    // Each worktree is its own Compose project, so two workspaces' containers and volumes never meet. A current-branch
    // workspace is the room's own checkout and keeps the project the user's terminal gets there (KERNEL-449).
    const defaults: Record<string, string> = ws.mode === 'worktree' ? { COMPOSE_PROJECT_NAME: kernel.KERNEL_WORKSPACE_SLUG } : {}
    return buildEnv({ base: process.env, defaults, app: keep(this.envStore.values()), files, room: keep(this.envStore.values(ws.roomId)), setup, kernel })
  }

  /**
   * The env files' variables, in order. A room that sets `[env] files` reads that list from the workspace folder. A repo's
   * env file can set ZDOTDIR or BASH_ENV and run its code in every shell, so the list must be one the last trust check
   * allowed, and a list changed since then waits for the next check, which this starts (KERNEL-247). A room that sets
   * none reads `.env.kernel` from its checkout, when it is the user's own (KERNEL-449).
   */
  private envFiles(room: Room, ws: Workspace, settings: RepoSettings): Record<string, string>[] {
    if (!settings.sources['env.files']) return this.ownEnvKernel(room) ? readEnvFiles(room.path, [ENV_KERNEL]).map((f) => f.vars) : []
    const list = settings.env.files
    const allowed = this.k.trust.envFilesOk.get(room.id) === JSON.stringify(list)
    if (list.length && !allowed) void this.k.trust.untrusted(room).catch(() => null)
    return allowed ? readEnvFiles(ws.path, list).map((f) => f.vars) : []
  }

  /**
   * Whether the room's checkout has a `.env.kernel` that is the user's own: git doesn't track it, so no commit wrote it
   * (KERNEL-449). A tracked one is the repo's, which runs nothing without trust, so it counts only when `[env] files` lists
   * it. git is asked only when the file changed since the last look.
   */
  ownEnvKernel(room: Room): boolean {
    const stamp = fileStamp(room.path, ENV_KERNEL)
    if (!stamp) { this.envKernel.delete(room.id); return false }
    const seen = this.envKernel.get(room.id)
    if (seen?.stamp === stamp) return seen.own
    const own = !trackedSync(room.path, ENV_KERNEL)
    this.envKernel.set(room.id, { stamp, own })
    return own
  }

  handlers() {
    return {
      'env.get': async ({ roomId }) => {
        const room = roomId ? this.mustRoom(roomId) : undefined
        // The room's files are checked in its main checkout, without reading them. A workspace reads its own copies when
        // something starts there.
        const settings = room ? await loadRepoSettings(room.path) : undefined
        const listed = room && settings?.sources['env.files'] ? settings.env.files.map((path) => ({ path, missing: !envFileReadable(room.path, path) })) : []
        // The fallback shows only when it is read, so a room without one lists nothing (KERNEL-449).
        const files = room && settings && !settings.sources['env.files'] && this.ownEnvKernel(room) ? [{ path: ENV_KERNEL, missing: false }] : listed
        return { names: this.envStore.names(roomId), files }
      },
      'env.set': async ({ roomId, name, value }) => {
        if (roomId) this.mustRoom(roomId)
        this.envStore.set(roomId, name, value)
        return { ok: true }
      },
      'env.reveal': async ({ roomId, name }) => {
        if (roomId) this.mustRoom(roomId)
        return this.envStore.reveal(roomId, name)
      }
    } satisfies Partial<Handlers>
  }
}
