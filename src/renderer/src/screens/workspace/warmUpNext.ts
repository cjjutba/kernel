import { useEffect } from 'react'
import { getState, isFixture, lastProject } from '../../store'
import { refreshUpNext } from './upNextCache'

/**
 * Asks for Up next once the app has loaded, for the project the user was last in (or the first one), so the cache is warm before
 * New chat opens. A fixture has no tracker to ask.
 */
export function useWarmUpNext(booted: boolean) {
  useEffect(() => {
    if (!booted || isFixture()) return
    const { projects } = getState()
    const id = projects.find((p) => p.id === lastProject())?.id ?? projects[0]?.id
    if (id) void refreshUpNext(id)
  }, [booted])
}
