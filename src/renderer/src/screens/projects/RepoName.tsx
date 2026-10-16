import { useEffect, useRef, useState } from 'react'
import type { GitHubOwner } from '@shared/types'
import { call, cleanError } from '../../api'
import { Icon, Select } from '../../ui'
import { useAvatar } from './avatar'

/** Owners, asked of gh once per window: they rarely change while a dialog is open (KERNEL-944). */
let owners: Promise<GitHubOwner[]> | undefined

type Check = { state: 'idle' | 'checking' | 'available' | 'taken' | 'error'; reason?: string }

/** A repo name GitHub keeps as typed: spaces and other characters become dashes. */
export const repoSlug = (s: string) => s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * The owner and name of a new private GitHub repo, with a debounced check that the name is free (KERNEL-944). The name follows
 * `suggested` until it is typed in. `ready` is true once the name is checked and free.
 */
export function useRepoName(suggested: string) {
  const [list, setList] = useState<GitHubOwner[] | null>(null)
  const [owner, setOwner] = useState('')
  const [typed, setTyped] = useState<string | null>(null)
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [listError, setListError] = useState<string | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    owners ??= call('github.owners', undefined)
    owners.then((o) => { setList(o); setOwner((cur) => cur || o[0]?.login || '') }, (e: unknown) => { owners = undefined; setList([]); setListError(cleanError(e)) })
  }, [])
  // A new folder or project name starts the name over.
  useEffect(() => { setTyped(null) }, [suggested])
  const name = typed ?? repoSlug(suggested)
  useEffect(() => {
    if (!owner || !name) { setCheck({ state: 'idle' }); return }
    const mine = ++seq.current
    setCheck({ state: 'checking' })
    const t = setTimeout(() => {
      call('github.repoAvailable', { owner, name }).then(
        (r) => { if (mine === seq.current) setCheck(r.available ? { state: 'available' } : { state: 'taken', reason: r.reason }) },
        (e: unknown) => { if (mine === seq.current) setCheck({ state: 'error', reason: cleanError(e) }) }
      )
    }, 300)
    return () => clearTimeout(t)
  }, [owner, name])
  return { owners: list, owner, setOwner, name, setName: (n: string) => setTyped(n), check, listError, ready: !!owner && !!name && check.state === 'available' }
}

/** Owner / name, and what the check found. Shared by Open a folder and New project. */
export function RepoNameField({ repo, label }: { repo: ReturnType<typeof useRepoName>; label?: boolean }) {
  const { owners: list, owner, setOwner, name, setName, check, listError } = repo
  const avatar = useAvatar(owner)
  return (
    <div className="rn">
      {label && <div className="rn-labels"><span className="rn-label">GitHub owner</span><span className="rn-label">Repository name</span></div>}
      <div className="rn-row">
        <Select className="rn-owner" label="GitHub owner" value={owner} onChange={setOwner} disabled={!list?.length}
          leading={avatar ? <img className="rn-av" src={avatar} alt="" /> : <span className="rn-av" aria-hidden="true">{owner.slice(0, 2)}</span>}
          options={(list ?? []).map((o) => ({ value: o.login, label: o.login }))} />
        <span className="rn-slash" aria-hidden="true">/</span>
        <input aria-label="Repository name" className="rn-input rn-name" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <p className="rn-status" role="status">
        {listError
          ? <span className="del">{listError}</span>
          : check.state === 'available'
            ? <><Icon name="check" size={12} /><span>Private repo <span className="mono">{owner}/{name}</span> is available</span></>
            : check.state === 'checking'
              ? <span>Checking <span className="mono">{owner}/{name}</span></span>
              : check.reason ? <span className="del">{check.reason}</span> : <span>&nbsp;</span>}
      </p>
    </div>
  )
}
