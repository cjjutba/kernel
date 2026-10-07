// Board and BoardEmpty (KERNEL-18). Re-exports the prototype until KERNEL-18 replaces this file.
import { BoardScreen } from '../Pages'

export function Board({ roomId }: { roomId: string; taskId?: string }) { return <BoardScreen roomId={roomId} /> }
