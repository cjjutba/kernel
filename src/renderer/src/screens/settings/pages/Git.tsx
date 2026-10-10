import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { call } from '../../../api'
import { useStore } from '../../../store'
import { SegmentedControl, Select, Toggle } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

type Workspace = AppSettings['workspace']
const set = (patch: Partial<Workspace>) => void patchSettings({ workspace: patch })
const withCurrent = (list: string[], current: string) => [...new Set([current, ...list])].map((v) => ({ value: v, label: v }))
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** Settings > Git and worktrees (SettingsGit.png). The defaults for every room. A room can override them from its own Git page. */
export function Git({ s }: { s: AppSettings }) {
  const w = s.workspace
  // The defaults belong to no room, so the branches and remotes to pick from are every room's.
  const roomIds = useStore((x) => x.rooms.filter((r) => !r.hidden && !r.archived).map((r) => r.id).join(','))
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void Promise.all(roomIds.split(',').filter(Boolean).map((roomId) => call('git.branches', { roomId }).catch(() => [] as string[])))
      .then((lists) => live && setBranches([...new Set(lists.flat())]))
    return () => { live = false }
  }, [roomIds])
  const remotes = [...new Set(branches.filter((b) => b.includes('/')).map((b) => b.split('/')[0]))]
  return (
    <Page title="Git and worktrees" intro="Defaults for every room. Each room can override them on its own Git page.">
      <Section title="New workspaces">
        <Row label="Default workspace type" desc="A worktree is an isolated copy on its own branch">
          <SegmentedControl label="Default workspace type" value={w.mode} onChange={(v) => set({ mode: v as Workspace['mode'] })} options={[{ value: 'worktree', label: 'New worktree' }, { value: 'current', label: 'Current branch' }]} />
        </Row>
        <Row label="Branch new workspaces from">
          <Select label="Branch new workspaces from" value={w.baseRef} options={withCurrent(branches, w.baseRef)} onChange={(e) => set({ baseRef: e.target.value })} />
        </Row>
        <Row label="Remote origin" desc="Where to push, pull and open PRs">
          <Select label="Remote origin" value={w.remote} options={withCurrent(remotes.length ? remotes : ['origin'], w.remote)} onChange={(e) => set({ remote: e.target.value })} />
        </Row>
        <Row label="Branch name pattern" desc="Renamed from your task once the workspace starts">
          <BranchPattern value={w.branchPattern} />
        </Row>
        <Row label="Worktree location"><span className="set-value">{home(s.worktreeRoot)}</span></Row>
      </Section>
      <Section title="Current branch workspaces">
        <Row label="Treat existing changes as the baseline" desc="Changes already in your checkout are hidden from the diff and never committed by agents">
          <Toggle label="Treat existing changes as the baseline" checked={w.baselineCurrentBranch} onChange={(v) => set({ baselineCurrentBranch: v })} />
        </Row>
        <Row label="One current-branch workspace per room" desc="Two agents editing one checkout would overwrite each other">
          <Toggle label="One current-branch workspace per room" checked={w.oneCurrentBranchPerRoom} onChange={(v) => set({ oneCurrentBranchPerRoom: v })} />
        </Row>
      </Section>
      <Section title="Cleanup">
        <Row label="Delete branch on archive"><Toggle label="Delete branch on archive" checked={w.deleteBranchOnArchive} onChange={(v) => set({ deleteBranchOnArchive: v })} /></Row>
        <Row label="Archive on merge"><Toggle label="Archive on merge" checked={w.archiveOnMerge} onChange={(v) => set({ archiveOnMerge: v })} /></Row>
        <Row label="Set upstream on first push"><Toggle label="Set upstream on first push" checked={w.setUpstream} onChange={(v) => set({ setUpstream: v })} /></Row>
      </Section>
    </Page>
  )
}

/** The pattern must keep `{slug}`, or every workspace would get the same branch name. */
function BranchPattern({ value }: { value: string }) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  const commit = () => {
    const next = text.trim()
    if (next === value) return
    if (!next.includes('{slug}')) { setText(value); return }
    set({ branchPattern: next })
  }
  return <input className="set-inline" aria-label="Branch name pattern" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}
