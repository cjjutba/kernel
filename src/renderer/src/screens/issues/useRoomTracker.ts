import { useEffect, useState } from 'react'
import type { RoomTracker } from '@shared/types'
import { call, cleanError } from '../../api'

export type TrackerRead = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; roomId: string; tracker: RoomTracker }

const LOADING: TrackerRead = { kind: 'loading' }

/**
 * The tracker a room uses, read when the room changes (KERNEL-471). Main works it out on every call, so a change in the room's
 * settings shows the next time a screen opens. An answer for another room is never handed back as this room's: it reads as loading.
 */
export function useRoomTracker(roomId: string | undefined): { read: TrackerRead; retry: () => void } {
  const [answer, setAnswer] = useState<TrackerRead>(LOADING)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!roomId) return
    let live = true
    setAnswer(LOADING)
    call('issues.tracker', { roomId }).then((tracker) => live && setAnswer({ kind: 'ready', roomId, tracker }), (e) => live && setAnswer({ kind: 'error', message: cleanError(e) }))
    return () => { live = false }
  }, [roomId, tries])
  const read: TrackerRead = answer.kind === 'ready' && answer.roomId !== roomId ? LOADING : answer
  return { read, retry: () => setTries((n) => n + 1) }
}
