import { useEffect, useState } from 'react'
import { call } from '../../api'

/** The login the GitHub CLI is signed in as, for the Work header. Undefined while it is read, or when gh is missing, signed out or offline. */
export function useGithubLogin(): string | undefined {
  const [login, setLogin] = useState<string>()
  useEffect(() => {
    let live = true
    call('github.auth', undefined).then((a) => { if (live) setLogin(a.state === 'ok' ? a.login : undefined) }, () => undefined)
    return () => { live = false }
  }, [])
  return login
}
