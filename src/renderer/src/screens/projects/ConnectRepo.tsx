import { useEffect, useRef, useState } from 'react'
import type { GitHubAuth, GitHubErrorKind, RepoSummary } from '@shared/types'
import { githubErrorKind } from '@shared/githubError'
import { call, cleanError } from '../../api'
import { actions } from '../../store'
import { Banner, Button, EmptyList, Icon, LoadingRow, Modal, useBusy } from '../../ui'
import { agoShort } from './projectInfo'
import { cloneFolder, getDraft, patchDraft, titleOf } from './draft'
import './projects.css'

const failure: Record<GitHubErrorKind, { kind: 'auth' | 'offline' | 'limit' | 'setup'; title: string }> = {
  'signed-out': { kind: 'auth', title: 'GitHub is not signed in' },
  'not-found': { kind: 'setup', title: 'GitHub could not find your repositories' },
  'rate-limited': { kind: 'limit', title: 'GitHub is rate limiting Kernel' },
  offline: { kind: 'offline', title: 'Could not reach GitHub' },
  other: { kind: 'setup', title: 'Could not load your repositories' }
}

const account = (auth: GitHubAuth | null): { name: string; sub: string } => {
  if (!auth) return { name: 'GitHub', sub: 'Checking the GitHub CLI' }
  if (auth.state === 'ok') return { name: auth.login ?? 'GitHub', sub: 'Signed in through the GitHub CLI' }
  if (auth.state === 'missing') return { name: 'GitHub', sub: 'The GitHub CLI is not installed' }
  if (auth.state === 'signed-out') return { name: 'GitHub', sub: 'Not signed in. Run gh auth login in a terminal.' }
  return { name: auth.login ?? 'GitHub', sub: 'Could not check the sign-in' }
}

/** ConnectRepo.png: pick one of your GitHub repos. New project does the cloning. */
export function ConnectRepo() {
  const [auth, setAuth] = useState<GitHubAuth | null>(null)
  const [busy, run] = useBusy<'retry'>()
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(getDraft().source === 'repo' ? getDraft().from : '')
  const [error, setError] = useState<{ kind: GitHubErrorKind; message: string } | null>(null)
  const [cloneTo, setCloneTo] = useState(getDraft().cloneTo)
  const seq = useRef(0)

  const loadRepos = (q: string) => {
    const mine = ++seq.current
    return call('github.repos', { query: q || undefined })
      .then((r) => { if (mine === seq.current) { setRepos(r); setError(null); setPicked((p) => p || (q ? '' : r[0]?.fullName ?? '')) } })
      .catch((e: unknown) => { if (mine === seq.current) { setRepos([]); setError({ kind: githubErrorKind(e) ?? 'other', message: cleanError(e) }) } })
  }
  const loadAuth = () => call('github.auth', undefined).then(setAuth, () => setAuth({ state: 'offline' }))
  useEffect(() => {
    const t = setTimeout(() => void loadRepos(query.trim()), query ? 200 : 0)
    return () => clearTimeout(t)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void loadAuth() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => run('retry', async () => {
    setRepos(null)
    setError(null)
    await Promise.all([loadRepos(query.trim()), loadAuth()])
  })
  const switchAccount = () => actions.ui.toast({ title: 'Run gh auth switch in a terminal', sub: 'Then try again.' })

  useEffect(() => { const t = setTimeout(() => document.getElementById('repo-q')?.focus(), 0); return () => clearTimeout(t) }, [])
  const back = () => (getDraft().name ? actions.ui.openModal({ name: 'newProject' }) : actions.ui.closeModal())
  const repoName = picked.split('/').pop() ?? ''
  const who = account(auth)
  const fail = error ? failure[error.kind] : null
  const where = cloneFolder({ cloneTo, from: picked, name: '', source: 'repo' })
  const connect = () => {
    const d = getDraft()
    patchDraft({ source: 'repo', from: picked, cloneTo, baseBranch: '', initGit: false, name: d.named ? d.name : titleOf(repoName) })
    actions.ui.openModal({ name: 'newProject' })
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
          <span className="rm-av" aria-hidden="true">{who.name.slice(0, 2)}</span>
          <span className="col grow"><span style={{ fontWeight: 500 }}>{who.name}</span><span className="cr-sub">{who.sub}</span></span>
          <Button variant="ghost" onClick={switchAccount}>Switch account</Button>
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
                <Icon name="branch" size={16} />
                <span className="grow mono ellipsis" style={{ fontSize: 12.5 }}><span className="muted">{owner}/</span>{name}</span>
                <span className="cr-vis">{r.private ? 'Private' : 'Public'}</span>
                <span className="cr-ago">{agoShort(r.updatedAt)}</span>
              </button>
            )
          })}
          {!repos && <LoadingRow what="repositories" />}
          {repos && !repos.length && fail && error && (
            <Banner
              kind={fail.kind} title={fail.title}
              actions={<>
                {error.kind === 'signed-out' && <Button size="md" onClick={switchAccount}>Switch account</Button>}
                <Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void retry()}>Try again</Button>
              </>}
            >{error.message}</Banner>
          )}
          {repos && !repos.length && !error && (query.trim()
            ? <p className="muted" role="status" style={{ margin: 0, padding: '10px 12px' }}>No repositories match.</p>
            : <EmptyList icon="branch" title="This account has no repositories" action={<Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void retry()}>Try again</Button>}>Create or fork one on GitHub, then try again.</EmptyList>)}
        </div>
      </div>
    </Modal>
  )
}

