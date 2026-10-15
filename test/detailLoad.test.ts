// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { resetIssuesCache } from '../src/renderer/src/screens/issues/cache'
import { useDetailLoad } from '../src/renderer/src/screens/issues/useDetailLoad'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('useDetailLoad', () => {
  let root: Root | null = null
  afterEach(() => { act(() => root?.unmount()); root = null; resetIssuesCache() })

  it('a retry waits for its own request, not for an older one that finishes first', async () => {
    const pending: { resolve: (v: string) => void }[] = []
    let retry!: () => Promise<void>
    let loaded: string | null = null
    function Probe() {
      const r = useDetailLoad<string>('#1', 'linear||#1', () => new Promise<string>((resolve) => pending.push({ resolve })), [])
      retry = r.retry
      loaded = r.loaded
      return null
    }
    root = createRoot(document.createElement('div'))
    act(() => root!.render(React.createElement(Probe)))
    expect(pending).toHaveLength(1)
    let done = false
    act(() => { void retry().then(() => { done = true }) })
    expect(pending).toHaveLength(2)
    await act(async () => { pending[0].resolve('old'); await Promise.resolve() })
    expect(done).toBe(false)
    expect(loaded).toBeNull()
    await act(async () => { pending[1].resolve('new'); await Promise.resolve() })
    expect(done).toBe(true)
    expect(loaded).toBe('new')
  })
})
