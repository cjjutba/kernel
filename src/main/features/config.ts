import { join } from 'node:path'
import type { Workspace } from '@shared/types'
import type { Handlers } from '../kernel'
import { kernelHooksPresent } from '../services/hooksInstaller'
import { applySettingsPatch, configuredRemote, loadRepoSettings, remoteOf, saveAppSettings, saveRepoSettings, type AppSettings, type RepoSettings } from '../services/settings'
import { discoverMcp } from '../services/integrations'
import { discoverSkills } from '../services/files'
import { resolveFilesToCopy } from '../services/filesToCopy'
import { listBranches } from '../services/worktrees'
import { Feature } from './feature'

/** The app's settings, each room's settings file, and the git remote they name (KERNEL-325). */
export class Config extends Feature {
  /** Each room's own `workspace.remote` by path, for the review rule, which can't wait on a file read (`remoteFor`). */
  private readonly roomRemotes = new Map<string, string | undefined>()

  get settingsFile() { return join(this.o.dataDir, 'settings.json') }

  /**
   * Settings > any app page. Saves to settings.json and applies at once: running sessions read the permission lists on their
   * next tool call, the mode moves to them now, a higher limit on agents working at once starts what was waiting, and a new
   * approval timeout is read per request and rewritten into the installed hooks.
   */
  async setSettings(patch: Parameters<typeof applySettingsPatch>[1]): Promise<AppSettings> {
    const before = this.settings
    this.k.settings = applySettingsPatch(before, patch)
    await saveAppSettings(this.settingsFile, this.settings)
    this.sessions.applySettings(before)
    this.o.onSettings?.(this.settings)
    // The server reads the timeout per request. Only the copy in the installed hooks needs rewriting.
    if (before.permissions.approvalTimeoutSec !== this.settings.permissions.approvalTimeoutSec && (await kernelHooksPresent(this.k.hooks.claudeSettings).catch(() => false))) await this.k.hooks.writeHooks(this.settings.hookPort)
    return this.settings
  }

  /**
   * The git remote a room fetches from and pushes to: the room's, then the app's, then origin (`remoteOf`, KERNEL-190).
   * Pass `repo` when the room's settings are already loaded.
   */
  async remoteFor(path: string, repo?: RepoSettings): Promise<string> {
    const r = repo ?? await loadRepoSettings(path)
    this.roomRemotes.set(path, r.workspace.remote)
    return remoteOf(r, this.settings)
  }

  remoteOfWs(ws: Workspace) { return this.remoteFor(this.mustRoom(ws.roomId).path) }

  handlers() {
    return {
      'git.branches': async ({ roomId }) => {
        const { path } = this.mustRoom(roomId)
        const repo = await loadRepoSettings(path)
        this.roomRemotes.set(path, repo.workspace.remote)
        return listBranches(path, configuredRemote(repo, this.settings))
      },
      'skills.list': async ({ roomId }) => {
        const off = (await loadRepoSettings(this.mustRoom(roomId).path)).disabled?.skills ?? []
        return (await discoverSkills(this.mustRoom(roomId).path, this.home)).map((s) => ({ ...s, enabled: !off.includes(s.name) }))
      },
      'settings.get': async () => this.settings,
      'settings.set': async ({ patch }) => this.setSettings(patch),
      'settings.room': async ({ roomId }) => {
        const { path } = this.mustRoom(roomId)
        const rs = await loadRepoSettings(path)
        // A read refreshes the room's remote as a save does, so a file edited outside Kernel takes effect (KERNEL-244).
        this.roomRemotes.set(path, rs.workspace.remote)
        return rs
      },
      'settings.setRoom': async ({ roomId, patch, shared }) => {
        const room = this.mustRoom(roomId)
        const before = await this.k.trust.trustState(room)
        const next = await saveRepoSettings(room.path, patch, shared)
        this.roomRemotes.set(room.path, next.workspace.remote)
        await this.k.trust.trustSaved(room, before, patch, !!shared, next)
        // A saved env files list counts once the check agrees, trusted or the user's own (KERNEL-247).
        await this.k.trust.untrusted(room, next)
        return next
      },
      // Lists, never copies, through the same confinement as the copy, so it shows nothing outside the repo (KERNEL-209).
      'files.preview': async ({ roomId, patterns }) => {
        const { path } = this.mustRoom(roomId)
        return resolveFilesToCopy(path, patterns ?? (await loadRepoSettings(path)).files.copy)
      },
      'mcp.list': async ({ roomId }) => {
        const room = roomId ? this.mustRoom(roomId) : undefined
        const off = room ? (await loadRepoSettings(room.path)).disabled?.mcp ?? [] : []
        return discoverMcp(room?.path ?? this.home, this.home, off)
      }
    } satisfies Partial<Handlers>
  }
}
