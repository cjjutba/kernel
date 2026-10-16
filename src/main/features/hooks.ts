import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AnyHook } from '@shared/hookSchemas'
import type { AgentStatus, HookProblem, HookStatus } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { hooksPolicy, type HooksPolicy } from '../services/claudeSettings'
import { startHookServer, type HookContext } from '../services/hookServer'
import { hookToken } from '../services/hookToken'
import { HooksFileError, hookStatus, installedEvents, installHooks, KERNEL_HOOK_EVENTS, kernelHooksPresent, refreshHooks, RUN_HOOKS_OFF, turnHooksOn, uninstallHooks, withKernelHooks, type HookWriteProblem } from '../services/hooksInstaller'
import { nextFreePort, portBusy, runPreflight } from '../services/preflight'
import { tildify } from '../services/projects'
import { Feature } from './feature'

/** How a hook from an outside session sets its agent's status in Team and the sidebar. */
const HOOK_STATUS: Record<string, AgentStatus> = { UserPromptSubmit: 'working', PreToolUse: 'working', PermissionRequest: 'needs', Stop: 'idle', SessionEnd: 'idle' }

/** The hook server, the hooks in Claude's settings file, and the preflight checks (KERNEL-325). */
export class Hooks extends Feature {
  private hookServer?: Server
  /** The start-up rewrite of out-of-date hooks failed (KERNEL-206). The hooks banner shows until a write succeeds. */
  private hooksNeedInstall = false
  /** When each hook event last arrived from a real session. The test event is not counted. */
  private hookSeen = new Map<string, number>()
  /** The last write of the hooks that failed in a way Check hooks explains, until a write works (KERNEL-461). */
  private writeProblem?: HookWriteProblem
  /** Reads what Claude Code's managed and user settings do to hooks. Tests swap it. */
  readPolicy: () => Promise<HooksPolicy> = () => hooksPolicy()

  async start() {
    // Hooks from before KERNEL-206, or from another port or timeout, get a 401. Rewrite Kernel's own entries, never add any.
    // A workspace run has none and leaves the file alone: a rewrite would point Kernel Dev's entries at this copy (KERNEL-679).
    if (!this.off) this.hooksNeedInstall = await this.write(() => this.adoptShared().then((adopted) => adopted || refreshHooks(this.claudeSettings, this.settings.hookPort, this.settings.permissions.approvalTimeoutSec, this.hookToken, this.build))).then(() => false, (e) => { console.warn('[hooks] could not update the hooks', e); return true })
    await this.listenHooks(this.settings.hookPort)
  }

  /**
   * Kernel Dev just moved its data, or stopped sharing the installed app's token (KERNEL-675). The installed app's entries
   * were the hooks both builds ran on, so Kernel Dev installs its own next to them, once, and leaves them as they are. With
   * none there, it adds nothing, as any start.
   */
  private async adoptShared(): Promise<boolean> {
    if (!this.o.hooksWereShared || this.build !== 'dev') return false
    if (await kernelHooksPresent(this.claudeSettings, 'dev') || !(await kernelHooksPresent(this.claudeSettings, 'app'))) return false
    await installHooks(this.claudeSettings, this.settings.hookPort, this.settings.permissions.approvalTimeoutSec, this.hookToken, this.build)
    return true
  }

  /** Whether this build's entries are in Claude's settings, current or not. A port or timeout change rewrites them only then. */
  present(): Promise<boolean> { return this.off ? Promise.resolve(false) : kernelHooksPresent(this.claudeSettings, this.build).catch(() => false) }

