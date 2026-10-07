import { PlaceholderPage } from '../../components/Placeholder'

/** Task detail, drawn over the board (KERNEL-18). */
export function TaskDetail({ taskId }: { roomId: string; taskId: string }) { return <PlaceholderPage title={`Task ${taskId}`} issue="KERNEL-18" /> }
