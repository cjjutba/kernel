import { useEffect, useRef, useState } from 'react'
import { cleanError } from '../../api'
import { generation, peekDetail, setDetail } from './cache'

/**
 * Loads an issue's detail for `id` again whenever `deps` change. `cacheKey` names the cached copy: it shows at once, the load always runs
 * behind it, and a failed load keeps it (KERNEL-892). `retry` runs another load and settles when that load does, so a request an earlier
 * load left in flight never ends it. `failure` names the id it belongs to.
 */
export function useDetailLoad<T>(id: string, cacheKey: string, load: () => Promise<T>, deps: readonly unknown[]) {
  const [fresh, setFresh] = useState<{ key: string; value: T } | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const waiting = useRef<(() => void)[]>([])
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    const gen = generation()
    load().then((d) => {
      setDetail(cacheKey, d, gen)
      if (live) { setFresh({ key: cacheKey, value: d }); setFailure(null) }
    }).catch((e: Error) => { if (live) setFailure({ id, message: cleanError(e) }) }).finally(() => { if (live) waiting.current.splice(0).forEach((done) => done()) })
    return () => { live = false }
  }, [id, cacheKey, attempt, ...deps])
  const loaded: T | null = fresh?.key === cacheKey ? fresh.value : peekDetail<T>(cacheKey)?.value ?? null
  const retry = () => {
    setAttempt((a) => a + 1)
    return new Promise<void>((done) => waiting.current.push(done))
  }
  return { loaded, failure, retry }
}
