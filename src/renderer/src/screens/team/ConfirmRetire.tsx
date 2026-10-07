import { PlaceholderModal } from '../../components/Placeholder'

/** Retire an agent (KERNEL-19). */
export function ConfirmRetire({ agentId }: { roomId: string; agentId: string }) { return <PlaceholderModal title={`Retire ${agentId}`} issue="KERNEL-19" /> }
