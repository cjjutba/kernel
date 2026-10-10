import type { AgentDef, DevUiPage, HookStatus, Integration, McpServer, PreflightCheck, RateLimit, RoomSettings, RoomSettingsSection, SettingsPage, Skill } from '@shared/types'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import type { Fixture } from './types'
import { teamFixtures } from './team'
import { workspaceFixtures } from './workspace'
import { at, base, ids, scene, tableItems, withWorkspace } from './base'

// Platform lane: setup checks (KERNEL-27), limits and setup failures (KERNEL-28).
// Check copy matches src/main/services/preflight.ts.

const onboarding = { route: { name: 'onboarding', step: 'checks' } } as const
const open = { route: { name: 'workspace', workspaceId: ids.table } } as const
const empty = { rooms: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [] }

// The five checks, in canvas order. Copy matches src/main/services/preflight.ts.
const claudeOk: PreflightCheck = { id: 'claude', ok: true, title: 'Claude Code', detail: 'Found on your PATH', meta: 'v2.1.284' }
const authOk: PreflightCheck = { id: 'auth', ok: true, title: 'Signed in', detail: 'Claude Max' }
const teamsOk: PreflightCheck = { id: 'teams', ok: true, title: 'Agent teams', detail: 'Enabled for Kernel sessions' }
const ghOk: PreflightCheck = { id: 'gh', ok: true, title: 'GitHub CLI', detail: 'Signed in as samrivera', meta: 'gh 2.62' }
const hooksOk: PreflightCheck = { id: 'hooks', ok: true, title: 'Hook server', detail: 'Listening for events', meta: 'localhost:7420' }
const allOk = [claudeOk, authOk, teamsOk, ghOk, hooksOk]
/** Every check passing except the one at `id`, which is replaced by `failing`. */
const failing = (failed: PreflightCheck) => allOk.map((c) => (c.id === failed.id ? failed : c))

const setup = (checks: PreflightCheck[]) => scene(() => ({ ...empty, preflight: checks, ui: onboarding }))

/** Six running sessions, the count the canvas shows: the seed's chats, topped up with copies. */
const sixRunning = (f: Fixture) => {
  const chats = Array.from({ length: 6 }, (_, i) => f.chats[i] ?? { ...f.chats[0], id: `${f.chats[0].id}-copy-${i}` })
  return { chats: [...f.chats, ...chats.filter((c) => !f.chats.includes(c))], push: chats.map((c) => ({ type: 'chat.running' as const, chatId: c.id, running: true })) }
}

const eventsAgo = (m: number | null) => (m === null ? undefined : Date.now() - m * 60_000)
const hookEvents: HookStatus['events'] = [
  ['SessionStart', 2], ['UserPromptSubmit', 12], ['PreToolUse', 0], ['PostToolUse', 0], ['PermissionRequest', 2], ['Notification', 2], ['Stop', 6], ['TaskCreated', 6], ['TaskCompleted', 18], ['TeammateIdle', null]
].map(([name, m]) => ({ name: name as string, installed: true, lastSeen: eventsAgo(m as number | null) }))

/** `resetsAt` is epoch seconds, as rate_limit_event sends it. */
const secs = (ms: number) => Math.round(ms / 1000)
/** The next h:m from now, so a reset is always ahead and within a day ("Resets at 3:40 PM"). */
const next = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime() }
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d.getTime() }
/** The invoice table chat with a change. */
const withChat = (f: Fixture, change: Partial<Fixture['chats'][number]>) => f.chats.map((c) => (c.id === ids.tableChat ? { ...c, ...change } : c))

// KERNEL-9: the component gallery in both themes. the `devUi` route shows it. No design PNG, so no compare.
const gallery = (page: DevUiPage) => scene(() => ({ ...empty, ui: { route: { name: 'devUi', page } } }))

