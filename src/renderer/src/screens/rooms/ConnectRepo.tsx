import { useEffect, useRef, useState } from 'react'
import type { RepoSummary } from '@shared/types'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Button, Icon, Modal } from '../../ui'
import { agoShort } from './roomInfo'
import { cloneFolder, getDraft, patchDraft, titleOf } from './draft'
import './rooms.css'

/** The login from the first-run GitHub check ("Signed in as cjjutba"). */
function useLogin() {
  return useStore((s) => /as (\S+)/.exec(s.system.preflight?.find((c) => c.id === 'gh')?.detail ?? '')?.[1])
}

/** ConnectRepo.png: pick one of your GitHub repos. New room does the cloning. */
export function ConnectRepo() {
  const login = useLogin()
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(getDraft().source === 'repo' ? getDraft().from : '')
  const [error, setError] = useState<string | null>(null)
  const [cloneTo, setCloneTo] = useState(getDraft().cloneTo)
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    const t = setTimeout(() => {
      call('github.repos', { query: query.trim() || undefined })
        .then((r) => { if (mine === seq.current) { setRepos(r); setError(null); setPicked((p) => p || (query ? '' : r[0]?.fullName ?? '')) } })
        .catch((e: Error) => { if (mine === seq.current) { setRepos([]); setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) } })
    }, query ? 200 : 0)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => { const t = setTimeout(() => document.getElementById('repo-q')?.focus(), 0); return () => clearTimeout(t) }, [])
  const back = () => (getDraft().name ? actions.ui.openModal({ name: 'newRoom' }) : actions.ui.closeModal())
  const repoName = picked.split('/').pop() ?? ''
  const where = cloneFolder({ cloneTo, from: picked, name: '', source: 'repo' })
  const connect = () => {
    const d = getDraft()
    patchDraft({ source: 'repo', from: picked, cloneTo, baseBranch: '', initGit: false, name: d.named ? d.name : titleOf(repoName) })
    actions.ui.openModal({ name: 'newRoom' })
  }
  const chooseFolder = async () => {
    const parent = await call('system.pickFolder', undefined)
    if (parent) setCloneTo(`${parent.replace(/\/+$/, '')}/${repoName || 'repo'}`)
  }

  return (
    <Modal
      title="Connect a repo" onClose={back} width={600} top={96}
      footer={
        <>
          <span className="cr-where">Clones to <span className="mono">{where}</span>{picked && <button type="button" className="cr-link" onClick={() => void chooseFolder()}>Change</button>}</span>
          <span className="grow" />
          <Button variant="ghost" size="lg" onClick={back}>Cancel</Button>
          <Button variant="primary" size="lg" disabled={!picked} onClick={connect}>Connect repo</Button>
        </>
      }
    >
      <p className="rm-sub">Agents clone it and work on branches. Nothing is pushed without your OK.</p>
      <div className="rm-pad">
        <div className="cr-acct">
          <span className="rm-av" aria-hidden="true">{(login ?? 'gh').slice(0, 2)}</span>
          <span className="col grow"><span style={{ fontWeight: 500 }}>{login ?? 'GitHub'}</span><span className="cr-sub">Signed in through the GitHub CLI</span></span>
          <Button variant="ghost" onClick={() => actions.ui.toast({ title: 'Run gh auth switch in a terminal', sub: 'Then search again.' })}>Switch account</Button>
        </div>
        <div className="cr-search">
          <Icon name="search" size={14} />
          <label htmlFor="repo-q" className="sr-only">Search your repositories</label>
          <input id="repo-q" autoComplete="off" placeholder="Search your repositories" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div role="radiogroup" aria-label="Repositories" className="cr-list" aria-busy={!repos}>
          {repos?.map((r) => {
            const [owner, name] = r.fullName.split('/')
            return (
              <button key={r.fullName} type="button" role="radio" aria-checked={picked === r.fullName} className="cr-repo" onClick={() => setPicked(r.fullName)}>
                <Icon name="branch" size={15} />
                <span className="grow mono ellipsis" style={{ fontSize: 12.5 }}><span className="muted">{owner}/</span>{name}</span>
                <span className="cr-vis">{r.private ? 'Private' : 'Public'}</span>
                <span className="cr-ago">{agoShort(r.updatedAt)}</span>
              </button>
            )
          })}
          {repos && !repos.length && <p className="muted" role={error ? 'alert' : 'status'} style={{ margin: 0, padding: '10px 12px' }}>{error ?? 'No repositories match.'}</p>}
        </div>
      </div>
    </Modal>
  )
}

