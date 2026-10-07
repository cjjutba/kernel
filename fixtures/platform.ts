import type { DevUiPage, HookStatus, PreflightCheck, RateLimit, SettingsPage } from '@shared/types'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import type { Fixture } from './types'
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
const ghOk: PreflightCheck = { id: 'gh', ok: true, title: 'GitHub CLI', detail: 'Signed in as cjjutba', meta: 'gh 2.62' }
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
const accountUsage: RateLimit[] = [
  { type: 'five_hour', status: 'allowed', utilization: 0.62, resetsAt: secs(next(15, 40)) },
  { type: 'seven_day', status: 'allowed', utilization: 0.38, resetsAt: secs(nextMonday()) },
  { type: 'seven_day_opus', status: 'allowed_warning', utilization: 0.9, resetsAt: secs(nextMonday()), model: 'claude-fable-5-1' }
]

export const platformFixtures: Record<string, Fixture> = {
  Settings: settingsPage('general'),
  SettingsAppearance: settingsPage('appearance'),
  SettingsNotifications: settingsPage('notifications'),
  SettingsAccount: settingsPage('account', { usage: accountUsage }),
  SettingsShortcuts: settingsPage('shortcuts'),
  SettingsModels: settingsPage('models'),
  SettingsPermissions: settingsPage('permissions', { settings: { ...DEFAULT_SETTINGS('/Users/cj'), permissions: { ...DEFAULT_SETTINGS('/Users/cj').permissions, neverAllow: ['git push origin main', 'curl * | sh'] } } }),
  SettingsExperimental: settingsPage('experimental'),
  SettingsAbout: settingsPage('about', { preflight: [] }),
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
  WorkspaceOffline: scene((f) => ({
    queue: { [ids.tableChat]: [{ id: 'q-offline', chatId: ids.tableChat, parts: [{ type: 'text', text: 'Also add a loading skeleton.' }], ts: at(10, 40) }] },
    push: [...f.push, { type: 'online', online: false }],
    ui: open
  })),
  // Main keeps the last name it read when a session reports the sign-out, so the account menu still says who.
  WorkspaceSignedOut: scene(() => ({ account: { signedIn: false, name: 'CJ Jutba', login: 'cjjutba', plan: 'Claude Max' }, ui: open })),
  WorkspaceSetupFailed: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { status: 'failed' }),
    items: {},
    push: [
      ...f.push,
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', line: '$ pnpm install --frozen-lockfile', stream: 'stdout' },
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', line: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date', stream: 'stderr' },
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', line: 'Setup failed with exit code 1', stream: 'stderr' },
      { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 1 }
    ],
    ui: { ...open, workspace: { right: 'files', bottom: 'setup', focus: false, checkpoints: false, toolsOpen: false } }
  })),
  WorkspaceHooksDown: scene(() => ({ hooks: { port: 7420, listening: false, installed: true, events: hookEvents }, ui: open })),
  ConfirmArchive: scene((f) => ({
    gitStatus: { [ids.table]: { branch: 'feat/t-14-invoice-table', ahead: 2, behind: 0, dirty: { files: 0, added: 0, removed: 0 } } },
    push: f.push,
    ui: { ...open, modal: { name: 'confirm', kind: 'archive', workspaceId: ids.table } }
  })),
  ConfirmDiscard: scene(() => ({ ui: { ...open, modal: { name: 'confirm', kind: 'discard', workspaceId: ids.table } } }))
}
