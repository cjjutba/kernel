import { useEffect, useState } from 'react'
import type { FolderInfo } from '@shared/types'
import { call } from '../../api'
import { actions } from '../../store'
import { Button, Icon, Modal } from '../../ui'
import { baseName, getDraft, patchDraft, tilde, titleOf } from './draft'
import './rooms.css'

const sub = (f: FolderInfo) => (!f.git ? 'Not a git repository' : `git · ${f.branch ?? 'main'} · ${f.dirty ? `${f.dirty} uncommitted ${f.dirty === 1 ? 'change' : 'changes'}` : 'clean'}`)

/** OpenFolder.png: choose a folder on this Mac, or one of the recent ones. New room does the rest. */
export function OpenFolder() {
  const [folders, setFolders] = useState<FolderInfo[] | null>(null)
  const [picked, setPicked] = useState(getDraft().source === 'folder' ? getDraft().from : '')
  const [init, setInit] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { const t = setTimeout(() => document.querySelector<HTMLElement>('[role=dialog]')?.focus(), 0); return () => clearTimeout(t) }, [])
  useEffect(() => { void call('rooms.recentFolders', undefined).then(setFolders, () => setFolders([])) }, [])

  const add = (f: FolderInfo) => { setFolders((list) => [f, ...(list ?? []).filter((x) => x.path !== f.path)]); setPicked(f.path); setError(null) }
  const choose = async () => {
    const path = await call('system.pickFolder', undefined)
    if (!path) return
    try { add(await call('rooms.inspectFolder', { path })) } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  }
  const back = () => (getDraft().name ? actions.ui.openModal({ name: 'newRoom' }) : actions.ui.closeModal())
  const current = folders?.find((f) => f.path === picked)
  const open = () => {
    if (!current) return
    const d = getDraft()
    patchDraft({ source: 'folder', from: current.path, baseBranch: current.branch ?? 'main', initGit: init === current.path, cloneTo: undefined, name: d.named ? d.name : titleOf(baseName(current.path)) })
    actions.ui.openModal({ name: 'newRoom' })
  }

  return (
    <Modal
      title="Open a folder" onClose={back} width={600} top={96}
      footer={
        <>
          <span className="cr-where">Workspaces use worktrees by default</span>
          <span className="grow" />
          <Button variant="ghost" size="lg" onClick={back}>Cancel</Button>
          <Button variant="primary" size="lg" disabled={!current || (!current.git && init !== current.path)} onClick={open}>Open folder</Button>
        </>
      }
    >
      <p className="rm-sub">Point a room at a project that already lives on your Mac.</p>
      <div className="rm-pad" style={{ gap: 14 }}>
        <div className="of-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setError('Kernel cannot read a dropped folder yet. Use Choose folder.') }}>
          <Icon name="folder" size={20} />
          <span style={{ color: 'var(--ink-2)' }}>Drop a project folder here</span>
          <Button onClick={() => void choose()}>Choose folder</Button>
        </div>
        {error && <p role="alert" className="del" style={{ margin: 0, fontSize: 12.5 }}>{error}</p>}
        <p className="nr-label" style={{ margin: 0 }}>Recent folders</p>
        <div role="radiogroup" aria-label="Recent folders" className="cr-list" style={{ marginTop: -6 }} aria-busy={!folders}>
          {folders?.map((f) => (
            <div key={f.path} className="of-rowwrap">
              <button type="button" role="radio" aria-checked={picked === f.path} className="cr-repo of-row" onClick={() => setPicked(f.path)}>
                <Icon name="folder" size={15} />
                <span className="col grow">
                  <span className="mono" style={{ fontSize: 12.5 }}>{tilde(f.path)}</span>
                  <span className="cr-sub" style={{ color: f.dirty ? 'var(--ink-2)' : undefined }}>{sub(f)}</span>
                </span>
              </button>
              {!f.git && <button type="button" className="of-init" aria-pressed={init === f.path} onClick={() => { setPicked(f.path); setInit(init === f.path ? null : f.path) }}>{init === f.path ? 'Will initialize git' : 'Initialize git'}</button>}
            </div>
          ))}
          {folders && !folders.length && <p className="muted" style={{ margin: 0, padding: '10px 12px' }}>No recent folders. Use Choose folder.</p>}
        </div>
        {!!current?.dirty && <p className="of-note">The {current.dirty} uncommitted {current.dirty === 1 ? 'change stays' : 'changes stay'}. Current-branch workspaces treat them as the baseline.</p>}
      </div>
    </Modal>
  )
}
