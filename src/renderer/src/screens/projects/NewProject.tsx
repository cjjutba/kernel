import { useEffect, useId, useState } from 'react'
import type { NewProjectPrefill } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go } from '../../store'
import { Button, Modal, useBusy } from '../../ui'
import { defaultTeam } from './draft'
import { RepoNameField, useRepoName } from './RepoName'
import './projects.css'

/** "Habit tracker" becomes "habit-tracker": the folder's name. */
const folderOf = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * New project from scratch (KERNEL-947): a name, where the folder goes, and its private GitHub repo. It is always an empty repo
 * with a README; Kernel makes it, commits it and pushes it (KERNEL-944). Cloning and opening a folder have their own dialogs, so
 * a prefill for either opens that one instead.
 */
export function NewProject({ prefill }: { prefill?: NewProjectPrefill }) {
  useEffect(() => {
    if (prefill?.source === 'repo') actions.ui.openModal({ name: 'connectRepo' })
    else if (prefill?.source === 'folder') actions.ui.openModal({ name: 'openFolder' })
  }, [])
  const [name, setName] = useState(prefill?.source === 'scratch' ? prefill.name : '')
  const [parent, setParent] = useState('~/Projects')
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const repo = useRepoName(folderOf(name))
  const id = useId()

  const folder = folderOf(name)
  const ready = !!folder && repo.ready
  const browse = async () => {
    const chosen = await call('system.pickFolder', undefined)
    if (chosen) setParent(chosen.replace(/^\/Users\/[^/]+/, '~'))
  }
  const create = () => run('create', async () => {
    if (!ready) return
    setError(null)
    try {
      const project = await call('projects.create', {
        source: 'scratch', name: name.trim(), from: '', cloneTo: `${parent.replace(/\/+$/, '')}/${folder}`, team: defaultTeam(), autostart: false,
        github: { owner: repo.owner, name: repo.name }
      })
      actions.projects.upsert(project)
      go({ name: 'onboarding', step: 'project', projectId: project.id })
    } catch (e) { setError(cleanError(e)) }
  })

  return (
    <Modal
      title="New project" onClose={actions.ui.closeModal} width={560} top={112}
      footer={
        <>
          <span className="nps-other">Or <button type="button" className="cr-link" onClick={() => actions.ui.openModal({ name: 'connectRepo' })}>clone a repo</button> or <button type="button" className="cr-link" onClick={() => actions.ui.openModal({ name: 'openFolder' })}>open a folder</button></span>
          <span className="grow" />
          <Button variant="ghost" size="lg" onClick={actions.ui.closeModal}>Cancel</Button>
          <Button variant="primary" size="lg" disabled={!ready} busy={busy !== null} busyLabel="Creating" onClick={() => void create()}>Create project</Button>
        </>
      }
    >
      <form className="nps-body" onSubmit={(e) => { e.preventDefault(); void create() }}>
        <p className="nps-intro">Kernel makes the folder with a README, runs <code>git init</code>, creates a private GitHub repo as <code>origin</code> and pushes <code>main</code>.</p>
        <div className="nps-field">
          <label className="rn-label" htmlFor={`${id}n`}>Name</label>
          <input id={`${id}n`} className="rn-input" autoComplete="off" placeholder="Habit tracker" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </div>
        <div className="nps-field">
          <label className="rn-label" htmlFor={`${id}l`}>Location</label>
          <div className="row" style={{ gap: 8 }}>
            <input id={`${id}l`} className="rn-input mono grow" autoComplete="off" spellCheck={false} value={parent} onChange={(e) => setParent(e.target.value)} />
            <Button size="lg" onClick={() => void browse()}>Change…</Button>
          </div>
          <span className="nps-hint">{folder ? <>Creates <span className="mono">{parent.replace(/\/+$/, '')}/{folder}</span></> : 'Name it to see where it goes'}</span>
        </div>
        <RepoNameField repo={repo} label />
        {error && <p className="del of-err" role="alert">{error}</p>}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  )
}
