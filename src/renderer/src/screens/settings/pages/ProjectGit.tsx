import './projects.css'
import { useEffect, useState } from 'react'
import type { AppSettings, PushCheck, PushCheckRow, ProjectSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions } from '../../../store'
import { Button, CodeBlock, Icon, SegmentedControl, Select, Spinner, Toggle, useBusy } from '../../../ui'
import { NoProject, ProjectPage, Section, useProjectPage } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { FollowsApp, SourcedRow, whereOf } from './projectSource'


/** "just now", "2 minutes ago", for Checked. */
export function checkedAgo(at: number, now = Date.now()): string {
  const m = Math.floor((now - at) / 60_000)
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`
  if (m < 1) return 'just now'
  if (m < 60) return unit(m, 'minute')
  return m < 24 * 60 ? unit(Math.floor(m / 60), 'hour') : unit(Math.floor(m / (24 * 60)), 'day')
}

/** What a failed row adds under the status: git's own error, the fix to copy, what to try. */
function FailDetail({ row }: { row: PushCheckRow }) {
  if (!row.output && !row.fix && !row.note) return null
  return (
    <div className="rm-fail">
      {row.output && <pre className="code boxed">{row.output}</pre>}
      {row.fix && <CodeBlock>{row.fix}</CodeBlock>}
      {row.note && <p className="set-note">{row.note}</p>}
    </div>
  )
}

/**
 * Push access (MorePage projectGit, KERNEL-680): whether git can reach the project's remote and push to it, from the last check, as one
 * status line. Check again runs it now. A project with no remote has no line.
 */
function PushAccess({ projectId, remote }: { projectId: string; remote: string }) {
  const [check, setCheck] = useState<PushCheck | null>()
  const [busy, run] = useBusy()
  const [, tick] = useState(0)
  useEffect(() => {
    let stale = false
    setCheck(undefined)
    call('projects.pushCheck', { projectId }).then((c) => { if (!stale) setCheck(c) }, () => { if (!stale) setCheck(null) })
    return () => { stale = true }
  }, [projectId, remote])
  // The age keeps counting while the page is open.
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t) }, [])
  const recheck = () => run('recheck', async () => {
    try { setCheck(await call('projects.pushCheck', { projectId, recheck: true })) } catch (e) { actions.ui.toast({ title: 'Could not check push access', sub: cleanError(e) }) }
  })
  if (check === null) return null
  const name = check?.remote ?? remote
  const failed = check && (check.reach.state === 'fail' ? check.reach : check.push.state === 'fail' ? check.push : undefined)
  const title = !check ? `Checking ${name}` : check.reach.state === 'fail' ? `Can’t reach ${name}` : check.push.state === 'fail' ? `Can’t push to ${name}` : check.push.state === 'ok' ? `Agents can push to ${check.repo ?? name}` : 'Push access not checked'
  const sub = !check ? undefined : failed ? [failed.detail, `Checked ${checkedAgo(check.at)}`].join(' · ') : `Checked with git ls-remote ${checkedAgo(check.at)}`
  const tone = !check ? undefined : failed ? 'fail' : check.push.state === 'ok' ? 'ok' : undefined
  return (
    <Section title="Push access" plain>
      <div className="set-status rm-push" role="status" data-tone={tone}>
        {!check ? <Spinner label={null} pattern="arrow-down" /> : <Icon name={failed ? 'xCircle' : check.push.state === 'ok' ? 'checkCircle' : 'clock'} size={16} />}
        <span className="set-status-text"><span className="set-label">{title}</span>{sub && <span className="set-desc">{sub}</span>}</span>
        <Button icon="refresh" busy={busy === 'recheck'} busyPattern="ripple" busyLabel="Checking" disabled={busy !== null || !check} onClick={() => void recheck()}>Check again</Button>
      </div>
      {failed && <FailDetail row={failed} />}
    </Section>
  )
}

/** The pattern keeps `{slug}`, or every chat would get one branch name. Empty goes back to the default. */
function LeadPattern({ value, placeholder, save }: { value: string; placeholder: string; save: (v: string | null) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  const commit = () => {
    const next = text.trim()
    if (next === value) return
    if (!next) return save(null)
    if (!next.includes('{slug}')) return setText(value)
    save(next)
  }
  return <input className="set-inline set-boxed rm-pattern" aria-label="Branch names for chats with Kernel" spellCheck={false} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}

/** Settings > a project > Git (MorePage projectGit, KERNEL-680): the project's overrides of the app's Git defaults. Each Select starts with "Default (the app's value)", and Reset goes back to it. */
export function ProjectGit({ projectId, s }: { projectId?: string; s: AppSettings }) {
  const { project, rs } = useProjectPage(projectId)
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    if (projectId) void call('git.branches', { projectId }).then(setBranches).catch(() => setBranches([]))
  }, [projectId])
  if (!project || !projectId) return <NoProject />
  const app = s.workspace
  const set = (patch: Partial<Record<keyof ProjectSettings['workspace'], string | boolean | null>>) => void patchProjectSettings(projectId, { workspace: patch as never })
  const page = { page: 'git' } as const
  const row = (key: keyof ProjectSettings['workspace']) => ({ rs, path: `workspace.${key}`, onReset: () => set({ [key]: null }) })
  const flag = (key: 'deleteBranchOnArchive' | 'archiveOnMerge' | 'archiveChatWorkspaces', label: string, extra?: string) => {
    const on = rs?.workspace[key] ?? app[key]
    return (
      <SourcedRow {...row(key)} label={label} value={on ? 'On' : 'Off'} extra={whereOf(rs, `workspace.${key}`) === 'app' ? undefined : extra} app={<FollowsApp to={page} lead="Follows" tail={app[key] ? 'turns it on' : 'leaves it off'} />}>
        <Toggle label={label} checked={on} onChange={(v) => set({ [key]: v })} />
      </SourcedRow>
    )
  }
  const own = (key: 'baseRef' | 'remote') => rs?.workspace[key] ?? app[key]
  const named = (list: string[], current: string) => [...new Set([...(current ? [current] : []), ...list])].map((v) => ({ value: v, label: v }))
  const remotes = [...new Set(branches.filter((b) => b.includes('/')).map((b) => b.split('/')[0]))]
  return (
    <ProjectPage project={project} rs={rs} title="Git" desc="What this project changes from Settings, Git and worktrees.">
      <PushAccess projectId={projectId} remote={rs?.workspace.remote ?? app.remote} />
      <Section title="New workspaces">
        <SourcedRow id="workspace-type" {...row('mode')} label="Workspace type" value={(rs?.workspace.mode ?? app.mode) === 'current' ? 'Current branch' : 'Worktree'} app={<FollowsApp to={page} />}>
          <SegmentedControl label="Workspace type" value={rs?.workspace.mode ?? app.mode} onChange={(v) => set({ mode: v })} options={[{ value: 'worktree', label: 'Worktree' }, { value: 'current', label: 'Current branch' }]} />
        </SourcedRow>
        <SourcedRow id="branch-from" {...row('baseRef')} label="Branch from" value={own('baseRef')} app={<FollowsApp to={page} />}>
          <Select label="Branch from" align="right" value={own('baseRef')} onChange={(v) => set({ baseRef: v })} options={named(branches, own('baseRef'))} />
        </SourcedRow>
        <SourcedRow id="remote" {...row('remote')} label="Remote" value={own('remote')} app={<FollowsApp to={page} />}>
          <Select label="Remote" align="right" value={own('remote')} onChange={(v) => set({ remote: v })} options={named(remotes.length ? remotes : ['origin'], own('remote'))} />
        </SourcedRow>
        <SourcedRow id="lead-branch-names" {...row('leadBranchPattern')} label="Branch names for chats with Kernel" value={rs?.workspace.leadBranchPattern ?? app.leadBranchPattern} app={<FollowsApp to={page} />}>
          <LeadPattern value={rs?.workspace.leadBranchPattern ?? app.leadBranchPattern} placeholder={app.leadBranchPattern} save={(v) => set({ leadBranchPattern: v })} />
        </SourcedRow>
      </Section>
      <Section title="Cleanup">
        {flag('archiveOnMerge', 'Archive on merge', 'Review workspaces go too.')}
        {flag('deleteBranchOnArchive', 'Delete the branch on archive')}
        {flag('archiveChatWorkspaces', 'Archive a chat’s workspaces with it')}
      </Section>
    </ProjectPage>
  )
}
