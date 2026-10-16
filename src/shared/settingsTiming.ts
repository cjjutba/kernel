import type { ProjectSettings } from './types'

/**
 * When a settings change reaches Kernel and its agents (KERNEL-724). `now`: main reads the value each time it acts, so the
 * next tool call, send, merge or archive uses it. `nextTurn`: a running chat's process restarts, an idle one at once and a
 * busy one when its turn ends. `newChats`: main reads it when a chat starts, or when a chat's process starts, so a running
 * chat keeps the old value until its process ends (a 10 minute idle stop, a restart or an account switch). `newWorkspaces`:
 * main reads it when a workspace is made. `newProjects`: the renderer reads it when a project is added. `restart`: read once when
 * Kernel starts.
 */
export type SettingTiming = 'now' | 'nextTurn' | 'newChats' | 'newWorkspaces' | 'newProjects' | 'restart'

/**
 * App settings by dotted path. An entry covers every key under it (`models.roles` covers `models.roles.lead.model`).
 * test/settingsTiming.test.ts fails when a key of `DEFAULT_SETTINGS` has none.
 */
export const APP_SETTING_TIMING: Record<string, SettingTiming> = {
  // features/hooks.ts listens on it once, in start().
  hookPort: 'restart',
  // projectWorktreeRoot() in features/workspaces.ts, when a worktree is made.
  worktreeRoot: 'newWorkspaces',
  // store.ts picks the first route from it when the window opens.
  'general.openTo': 'restart',
  'general.openAtLogin': 'now',
  'general.sendWith': 'now',
  'appearance.theme': 'now',
  'appearance.fontSize': 'now',
  'appearance.density': 'now',
  'appearance.pointerCursors': 'now',
  'appearance.reduceMotion': 'now',
  'notifications.permission': 'now',
  'notifications.plan': 'now',
  'notifications.merge': 'now',
  'notifications.checkFailed': 'now',
  'notifications.finished': 'now',
  'notifications.idle': 'now',
  'notifications.sound': 'now',
  'notifications.quietHours': 'now',
  // features/account.ts, on each usage reading.
  'usage.warnBeforeWeekly': 'now',
  // nearLimitHolds() in services/sessions.ts, before each send.
  'usage.pauseNearLimit': 'now',
  // switchAtLimit() in features/account.ts, on each usage reading.
  'accounts.switchAtLimit': 'now',
  // features/placement.ts, as a turn starts and when a switch is previewed (KERNEL-841).
  'accounts.keepChatsOnAccount': 'now',
  'accounts.longChatMove': 'now',
  'accounts.longChatTokens': 'now',
  // createWorkspace() in features/workspaces.ts.
  'workspace.mode': 'newWorkspaces',
  'workspace.baseRef': 'newWorkspaces',
  // remoteFor() in features/config.ts, on each fetch and push.
  'workspace.remote': 'now',
  'workspace.branchPattern': 'newWorkspaces',
  // features/archive.ts, when a workspace is archived.
  'workspace.deleteBranchOnArchive': 'now',
  // features/autoArchive.ts, when a PR merges.
  'workspace.archiveOnMerge': 'now',
  'workspace.baselineCurrentBranch': 'newWorkspaces',
  'workspace.oneCurrentBranchPerProject': 'newWorkspaces',
  // The branch a new Lead chat starts on, in features/workspaces.ts and features/lead.ts.
  'workspace.leadBranchPattern': 'newChats',
  // features/lead.ts, when a Lead chat starts.
  'workspace.leadWaitForSetup': 'newChats',
  // features/lead.ts, when a Lead chat is archived.
  'workspace.archiveChatWorkspaces': 'now',
  // features/setup.ts, when a workspace is made.
  'scripts.setupOnCreate': 'newWorkspaces',
  'scripts.runAfterSetup': 'newWorkspaces',
  // features/archive.ts, when a workspace is archived.
  'scripts.archiveOnArchive': 'now',
  // scriptTimeout() in services/scripts.ts, when a script starts.
  'scripts.timeoutMinutes': 'now',
  // A chat's model and effort are picked when it is made (features/chats.ts, features/lead.ts).
  'models.roles': 'newChats',
  // Lead chats made from then on start in plan mode (features/lead.ts).
  'models.leadPlanMode': 'newChats',
  // sessionEnv() in services/providers/claude.ts, when a chat's process starts.
  'models.agentTeams': 'newChats',
  // applySettings() in services/sessions.ts restarts Claude's processes.
  'models.compact': 'nextTurn',
  // atCapacity() in services/sessions.ts, before each send.
  'models.agentLimit': 'now',
  // features/wiring.ts, on each Team update.
  'models.leadUpdates': 'now',
  // workspaces.create in features/workspaces.ts.
  'models.workspacePlanMode': 'newWorkspaces',
  // effortFor() in features/chats.ts, when a chat is made.
  'models.effortByModel': 'newChats',
  // setPath() in features/providers.ts restarts the provider's processes.
  'providers.claude': 'nextTurn',
  'providers.codex.path': 'nextTurn',
  'providers.codex.useSystem': 'nextTurn',
  // The Codex runner passes it to thread/start and thread/resume, when a chat's process starts.
  'providers.codex.personality': 'newChats',
  // The renderer seeds a new project's agents with it (screens/projects/draft.ts).
  'team.defaultTemplate': 'newProjects',
  // newLeadChat() in features/lead.ts, when a chat with Kernel starts. Open chats keep their mode (KERNEL-770).
  'team.leadMode': 'newChats',
  // applyModes() in services/sessions.ts moves live sessions. Crossing into or out of Bypass restarts the process after its turn,
  // and it runs in the stricter mode until then.
  'permissions.mode': 'now',
  'permissions.bypassOnlyInWorktrees': 'now',
  // services/permissions.ts reads the rules on each tool call.
  'permissions.network': 'now',
  'permissions.alwaysAsk': 'now',
  'permissions.neverAllow': 'now',
  'permissions.protectedBranches': 'now',
  // The hook server reads it per request, and setSettings() rewrites the installed hooks.
  'permissions.approvalTimeoutSec': 'now',
  // features/codeHost.ts, on each merge.
  'pr.mergeMethod': 'now',
  // features/prs.ts, when Create PR is sent.
  'pr.draft': 'now',
  // features/prs.ts, on each merge.
  'pr.requireGreen': 'now',
  'pr.requireReviewer': 'now',
  // features/reviews.ts, when a PR passes checks.
  'pr.autoReview': 'now',
  // features/lead.ts, on each merge_workspace call.
  'pr.leadMerge': 'now',
  // features/prs.ts, on each PR change.
  'pr.autoMerge': 'now',
  // prInstructions() in features/prs.ts, when the action is sent.
  'pr.createInstructions': 'now',
  'pr.resolveInstructions': 'now',
  'pr.fixChecksInstructions': 'now',
  'pr.addressReviewInstructions': 'now',
  // teamGates() in services/providers/claude.ts, on each hook.
  'hooks.requireTestOutput': 'now',
  'hooks.keepTeammatesWorking': 'now',
  'terminal.enabled': 'now',
  // resolvePreset() in services/terminalPresets.ts, when a tab opens.
  'terminal.preset': 'newChats',
  'terminal.onlyInWorktrees': 'newChats',
  'terminal.connect': 'newChats',
  'terminal.custom': 'now',
  // features/tools.ts adds share_file to the tools a chat's process starts with.
  'experimental.sharing': 'newChats',
  'privacy.telemetry': 'now'
}

