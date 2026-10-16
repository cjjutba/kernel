import { useEffect, useRef, useState } from 'react'
import type { GitHubAuth, GitHubErrorKind, RepoSummary } from '@shared/types'
import { githubErrorKind } from '@shared/githubError'
import { call, cleanError } from '../../api'
import { actions, go } from '../../store'
import { Banner, Button, EmptyList, Icon, LoadingRow, Modal, useBusy } from '../../ui'
import { defaultTeam } from './draft'
import { useAvatar } from './avatar'
import './projects.css'

const failure: Record<GitHubErrorKind, { kind: 'auth' | 'offline' | 'limit' | 'setup'; title: string }> = {
  'signed-out': { kind: 'auth', title: 'GitHub is not signed in' },
  'not-found': { kind: 'setup', title: 'GitHub could not find your repositories' },
  'rate-limited': { kind: 'limit', title: 'GitHub is rate limiting Kernel' },
  offline: { kind: 'offline', title: 'Could not reach GitHub' },
  other: { kind: 'setup', title: 'Could not load your repositories' }
}

/** `owner/name` from a GitHub URL, ssh or https, or from `owner/name` typed as is. Nothing for anything else. */
export function repoOfUrl(text: string): string | undefined {
  const t = text.trim()
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(t) ?? /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(t) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(t)
  return m ? `${m[1]}/${m[2]}` : undefined
}

/** An owner's avatar, or their initials while it loads or when there is none. */
function Avatar({ owner, size }: { owner: string; size: number }) {
  const src = useAvatar(owner)
  return src
    ? <img className="cl-av" src={src} alt="" width={size} height={size} />
    : <span className="cl-av cl-av-none" style={{ width: size, height: size }} aria-hidden="true">{owner.slice(0, 2)}</span>
}

/**
 * Clone a GitHub repo (KERNEL-945), as Conductor does: a URL, or one of your repos picked from a searchable list, and the folder it
 * goes in. Clone creates the project at once and setup runs; there is no second form.
 */
export function ConnectRepo() {
  const [auth, setAuth] = useState<GitHubAuth | null>(null)
  const [busy, run] = useBusy<'retry' | 'clone'>()
  const [repos, setRepos] = useState<RepoSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [url, setUrl] = useState('')
  const [picked, setPicked] = useState('')
  const [parent, setParent] = useState('~/Projects')
  const [error, setError] = useState<{ kind: GitHubErrorKind; message: string } | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const seq = useRef(0)

  const loadRepos = (q: string) => {
    const mine = ++seq.current
    return call('github.repos', { query: q || undefined })
      .then((r) => { if (mine === seq.current) { setRepos(r); setError(null) } })
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

  const login = auth?.state === 'ok' ? auth.login : undefined
  // A typed URL wins over a picked row, and typing clears the pick.
  const target = repoOfUrl(url) ?? (picked || undefined)
  const name = target?.split('/')[1] ?? ''
  const folder = `${parent.replace(/\/+$/, '')}/${name}`
  const pick = (fullName: string) => { setPicked(fullName); setUrl(`https://github.com/${fullName}`); setCloneError(null) }
  const browse = async () => {
    const chosen = await call('system.pickFolder', undefined)
    if (chosen) setParent(chosen.replace(/^\/Users\/[^/]+/, '~'))
  }
  const clone = () => run('clone', async () => {
    if (!target) return
    setCloneError(null)
    try {
      const project = await call('projects.create', { source: 'repo', name, from: target, cloneTo: folder, team: defaultTeam(), autostart: false })
      actions.projects.upsert(project)
      go({ name: 'onboarding', step: 'project', projectId: project.id })
    } catch (e) { setCloneError(cleanError(e)) }
  })
  const fail = error ? failure[error.kind] : null

  return (
    <Modal
      title="Clone a GitHub repo" onClose={actions.ui.closeModal} width={560} top={96}
      footer={
        <>
          <span className="grow" />
          <Button variant="ghost" size="lg" onClick={actions.ui.closeModal}>Cancel</Button>
          <Button variant="primary" size="lg" disabled={!target} busy={busy === 'clone'} busyLabel="Cloning" onClick={() => void clone()} aria-keyshortcuts="Meta+Enter">Clone repo <span className="cl-kbd" aria-hidden="true">⌘↵</span></Button>
        </>
      }
    >
      <div className="rm-pad cl-body" onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey && target) { e.preventDefault(); void clone() } }}>
        {login && (
          <div className="cl-acct">
            <Avatar owner={login} size={20} />
            <span>{login}</span>
          </div>
        )}
        <label className="cl-field">
          <span className="cl-label">Repository URL</span>
          <input className="cl-input mono" autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repo" value={url} onChange={(e) => { setUrl(e.target.value); setPicked('') }} />
        </label>
        <div className="cl-field">
          <span className="cl-label" id="cl-repos">Your repositories</span>
          <div className="cr-search">
            <Icon name="search" size={14} />
            <label htmlFor="repo-q" className="sr-only">Search your repositories</label>
            <input id="repo-q" autoComplete="off" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div role="radiogroup" aria-labelledby="cl-repos" className="cl-list" aria-busy={!repos}>
            {repos?.map((r) => {
              const [owner, repo] = r.fullName.split('/')
              return (
                <button key={r.fullName} type="button" role="radio" aria-checked={target === r.fullName} className="cl-repo" onClick={() => pick(r.fullName)}>
                  <Avatar owner={owner} size={28} />
                  <span className="col grow cl-repo-text">
                    <span className="ellipsis"><span className="muted">{owner}/</span>{repo}</span>
                    {r.description && <span className="cl-desc ellipsis">{r.description}</span>}
                  </span>
                  {r.private && <Icon name="lock" size={14} />}
                  {target === r.fullName && <Icon name="check" size={14} />}
                </button>
              )
            })}
            {!repos && <LoadingRow what="repositories" />}
            {repos && !repos.length && fail && error && (
              <Banner kind={fail.kind} title={fail.title} actions={<Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void retry()}>Try again</Button>}>
                {error.kind === 'signed-out' ? 'Run gh auth login in a terminal, then try again.' : error.message}
              </Banner>
            )}
            {repos && !repos.length && !error && (query.trim()
              ? <p className="muted cr-empty" role="status">No repositories match.</p>
              : <EmptyList icon="branch" title="This account has no repositories">Paste a repository URL above instead.</EmptyList>)}
          </div>
        </div>
        <div className="cl-field">
          <label className="cl-label" htmlFor="cl-loc">Location</label>
          <div className="row">
            <input id="cl-loc" className="cl-input mono grow" autoComplete="off" spellCheck={false} value={parent} onChange={(e) => setParent(e.target.value)} />
            <Button size="lg" onClick={() => void browse()}>Browse…</Button>
          </div>
          <span className="cl-hint">{name ? <>Clones into <span className="mono">{folder}</span></> : 'Pick a repo or paste its URL'}</span>
        </div>
        {cloneError && <p className="cl-error" role="alert">{cloneError}</p>}
      </div>
    </Modal>
  )
}