  /** A write of the hooks file. One that works clears the last failure, and one Check hooks can explain is kept for it. */
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn()
      this.writeProblem = undefined
      return out
    } catch (e) {
      if (e instanceof HooksFileError) this.writeProblem = e.problem
      throw e
    }
  }

  stop(): Promise<void> {
    // An outside session waiting on an approval holds its request open for up to the approval timeout, and close()
    // waits for it, so whatever is still open ends first.
    return new Promise<void>((r) => { if (!this.hookServer) return r(); this.hookServer.closeAllConnections(); this.hookServer.close(() => r()) })
  }

  /** A hook from a session Kernel did not start. The listener on the bus calls it. */
  onHook(e: AnyHook, ctx?: HookContext) {
    this.hookSeen.set(e.hook_event_name, Date.now())
    if (ctx?.chatId) this.k.seatSignals.onHook(e, ctx.chatId)
    // Only sessions Kernel did not start reach here (the big terminal, or Claude Code run by hand), so Kernel learns their status from the hooks.
    const status = HOOK_STATUS[e.hook_event_name]
    if (!status || !ctx?.projectId || !ctx.agentId) return
    if (this.k.team.statuses.get(ctx.projectId)?.[ctx.agentId] === 'paused') return
    bus.push({ type: 'agent.status', projectId: ctx.projectId, agentId: ctx.agentId, status })
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
        build: this.build,
        resolve: (cwd, _session, chatId) => this.resolveCwd(cwd, chatId)
      })
      // A server that closes or errors on its own takes agent statuses and the logs with it (WorkspaceHooksDown.png).
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
    const wasInstalled = await this.present()
    await new Promise<void>((r) => (this.hookServer?.listening ? this.hookServer.close(() => r()) : r()))
    this.hookServer = undefined
    if (!(await this.listenHooks(port))) throw new Error(`Port ${port} is in use. Pick another port and try again.`)
    // Saved as a choice, like any other change in Settings (KERNEL-225).
    if (port !== this.settings.hookPort) await this.k.config.setSettings({ hookPort: port })
    if (wasInstalled) await this.writeHooks(port)
    return this.pushHooks()
  }

  /** Install, and every rewrite after a port or timeout change. A write that works clears the start-up failure. */
  async writeHooks(port: number): Promise<string[]> {
    this.refuseRun()
    const events = await this.write(() => installHooks(this.claudeSettings, port, this.settings.permissions.approvalTimeoutSec, this.hookToken, this.build))
    this.hooksNeedInstall = false
    return events
  }

  private async pushHooks(): Promise<HookStatus> {
    const status = await this.hooksStatus()
    if (!this.stopped) bus.push({ type: 'hooks', status })
    return status
  }

  async hooksStatus(): Promise<HookStatus> {
    // A workspace run has nothing installed, whatever Claude's settings say, and says why in place of Install (KERNEL-679).
    if (this.off) {
      return { port: this.settings.hookPort, listening: !!this.hookServer?.listening, installed: false, events: KERNEL_HOOK_EVENTS.map((name) => ({ name, installed: false, lastSeen: this.hookSeen.get(name) })), token: this.hookToken, needsInstall: false, build: this.build, problem: { kind: 'workspace-run' } }
    }
    const policy = await this.readPolicy().catch((e) => { console.warn('[hooks] could not read Claude Code settings', e); return undefined })
    // Kernel's entries an admin put in managed settings count too, and run when only managed hooks do.
    const managed = new Set(policy ? installedEvents({ hooks: policy.managedHooks } as Parameters<typeof installedEvents>[0], this.hookToken, this.build) : [])
    const installed = new Set([...managed, ...await hookStatus(this.claudeSettings, this.hookToken, this.build).catch(() => [] as string[])])
    const problem = this.problem(policy, KERNEL_HOOK_EVENTS.every((e) => managed.has(e)))
    return {
      port: this.settings.hookPort,
      listening: !!this.hookServer?.listening,
      installed: KERNEL_HOOK_EVENTS.every((e) => installed.has(e)),
      events: KERNEL_HOOK_EVENTS.map((name) => ({ name, installed: installed.has(name), lastSeen: this.hookSeen.get(name) })),
      token: this.hookToken,
      needsInstall: this.hooksNeedInstall,
      build: this.build,
      ...(problem ? { problem } : {})
    }
  }

  /**
   * Why the hooks can't run or weren't written (KERNEL-461). Managed policy comes first, because nothing on this Mac changes
   * it, then the last failed write, then the user's own disableAllHooks, which Turn hooks on removes. Managed hooks run under
   * the user's disableAllHooks, so Kernel's entries there clear it.
   */
  private problem(policy: HooksPolicy | undefined, inManaged: boolean): HookProblem | undefined {
    if (policy?.managedOff) return { kind: 'managed', setting: 'disableAllHooks', ...this.source(policy.managedOff.path) }
    if (policy?.managedOnly && !inManaged) {
      const block = JSON.stringify({ hooks: withKernelHooks({}, this.settings.hookPort, this.settings.permissions.approvalTimeoutSec, this.hookToken, this.build).hooks }, null, 2)
      return { kind: 'managed', setting: 'allowManagedHooksOnly', ...this.source(policy.managedOnly.path), block }
    }
    if (this.writeProblem) return this.writeProblem
    if (policy?.userOff && !inManaged) return { kind: 'off', file: tildify(policy.userOff.path ?? this.claudeSettings, this.home) }
  }

  private source(path?: string) { return path ? { source: tildify(path, this.home) } : {} }

  /** Whether hooks can reach Kernel now: the server listens, and this build keeps entries in Claude's settings. */
  async connected(): Promise<boolean> {
    return !this.off && !!this.hookServer?.listening && (await this.hooksStatus()).installed
  }

  private resolveCwd(cwd: string, chatId?: string): HookContext {
    // A seat's own chat, when the hook names one that is an open terminal in a live workspace (KERNEL-999).
    const chat = chatId ? this.store.chat(chatId) : undefined
    const home = chat?.kind === 'terminal' && !chat.closed ? this.store.workspace(chat.workspaceId) : undefined
    if (chat && home && home.status !== 'archived') return { projectId: home.projectId, workspaceId: home.id, agentId: home.agentId, chatId: chat.id }
    const ws = this.store.workspaces().filter((w) => w.status !== 'archived').sort((a, b) => b.path.length - a.path.length).find((w) => cwd === w.path || cwd.startsWith(w.path + '/'))
    if (ws) return { projectId: ws.projectId, workspaceId: ws.id, agentId: ws.agentId }
    const project = this.store.projects().find((r) => cwd === r.path || cwd.startsWith(r.path + '/'))
    return project ? { projectId: project.id } : {}
  }

  private async preflight() {
    const shell = (await this.o.refreshPath?.()) ?? undefined
    const codex = Object.values(this.settings.models.roles).some((r) => r.provider === 'codex') ? { bin: this.k.providers.binary('codex').path } : undefined
    // gh only while a project's PRs go to GitHub, so a Mac with only local projects sees no gh warning (KERNEL-477).
    return runPreflight({ hookPort: this.settings.hookPort, hookServerUp: !!this.hookServer?.listening, codex, shell, gh: this.k.codeHost.usesGitHub() })
  }

  private get hookToken() { return hookToken(this.o.dataDir) }
  private get build() { return this.o.build ?? 'app' }
  /**
   * A dev run started inside a Kernel workspace (KERNEL-679). Its hook server listens, but it keeps no entries in Claude's
   * settings and never writes the file, so it sees no session started outside it.
   */
  private get off() { return this.build === 'run' }
  private refuseRun() { if (this.off) throw new Error(RUN_HOOKS_OFF) }
  get claudeSettings() { return this.o.claudeSettingsFile ?? join(this.home, '.claude', 'settings.json') }

  handlers() {
    return {
      'preflight.run': async () => this.preflight(),
      'preflight.fix': async ({ id }) => {
        if (id === 'hooks') await this.restartHooks(await nextFreePort(this.settings.hookPort + 1))
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
      'hooks.uninstall': async () => { this.refuseRun(); await uninstallHooks(this.claudeSettings, this.build); return this.pushHooks() },
      'hooks.turnOn': async () => { this.refuseRun(); await this.write(() => turnHooksOn(this.claudeSettings)); return this.pushHooks() },
      'hooks.install': async ({ port }) => ({ path: this.claudeSettings, events: await this.writeHooks(port) })
    } satisfies Partial<Handlers>
  }
}
