import type { ReactNode } from 'react'
import type { GitHubErrorKind, Project, ProjectTracker } from '@shared/types'
import { go } from '../../store'
import { Button, EmptyList, Icon, LinkButton, LoadingRow, Select, Skeleton } from '../../ui'
import type { IconName } from '../../icons'
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

/** A project with no tracker says so and points at where to choose one (Pen 11.15, WorkIssuesNoTracker). */
export function NoTracker({ project }: { project: Project }) {
  return (
    <EmptyList icon="issues" title="No tracker for this project" action={<Button onClick={() => chooseTracker(project.id)}>Choose a tracker</Button>}>
      Connect Linear or use GitHub Issues to see issues next to the agents on them.
    </EmptyList>
  )
}

/** Linear is not connected: what connecting gives, and the ways on. GitHub Issues is one press away when the project has a GitHub remote (Pen 11.6). */
export function ConnectLinear({ head }: { head: ProjectHead }) {
  const github = head.tracker?.available.github
  return (
    <div className="state-center">
      <div className="empty is-connect">
        <span className="empty-icon"><Icon name="issues" size={20} /></span>
        <div className="empty-title">Connect Linear</div>
        <div className="muted">See your issues next to the agents working on them. Agents comment on issues and move them as they work, and Kernel never changes an issue you didn't hand it.</div>
        <div className="empty-action">
          <Button variant="primary" size="lg" onClick={() => go({ name: 'settings', page: 'integrations' })}>Connect Linear</Button>
          {github && head.tracker && <Button size="lg" onClick={() => head.tracker!.onChange('github')}>Use GitHub Issues</Button>}
        </div>
      </div>
    </div>
  )
}

/** The open issue is hidden by the filter: say so above the list, with the way to show it. */
export function HiddenNote({ id, fits, onClear }: { id: string; fits: string[]; onClear: () => void }) {
  return (
    <div className="is-hidden" role="status">
      <span className="grow">{id} isn't in this list{fits.length > 0 ? `, which shows only ${joinFits(fits)}` : ''}.</span>
      {fits.length > 0 && <LinkButton variant="action" size="ui" onClick={onClear}>Clear filter</LinkButton>}
    </div>
  )
}

/** Rows the shape of the list's own while it loads, a round mark and two bars each, with what is loading under them (Pen 11.16). */
export function IssueSkeleton({ what = 'issues' }: { what?: string }) {
  const widths = [260, 220, 300, 180, 240]
  return (
    <div className="is-body">
      <div className="is-skeleton" role="status" aria-label={`Loading ${what}`}>
        <div className="is-sk-rows">
          {widths.map((w, i) => (
            <div key={i} className="is-sk-row"><Skeleton width={14} height={14} /><span className="col"><Skeleton width={w} height={9} /><Skeleton width={110} height={7} /></span></div>
          ))}
        </div>
        <LoadingRow what={what} inline />
      </div>
    </div>
  )
}

/** The list stops at the most recent issues the tracker returns. Say so at its foot. */
export function CapNote({ children }: { children: ReactNode }) {
  return <p className="is-cap muted">{children}</p>
}

/** What a failed GitHub read says, by the kind the engine gave it (KERNEL-861, Pen 11.15). `toast` is the one line the toast carries. */
export function githubProblem(kind: GitHubErrorKind, message: string, where: string): { icon: IconName; title: string; sub: string; toast?: string; toastSub?: string } {
  if (kind === 'signed-out') return { icon: 'key', title: 'Sign in to GitHub', sub: 'Kernel reads issues with the GitHub CLI.' }
  if (kind === 'not-found') return { icon: 'folder', title: `${where} isn't on GitHub anymore`, sub: 'It was renamed, moved or deleted. Check the remote in Settings, Git.' }
  if (kind === 'rate-limited') return { icon: 'question', title: 'GitHub is limiting requests', sub: 'Kernel tries again on its own.', toast: 'GitHub rate limit reached', toastSub: 'Kernel tries again later.' }
  if (kind === 'offline') return { icon: 'wifioff', title: "You're offline", sub: "Issues show again when you're back online." }
  return { icon: 'wifioff', title: "Issues didn't load", sub: 'Kernel will try again on its own.', toast: "Couldn't load GitHub issues", toastSub: message }
}