// KERNEL-25: the app-wide settings pages. The seed's rooms fill the nav; Account adds the three usage windows the canvas shows.
const settingsPage = (page: SettingsPage, extra: Partial<Fixture> = {}) => scene(() => ({ ...extra, ui: { route: { name: 'settings', page } } }))
/** One of Client A's room pages (KERNEL-191). */
const roomPage = (section: RoomSettingsSection, extra: Partial<Fixture> = {}, menu?: 'settingsFiles') => scene(() => ({ ...extra, ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section }, ...(menu ? { menu } : {}) } }))
const accountUsage: RateLimit[] = [
  { type: 'five_hour', status: 'allowed', utilization: 0.62, resetsAt: secs(next(15, 40)) },
  { type: 'seven_day', status: 'allowed', utilization: 0.38, resetsAt: secs(nextMonday()) },
  { type: 'seven_day_opus', status: 'allowed_warning', utilization: 0.9, resetsAt: secs(nextMonday()), model: 'claude-fable-5-1' }
]

// KERNEL-26, KERNEL-191: the room pages read their own room's .kernel files, so the fixture gives Client A the values the canvas shows.
// `sources` says which file set what: both files are there, so the settings files button offers both.
const kernelFiles: RoomSettings = {
  scripts: { setup: 'pnpm install\ncp ../../.env.local .env.local', run: 'pnpm dev --port $KERNEL_PORT', archive: 'docker compose down', runMode: 'concurrent' },
  files: { copy: ['.env.local', '.env.test', 'certs/*.pem'], symlinkNodeModules: false },
  workspace: { baseRef: 'origin/dev' },
  disabled: { skills: [], mcp: ['Figma'] },
  pr: { createInstructions: '# Create a pull request\n1. Rebase on origin/dev and run pnpm test\n2. Title it as a Conventional Commit\n3. Fill in summary, scope and risk\n4. Link the Linear issue in the description' },
  sources: { 'scripts.setup': 'shared', 'scripts.run': 'override', 'files.copy': 'shared', 'workspace.baseRef': 'override', 'pr.createInstructions': 'override' }
}
const clientA = (extra: Partial<RoomSettings> = {}) => ({ roomSettings: { [ids.roomA]: { ...kernelFiles, ...extra } } })
const prSettings = { ...DEFAULT_SETTINGS('/Users/you'), pr: { ...DEFAULT_SETTINGS('/Users/you').pr, createInstructions: '# Create a pull request\n1. Rebase on origin/main and run pnpm test\n2. Title it as a Conventional Commit\n3. Fill in summary, scope and risk', resolveInstructions: '# Resolve conflicts\n1. Rebase on origin/main\n2. Re-run pnpm test and pnpm typecheck', fixChecksInstructions: '# Fix failing checks\n1. Read the failing job log\n2. Fix the cause, not the test\n3. Push and wait for the checks', addressReviewInstructions: '# Address review comments\n1. Read every open thread\n2. Change the code or reply with a reason\n3. Push and resolve the threads' } }
/** What approvals saved with Always allow in this room. Two are long enough to clamp to two lines. */
const roomRules = [
  'pnpm test', 'pnpm typecheck',
  'gh pr view --json number,title,state,statusCheckRollup,reviewDecision,mergeable,headRefName,baseRefName,url,isDraft,mergeStateStatus,author,labels',
  'node design/canvas/source/render.mjs Settings SettingsAppearance SettingsNotifications SettingsAccount SettingsShortcuts SettingsModels SettingsPermissions SettingsGit SettingsScripts SettingsPRs',
  'for f in design/screens/Settings*.png; do sips -g pixelWidth -g pixelHeight "$f"; done | grep -v "pixelWidth: 1440" | grep -v "pixelHeight: 900"',
  'git log --oneline origin/main..HEAD'
]
const skill = (name: string): Skill => ({ name, description: '', source: 'project', enabled: true })
const mcpServers: McpServer[] = ['GitHub', 'Linear', 'Vercel', 'Figma'].map((name) => ({ name, source: 'user', enabled: true }))
const agentFile = (id: string, name: string, role: string, description: string): AgentDef => ({ id, name, role, description, lead: id === 'rowan', prompt: '', file: `.claude/agents/${id}.md`, model: id === 'rowan' || id === 'theo' ? 'opus' : 'sonnet' })
const sixAgents: AgentDef[] = [
  agentFile('rowan', 'Rowan', 'Lead', 'Plans and hands out tasks'), agentFile('kai', 'Kai', 'Frontend', 'UI work, follows DESIGN.md'),
  agentFile('noor', 'Noor', 'Backend', 'Schema, API, migrations'), agentFile('ivy', 'Ivy', 'QA', 'Runs tests, attaches output'),
  agentFile('theo', 'Theo', 'Reviewer', 'Types, security, tenancy'), agentFile('lumi', 'Lumi', 'Designer', 'Joined today')
]
const integrationRows: Integration[] = [
  { id: 'github', name: 'GitHub', connected: true, detail: 'Through the GitHub CLI as samrivera' },
  { id: 'linear', name: 'Linear', connected: false, detail: 'Create workspaces from issues' },
  { id: 'vercel', name: 'Vercel', connected: false, detail: 'Preview deployments show up in Checks' },
  { id: 'remote', name: 'Remote Control', connected: false, detail: 'Approvals and briefs from your phone' }
]

