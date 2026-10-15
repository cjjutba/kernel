import type { ReactNode } from 'react'
import type { BannerKind, GitHubErrorKind, Room } from '@shared/types'
import { go } from '../../store'
import { Banner, Button, EmptyList, Select, Skeleton, useBusy } from '../../ui'

type Option = { value: string; label: string }

/** A filter as a chip: its name, its value and a chevron. It is a Select, so the keyboard and screen readers work (KERNEL-680). */
export function FilterChip({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  return <Select variant="chip" prefix={label} label={label} value={value || (options[0]?.value ?? '')} options={options} onChange={onChange} />
}

/** The room the page lists and the rooms it can switch to. A page with no room at all has none. */
export interface RoomHead { rooms: Room[]; room?: Room; onRoom: (id: string) => void }

/** Settings, the room, General: where the room's tracker is chosen. */
export const chooseTracker = (roomId: string) => go({ name: 'settings', page: 'room', roomId, section: 'general' })

/** A room with no tracker says so and points at where to choose one (IssuesNoTracker.png). */
export function NoTracker({ room }: { room: Room }) {
  return (
    <EmptyList icon="plug" title={`${room.name} has no tracker yet`} action={<Button variant="primary" size="lg" onClick={() => chooseTracker(room.id)}>Choose a tracker</Button>}>
      Connect Linear or GitHub Issues in the room's settings, and its issues show up here. Chats work without one.
    </EmptyList>
  )
}

/** Rows the shape of the list's own while it loads, one group header and a few issues. */
export function IssueSkeleton({ what = 'issues' }: { what?: string }) {
  return (
    <div className="is-body">
      <div className="is-list is-skeleton" role="status" aria-label={`Loading ${what}`}>
        {[0, 1].map((g) => (
          <div key={g} className="col">
            <div className="is-sk-group"><Skeleton width={90} height={10} /></div>
            {Array.from({ length: g === 0 ? 3 : 2 }, (_, i) => (
              <div key={i} className="is-sk-row"><Skeleton width={16} height={16} /><span className="col grow"><Skeleton width={`${70 - i * 12}%`} height={11} /><Skeleton width="34%" height={9} /></span></div>
            ))}
          </div>
        ))}
      </div>
      <div className="is-pane" />
    </div>
  )
}

/** A failed refresh over rows that already loaded: the rows stay and this sits above them. */
export function RefreshNotice({ kind, title, action, children }: { kind: BannerKind; title: string; action: ReactNode; children: ReactNode }) {
  return <div className="is-notice"><Banner kind={kind} title={title} actions={action}>{children}</Banner></div>
}

/** The list stops at the most recent issues the tracker returns. Say so at its foot. */
export function CapNote({ children }: { children: ReactNode }) {
  return <p className="is-cap muted">{children}</p>
}

/** What a failed GitHub read says and where it points, by the kind the engine gave it (KERNEL-861). */
export function githubProblem(kind: GitHubErrorKind, message: string, where: string): { title: string; sub: string; banner: BannerKind } {
  if (kind === 'signed-out') return { title: "GitHub isn't signed in", sub: 'Run gh auth login in a terminal, then try again.', banner: 'auth' }
  if (kind === 'not-found') return { title: `Can't find ${where}`, sub: 'The repo may have been renamed, deleted or made private. Choose another tracker for this room.', banner: 'setup' }
  if (kind === 'rate-limited') return { title: 'GitHub rate limit reached', sub: 'Wait a few minutes, then try again.', banner: 'limit' }
  if (kind === 'offline') return { title: "Can't reach GitHub", sub: 'Check your connection, then try again.', banner: 'offline' }
  return { title: "Can't load issues", sub: message, banner: 'offline' }
}

/** The description and comments of an issue that did not load, with the way to ask again. The header and buttons stay. */
export function DescriptionFailed({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  const [busy, run] = useBusy<'retry'>()
  return (
    <Banner kind="offline" title="Could not load the description" actions={<Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void run('retry', async () => onRetry())}>Try again</Button>}>{children}</Banner>
  )
}
