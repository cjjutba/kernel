import type { PreflightCheck } from '@shared/types'
import type { Fixture } from './types'
import { at, base, ids, scene, withWorkspace } from './base'

// Platform lane: setup checks (KERNEL-27), limits and setup failures (KERNEL-28).
// Check copy matches src/main/services/preflight.ts.

const onboarding = { route: { name: 'onboarding', step: 'checks' } } as const
const open = { route: { name: 'workspace', workspaceId: ids.table } } as const
const [claudeOk, ghOk, hooksOk] = base.preflight

const setup = (checks: PreflightCheck[]) => scene(() => ({
  rooms: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [],
  preflight: checks, ui: onboarding
}))

// KERNEL-9: the component gallery in both themes. `stage` routes to it in src/renderer/src/main.tsx. No design PNG, so no compare.
const gallery = (stage: string) => scene(() => ({ rooms: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [], ui: { stage } }))

export const platformFixtures: Record<string, Fixture> = {
  DevUi: gallery('dev/ui'),
  DevUiDisplay: gallery('dev/ui:display'),
  DevUiOverlays: gallery('dev/ui:overlays'),
  DevUiDialogs: gallery('dev/ui:dialogs'),
  SetupClaudeMissing: setup([{ id: 'claude', ok: false, title: 'Claude Code not found', detail: 'Kernel runs your agents with Claude Code. Install it, then check again.', fix: { command: 'npm install -g @anthropic-ai/claude-code' } }, ghOk, hooksOk]),
  SetupClaudeOld: setup([{ id: 'claude', ok: false, title: 'Claude Code is too old', detail: 'Found v2.0.14. Kernel needs v2.1.80 or later.', fix: { command: 'claude update' } }, ghOk, hooksOk]),
  SetupGhSignedOut: setup([claudeOk, { id: 'gh', ok: false, title: 'GitHub CLI is not signed in', detail: 'Kernel uses gh to open and merge pull requests.', fix: { command: 'gh auth login' } }, hooksOk]),
  SetupPortBusy: setup([claudeOk, ghOk, { id: 'hooks', ok: false, title: 'Port 7420 is taken', detail: 'Another process is using it. Kernel can listen on the next port and update your hooks.', fix: { action: 'use-next-port' } }]),
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
