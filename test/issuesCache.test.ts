import { afterEach, describe, expect, it } from 'vitest'
import type { GithubIssue, LinearIssue, LinearScope, ProjectTracker } from '../src/shared/types'
import {
  detailKey, FRESH_MS, forgetAll, forgetLinear, forgetTracker, forgetTrackers, generation, getGithubList, getLinearLists, getScope, getSelected, getTracker, isFresh, MAX_DETAILS, MAX_LISTS,
  peekDetail, resetIssuesCache, setDetail, setGithubList, setLinearLists, setScope, setSelected, setTracker, touchDetail
} from '../src/renderer/src/screens/issues/cache'
import { serializeFilter } from '../src/renderer/src/screens/issues/model'

const scope: LinearScope = { teams: [{ id: 't1', key: 'KERNEL', name: 'Kernel' }], projects: [], cycles: [] }
const linear: ProjectTracker = { kind: 'linear', available: { linear: true } }
const none: ProjectTracker = { kind: 'none', available: { linear: false } }
const lists = (n: number) => ({ mine: [{ id: `K-${n}` } as LinearIssue], all: [{ id: `K-${n}` } as LinearIssue] })
const filterKey = (n: number) => serializeFilter({ mine: false, teamId: `t${n}` })
const gh = (id: string) => [{ id } as GithubIssue]

afterEach(() => resetIssuesCache())

describe('trackers, scope and lists', () => {
  it('keeps a tracker per project', () => {
    setTracker('a', linear)
    setTracker('b', none)
    expect(getTracker('a')?.value).toEqual(linear)
    expect(getTracker('b')?.value).toEqual(none)
    expect(getTracker('c')).toBeUndefined()
  })

  it('keys Linear lists by the filter and drops the oldest past the cap', () => {
    for (let n = 0; n < MAX_LISTS + 2; n++) setLinearLists(filterKey(n), lists(n))
    expect(getLinearLists(filterKey(0))).toBeUndefined()
    expect(getLinearLists(filterKey(1))).toBeUndefined()
    expect(getLinearLists(filterKey(2))?.value.all[0].id).toBe('K-2')
    expect(getLinearLists(filterKey(MAX_LISTS + 1))).toBeDefined()
  })

  it('a rewritten list counts as the newest', () => {
    for (let n = 0; n < MAX_LISTS; n++) setLinearLists(filterKey(n), lists(n))
    setLinearLists(filterKey(0), lists(100))
    setLinearLists(filterKey(99), lists(99))
    expect(getLinearLists(filterKey(0))?.value.all[0].id).toBe('K-100')
    expect(getLinearLists(filterKey(1))).toBeUndefined()
  })

  it('keeps one GitHub list per project', () => {
    setGithubList('a', gh('#1'))
    setGithubList('b', gh('#2'))
    expect(getGithubList('a')?.value[0].id).toBe('#1')
    expect(getGithubList('b')?.value[0].id).toBe('#2')
  })
})

describe('details', () => {
  it('keys a detail by tracker, project and id', () => {
    expect(detailKey('github', 'p', '#4')).not.toBe(detailKey('github', 'q', '#4'))
    expect(detailKey('linear', '', 'K-1')).not.toBe(detailKey('github', '', 'K-1'))
  })

  it('drops the least recently used past the cap, and a touch saves one', () => {
    for (let n = 0; n < MAX_DETAILS; n++) setDetail(`k${n}`, n)
    touchDetail('k0')
    setDetail('extra', 1)
    expect(peekDetail('k0')).toBeDefined()
    expect(peekDetail('k1')).toBeUndefined()
    expect(peekDetail('extra')).toBeDefined()
  })

  it('a peek does not move an entry', () => {
    for (let n = 0; n < MAX_DETAILS; n++) setDetail(`k${n}`, n)
    peekDetail('k0')
    setDetail('extra', 1)
    expect(peekDetail('k0')).toBeUndefined()
  })
})

