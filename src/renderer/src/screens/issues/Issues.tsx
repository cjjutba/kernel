import { useMemo, useState } from 'react'
import { go, lastRoom, useStore } from '../../store'
import { Banner, Button, Spinner } from '../../ui'
import { GithubIssues } from './GithubIssues'
import { LinearIssues } from './LinearIssues'
import { IssuesHeader, JiraNotBrowsable, NoTracker, type RoomHead } from './parts'
import { useRoomTracker } from './useRoomTracker'
import './issues.css'

/**
 * The Issues page for one room (KERNEL-471). The room's tracker decides what it lists: Linear's list (the account's, as it always
 * was), the room's GitHub Issues, a line saying a Jira room can't be browsed yet (KERNEL-503), or a line saying the room has no
 * tracker. The route's `roomId` picks the room, else the one used last. The room menu in the header switches to another room's tracker.
 */
export function Issues({ issueId, roomId }: { issueId?: string; roomId?: string }) {
  const rooms = useStore((s) => s.rooms)
  const choices = useMemo(() => rooms.filter((r) => !r.archived && !r.hidden), [rooms])
  // The room opened last, read once. A store selector runs on every change and must not touch localStorage.
  const [lastRoomId] = useState(lastRoom)
  const room = choices.find((r) => r.id === roomId) ?? choices.find((r) => r.id === lastRoomId) ?? choices[0]
  // Another room is another route, so the sidebar follows it and Back returns to the room before.
  const head: RoomHead = { rooms: choices, room, onRoom: (id) => go({ name: 'issues', roomId: id }) }

  const { read, retry } = useRoomTracker(room?.id)

  // With no room there is no tracker to read, and Linear's list needs none.
  if (!room) return <LinearIssues issueId={issueId} head={head} />
  if (read.kind === 'ready' && read.tracker.kind === 'linear') return <LinearIssues key={room.id} issueId={issueId} head={head} />
  if (read.kind === 'ready' && read.tracker.kind === 'github') return <GithubIssues key={room.id} room={room} where={read.tracker.where} issueId={issueId} head={head} />

  return (
    <div className="panel">
      <IssuesHeader head={head} />
      {read.kind === 'loading' && <div className="is-center is-loading" role="status"><Spinner label={null} kind="load" />Loading issues</div>}
      {read.kind === 'error' && (
        <div className="is-center">
          <div className="is-fail">
            <Banner kind="offline" title="Can't load issues" actions={<Button size="md" onClick={retry}>Try again</Button>}>{read.message}</Banner>
          </div>
        </div>
      )}
      {read.kind === 'ready' && read.tracker.kind === 'jira' && <JiraNotBrowsable room={room} />}
      {read.kind === 'ready' && read.tracker.kind === 'none' && <NoTracker room={room} />}
    </div>
  )
}