/** The same screen as `src`, drawn in the light theme (HomeLight.png, WorkspaceLight.png). */
const light = (src: Fixture): Fixture => ({ ...src, ui: { ...src.ui, theme: 'light' } })

// What's new (KERNEL-30): the canvas's four notes on a ready 0.2.0, over UpdateReady's home.
const whatsNewNotes = [
  { title: 'Checkpoints', body: 'Every turn saves the worktree. Revert any workspace to an earlier turn without losing the chat.' },
  { title: 'Pause room', body: 'Freeze every agent in a room with one click. They finish the current step, then wait.' },
  { title: 'Big terminal', body: 'Open Claude Code itself in a tab with ⌘⇧T, in the same worktree as your chats.' },
  { title: 'Overlap warnings', body: 'Rowan flags it when two agents edit the same file in different worktrees.' }
]
const whatsNew: Fixture = {
  ...teamFixtures.UpdateReady,
  update: { status: 'ready', current: '0.1.0', version: '0.2.0', notes: whatsNewNotes },
  ui: { ...teamFixtures.UpdateReady.ui, modal: { name: 'whatsNew' } }
}
// What's new opened from the sidebar with no update ready (KERNEL-154): the running 0.1.1's notes and Done. No PNG
// draws it; it reuses the layout What's new has after an update installs.
const whatsNewCurrent: Fixture = {
  ...teamFixtures.UpdateReady,
  update: {
    status: 'idle',
    current: '0.1.1',
    currentNotes: [
      { title: 'New', body: 'Hovering a workspace in the sidebar shows an archive button, so you can archive it without opening it.\nA new chat takes a short title from its first message instead of staying "New chat".' },
      { title: 'Improved', body: 'A file\'s diff opens in its own tab, so the chat stays where you left it.' },
      { title: 'Fixed', body: 'Fixed Create PR showing in a workspace with no changes.\nFixed Rowan starting a new turn right after you pressed Stop.' }
    ]
  },
  ui: { ...teamFixtures.UpdateReady.ui, modal: { name: 'whatsNew' } }
}

