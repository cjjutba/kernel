import './roomIcon.css'
import { useEffect, useReducer, useState, type CSSProperties } from 'react'
import type { Room } from '@shared/types'
import { call } from '../api'
import { roomLetter } from '../screens/rooms/roomInfo'

/**
 * One room icon, drawn everywhere a room shows its letter (KERNEL-253). The image comes from `rooms.icon` and is cached by
 * `roomId:at`, so a new icon has a new key and an old one is never shown. It shows in grayscale (CJ's choice, KERNEL-241), and the
 * letter stands in while it loads, when the room has no icon, or when the image can't be read.
 */
const loading = new Map<string, Promise<void>>()
const loaded = new Map<string, string | null>()

const keyOf = (room: Pick<Room, 'id' | 'icon'> | undefined) => (room?.icon ? `${room.id}:${room.icon.at}` : null)

function fetchIcon(roomId: string, key: string) {
  let p = loading.get(key)
  if (!p) {
    // A room only needs its newest image, so older keys for it go.
    for (const k of [...loaded.keys(), ...loading.keys()]) if (k.startsWith(`${roomId}:`) && k !== key) { loaded.delete(k); loading.delete(k) }
    p = call('rooms.icon', { roomId }).then((url) => { loaded.set(key, url) })
    // A failed read isn't cached, so the next mount asks again.
    p.catch(() => loading.delete(key))
    loading.set(key, p)
  }
  return p
}

export function useRoomIcon(room: Pick<Room, 'id' | 'icon'> | undefined): string | null {
  const [, update] = useReducer((n: number) => n + 1, 0)
  const key = keyOf(room)
  const roomId = room?.id
  useEffect(() => {
    if (!key || !roomId || loaded.has(key)) return
    let live = true
    fetchIcon(roomId, key).then(() => { if (live) update() }, () => {})
    return () => { live = false }
  }, [key, roomId])
  return key ? loaded.get(key) ?? null : null
}

/**
 * `className` carries the place's own look (border, fill, letter size). `size` sets both sides in px for places with no class of
 * their own. `fallback` is the letter for a place that has no room yet.
 */
export function RoomIcon({ room, className, size, fallback = '' }: { room: Pick<Room, 'id' | 'name' | 'icon'> | undefined; className?: string; size?: number; fallback?: string }) {
  const url = useRoomIcon(room)
  const [failed, setFailed] = useState<string | null>(null)
  const style: CSSProperties | undefined = size ? { width: size, height: size } : undefined
  const shown = url && failed !== url ? url : null
  return (
    <span className={['room-icon', className].filter(Boolean).join(' ')} style={style} aria-hidden="true" data-image={shown ? '' : undefined}>
      {shown ? <img className="room-icon-img" src={shown} alt="" draggable={false} onError={() => setFailed(shown)} /> : room ? roomLetter(room.name) : fallback}
    </span>
  )
}
