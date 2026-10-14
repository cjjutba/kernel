import type { RoomSettingsSection, SettingsPage } from '@shared/types'
import type { IconName } from '../../icons'

/**
 * The Settings pages, one list for the Settings sidebar, its search and the command palette (KERNEL-680). `keywords` are the names
 * of the settings on the page, so a search for "quiet hours" finds Notifications.
 */
export interface NavPage { page: SettingsPage; label: string; icon: IconName; keywords: string[] }
export interface NavGroup { title: string; items: NavPage[] }

export const NAV: NavGroup[] = [
  { title: 'Personal', items: [
    { page: 'general', label: 'General', icon: 'sliders', keywords: ['open at login', 'open to', 'send with', 'composer', 'startup'] },
    { page: 'appearance', label: 'Appearance', icon: 'half', keywords: ['theme', 'dark', 'light', 'font size', 'density', 'reduce motion', 'pointer cursors'] },
    { page: 'notifications', label: 'Notifications', icon: 'bell', keywords: ['needs you', 'approvals', 'sound', 'quiet hours', 'updates'] },
    { page: 'accounts', label: 'Accounts', icon: 'user', keywords: ['usage', 'limits', 'providers', 'claude code', 'codex', 'sign in', 'sign out', 'add account', 'api key', 'switch at a limit'] },
    { page: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', keywords: ['keyboard', 'keys', 'hotkeys'] }
  ] },
  { title: 'Agents', items: [
    { page: 'models', label: 'Models and effort', icon: 'chip', keywords: ['model', 'effort', 'compact', 'lead', 'reviewer', 'planning', 'agents at once', 'agent teams'] },
    { page: 'agents', label: 'Agents', icon: 'team', keywords: ['personal agents', 'plugins', 'new rooms start with', 'default team'] },
    { page: 'mcp', label: 'MCP servers', icon: 'layers', keywords: ['mcp', 'servers', 'connectors', 'sign in'] },
    { page: 'permissions', label: 'Permissions', icon: 'shield', keywords: ['mode', 'bypass', 'always ask', 'never allow', 'protected branches', 'network', 'approval timeout'] },
    { page: 'env', label: 'Environment', icon: 'env', keywords: ['variables', 'env', 'secrets'] }
  ] },
  { title: 'Workspaces', items: [
    { page: 'git', label: 'Git and worktrees', icon: 'branch', keywords: ['worktrees', 'branch names', 'setup script', 'archive script', 'cleanup', 'scripts'] },
    { page: 'prs', label: 'Pull requests', icon: 'pr', keywords: ['merge', 'auto merge', 'reviews', 'instructions', 'paths you always review', 'size limit'] },
    { page: 'bigterm', label: 'Big terminal', icon: 'bigterm', keywords: ['terminal', 'presets', 'tabs'] }
  ] },
  { title: 'System', items: [
    { page: 'integrations', label: 'Integrations', icon: 'link', keywords: ['github', 'linear', 'jira', 'connect'] },
    { page: 'hooks', label: 'Hooks', icon: 'plug', keywords: ['hook server', 'port', 'test event', 'settings.json'] },
    { page: 'privacy', label: 'Privacy', icon: 'lock', keywords: ['diagnostics', 'telemetry', 'events'] },
    { page: 'about', label: 'About', icon: 'info', keywords: ['version', 'updates', 'data folder', 'logs', 'onboarding'] }
  ] }
]

export const NAV_PAGES: NavPage[] = NAV.flatMap((g) => g.items)

/** A room's pages, in order. `section` is the route's, and a route without one opens General. */
export interface RoomNavPage { section: RoomSettingsSection; label: string; icon: IconName; keywords: string[] }

export const ROOM_PAGES: RoomNavPage[] = [
  { section: 'general', label: 'General', icon: 'sliders', keywords: ['icon', 'repository', 'path', 'tracker', 'linear team', 'archive room'] },
  { section: 'git', label: 'Git', icon: 'branch', keywords: ['push access', 'base branch', 'branch names', 'remote'] },
  { section: 'setup', label: 'Setup and scripts', icon: 'term', keywords: ['files to copy', 'setup script', 'archive script', 'run scripts', 'ports', 'preview urls'] },
  { section: 'environment', label: 'Environment', icon: 'env', keywords: ['variables', 'env files'] },
  { section: 'agents', label: 'Agents', icon: 'team', keywords: ['lead', 'reviewer', 'repo agents', 'retired'] },
  { section: 'prs', label: 'Pull requests', icon: 'pr', keywords: ['reviews', 'instructions', 'merge method', 'optional checks', 'stop after'] },
  { section: 'permissions', label: 'Permissions', icon: 'shield', keywords: ['mode', 'always allowed', 'commands', 'tools'] },
  { section: 'skills', label: 'Skills and MCP', icon: 'plug', keywords: ['skills', 'mcp servers'] }
]

/** Does a page's name or one of its settings match the search? Empty matches everything. */
export function navMatch(q: string, label: string, keywords: string[] = []): boolean {
  const n = q.trim().toLowerCase()
  return !n || label.toLowerCase().includes(n) || keywords.some((k) => k.includes(n))
}
