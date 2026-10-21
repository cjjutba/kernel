import { useEffect, useState } from 'react'
import type { GitHubAuth } from '@shared/types'
import { call } from '../../api'

/** gh's sign-in, read once. Undefined while it is read or when the read fails. */
export function useGithubAuth(): GitHubAuth | undefined {
  const [auth, setAuth] = useState<GitHubAuth>()
  useEffect(() => {
    let live = true
    call('github.auth', undefined).then((a) => { if (live) setAuth(a) }, () => undefined)
    return () => { live = false }
  }, [])
  return auth
}

/** The login the GitHub CLI is signed in as, for the Work header. Undefined while it is read, or when gh is missing, signed out or offline. */
export function useGithubLogin(): string | undefined {
  const auth = useGithubAuth()
  return auth?.state === 'ok' ? auth.login : undefined
}
