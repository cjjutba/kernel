import type { ReactNode } from 'react'
import type { BannerKind, GitHubErrorKind, Project, ProjectTracker } from '@shared/types'
import { go } from '../../store'
import { Banner, Button, EmptyList, Select, Skeleton, useBusy } from '../../ui'
import { joinFits } from './model'

type Option = { value: string; label: string }

/** A filter as a chip: its name, its value and a chevron. It is a Select, so the keyboard and screen readers work (KERNEL-680). */
export function FilterChip({ label, prefix, value, options, onChange }: { label: string; prefix?: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  return <Select variant="chip" prefix={prefix ?? label} label={label} value={value || (options[0]?.value ?? '')} options={options} onChange={onChange} />
}

export type IssueTracker = 'linear' | 'github'

/** What the Linear | GitHub control in the header needs. A header without it shows no control. */
export interface TrackerSwitch { active: IssueTracker; available: ProjectTracker['available']; onChange: (t: IssueTracker) => void }

/** The project the page lists and the projects it can switch to. A page with no project at all has none. */
export interface ProjectHead { projects: Project[]; project?: Project; onProject: (id: string) => void; tracker?: TrackerSwitch }

/** `parse` for the remembered choice: a stored value that is not a tracker reads as no choice. */
export const trackerChoice = (raw: string | null): IssueTracker | '' => (raw === 'linear' || raw === 'github' ? raw : '')

/** Settings, the project, General: where the project's tracker is chosen. */
export const chooseTracker = (projectId: string) => go({ name: 'settings', page: 'project', projectId, section: 'general' })

/** A project with no tracker says so and points at where to choose one (IssuesNoTracker.png). */
export function NoTracker({ project }: { project: Project }) {
  return (
    <EmptyList icon="plug" title={`${project.name} has no tracker yet`} action={<Button variant="primary" size="lg" onClick={() => chooseTracker(project.id)}>Choose a tracker</Button>}>
      Connect Linear or GitHub Issues in the project's settings, and its issues show up here. Chats work without one.
    </EmptyList>
  )
}

/** The open issue is hidden by the filter: say so above the list, with the way to show it. */
export function HiddenNote({ id, fits, onClear }: { id: string; fits: string[]; onClear: () => void }) {
  return (
    <div className="is-hidden" role="status">
      <span className="grow">{id} isn't in this list{fits.length > 0 ? `, which shows only ${joinFits(fits)}` : ''}.</span>
      {fits.length > 0 && <Button size="md" onClick={onClear}>Clear filter</Button>}
    </div>
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
  if (kind === 'not-found') return { title: `Can't find ${where}`, sub: 'The repo may have been renamed, deleted or made private. Check the repo name and your access to it, then try again.', banner: 'setup' }
  if (kind === 'rate-limited') return { title: 'GitHub rate limit reached', sub: 'Wait a few minutes, then try again.', banner: 'limit' }
  if (kind === 'offline') return { title: "Can't reach GitHub", sub: 'Check your connection, then try again.', banner: 'offline' }
  return { title: "Can't load issues", sub: message, banner: 'offline' }
}

/** The description and comments of an issue that did not load, with the way to ask again. The header and buttons stay. */
export function DescriptionFailed({ children, onRetry }: { children: ReactNode; onRetry: () => Promise<unknown> | void }) {
  const [busy, run] = useBusy<'retry'>()
  return (
    <Banner kind="offline" title="Could not load the description" actions={<Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="ripple" onClick={() => void run('retry', async () => onRetry())}>Try again</Button>}>{children}</Banner>
  )
}
