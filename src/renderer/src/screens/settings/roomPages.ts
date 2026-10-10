import type { RoomSettingsSection } from '@shared/types'

/**
 * A room's pages in the Settings nav, in order. Environment (KERNEL-254) adds its row when its page is built.
 * `section` is the route's, and a route without one opens General.
 */
export const ROOM_PAGES: { section: RoomSettingsSection; label: string }[] = [
  { section: 'general', label: 'General' }, { section: 'git', label: 'Git' }, { section: 'scripts', label: 'Scripts' },
  { section: 'files', label: 'Files to copy' }, { section: 'instructions', label: 'Instructions' }, { section: 'permissions', label: 'Permissions' },
  { section: 'agents', label: 'Agents' }, { section: 'skills', label: 'Skills and MCP' }
]
