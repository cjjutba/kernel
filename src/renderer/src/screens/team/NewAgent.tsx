import { PlaceholderModal } from '../../components/Placeholder'

/** New agent: describe, review the file, joined (KERNEL-19). */
export function NewAgent(_: { roomId: string; step: 'describe' | 'draft' | 'done' }) { return <PlaceholderModal title="New agent" issue="KERNEL-19" /> }
