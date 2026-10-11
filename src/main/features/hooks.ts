import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AgentStatus, HookStatus } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { startHookServer } from '../services/hookServer'
import { hookToken } from '../services/hookToken'
import { hookStatus, installHooks, KERNEL_HOOK_EVENTS, kernelHooksPresent, refreshHooks, uninstallHooks } from '../services/hooksInstaller'
import { nextFreePort, portBusy, runPreflight } from '../services/preflight'
import { saveAppSettings } from '../services/settings'
import { Feature } from './feature'

/** How a hook from an outside session moves its agent on the floor. */
const HOOK_STATUS: Record<string, AgentStatus> = { UserPromptSubmit: 'working', PreToolUse: 'working', PermissionRequest: 'needs', Stop: 'idle', SessionEnd: 'idle' }

/** The hook server, the hooks in Claude's settings file, and the preflight checks (KERNEL-325). */
export class Hooks extends Feature {
  private hookServer?: Server
  /** The start-up rewrite of out-of-date hooks failed (KERNEL-206). The hooks banner shows until a write succeeds. */
  private hooksNeedInstall = false
  /** When each hook event last arrived from a real session. The test event is not counted. */
  private hookSeen = new Map<string, number>()

  async start() {
    // Hooks from before KERNEL-206, or from another port or timeout, get a 401. Rewrite Kernel's own entries, never add any.
    this.hooksNeedInstall = await refreshHooks(this.claudeSettings, this.settings.hookPort, this.settings.permissions.approvalTimeoutSec, this.hookToken).then(() => false, (e) => { console.warn('[hooks] could not update the hooks', e); return true })
    await this.listenHooks(this.settings.hookPort)
  }

  stop(): Promise<void> {
    // An outside session waiting on an approval holds its request open for up to the approval timeout, and close()
    // waits for it, so whatever is still open ends first.
    return new Promise<void>((r) => { if (!this.hookServer) return r(); this.hookServer.closeAllConnections(); this.hookServer.close(() => r()) })
  }

  /** A hook from a session Kernel did not start. The listener on the bus calls it. */
  onHook(e: { hook_event_name: string }, ctx?: { roomId?: string; agentId?: string }) {
    this.hookSeen.set(e.hook_event_name, Date.now())
    // Only sessions Kernel did not start reach here (the big terminal, or Claude Code run by hand), so the floor learns their status from the hooks.
    const status = HOOK_STATUS[e.hook_event_name]
    if (!status || !ctx?.roomId || !ctx.agentId) return
    if (this.k['statuses'].get(ctx.roomId)?.[ctx.agentId] === 'paused') return
    bus.push({ type: 'agent.status', roomId: ctx.roomId, agentId: ctx.agentId, status })
  }

  /** Starts the hook server on `port`. A taken port is not fatal: preflight reports it and offers the next one. */
  private async listenHooks(port: number): Promise<boolean> {
    try {
      this.hookServer = await startHookServer({
        port,
        token: this.hookToken,
        approvals: this.approvals,
        approvalTimeoutMs: () => this.settings.permissions.approvalTimeoutSec * 1000,
        isManaged: (id) => this.sessions.isManaged(id),
        resolve: (cwd) => this.resolveCwd(cwd)
      })
      // A server that closes or errors on its own takes the floor and the logs with it (WorkspaceHooksDown.png).
      const server = this.hookServer
      // A quit closes it on purpose, and the window is still up to flash Hooks are disconnected (KERNEL-214).
      server.on('close', () => { if (this.hookServer === server && !this.stopped) void this.pushHooks() })
      server.on('error', () => { if (!this.stopped) void this.pushHooks() })
      return true
    } catch { return false }
  }

