import './system.css'
import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, useStore } from '../../../store'
import { Button, SegmentedControl, Select, Toggle, useBusy } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

type Workspace = AppSettings['workspace']
const set = (patch: Partial<Workspace>) => void patchSettings({ workspace: patch })
const setScripts = (patch: Partial<AppSettings['scripts']>) => void patchSettings({ scripts: patch })
const withCurrent = (list: string[], current: string) => [...new Set([current, ...list])].map((v) => ({ value: v, label: v }))
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')
/** How long a setup or archive script may run, in minutes. Main takes 1 to 240 (KERNEL-216). */
const TIMEOUTS = [5, 10, 15, 30]

/** Settings > Git and worktrees (MorePage git, KERNEL-680): the defaults for every project, then setup and archive scripts and cleanup. */
export function Git({ s }: { s: AppSettings }) {
  const w = s.workspace
  const a = s.scripts
  const [busy, run] = useBusy()
  // The defaults belong to no project, so the branches and remotes to pick from are every project's.
  const projectIds = useStore((x) => x.projects.filter((r) => !r.hidden && !r.archived).map((r) => r.id).join(','))
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void Promise.all(projectIds.split(',').filter(Boolean).map((projectId) => call('git.branches', { projectId }).catch(() => [] as string[])))
      .then((lists) => live && setBranches([...new Set(lists.flat())]))
    return () => { live = false }
  }, [projectIds])
  const remotes = [...new Set(branches.filter((b) => b.includes('/')).map((b) => b.split('/')[0]))]
  const reveal = () => run('reveal', async () => {
    try { await call('system.openInEditor', { path: s.worktreeRoot }) } catch (e) { actions.ui.toast({ title: 'Could not open the folder', sub: cleanError(e) }) }
  })
  return (
    <Page title="Git and worktrees">
      <Section title="New workspaces">
        <Row id="workspace-type" setting="workspace.mode" label="Workspace type" desc="A worktree is an isolated copy on its own branch.">
          <SegmentedControl label="Workspace type" value={w.mode} onChange={(v) => set({ mode: v as Workspace['mode'] })} options={[{ value: 'worktree', label: 'New worktree' }, { value: 'current', label: 'Current branch' }]} />
        </Row>
        <Row id="branch-from" setting="workspace.baseRef" label="Branch from"><Select label="Branch from" align="right" value={w.baseRef} options={withCurrent(branches, w.baseRef)} onChange={(v) => set({ baseRef: v })} /></Row>
        <Row id="remote" label="Remote" desc="Where agents push and open pull requests.">
          <Select label="Remote" align="right" value={w.remote} options={withCurrent(remotes.length ? remotes : ['origin'], w.remote)} onChange={(v) => set({ remote: v })} />
        </Row>
        <Row id="worktree-location" setting="worktreeRoot" label="Worktree location">
          <span className="set-actions">
            <span className="set-value">{home(s.worktreeRoot)}</span>
            <Button busy={busy === 'reveal'} busyLabel="Opening" disabled={busy !== null} onClick={() => void reveal()}>Reveal</Button>
          </span>
        </Row>
      </Section>
      <Section title="Branch names">
        <Row id="branch-names" setting="workspace.branchPattern" label="Workspaces" desc="Renamed from the task once work starts."><BranchPattern value={w.branchPattern} label="Workspace branch name pattern" /></Row>
        <Row id="lead-branch-names" setting="workspace.leadBranchPattern" label="Chats with Kernel" desc="Renamed from the chat title until pushed."><BranchPattern value={w.leadBranchPattern} field="leadBranchPattern" label="Branch name pattern for chats with Kernel" /></Row>
      </Section>
      <Section title="Current branch">
        <Row id="baseline" setting="workspace.baselineCurrentBranch" label="Treat existing changes as the baseline" desc="They stay out of the diff, and agents never commit them."><Toggle label="Treat existing changes as the baseline" checked={w.baselineCurrentBranch} onChange={(v) => set({ baselineCurrentBranch: v })} /></Row>
        <Row id="one-current-branch" setting="workspace.oneCurrentBranchPerProject" label="One current-branch workspace per project"><Toggle label="One current-branch workspace per project" checked={w.oneCurrentBranchPerProject} onChange={(v) => set({ oneCurrentBranchPerProject: v })} /></Row>
      </Section>
      <Section title="Setup and archive" note="The scripts live on each project’s Scripts page.">
        <Row id="run-setup" setting="scripts.setupOnCreate" label="Run setup when a workspace is created"><Toggle label="Run setup when a workspace is created" checked={a.setupOnCreate} onChange={(v) => setScripts({ setupOnCreate: v })} /></Row>
        <Row id="wait-for-setup" setting="workspace.leadWaitForSetup" child label="Wait for setup before the first message" desc="The first message holds until setup passes."><Toggle label="Wait for setup before the first message" checked={w.leadWaitForSetup} onChange={(v) => set({ leadWaitForSetup: v })} /></Row>
        <Row id="run-after-setup" setting="scripts.runAfterSetup" label="Start the run script after setup"><Toggle label="Start the run script after setup" checked={a.runAfterSetup} onChange={(v) => setScripts({ runAfterSetup: v })} /></Row>
        <Row id="run-archive" label="Run the archive script on archive"><Toggle label="Run the archive script on archive" checked={a.archiveOnArchive} onChange={(v) => setScripts({ archiveOnArchive: v })} /></Row>
        <Row id="script-timeout" label="Stop setup and archive scripts after" desc="Run scripts have no limit.">
          <Select label="Stop setup and archive scripts after" align="right" value={String(a.timeoutMinutes)} options={[...new Set([...TIMEOUTS, a.timeoutMinutes])].sort((x, y) => x - y).map((n) => ({ value: String(n), label: `${n} minute${n === 1 ? '' : 's'}` }))} onChange={(v) => setScripts({ timeoutMinutes: Number(v) })} />
        </Row>
      </Section>
      <Section title="Cleanup">
        <Row id="delete-branch" label="Delete the branch on archive"><Toggle label="Delete the branch on archive" checked={w.deleteBranchOnArchive} onChange={(v) => set({ deleteBranchOnArchive: v })} /></Row>
        <Row id="archive-on-merge" label="Archive on merge" desc="Review workspaces go too."><Toggle label="Archive on merge" checked={w.archiveOnMerge} onChange={(v) => set({ archiveOnMerge: v })} /></Row>
        <Row id="archive-chat-workspaces" label="Archive a chat’s workspaces with it"><Toggle label="Archive a chat’s workspaces with it" checked={w.archiveChatWorkspaces} onChange={(v) => set({ archiveChatWorkspaces: v })} /></Row>
      </Section>
    </Page>
  )
}

/** The pattern must keep `{slug}`, or every workspace would get the same branch name. A Lead chat's has its own (KERNEL-405). */
export function BranchPattern({ value, field = 'branchPattern', label = 'Branch name pattern', save = (v) => set({ [field]: v }), placeholder }: { value: string; field?: 'branchPattern' | 'leadBranchPattern'; label?: string; save?: (v: string | null) => void; placeholder?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  const commit = () => {
    const next = text.trim()
    if (next === value) return
    // Empty goes back to the default where there is one to go back to, as on a project's page.
    if (!next && placeholder) { save(null); return }
    if (!next.includes('{slug}')) { setText(value); return }
    save(next)
  }
  return <input className="set-inline set-boxed" aria-label={label} spellCheck={false} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}
