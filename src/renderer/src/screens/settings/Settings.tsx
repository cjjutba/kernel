import type { SettingsPage } from '@shared/types'
import { PlaceholderPage } from '../../components/Placeholder'

/** Settings shell and every page (KERNEL-25 for app pages, KERNEL-26 for project pages and room overrides). */
export function Settings({ page }: { page: SettingsPage; roomId?: string }) { return <PlaceholderPage title={`Settings: ${page}`} issue={page === 'room' ? 'KERNEL-26' : 'KERNEL-25'} /> }