export const platformFixtures: Record<string, Fixture> = {
  WhatsNew: whatsNew,
  WhatsNewCurrent: whatsNewCurrent,
  // The update card in the light theme (KERNEL-164). UpdateReady shows it in dark; no PNG draws it.
  UpdateReadyLight: light(teamFixtures.UpdateReady),
  HomeLight: light(teamFixtures.Home),
  WorkspaceLight: light(workspaceFixtures.Workspace),
  // Open at login is off by default since KERNEL-57; the canvas draws it on.
  Settings: settingsPage('general', { settings: { ...DEFAULT_SETTINGS('/Users/you'), general: { ...DEFAULT_SETTINGS('/Users/you').general, openAtLogin: true } } }),
  SettingsAppearance: settingsPage('appearance'),
  SettingsNotifications: settingsPage('notifications'),
  SettingsAccount: settingsPage('account', { usage: accountUsage }),
  SettingsShortcuts: settingsPage('shortcuts'),
  SettingsModels: settingsPage('models'),
  SettingsPermissions: settingsPage('permissions', { settings: { ...DEFAULT_SETTINGS('/Users/you'), permissions: { ...DEFAULT_SETTINGS('/Users/you').permissions, neverAllow: ['git push origin main', 'curl * | sh'] } } }),
  SettingsExperimental: settingsPage('experimental'),
  SettingsAbout: settingsPage('about', { preflight: [] }),
  SettingsGit: settingsPage('git', { branches: ['origin/main', 'origin/dev', 'main'] }),
  SettingsRoomGit: roomPage('git', { ...clientA(), branches: ['origin/main', 'origin/dev', 'main'] }, 'settingsFiles'),
  SettingsRoomScripts: roomPage('scripts', clientA()),
  SettingsRoomInstructions: roomPage('instructions', clientA()),
  SettingsRoomPermissions: scene((f) => ({
    ...clientA(),
    rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, allow: roomRules } : r)),
    ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'permissions' } }
  })),
  SettingsPRs: settingsPage('prs', { settings: prSettings }),
  SettingsScripts: settingsPage('scripts'),
  SettingsFiles: roomPage('files', clientA()),
  SettingsHooks: settingsPage('hooks', { hooks: { port: 7420, listening: true, installed: true, events: hookEvents.filter((e) => e.name !== 'SessionStart') } }),
  SettingsTeam: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.roomA]: sixAgents }, ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' } } })),
  SettingsSkills: roomPage('skills', { ...clientA(), skills: ['setup', 'plan', 'feature', 'verify', 'image'].map(skill), mcp: mcpServers }),
  SettingsIntegrations: settingsPage('integrations', { integrations: integrationRows }),
  SettingsRoom: scene((f) => ({
    ...clientA({ scripts: { setup: 'pnpm install' }, linear: { team: 'KERNEL' } }),
    rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, path: '/Users/you/Projects/client-a', repo: 'cjjutba/client-a' } : r)),
    agents: { ...f.agents, [ids.roomA]: sixAgents.slice(0, 5) },
    // KERNEL-161: Linear is connected and the room has a team, so the row shows its select.
    integrations: integrationRows.map((r) => (r.id === 'linear' ? { ...r, connected: true } : r)),
    linear: { scope: { teams: [{ id: 'team-kernel', key: 'KERNEL', name: 'Kernel' }, { id: 'team-web', key: 'WEB', name: 'Web' }], projects: [], cycles: [] } },
    ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA } }
  })),
  DevUi: gallery('components'),
  DevUiDisplay: gallery('display'),
  DevUiOverlays: gallery('overlays'),
  DevUiDialogs: gallery('dialogs'),
  Welcome: scene(() => ({ ...empty, ui: { route: { name: 'onboarding', step: 'welcome' } } })),
  LoadingApp: scene((f) => ({ ...sixRunning(f), ui: { route: { name: 'onboarding', step: 'loading' } } })),
  CheckHooks: scene((f) => ({
    ...sixRunning(f),
    hooks: { port: 7420, listening: true, installed: true, events: hookEvents },
    ui: { route: { name: 'home' }, modal: { name: 'checkHooks' } }
  })),
  SetupClaudeMissing: setup(failing({ id: 'claude', ok: false, title: 'Claude Code not found', detail: 'Kernel runs your agents with Claude Code. Install it, then check again.', fix: { command: 'npm install -g @anthropic-ai/claude-code' } })),
  SetupClaudeOld: setup(failing({ id: 'claude', ok: false, title: 'Claude Code is too old', detail: 'Found v2.0.14. Agent teams need v2.1.32 and Channels need v2.1.80 or later.', meta: 'v2.0.14', fix: { command: 'claude update' } })),
  SetupTeamsOff: setup(failing({ id: 'teams', ok: false, title: 'Agent teams are off', detail: 'Kernel turns on CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS for its own sessions only.', fix: { action: 'enable-teams' } })),
  SetupGhSignedOut: setup(failing({ id: 'gh', ok: false, title: 'GitHub CLI is not signed in', detail: 'Kernel uses gh to open and merge pull requests.', fix: { command: 'gh auth login' } })),
  SetupPortBusy: setup(failing({ id: 'hooks', ok: false, title: 'Port 7420 is taken', detail: 'Another process (node, pid 4821) is using it. Kernel can listen on 7421 and update your hooks.', fix: { action: 'use-next-port' } })),
  // KERNEL-28: failure banners. Each one is the state main would push: usage, account, network, retry, setup, hooks.
  WorkspaceSessionLimit: scene(() => ({ usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }], ui: open })),
  WorkspaceWeeklyLimit: scene(() => ({ usage: [{ type: 'seven_day', status: 'rejected', utilization: 1, resetsAt: secs(nextMonday()) }], ui: open })),
  // Fable has no window name of its own in rate_limit_event, so the fixture tags a per-model window with the model.
  WorkspaceModelLimit: scene((f) => ({
    chats: withChat(f, { model: 'claude-fable-5-1' }),
    usage: [{ type: 'seven_day_opus', status: 'rejected', utilization: 1, resetsAt: secs(Date.now() + 3 * 24 * 3600_000 - 3600_000), model: 'claude-fable-5-1' }],
    ui: open
  })),
  WorkspaceContext: scene((f) => ({ chats: withChat(f, { context: 92 }), ui: open })),
  // The retry is between attempts, so the turn shows as the canvas draws it: no Stop button.
  WorkspaceOverloaded: scene((f) => ({
    items: { [ids.tableChat]: [...tableItems, { kind: 'user', id: 'u-shorten', ts: at(10, 40), parts: [{ type: 'text', text: 'Shorten the empty state copy.' }] }] },
    push: [...f.push, { type: 'retry', chatId: ids.tableChat, retry: { attempt: 2, of: 5, nextAt: Date.now() + 14_000 } }],
    ui: open
  })),
  WorkspaceOffline: scene((f) => {
    const queue = [{ id: 'q-offline', chatId: ids.tableChat, parts: [{ type: 'text' as const, text: 'Also add a loading skeleton.' }], ts: at(10, 40) }]
    // The queue's note comes from the reason the engine pushes with it (KERNEL-273).
    return {
      queue: { [ids.tableChat]: queue },
      push: [...f.push, { type: 'online', online: false }, { type: 'chat.queue', chatId: ids.tableChat, queue, why: 'offline' }],
      ui: open
    }
  }),
  // Main keeps the last name it read when a session reports the sign-out, so the account menu still says who.
  WorkspaceSignedOut: scene(() => ({ account: { signedIn: false, name: 'Sam Rivera', login: 'samrivera', plan: 'Claude Max' }, ui: open })),
  WorkspaceSetupFailed: scene((f) => ({
    ...clientA({ scripts: { ...kernelFiles.scripts, setup: 'pnpm install --frozen-lockfile' } }),
    workspaces: withWorkspace(f, ids.table, { status: 'failed' }),
    items: {},
    push: [
      ...f.push,
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', line: '$ pnpm install --frozen-lockfile', stream: 'stdout' },
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', line: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date', stream: 'stderr' },
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', line: 'Setup failed with exit code 1', stream: 'stderr' },
      { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 1 }
    ],
    ui: { ...open, workspace: { right: 'files', bottom: 'setup', checkpoints: false, toolsOpen: false } }
  })),
  WorkspaceHooksDown: scene(() => ({ hooks: { port: 7420, listening: false, installed: true, events: hookEvents }, ui: open })),
  ConfirmArchive: scene((f) => ({
    gitStatus: { [ids.table]: { branch: 'feat/t-14-invoice-table', ahead: 2, behind: 0, dirty: { files: 0, added: 0, removed: 0 } } },
    push: f.push,
    ui: { ...open, modal: { name: 'confirm', kind: 'archive', workspaceId: ids.table } }
  })),
  ConfirmDiscard: scene(() => ({ ui: { ...open, modal: { name: 'confirm', kind: 'discard', workspaceId: ids.table } } }))
}
