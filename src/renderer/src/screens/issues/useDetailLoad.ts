import { useEffect, useRef, useState } from 'react'
import { cleanError } from '../../api'

/**
 * Loads an issue's detail for `id` again whenever `deps` change. `retry` runs another load and settles when that load does, so a request
 * an earlier load left in flight never ends it. `failure` names the id it belongs to.
 */
export function useDetailLoad<T>(id: string, load: () => Promise<T>, deps: readonly unknown[]) {
  const [loaded, setLoaded] = useState<T | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const waiting = useRef<(() => void)[]>([])
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    load().then((d) => { if (live) { setLoaded(d); setFailure(null) } }).catch((e: Error) => { if (live) setFailure({ id, message: cleanError(e) }) }).finally(() => { if (live) waiting.current.splice(0).forEach((done) => done()) })
    return () => { live = false }
  }, [id, attempt, ...deps])
  const retry = () => {
    setAttempt((a) => a + 1)
    return new Promise<void>((done) => waiting.current.push(done))
  }
  return { loaded, failure, retry }
}
