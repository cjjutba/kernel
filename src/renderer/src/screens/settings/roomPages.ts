import type { RoomSettingsSection } from '@shared/types'
import type { IconName } from '../../icons'

/**
 * A room's pages in the Settings nav, in order. Environment (KERNEL-254) sits between Files to copy and Instructions, and Reviews (KERNEL-557) after Agents.
 * `section` is the route's, and a route without one opens General. `icon` is the page's glyph in the nav (KERNEL-534).
 */
export const ROOM_PAGES: { section: RoomSettingsSection; label: string; icon: IconName }[] = [
  { section: 'general', label: 'General', icon: 'sliders' }, { section: 'git', label: 'Git', icon: 'branch' }, { section: 'scripts', label: 'Scripts', icon: 'term' },
  { section: 'files', label: 'Files to copy', icon: 'copy' }, { section: 'environment', label: 'Environment', icon: 'env' }, { section: 'instructions', label: 'Instructions', icon: 'book' },
  { section: 'permissions', label: 'Permissions', icon: 'shield' }, { section: 'agents', label: 'Agents', icon: 'team' }, { section: 'reviews', label: 'Reviews', icon: 'checkCircle' }, { section: 'skills', label: 'Skills and MCP', icon: 'plug' }
]