describe('freshness', () => {
  it('is fresh for FRESH_MS after a read', () => {
    setTracker('a', linear, undefined, 1000)
    const at = getTracker('a')!.at
    expect(at).toBe(1000)
    expect(isFresh(at, 1000 + FRESH_MS - 1)).toBe(true)
    expect(isFresh(at, 1000 + FRESH_MS)).toBe(false)
  })

  it('a rewrite stamps the new time', () => {
    setLinearLists('k', lists(1), undefined, 1000)
    setLinearLists('k', lists(1), undefined, 9000)
    expect(getLinearLists('k')?.at).toBe(9000)
  })
})

describe('forgetting', () => {
  const fill = () => {
    setTracker('a', linear)
    setTracker('b', linear)
    setScope(scope)
    setLinearLists('k', lists(1))
    setGithubList('a', gh('#1'))
    setGithubList('b', gh('#2'))
    setDetail(detailKey('linear', '', 'K-1'), 1)
    setDetail(detailKey('github', 'a', '#1'), 1)
    setDetail(detailKey('github', 'b', '#2'), 1)
    setSelected('linear', 'K-1')
    setSelected('github|a', '#1')
  }

  it('forgetTracker clears that project only', () => {
    fill()
    forgetTracker('a')
    expect(getTracker('a')).toBeUndefined()
    expect(getGithubList('a')).toBeUndefined()
    expect(peekDetail(detailKey('github', 'a', '#1'))).toBeUndefined()
    expect(getSelected('github|a')).toBeUndefined()
    expect(getTracker('b')).toBeDefined()
    expect(getGithubList('b')).toBeDefined()
    expect(peekDetail(detailKey('github', 'b', '#2'))).toBeDefined()
    expect(getScope()).toBeDefined()
    expect(getLinearLists('k')).toBeDefined()
  })

  it('forgetLinear clears the scope, lists and Linear details and keeps GitHub', () => {
    fill()
    forgetLinear()
    expect(getScope()).toBeUndefined()
    expect(getLinearLists('k')).toBeUndefined()
    expect(peekDetail(detailKey('linear', '', 'K-1'))).toBeUndefined()
    expect(getSelected('linear')).toBeUndefined()
    expect(getGithubList('a')).toBeDefined()
    expect(peekDetail(detailKey('github', 'a', '#1'))).toBeDefined()
    expect(getTracker('a')).toBeDefined()
  })

  it('forgetTrackers clears every tracker answer only', () => {
    fill()
    forgetTrackers()
    expect(getTracker('a')).toBeUndefined()
    expect(getTracker('b')).toBeUndefined()
    expect(getScope()).toBeDefined()
    expect(getGithubList('a')).toBeDefined()
  })

  it('forgetAll clears everything', () => {
    fill()
    forgetAll()
    expect(getTracker('a')).toBeUndefined()
    expect(getScope()).toBeUndefined()
    expect(getLinearLists('k')).toBeUndefined()
    expect(getGithubList('b')).toBeUndefined()
    expect(peekDetail(detailKey('github', 'b', '#2'))).toBeUndefined()
    expect(getSelected('github|a')).toBeUndefined()
  })
})

describe('writes from before a forget', () => {
  it('a request that began before a forget cannot write after it', () => {
    const gen = generation()
    forgetLinear()
    setScope(scope, gen)
    setLinearLists('k', lists(1), gen)
    setDetail(detailKey('linear', '', 'K-1'), 1, gen)
    expect(getScope()).toBeUndefined()
    expect(getLinearLists('k')).toBeUndefined()
    expect(peekDetail(detailKey('linear', '', 'K-1'))).toBeUndefined()
  })

  it('a request that began after a forget writes', () => {
    forgetTracker('a')
    setTracker('a', linear, generation())
    expect(getTracker('a')).toBeDefined()
  })

  it('a slow answer for an old filter lands under its own key, not the newest', () => {
    const old = serializeFilter({ mine: false, teamId: 't1' })
    const now = serializeFilter({ mine: false, teamId: 't2' })
    setLinearLists(now, lists(2))
    setLinearLists(old, lists(1))
    expect(getLinearLists(now)?.value.all[0].id).toBe('K-2')
    expect(getLinearLists(old)?.value.all[0].id).toBe('K-1')
  })
})
