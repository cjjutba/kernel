import type { DevUiPage, HookStatus, PreflightCheck } from '@shared/types'
import type { Fixture } from './types'
import { at, base, ids, scene, withWorkspace } from './base'

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

// KERNEL-9: the component gallery in both themes. the `devUi` route shows it. No design PNG, so no compare.
const gallery = (page: DevUiPage) => scene(() => ({ ...empty, ui: { route: { name: 'devUi', page } } }))

export const platformFixtures: Record<string, Fixture> = {
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
  WorkspaceSessionLimit: scene(() => ({ usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: at(13, 0) }], ui: open })),
  WorkspaceWeeklyLimit: scene(() => ({ usage: [{ type: 'seven_day', status: 'rejected', utilization: 1, resetsAt: new Date(2026, 9, 9, 9, 0).getTime() }], ui: open })),
  WorkspaceSetupFailed: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { status: 'failed' }),
    items: {},
    changes: {},
    push: [
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', line: '$ pnpm install', stream: 'stdout' },
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', line: 'ERR_PNPM_NO_MATCHING_VERSION No matching version found for @acme/ui@^4.2.0', stream: 'stderr' },
      { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 1 }
    ],
    ui: open
  }))
}
