import { useEffect, useState } from 'react'
import type { FolderInfo } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go } from '../../store'
import { Banner, Button, Icon, LoadingRow, Modal, useBusy } from '../../ui'
import { baseName, defaultTeam, tilde } from './draft'
import { RepoNameField, useRepoName } from './RepoName'
import './projects.css'

/** What a folder's row says on the right: on GitHub, a repo with no remote, or not a repo at all. */
const stateOf = (f: FolderInfo) => (!f.git ? 'Not a git repo' : f.remote ? 'GitHub' : 'No remote')

/** A dropped file's path on the Mac, or nothing for one made in the page. */
const pathOf = (file: File) => { try { return window.kernel.pathOf(file) } catch { return '' } }

/**
 * Open a folder (KERNEL-946): one list of recent folders with the pick highlighted in place, a folder dropped anywhere on the
 * dialog, and Choose folder… for the rest. Every project lives on GitHub, so a folder with no GitHub remote is offered a new
 * private repo under the list (KERNEL-944). Open creates the project at once.
 */
export function OpenFolder() {
  const [folders, setFolders] = useState<FolderInfo[] | null>(null)
  const [picked, setPicked] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [busy, run] = useBusy<'retry' | 'open'>()

  const load = () => call('projects.recentFolders', undefined).then((list) => { setFolders(list); setLoadError(null); setPicked((p) => p || list[0]?.path || '') }, (e: unknown) => { setFolders([]); setLoadError(cleanError(e)) })
  useEffect(() => { void load() }, [])
  const retry = () => run('retry', async () => {
    setFolders(null)
    setLoadError(null)
    await load()
  })

  const current = folders?.find((f) => f.path === picked)
  const needsRepo = !!current && !current.remote
  const repo = useRepoName(needsRepo ? baseName(current.path) : '')

  const add = async (path: string) => {
    if (!path) return
    try {
      const f = await call('projects.inspectFolder', { path })
      setFolders((list) => [f, ...(list ?? []).filter((x) => x.path !== f.path)])
      setPicked(f.path)
      setError(null)
    } catch (e) { setError(cleanError(e)) }
  }
  const choose = async () => { const path = await call('system.pickFolder', undefined); if (path) await add(path) }
  const open = () => run('open', async () => {
    if (!current || (needsRepo && !repo.ready)) return
    setError(null)
    try {
      const project = await call('projects.create', {
        source: 'folder', name: baseName(current.path), from: current.path, baseBranch: current.branch, team: defaultTeam(), autostart: false,
        ...(needsRepo ? { github: { owner: repo.owner, name: repo.name } } : {})
      })
      actions.projects.upsert(project)
      go({ name: 'onboarding', step: 'project', projectId: project.id })
    } catch (e) { setError(cleanError(e)) }
  })

  return (
    <Modal
      title="Open a folder" onClose={actions.ui.closeModal} width={560} top={112}
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" size="lg" onClick={actions.ui.closeModal}>Cancel</Button>
          <Button variant="primary" size="lg" disabled={!current || (needsRepo && !repo.ready)} busy={busy === 'open'} busyLabel={needsRepo ? 'Creating' : 'Opening'} onClick={() => void open()}>{needsRepo ? 'Create repo and open' : 'Open folder'}</Button>
        </>
      }
    >
      <div
        className="of-body2" data-over={over || undefined}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true) } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const file = e.dataTransfer.files[0]; if (file) void add(pathOf(file)) }}
      >
        <div className="of-head">
          <p className="rm-sub of-sub">Pick a recent folder, or drop one anywhere here.</p>
          <Button size="md" onClick={() => void choose()}>Choose folder…</Button>
        </div>
        {error && <p role="alert" className="del of-err">{error}</p>}
        <div role="radiogroup" aria-label="Recent folders" className="of-list2" aria-busy={!folders}>
          {folders?.map((f) => (
            <button key={f.path} type="button" role="radio" aria-checked={picked === f.path} className="of-row2" onClick={() => { setPicked(f.path); setError(null) }}>
              <Icon name="folder" size={16} />
              <span className="grow of-row2-text">
                <span className="of-row2-name">{baseName(f.path)}</span>
                <span className="mono of-row2-path ellipsis">{tilde(f.path)}</span>
              </span>
              <span className="of-row2-state">{stateOf(f)}</span>
              <span className="of-row2-tick">{picked === f.path && <Icon name="check" size={14} />}</span>
            </button>
          ))}
          {!folders && <LoadingRow what="recent folders" />}
          {folders && !folders.length && loadError && (
            <Banner kind="setup" title="Could not read your recent folders" actions={<Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void retry()}>Try again</Button>}>{loadError}</Banner>
          )}
          {folders && !folders.length && !loadError && <p className="muted cr-empty">No recent folders. Use Choose folder…, or drop one here.</p>}
        </div>
        {current && (
          <div className="of-detail">
            {current.remote
              ? <p className="of-line"><Icon name="branch" size={14} /><span className="mono">{current.remote}</span>{!!current.dirty && <span>Your {current.dirty} uncommitted {current.dirty === 1 ? 'change stays' : 'changes stay'} where {current.dirty === 1 ? 'it is' : 'they are'}.</span>}</p>
              : <>
                <p className="of-line of-why">{current.git
                  ? <>{baseName(current.path)} isn't on GitHub yet. Kernel creates a private repo, adds it as origin and pushes {current.branch ?? 'main'}.</>
                  : <>{baseName(current.path)} isn't a git repo yet. Kernel runs git init and creates a private repo as origin. Make the first commit and push it so agents have something to branch from.</>}</p>
                <RepoNameField repo={repo} />
              </>}
          </div>
        )}
      </div>
    </Modal>
  )
}
