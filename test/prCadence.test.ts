import { describe, expect, it } from 'vitest'
import { CADENCE, PrCadence } from '../src/main/services/prCadence'

// KERNEL-388: how often Kernel reads its PRs, and how it holds off for GitHub's rate limit.

function clock() {
  let now = Date.parse('2026-10-11T09:00:00Z')
  const c = new PrCadence(() => now)
  c.started()
  return { c, at: () => now, pass: (ms: number) => { now += ms } }
}
const rate = (remaining: number, resetIn: number, at: number) => ({ remaining, limit: 5000, resetAt: at + resetIn })

describe('the PR poll cadence', () => {
  it('reads every 10 seconds while a PR is moving and every 30 when all wait on someone', () => {
    const { c } = clock()
    expect(c.delay(true)).toBe(10_000)
    expect(c.delay(false)).toBe(30_000)
    expect(CADENCE).toMatchObject({ fastMs: 10_000, calmMs: 30_000 })
  })

  it('slows to once a minute below a fifth of the rate limit, even while a PR moves', () => {
    const { c, at } = clock()
    c.rated(rate(999, 600_000, at()))
    expect(c.paused()).toBe(false)
    expect(c.delay(true)).toBe(60_000)
    c.rated(rate(1000, 600_000, at()))
    expect(c.delay(true)).toBe(10_000)
  })

  it('reads nothing below a twentieth until the limit resets, at most an hour', () => {
    const { c, at, pass } = clock()
    c.rated(rate(249, 20 * 60_000, at()))
    expect(c.paused()).toBe(true)
    expect(c.delay(true)).toBe(20 * 60_000)
    expect(c.resumesAt()).toBe(at() + 20 * 60_000)
    pass(20 * 60_000)
    expect(c.paused()).toBe(false)
    c.rated(rate(10, 5 * 60 * 60_000, at()))
    expect(c.delay(false)).toBe(60 * 60_000)
  })

  it('pauses a refused read until the later of the reset times it knows', () => {
    const { c, at } = clock()
    c.rated(rate(3000, 30 * 60_000, at()))
    c.limited({ resetAt: at() + 10 * 60_000 })
    expect(c.delay(false)).toBe(30 * 60_000)
  })

  it("backs off from a minute for GitHub's slow down limit, doubling up to 15, and starts over after a read goes through", () => {
    const { c, at, pass } = clock()
    const waits: number[] = []
    for (let i = 0; i < 6; i++) { c.limited({ secondary: true }); waits.push(c.delay(true)); pass(c.delay(true)) }
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
    c.ok()
    c.limited({ secondary: true })
    expect(c.resumesAt()).toBe(at() + 60_000)
  })

  it('flushes Lead updates and retries waits 45 seconds after launch at the soonest, then every 45', () => {
    const { c, pass } = clock()
    expect(c.choresDue()).toBe(false)
    pass(30_000)
    expect(c.choresDue()).toBe(false)
    pass(15_000)
    expect(c.choresDue()).toBe(true)
    c.choresRan()
    pass(10_000)
    expect(c.choresDue()).toBe(false)
    pass(35_000)
    expect(c.choresDue()).toBe(true)
  })
})