  /** Moves the hook server to `port`, saves it, and rewrites the hooks if they were installed. Returns the status after. */
  private async restartHooks(port: number): Promise<HookStatus> {
    // A busy new port must not take down the server that works. Check before closing.
    if (port !== this.settings.hookPort && (await portBusy(port))) throw new Error(`Port ${port} is in use. Pick another port and try again.`)
    // Any Kernel entry counts, so an old http install moves to the command form. Hooks are never added where there were none.
    const wasInstalled = await kernelHooksPresent(this.claudeSettings).catch(() => false)
    await new Promise<void>((r) => (this.hookServer?.listening ? this.hookServer.close(() => r()) : r()))
    this.hookServer = undefined
    if (!(await this.listenHooks(port))) throw new Error(`Port ${port} is in use. Pick another port and try again.`)
    if (port !== this.settings.hookPort) {
      this.k.settings = { ...this.settings, hookPort: port }
      await saveAppSettings(this.k.config.settingsFile, this.settings)
    }
    if (wasInstalled) await this.writeHooks(port)
    return this.pushHooks()
  }

  /** Install, and every rewrite after a port or timeout change. A write that works clears the start-up failure. */
  async writeHooks(port: number): Promise<string[]> {
    const events = await installHooks(this.claudeSettings, port, this.settings.permissions.approvalTimeoutSec, this.hookToken)
    this.hooksNeedInstall = false
    return events
  }

  private async pushHooks(): Promise<HookStatus> {
    const status = await this.hooksStatus()
    if (!this.stopped) bus.push({ type: 'hooks', status })
    return status
  }

  async hooksStatus(): Promise<HookStatus> {
    const installed = new Set(await hookStatus(this.claudeSettings, this.hookToken).catch(() => [] as string[]))
    return {
      port: this.settings.hookPort,
      listening: !!this.hookServer?.listening,
      installed: KERNEL_HOOK_EVENTS.every((e) => installed.has(e)),
      events: KERNEL_HOOK_EVENTS.map((name) => ({ name, installed: installed.has(name), lastSeen: this.hookSeen.get(name) })),
      token: this.hookToken,
      needsInstall: this.hooksNeedInstall
    }
  }

  private resolveCwd(cwd: string) {
    const ws = this.store.workspaces().filter((w) => w.status !== 'archived').sort((a, b) => b.path.length - a.path.length).find((w) => cwd === w.path || cwd.startsWith(w.path + '/'))
    if (ws) return { roomId: ws.roomId, workspaceId: ws.id, agentId: ws.agentId }
    const room = this.store.rooms().find((r) => cwd === r.path || cwd.startsWith(r.path + '/'))
    return room ? { roomId: room.id } : {}
  }

  private async preflight() {
    await this.o.refreshPath?.()
    return runPreflight({ hookPort: this.settings.hookPort, hookServerUp: !!this.hookServer?.listening, agentTeams: this.settings.models.agentTeams })
  }

  private get hookToken() { return hookToken(this.o.dataDir) }
  get claudeSettings() { return this.o.claudeSettingsFile ?? join(this.home, '.claude', 'settings.json') }

  handlers() {
    return {
      'preflight.run': async () => this.preflight(),
      'preflight.fix': async ({ id }) => {
        // Through setSettings, so it is saved and applied like the Models page toggle.
        if (id === 'teams') await this.k.config.setSettings({ models: { agentTeams: true } })
        else if (id === 'hooks') await this.restartHooks(await nextFreePort(this.settings.hookPort + 1))
        return this.preflight()
      },
      'hooks.status': async () => this.hooksStatus(),
      'hooks.restart': async ({ port }) => this.restartHooks(port ?? this.settings.hookPort),
      'hooks.test': async () => {
        // /health answers from the same server that receives hooks, and records nothing.
        const res = await fetch(`http://127.0.0.1:${this.settings.hookPort}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
        if (!res?.ok) throw new Error(`No reply from the hook server on port ${this.settings.hookPort}.`)
        return this.hooksStatus()
      },
      'hooks.uninstall': async () => { await uninstallHooks(this.claudeSettings); return this.pushHooks() },
      'hooks.install': async ({ port }) => ({ path: this.claudeSettings, events: await this.writeHooks(port) })
    } satisfies Partial<Handlers>
  }
}
