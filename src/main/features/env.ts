import type { Workspace } from '@shared/types'
import { loadRepoSettings, loadRepoSettingsSync } from '../services/settings'
import { buildEnv, envFileReadable, kernelVars, readEnvFiles, withoutClaudeNames } from '../services/env'
import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** The variables every session, script and terminal in a workspace gets (KERNEL-247, KERNEL-327). */
export class Env extends Feature {
  /**
   * Every variable a session, script or terminal in the workspace gets: the Mac's, the app's, the room's env files, the
   * room's, then Kernel's own (KERNEL-247). Synchronous, since a session starts synchronously. Scripts also get PORT and
   * FORCE_COLOR=0. Sessions and terminals take `ANTHROPIC_*` and `CLAUDE_CODE_*` names from the Mac only, and drop the API
   * key afterwards, in `sessionEnv`. Scripts get every layer whole.
   */
  envFor(ws: Workspace, o: { script?: boolean } = {}): Record<string, string> {
    const room = this.store.room(ws.roomId)
    const keep = o.script ? (layer: Record<string, string>) => layer : withoutClaudeNames
    // A repo's env file can set ZDOTDIR or BASH_ENV and run its code in every shell, so the list must be one the last
    // trust check allowed. A list changed since then waits for the next check, which this starts.
    const list = room ? loadRepoSettingsSync(room.path).env.files : []
    const allowed = !!room && this.k.trust.envFilesOk.get(room.id) === JSON.stringify(list)
    if (room && list.length && !allowed) void this.k.trust.untrusted(room).catch(() => null)
    // Nothing is copied into the Lead's worktree, so it reads the checkout's files (KERNEL-355).
    const files = allowed ? readEnvFiles(ws.lead && room ? room.path : ws.path, list).map((f) => keep(f.vars)) : []
    const kernel: Record<string, string> = { ...kernelVars(ws, room?.path ?? ws.path), ...(o.script ? { PORT: String(ws.port), FORCE_COLOR: '0' } : {}) }
    return buildEnv({ base: process.env, app: keep(this.envStore.values()), files, room: keep(this.envStore.values(ws.roomId)), kernel })
  }

  handlers() {
    return {
      'env.get': async ({ roomId }) => {
        const room = roomId ? this.mustRoom(roomId) : undefined
        // The room's files are checked in its main checkout, without reading them. A workspace reads its own copies when
        // something starts there.
        const files = room ? (await loadRepoSettings(room.path)).env.files.map((path) => ({ path, missing: !envFileReadable(room.path, path) })) : []
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
