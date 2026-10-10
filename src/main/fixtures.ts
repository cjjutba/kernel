import type { AgentDef, Approval, Chat, ClaudeAccount, HookStatus, LinearIssue, RoomSettings, Workspace } from '@shared/types'
import type { Fixture } from '../../fixtures'
import type { PushEvent } from '@shared/ipc'
import { localUrlIn } from '@shared/previewUrl'
import { join, matchesGlob } from 'node:path'
import type { Handlers } from './kernel'
import { applySettingsPatch, DEFAULT_SETTINGS, isRunName, previewUrlsOf } from './services/settings'
import { agentFromFile, draftAgent } from './services/agents'
import { isPattern } from './services/filesToCopy'

const ok = { ok: true } as const
const fixtureAccount: ClaudeAccount = { signedIn: true, name: 'Sam Rivera', login: 'samrivera', plan: 'Claude Max' }

/**
 * Fixture mode (KERNEL_FIXTURES): every IPC channel answered from one fixture, with no database, hook server or sessions.
 * Reads serve the fixture. Writes return a plausible value and change nothing, so a screenshot shows the same state every time.
 */
export function fixtureHandlers(f: Fixture): Handlers {
  const chat = (id: string): Chat => {
    const c = f.chats.find((x) => x.id === id)
    if (!c) throw new Error(`Unknown chat ${id}`)
    return c
  }
  const workspace = (id: string): Workspace => {
    const w = f.workspaces.find((x) => x.id === id)
    if (!w) throw new Error(`Unknown workspace ${id}`)
    return w
  }
  const room = (id: string) => {
    const r = f.rooms.find((x) => x.id === id)
    if (!r) throw new Error(`Unknown room ${id}`)
    return r
  }
  const agentOf = (roomId: string, id: string): AgentDef => {
    const a = f.agents[roomId]?.find((x) => x.id === id)
    if (!a) throw new Error(`Unknown agent ${id}`)
    return a
  }
  /** The Lead's own workspace on the main checkout, the one `Kernel.leadChat` finds. */
  const leadWs = (roomId: string) => {
    const lead = f.agents[roomId]?.find((a) => a.lead)
    return f.workspaces.find((w) => w.roomId === roomId && w.agentId === lead?.id && w.mode === 'current' && w.status !== 'archived')
  }
  let settings = f.settings ?? DEFAULT_SETTINGS('/Users/you')
  const hooks: HookStatus = f.hooks ?? { port: settings.hookPort, listening: true, installed: true, events: [] }
  const update = f.update ?? { status: 'idle' as const, current: '0.1.0' }
  const account = f.account ?? fixtureAccount
  const roomSettings = (roomId: string): RoomSettings => {
    const rs = f.roomSettings?.[roomId] ?? { scripts: {}, files: { copy: ['.env', '.env.local'] }, workspace: {} }
    // Like the engine, `run` comes first, from `[scripts] run`.
    const runScripts = rs.runScripts ?? (rs.scripts.run ? [{ name: 'run', command: rs.scripts.run }] : [])
    return { ...rs, runScripts, disabled: { skills: [], mcp: [], ...rs.disabled }, preview: { urls: rs.preview?.urls ?? [] }, sources: rs.sources ?? {} }
  }
  const queue = (chatId: string) => f.queue?.[chatId] ?? []
  const decided = (a: Approval, d: Parameters<Handlers['approvals.decide']>[0]['decision']): Approval =>
    d.behavior === 'answer' ? { ...a, status: 'answered', answer: d.text } : { ...a, status: d.behavior === 'allow' ? 'allowed' : 'denied' }

  return {
    'preflight.run': async () => f.preflight,
    'preflight.fix': async () => f.preflight,
    'hooks.install': async () => ({ path: '(fixture)', events: [] }),
    'hooks.uninstall': async () => f.hooks ?? { port: 7420, listening: true, installed: false, events: [] },
    'hooks.status': async () => hooks,
    'hooks.test': async () => hooks,
    'hooks.restart': async () => hooks,
    'rooms.list': async () => f.rooms,
    'rooms.add': async ({ path, name }) => f.rooms.find((r) => r.path === path) ?? { id: 'fixture-room', name: name ?? path.split('/').pop() ?? path, path, defaultBranch: 'main', paused: false, createdAt: Date.now() },
    'rooms.create': async ({ name, desc, source, from }) => ({ id: 'fixture-room', name, desc, kind: source, path: from, defaultBranch: 'main', paused: false, createdAt: Date.now() }),
    'rooms.update': async ({ roomId, patch }) => ({ ...room(roomId), ...patch }),
    'rooms.setIcon': async ({ roomId, icon }) => {
      const { icon: _old, ...r } = room(roomId)
      return icon.kind === 'letter' ? r : { ...r, icon: { kind: icon.kind, file: `${roomId}-fixture.png`, at: Date.now() } }
    },
    'rooms.icon': async ({ roomId }) => (room(roomId).icon ? f.roomIcons?.[roomId] ?? null : null),
    'rooms.remove': async () => ok,
    'rooms.setPaused': async ({ roomId, paused }) => ({ ...room(roomId), paused }),
    'rooms.brief': async ({ roomId, agentId }) => {
      const lead = f.agents[roomId]?.find((a) => a.lead)
      const ws = f.workspaces.find((w) => w.roomId === roomId && w.agentId === (agentId ?? lead?.id) && w.status !== 'archived')
      const c = ws && f.chats.find((x) => x.workspaceId === ws.id)
      if (!ws || !c) throw new Error('This fixture has no chat for that agent.')
      return { chatId: c.id, workspaceId: ws.id }
    },
    'rooms.overlaps': async ({ roomId }) => (f.overlaps ?? []).filter((o) => o.roomId === roomId),
    'rooms.resolveOverlap': async () => ok,
    'rooms.inspectFolder': async ({ path }) => f.folders?.find((x) => x.path === path) ?? { path, git: true, branch: 'main', dirty: 0 },
    'rooms.recentFolders': async () => f.folders ?? [],
    'github.repos': async ({ query }) => (f.repos ?? []).filter((r) => !query || r.fullName.includes(query)),
    'agents.list': async ({ roomId, retired }) => (f.agents[roomId] ?? []).filter((a) => !!a.retired === !!retired),
    'agents.status': async ({ roomId }) => f.status[roomId] ?? {},
    'agents.save': async ({ roomId, agentId, patch }) => ({ ...agentOf(roomId, agentId), ...patch }),
    'agents.draft': async ({ description, name, model }) => draftAgent({ description, name, model }),
    'agents.create': async ({ draft }) => ({ ...agentFromFile(draft.file, draft.text), joinedAt: Date.now() }),
    'agents.retire': async () => ok,
    'agents.restore': async ({ roomId, agentId }) => ({ ...agentOf(roomId, agentId), retired: false }),
    'agents.seed': async ({ roomId }) => f.agents[roomId] ?? [],
    'workspaces.list': async ({ roomId }) => f.workspaces.filter((w) => !roomId || w.roomId === roomId),
    'workspaces.create': async () => { throw new Error('Fixture mode does not create workspaces.') },
    'workspaces.archive': async () => ok,
    'workspaces.restore': async ({ workspaceId }) => ({ ...workspace(workspaceId), status: 'ready' }),
    'workspaces.gitStatus': async ({ workspaceId }) => {
      if (f.gitStatus?.[workspaceId]) return f.gitStatus[workspaceId]
      const files = f.changes[workspaceId] ?? []
      return { branch: workspace(workspaceId).branch, ahead: 0, behind: 0, dirty: { files: files.length, added: files.reduce((n, c) => n + c.added, 0), removed: files.reduce((n, c) => n + c.removed, 0) } }
    },
    'workspaces.changes': async ({ workspaceId }) => f.changes[workspaceId] ?? [],
    'workspaces.diff': async ({ workspaceId }) => f.diffs[workspaceId] ?? '',
    'workspaces.tree': async ({ workspaceId }) => f.tree?.[workspaceId] ?? [],
    'workspaces.files': async ({ workspaceId, query, limit = 8 }) => (f.tree?.[workspaceId] ?? []).filter((e) => !e.dir && e.path.toLowerCase().includes(query.toLowerCase())).slice(0, limit),
    'workspaces.readFile': async ({ workspaceId, path }) => f.fileText?.[workspaceId]?.[path] ?? '',
    'workspaces.hunks': async ({ workspaceId, path }) => (f.hunks?.[workspaceId] ?? []).filter((h) => !path || h.path === path),
    'workspaces.commit': async () => ok,
    'workspaces.discard': async () => ok,
    'git.branches': async ({ roomId }) => f.branches ?? [...new Set(f.workspaces.filter((w) => w.roomId === roomId).map((w) => w.branch))],
    'github.prs': async ({ query }) => (f.openPrs ?? []).filter((p) => !query || `#${p.number} ${p.title} ${p.author ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    'github.issues': async ({ query }) => (f.issues ?? []).filter((i) => i.source === 'github' && (!query || `${i.id} ${i.title}`.toLowerCase().includes(query.toLowerCase()))),
    'issues.list': async ({ roomId, query }) => (f.issues?.filter((i) => i.source !== 'github') ?? (f.tasks?.[roomId] ?? []).map((t) => ({ id: t.id, title: t.title }))).filter((i) => !query || `${i.id} ${i.title}`.toLowerCase().includes(query.toLowerCase())),
    'linear.issues': async ({ filter }) => (f.linear?.issues ?? []).filter((i) => {
      const q = filter.query?.trim().toLowerCase()
      return (!filter.mine || i.assignee?.me) && (!filter.teamId || i.team.id === filter.teamId) && (!filter.projectId || i.project?.id === filter.projectId)
        && (!filter.cycleId || i.cycle?.id === filter.cycleId) && (!q || `${i.id} ${i.title}`.toLowerCase().includes(q))
    }).map(({ description: _d, comments: _c, ...issue }): LinearIssue => issue),
    'linear.issue': async ({ id }) => {
      const issue = f.linear?.issues?.find((i) => i.id === id)
      if (!issue) throw new Error(`Unknown issue ${id}`)
      return issue
    },
    'linear.scope': async () => f.linear?.scope ?? { teams: [], projects: [], cycles: [] },
    'linear.plan': async ({ roomId }) => {
      const ws = leadWs(roomId)
      const c = ws && f.chats.find((x) => x.workspaceId === ws.id)
      if (!ws || !c) throw new Error('This fixture has no chat for the Lead.')
      return { chatId: c.id, workspaceId: ws.id }
    },
    'chats.list': async ({ workspaceId }) => f.chats.filter((c) => c.workspaceId === workspaceId),
    'chats.create': async ({ workspaceId, kind }) => {
      const first = f.chats.find((c) => c.workspaceId === workspaceId)
      if (!first) throw new Error(`Unknown workspace ${workspaceId}`)
      return { ...first, id: `fixture-chat-${Date.now()}`, kind: kind ?? 'chat', title: kind === 'terminal' ? 'Terminal (claude)' : 'New chat', sessionId: undefined, plan: false }
    },
    'chats.items': async ({ chatId }) => f.items[chatId] ?? [],
    'chats.send': async () => ({ queued: false }),
    'chats.interrupt': async () => ok,
    'chats.configure': async ({ chatId, ...patch }) => ({ ...chat(chatId), ...patch }),
    'chats.rename': async ({ chatId, title }) => ({ ...chat(chatId), title }),
    'chats.close': async () => ok,
    'chats.fork': async ({ chatId, itemId }) => {
      const c = chat(chatId)
      return { ...c, id: `fixture-fork-${Date.now()}`, title: `Fork of ${c.title}`, sessionId: undefined, forkOf: { chatId, itemId: itemId ?? (f.items[chatId]?.at(-1)?.id ?? '') } }
    },
    'chats.retry': async () => ok,
    'chats.compact': async () => ok,
    'chats.restart': async () => ok,
    'chats.queue': async ({ chatId }) => queue(chatId),
    'chats.queueReason': async () => null,
    'chats.unqueue': async ({ chatId, id }) => queue(chatId).filter((q) => q.id !== id),
    'chats.sendNow': async ({ chatId, id }) => queue(chatId).filter((q) => q.id !== id),
    'skills.list': async () => f.skills ?? [],
    'commands.list': async () => [],
    'terminal.write': async () => ok,
    'terminal.resize': async () => ok,
    'checkpoints.list': async ({ workspaceId }) => f.checkpoints?.[workspaceId] ?? [],
    'checkpoints.revert': async ({ workspaceId }) => ({ backupBranch: `backup/${workspace(workspaceId).name}` }),
    'approvals.list': async ({ roomId }) => f.approvals.filter((a) => !roomId || a.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt),
    'approvals.decide': async ({ id, decision }) => {
      const a = f.approvals.find((x) => x.id === id)
      if (!a) throw new Error('This request already timed out or was answered.')
      return decided(a, decision)
    },
    'approvals.planFile': async ({ id }) => {
      const a = f.approvals.find((x) => x.id === id)
      const ws = a?.workspaceId ? workspace(a.workspaceId) : undefined
      if (!a?.planFile || !ws) throw new Error('This plan has no file.')
      return { path: join(ws.path, a.planFile), relative: a.planFile }
    },
    'tasks.list': async ({ roomId }) => f.tasks?.[roomId] ?? [],
    'notifications.list': async () => f.notifications ?? [],
    'notifications.read': async ({ ids }) => (f.notifications ?? []).map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)),
    'lead.ask': async ({ roomId }) => {
      const ws = leadWs(roomId)
      const c = ws && f.chats.find((x) => x.workspaceId === ws.id)
      if (!c) throw new Error('This fixture has no chat for the Lead.')
      return { chatId: c.id }
    },
    'lead.open': async ({ roomId }) => {
      const ws = leadWs(roomId)
      if (!ws) throw new Error('This fixture has no workspace for the Lead.')
      return ws
    },
    'lead.start': async () => { throw new Error('Fixture mode does not start chats.') },
    'pr.get': async ({ workspaceId }) => f.prs?.[workspaceId] ?? null,
    'pr.create': async ({ workspaceId }) => workspace(workspaceId),
    'pr.refresh': async ({ workspaceId }) => workspace(workspaceId),
    'pr.merge': async ({ workspaceId }) => workspace(workspaceId),
    'pr.resolve': async () => ({ ok: true }),
    'pr.ready': async ({ workspaceId }) => workspace(workspaceId),
    'pr.reopen': async ({ workspaceId }) => workspace(workspaceId),
    'pr.continue': async ({ workspaceId }) => ({ ...workspace(workspaceId), prState: 'none', prNumber: undefined, prUrl: undefined }),
    'scripts.run': async () => ok,
    'scripts.stop': async () => ok,
    'activity.recent': async ({ roomId, limit = 50 }) => f.activity.filter((e) => !roomId || e.roomId === roomId).sort((a, b) => b.ts - a.ts).slice(0, limit),
    'rooms.lastActivity': async ({ roomId }) => {
      const last: Record<string, number> = {}
      for (const e of f.activity) if (e.roomId === roomId && e.agentId) last[e.agentId] = Math.max(last[e.agentId] ?? 0, e.ts)
      return last
    },
    'usage.get': async () => f.usage,
    'usage.notifyOnReset': async () => ok,
    'account.get': async () => account,
    'account.signIn': async () => account,
    'account.signOut': async () => ({ signedIn: false }),
    'settings.get': async () => settings,
    'settings.set': async ({ patch }) => (settings = applySettingsPatch(settings, patch)),
    'settings.room': async ({ roomId }) => roomSettings(roomId),
    'settings.setRoom': async ({ roomId, patch, shared }) => {
      // Keeps the change for the life of the fixture, so a toggle in a screenshot run behaves like the real thing. Any group
      // the patch names is applied the same way, and the sources follow the file it was written to. `runScripts` is a list
      // here and a table in the patch, so it is applied by name, with `run` kept as `[scripts] run`.
      const cur = roomSettings(roomId)
      const next: Record<string, unknown> = { ...cur }
      const sources = { ...cur.sources }
      const file = shared ? 'shared' : 'local'
      const other = shared ? 'local' : 'shared'
      const runs = new Map(cur.runScripts.map((r) => [r.name, r.command]))
      // `RUN` and `Run` are `run`, as in the engine.
      if (patch.runScripts) patch = { ...patch, runScripts: Object.fromEntries(Object.entries(patch.runScripts).map(([k, v]) => [isRunName(k) ? 'run' : k, v])) }
      // A preview list with no entry left removes the key, as in the engine (KERNEL-246).
      if (patch.preview?.urls) {
        const urls = previewUrlsOf(patch.preview.urls)
        patch = { ...patch, preview: { urls: urls.length ? urls : null } }
      }
      for (const [group, values] of Object.entries(patch)) {
        const g = group === 'runScripts' ? Object.fromEntries(runs) : { ...(cur as unknown as Record<string, Record<string, unknown> | undefined>)[group] }
        for (const [k, v] of Object.entries(values ?? {})) {
          const path = `${group}.${k}`
          // Removing a key from one file leaves the other file's, as the engine does. The fixture keeps the value it shows.
          if (v === null) {
            if (sources[path] === 'override' || sources[path] === other) sources[path] = other
            else { delete g[k]; delete sources[path] }
          } else {
            g[k] = v
            sources[path] = sources[path] && sources[path] !== file ? 'override' : file
          }
        }
        if (group === 'runScripts') {
          runs.clear()
          for (const [k, v] of Object.entries(g)) if (typeof v === 'string') runs.set(k, v)
        } else next[group] = g
      }
      // `run` is one value with two names: whichever the patch set wins, and its source follows.
      const [from, to] = patch.runScripts && 'run' in patch.runScripts ? ['runScripts.run', 'scripts.run'] : ['scripts.run', 'runScripts.run']
      if (sources[from]) sources[to] = sources[from]
      else delete sources[to]
      const run = from === 'runScripts.run' ? runs.get('run') : (next.scripts as RoomSettings['scripts']).run
      next.scripts = { ...(next.scripts as RoomSettings['scripts']), run }
      next.runScripts = [...(run ? [{ name: 'run', command: run }] : []), ...[...runs].filter(([n]) => n !== 'run').map(([name, command]) => ({ name, command }))]
      f.roomSettings = { ...(f.roomSettings ?? {}), [roomId]: { ...next, sources } as RoomSettings }
      return roomSettings(roomId)
    },
    'files.preview': async ({ roomId, patterns }) => {
      const entries = patterns ?? roomSettings(roomId).files.copy
      return (f.localFiles?.[roomId] ?? []).filter((file) => entries.some((e) => (isPattern(e) ? matchesGlob(file.path, e) : file.path === e)))
        .sort((a, b) => a.path.localeCompare(b.path))
    },
    'shared.list': async ({ roomId, workspaceId, limit }) => (f.shared ?? [])
      .filter((x) => (!roomId || x.roomId === roomId) && (!workspaceId || x.workspaceId === workspaceId))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit ?? undefined),
    'shared.read': async ({ sharedId, version }) => {
      const file = f.shared?.find((x) => x.id === sharedId)
      const v = file?.versions.find((x) => x.n === version)
      if (!file || !v) throw new Error('That shared file or version is gone.')
      const data = f.sharedData?.[sharedId]?.[version]
      return { kind: file.kind, mime: v.mime, ...(data?.text !== undefined ? { text: data.text } : {}), ...(data?.dataUrl ? { dataUrl: data.dataUrl } : {}) }
    },
    'shared.thumb': async ({ sharedId, version }) => f.sharedData?.[sharedId]?.[version]?.thumb ?? null,
    'shared.reveal': async () => ok,
    'mcp.list': async () => f.mcp ?? [],
    'integrations.list': async () => f.integrations ?? [],
    'integrations.connect': async ({ id }) => ({ id, name: id, connected: true, detail: '' }),
    'update.get': async () => update,
    'update.check': async () => update,
    'update.install': async () => ok,
    'app.exportLogs': async () => ({ path: '(fixture)' }),
    'app.info': async () => ({ version: '0.1.0', dataDir: join('~', 'Library', 'Application Support', 'Kernel') }),
    'app.openTerminal': async () => ok,
    'app.checkOnline': async () => ({ online: !f.push.some((e) => e.type === 'online' && !e.online) })
  }
}

/**
 * The events a fixture replays, with the `script.url` events the engine would push among them: a run script's first local
 * URL right after the line that prints it, and null when it exits (KERNEL-246). A fixture that pushes its own keeps it.
 */
export function fixturePush(f: Fixture): PushEvent[] {
  const out: PushEvent[] = []
  const found = new Set<string>()
  for (const e of f.push) {
    if (e.type === 'script.exit' && e.kind === 'run' && found.delete(JSON.stringify([e.workspaceId, e.name ?? 'run']))) {
      out.push({ type: 'script.url', workspaceId: e.workspaceId, name: e.name ?? 'run', url: null })
    }
    out.push(e)
    if (e.type === 'script.url' && e.url) found.add(JSON.stringify([e.workspaceId, e.name]))
    if (e.type !== 'script.output' || e.kind !== 'run') continue
    const name = e.name ?? 'run'
    const k = JSON.stringify([e.workspaceId, name])
    const url = found.has(k) ? null : localUrlIn(e.line)
    if (url) { found.add(k); out.push({ type: 'script.url', workspaceId: e.workspaceId, name, url }) }
  }
  return out
}
