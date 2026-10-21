import type { ProjectSettingsSection, SettingsPage } from '@shared/types'
import type { IconName } from '../../icons'

/**
 * The Settings pages, one list for the Settings sidebar, its search and the command palette (KERNEL-680). `terms` are other words that find the page itself ("keyboard" finds Shortcuts), with no row to land on. `keywords` are the settings on the page: `label` is what a search matches and shows, and `rowId` is the `id` of the row it lands on (KERNEL-727).
 * A search for "quiet hours" finds that row on Notifications, and a test checks every `rowId` has a row.
 */
export interface Keyword { label: string; rowId: string }
export interface NavPage { page: SettingsPage; label: string; icon: IconName; keywords: Keyword[]; terms: string[] }
export interface NavGroup { title: string; items: NavPage[] }

export const NAV: NavGroup[] = [
  { title: 'Personal', items: [
    { page: 'general', label: 'General', icon: 'sliders', keywords: [{ label: 'Open at login', rowId: 'open-at-login' }, { label: 'Open to', rowId: 'open-to' }, { label: 'Send with', rowId: 'send-with' }], terms: ['open at login', 'open to', 'send with', 'composer', 'startup'] },
    { page: 'appearance', label: 'Appearance', icon: 'half', keywords: [{ label: 'Theme', rowId: 'theme' }, { label: 'Font size', rowId: 'font-size' }, { label: 'Density', rowId: 'density' }, { label: 'Tool calls', rowId: 'tool-calls' }, { label: 'Reduce motion', rowId: 'reduce-motion' }, { label: 'Pointer cursors', rowId: 'pointer-cursors' }], terms: ['theme', 'dark', 'light', 'font size', 'density', 'tool calls', 'steps', 'fold', 'reduce motion', 'pointer cursors'] },
    { page: 'notifications', label: 'Notifications', icon: 'bell', keywords: [{ label: 'Permission requests', rowId: 'notify-permission' }, { label: 'Plan ready for review', rowId: 'notify-plan' }, { label: 'Pull request ready to merge', rowId: 'notify-merge' }, { label: 'Failed checks', rowId: 'notify-checkFailed' }, { label: 'Workspace finished', rowId: 'notify-finished' }, { label: 'Agent idle', rowId: 'notify-idle' }, { label: 'Sound', rowId: 'sound' }, { label: 'Quiet hours', rowId: 'quiet-hours' }], terms: ['needs you', 'approvals', 'sound', 'quiet hours', 'updates'] },
    { page: 'accounts', label: 'Accounts', icon: 'user', keywords: [{ label: 'Switch accounts at a limit', rowId: 'switch-at-limit' }, { label: 'Pause new work near a limit', rowId: 'pause-near-limit' }, { label: 'Weekly limit warning', rowId: 'weekly-limit-warning' }], terms: ['usage', 'limits', 'providers', 'claude code', 'codex', 'sign in', 'sign out', 'add account', 'api key', 'switch at a limit'] },
    { page: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', keywords: [], terms: ['keyboard', 'keys', 'hotkeys'] }
  ] },
  { title: 'Agents', items: [
    { page: 'models', label: 'Models and effort', icon: 'chip', keywords: [{ label: 'Kernel starts in plan mode', rowId: 'lead-plan-mode' }, { label: 'New workspaces start in plan mode', rowId: 'workspace-plan-mode' }, { label: 'Agents working at once', rowId: 'agent-limit' }, { label: 'Keep Kernel updated', rowId: 'lead-updates' }, { label: 'Agent teams', rowId: 'agent-teams' }], terms: ['model', 'effort', 'compact', 'lead', 'kernel', 'reviewer', 'planning', 'agents at once', 'agent teams'] },
    { page: 'agents', label: 'Agents', icon: 'team', keywords: [{ label: 'New projects start with', rowId: 'new-projects-team' }], terms: ['personal agents', 'plugins', 'new projects start with', 'default team'] },
    { page: 'mcp', label: 'MCP servers', icon: 'layers', keywords: [], terms: ['mcp', 'servers', 'connectors', 'sign in'] },
    { page: 'permissions', label: 'Permissions', icon: 'shield', keywords: [{ label: 'Permission mode', rowId: 'mode' }, { label: 'Always ask before', rowId: 'always-ask' }, { label: 'Never allow', rowId: 'never-allow' }, { label: 'Protected branches', rowId: 'protected-branches' }, { label: 'Allow network access', rowId: 'network' }, { label: 'Approval timeout', rowId: 'approval-timeout' }], terms: ['mode', 'bypass', 'always ask', 'never allow', 'protected branches', 'network', 'approval timeout'] },
    { page: 'env', label: 'Environment', icon: 'env', keywords: [], terms: ['variables', 'env', 'secrets'] }
  ] },
  { title: 'Workspaces', items: [
    { page: 'git', label: 'Git and worktrees', icon: 'branch', keywords: [{ label: 'Workspace type', rowId: 'workspace-type' }, { label: 'Branch from', rowId: 'branch-from' }, { label: 'Remote', rowId: 'remote' }, { label: 'Worktree location', rowId: 'worktree-location' }, { label: 'Workspace branch names', rowId: 'branch-names' }, { label: 'Branch names for chats with Kernel', rowId: 'lead-branch-names' }, { label: 'Run setup when a workspace is created', rowId: 'run-setup' }, { label: 'Run the archive script on archive', rowId: 'run-archive' }, { label: 'Stop setup and archive scripts after', rowId: 'script-timeout' }, { label: 'Delete the branch on archive', rowId: 'delete-branch' }, { label: 'Archive on merge', rowId: 'archive-on-merge' }], terms: ['worktrees', 'branch names', 'setup script', 'archive script', 'cleanup', 'scripts'] },
    { page: 'prs', label: 'Pull requests', icon: 'pr', keywords: [{ label: 'Merge without asking me', rowId: 'merge-without-asking' }, { label: 'Merge without a review', rowId: 'merge-without-review' }, { label: 'Size limit', rowId: 'size-limit' }, { label: 'Paths you always review', rowId: 'always-review' }, { label: 'Merge method', rowId: 'merge-method' }, { label: 'Review every pull request automatically', rowId: 'auto-review' }, { label: 'Create PR instructions', rowId: 'instructions-create' }, { label: 'Resolve conflicts instructions', rowId: 'instructions-resolve' }, { label: 'Fix checks instructions', rowId: 'instructions-fixChecks' }, { label: 'Address review instructions', rowId: 'instructions-addressReview' }], terms: ['merge', 'auto merge', 'reviews', 'instructions', 'paths you always review', 'size limit'] },
    { page: 'bigterm', label: 'Big terminal', icon: 'term', keywords: [{ label: 'Big terminal tab', rowId: 'big-terminal-tab' }, { label: 'Terminal tabs only in worktrees', rowId: 'terminal-only-worktrees' }], terms: ['terminal', 'presets', 'tabs'] }
  ] },
  { title: 'System', items: [
    { page: 'integrations', label: 'Integrations', icon: 'link', keywords: [{ label: 'GitHub', rowId: 'github' }, { label: 'Linear', rowId: 'linear' }], terms: ['github', 'linear', 'connect'] },
    { page: 'hooks', label: 'Hooks', icon: 'plug', keywords: [{ label: 'Kernel’s hooks', rowId: 'kernel-hooks' }, { label: 'Settings file', rowId: 'settings-file' }, { label: 'Hook server port', rowId: 'hook-port' }], terms: ['hook server', 'port', 'test event', 'settings.json'] },
    { page: 'remote', label: 'Remote access', icon: 'link', keywords: [{ label: 'Let other devices connect', rowId: 'remote-enabled' }, { label: 'Who can reach Kernel remotely', rowId: 'remote-host' }, { label: 'Remote address', rowId: 'remote-url' }], terms: ['remote', 'phone', 'browser', 'pair', 'pairing', 'qr code', 'devices', 'network'] },
    { page: 'privacy', label: 'Privacy', icon: 'lock', keywords: [{ label: 'Share diagnostics', rowId: 'diagnostics' }], terms: ['diagnostics', 'telemetry', 'events'] },
    { page: 'about', label: 'About', icon: 'info', keywords: [{ label: 'Data folder', rowId: 'data-folder' }, { label: 'Logs', rowId: 'logs' }, { label: 'Onboarding', rowId: 'onboarding' }], terms: ['version', 'updates', 'data folder', 'logs', 'onboarding'] }
  ] }
]

export const NAV_PAGES: NavPage[] = NAV.flatMap((g) => g.items)

/** A project's pages, in order. `section` is the route's, and a route without one opens General. */
export interface ProjectNavPage { section: ProjectSettingsSection; label: string; icon: IconName; keywords: Keyword[]; terms: string[] }

export const PROJECT_PAGES: ProjectNavPage[] = [
  { section: 'general', label: 'General', icon: 'sliders', keywords: [{ label: 'Icon', rowId: 'icon' }, { label: 'Repository', rowId: 'repository' }, { label: 'Local path', rowId: 'path' }, { label: 'Issue tracker', rowId: 'tracker' }, { label: 'Linear team', rowId: 'linear-team' }, { label: 'Archive project', rowId: 'archive-project' }], terms: ['icon', 'repository', 'path', 'tracker', 'linear team', 'archive project'] },
  { section: 'git', label: 'Git', icon: 'branch', keywords: [{ label: 'Workspace type', rowId: 'workspace-type' }, { label: 'Branch from', rowId: 'branch-from' }, { label: 'Remote', rowId: 'remote' }, { label: 'Branch names for chats with Kernel', rowId: 'lead-branch-names' }], terms: ['push access', 'base branch', 'branch names', 'remote'] },
  { section: 'setup', label: 'Scripts', icon: 'term', keywords: [{ label: 'Setup script', rowId: 'script-setup' }, { label: 'Archive script', rowId: 'script-archive' }, { label: 'Run scripts', rowId: 'run-scripts' }, { label: 'Run mode', rowId: 'run-mode' }, { label: 'Ports', rowId: 'ports' }, { label: 'Preview URLs', rowId: 'preview-urls' }], terms: ['setup script', 'archive script', 'run scripts', 'ports', 'preview urls'] },
  { section: 'environment', label: 'Environment', icon: 'env', keywords: [{ label: 'Files to copy', rowId: 'copy-files' }, { label: 'Never copied', rowId: 'never-copied' }, { label: 'Symlink node_modules', rowId: 'symlink-node-modules' }], terms: ['variables', 'env files', 'gitignored files', 'copy files'] },
  { section: 'agents', label: 'Agents', icon: 'team', keywords: [{ label: 'Kernel', rowId: 'lead' }, { label: 'Reviewer', rowId: 'reviewer' }, { label: 'Open workspaces', rowId: 'open-workspaces' }, { label: 'Mode', rowId: 'mode' }, { label: 'Commands always allowed', rowId: 'commands' }, { label: 'Tools always allowed', rowId: 'tools' }], terms: ['lead', 'reviewer', 'repo agents', 'retired', 'permissions', 'always allowed', 'commands', 'tools', 'skills', 'mcp servers'] },
  { section: 'prs', label: 'Pull requests', icon: 'pr', keywords: [{ label: 'Stop after', rowId: 'stop-after' }, { label: 'Paths you always review', rowId: 'always-review' }, { label: 'Optional checks', rowId: 'optional-checks' }, { label: 'Merge method', rowId: 'merge-method' }, { label: 'Create PR instructions', rowId: 'instructions-create' }, { label: 'Resolve conflicts instructions', rowId: 'instructions-resolve' }, { label: 'Fix checks instructions', rowId: 'instructions-fixChecks' }, { label: 'Address review instructions', rowId: 'instructions-addressReview' }], terms: ['reviews', 'instructions', 'merge method', 'optional checks', 'stop after'] }
]

/** Does a page's name or one of its settings match the search? Empty matches everything. */
export function navMatch(q: string, label: string, keywords: Keyword[] = [], terms: string[] = []): boolean {
  const n = q.trim().toLowerCase()
  return !n || label.toLowerCase().includes(n) || keywords.some((k) => k.label.toLowerCase().includes(n)) || terms.some((t) => t.includes(n))
}

/** The settings on a page that the search names, in the page's order. None for an empty search. */
export function keywordHits(q: string, keywords: Keyword[] = []): Keyword[] {
  const n = q.trim().toLowerCase()
  return n ? keywords.filter((k) => k.label.toLowerCase().includes(n)) : []
}
