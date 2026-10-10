import { useCallback, useEffect, useRef, useState } from 'react'
import { call } from '../../api'

/** What `env.get` returns: names only. A value only ever comes from `env.reveal`, and stays in the component that asked. */
export interface EnvList { names: string[]; files: { path: string; missing: boolean }[] }

const listeners = new Set<() => void>()

/** The add form and Delete tell every open Environment page to read the list again. */
export const envChanged = () => listeners.forEach((l) => l())

/**
 * The names and env files of one scope: a room, or the app with no `roomId`. They sit in component state, not the store, and
 * `reload` runs again when the form or Delete saves. `env` is null until the first answer, and `error` is main's message
 * when the read failed.
 */
export function useEnv(roomId?: string) {
  const [env, setEnv] = useState<EnvList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++latest.current
    try {
      const next = await call('env.get', { roomId })
      if (mine === latest.current) { setEnv(next); setError(null) }
    } catch (e) {
      if (mine === latest.current) setError((e as Error).message)
    }
  }, [roomId])
  useEffect(() => {
    setEnv(null)
    void reload()
    listeners.add(reload)
    return () => { listeners.delete(reload) }
  }, [reload])
  return { env, error, reload }
}
