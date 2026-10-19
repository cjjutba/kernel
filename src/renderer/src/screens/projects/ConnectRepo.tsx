import { useEffect, useRef, useState } from 'react'
import type { GitHubAuth, GitHubErrorKind, RepoSummary } from '@shared/types'
import { githubErrorKind } from '@shared/githubError'
import { call, cleanError } from '../../api'
import { actions } from '../../store'
import { openNewChat } from '../../lead'
import { Button, EmptyList, Icon, LoadingRow, Modal, useBusy } from '../../ui'
import { defaultTeam } from './draft'
import { useAvatar } from './avatar'
import './projects.css'

const failure: Record<GitHubErrorKind, { title: string; hint?: string }> = {
  'signed-out': { title: 'GitHub is not signed in', hint: 'Run gh auth login in a terminal, then try again.' },
  'not-found': { title: 'GitHub could not find your repositories' },
  'rate-limited': { title: 'GitHub is rate limiting Kernel' },
  offline: { title: 'Could not reach GitHub', hint: 'Check your connection, then try again.' },
  other: { title: 'Could not load your repositories' }
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
 * Clone a GitHub repo (KERNEL-945): a URL, or one of your repos picked from a searchable list, and the folder it
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
  const seq = useRef(0)

  const loadRepos = (q: string) => {
    const mine = ++seq.current
    return call('github.repos', { query: q || undefined })
      .then((r) => { if (mine === seq.current) { setRepos(r); setError(null) } })
      .catch((e: unknown) => {
        if (mine !== seq.current) return
        const kind = githubErrorKind(e) ?? 'other'
        const message = cleanError(e)
        setRepos([])
        setError({ kind, message })
        // Every error is a toast too, and the list says what to do next (KERNEL-1089).
        actions.ui.toast({ title: failure[kind].title, sub: failure[kind].hint ?? message, glyph: 'error' })
      })
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
  const pick = (fullName: string) => { setPicked(fullName); setUrl(`https://github.com/${fullName}`) }
  const browse = async () => {
    const chosen = await call('system.pickFolder', undefined)
    if (chosen) setParent(chosen.replace(/^\/Users\/[^/]+/, '~'))
  }
  const clone = () => run('clone', async () => {
    if (!target) return
    try {
      const project = await call('projects.create', { source: 'repo', name, from: target, cloneTo: folder, team: defaultTeam(), autostart: false })
      actions.projects.upsert(project)
      openNewChat(project.id)
    } catch (e) { actions.ui.toast({ title: 'Could not clone the repo', sub: cleanError(e), glyph: 'error' }) }
  })
  const fail = error ? failure[error.kind] : null
  const cloning = busy === 'clone'
  const tryAgain = <Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="ripple" onClick={() => void retry()}>Try again</Button>

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
            <span className="cl-acct-note">signed in with gh</span>
          </div>
        )}
        <label className="cl-field">
          <span className="cl-label">Repository URL</span>
          <input className="cl-input mono" autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repo" value={url} onChange={(e) => { setUrl(e.target.value); setPicked('') }} />
        </label>
        {cloning && <p className="cl-sub" role="status">Kernel clones it and adds it as a project.</p>}
        {!cloning && <div className="cl-field">
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
            {repos && !repos.length && error && (
              <EmptyList icon={error.kind === 'offline' ? 'wifioff' : 'warning'} title={fail!.title} action={tryAgain}>{fail!.hint ?? error.message}</EmptyList>
            )}
            {repos && !repos.length && !error && (query.trim()
              ? <EmptyList icon="search" title="No repositories match">Paste a repository URL above instead.</EmptyList>
              : <EmptyList icon="branch" title="This account has no repositories" action={tryAgain}>Paste a repository URL above instead.</EmptyList>)}
          </div>
        </div>}
        <div className="cl-field">
          <label className="cl-label" htmlFor="cl-loc">Location</label>
          <div className="row">
            <input id="cl-loc" className="cl-input mono grow" autoComplete="off" spellCheck={false} value={parent} onChange={(e) => setParent(e.target.value)} />
            <Button size="lg" onClick={() => void browse()}>Browse…</Button>
          </div>
          <span className="cl-hint">{name ? <>Clones into <span className="mono">{folder}</span></> : 'Pick a repo or paste its URL'}</span>
        </div>
      </div>
    </Modal>
  )
}