type Project = Omit<Required<ProjectSettings>, 'sources' | 'missingReferences'>

/** Every project setting by dotted path: a list or table of names by its own key, the rest one level down (`pr.mergeMethod`). */
export type ProjectSettingPath = {
  [G in keyof Project]: NonNullable<Project[G]> extends readonly unknown[] ? G : `${G}.${Extract<keyof NonNullable<Project[G]>, string>}`
}[keyof Project]

/**
 * Project settings by dotted path. Main reads `.kernel/settings.toml` and `settings.local.toml` from disk each time it uses
 * them, so a project value has the timing of the code that reads it. `pnpm typecheck` fails when a path has no entry.
 */
export const PROJECT_SETTING_TIMING: Record<ProjectSettingPath, SettingTiming> = {
  // features/setup.ts runs it when a workspace is made.
  'scripts.setup': 'newWorkspaces',
  'scripts.run': 'now',
  'scripts.archive': 'now',
  'scripts.runMode': 'now',
  runScripts: 'now',
  // features/setup.ts copies and links files when a workspace is made.
  'files.copy': 'newWorkspaces',
  'files.exclude': 'newWorkspaces',
  'files.symlinkNodeModules': 'newWorkspaces',
  'workspace.mode': 'newWorkspaces',
  'workspace.baseRef': 'newWorkspaces',
  'workspace.remote': 'now',
  'workspace.branchPattern': 'newWorkspaces',
  'workspace.deleteBranchOnArchive': 'now',
  'workspace.archiveOnMerge': 'now',
  'workspace.baselineCurrentBranch': 'newWorkspaces',
  'workspace.oneCurrentBranchPerProject': 'newWorkspaces',
  'workspace.leadBranchPattern': 'newChats',
  'workspace.leadWaitForSetup': 'newChats',
  'workspace.archiveChatWorkspaces': 'now',
  // disabledFor() in features/sessionDeps.ts, when a chat's process starts.
  'disabled.skills': 'newChats',
  'disabled.mcp': 'newChats',
  'linear.team': 'now',
  // features/integrations.ts builds the tracker on each call.
  'tracker.kind': 'now',
  'pr.createInstructions': 'now',
  'pr.resolveInstructions': 'now',
  'pr.fixChecksInstructions': 'now',
  'pr.addressReviewInstructions': 'now',
  'pr.optionalChecks': 'now',
  'pr.mergeMethod': 'now',
  // aliasesFor() in features/sessionDeps.ts, when a chat's process starts.
  'mcp.aliases': 'newChats',
  // accessFor() in features/sessionDeps.ts, when a chat's process starts.
  'agents.unlistedTools': 'newChats',
  'agents.allow': 'newChats',
  // features/lead.ts, on each hand-off.
  'agents.openWorkspaces': 'now',
  // newLeadChat() in features/lead.ts, when a chat with Kernel starts (KERNEL-770).
  'agents.leadMode': 'newChats',
  'preview.urls': 'now',
  // envFor() in features/env.ts builds a chat's env when its process starts. Scripts read it when they start.
  'env.files': 'newChats',
  // referencesFor() in features/sessionDeps.ts, when a chat's process starts. The @ menu reads them on each search.
  references: 'newChats',
  // features/team.ts reads the roster each time it lists the team.
  'team.lead': 'now',
  'team.reviewer': 'now',
  'team.members': 'now',
  'team.helpers': 'now',
  'team.roster': 'now',
  // features/reviews.ts reads it from the PR's base branch when reviews start.
  'review.rounds': 'now',
  'review.kinds': 'now',
  // features/prs.ts, on each auto-merge check.
  'merge.alwaysReview': 'now'
}
