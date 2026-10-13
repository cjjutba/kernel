import { PROVIDERS, type AccountProfile, type Provider, type RateLimit } from '@shared/types'
import { switchChoices } from '@shared/usage'
import { isFable, live, windowsOf, type PlanWindow } from './planModel'

// What the footer's usage row draws (UsageFooter.png, KERNEL-674): every signed-in account of each provider, the one the provider runs on first.
// Every input is what main pushed, so the row follows `usage` and `accounts` pushes, with no timer.

/** One account's chip. `five`, `week` and `fable` are 0 to 1, and undefined while Kernel has no number for the window or it has reset since. */
export interface FooterChip {
  id: string
  name: string
  active: boolean
  /** A key in use has no windows. */
  billed: boolean
  five?: number
  week?: number
  /** Fable 5.1's weekly window, only for an account that reports one. */
  fable?: number
}

export interface FooterGroup {
  provider: Provider
  name: string
  /** Signed out: the row is the mark and Sign in. */
  signedOut: boolean
  chips: FooterChip[]
}

const pct = (v: number) => `${Math.round(v * 100)}%`

const windowOf = (usage: RateLimit[], a: AccountProfile, type: 'five_hour' | 'seven_day', now: number): number | undefined =>
  live(windowsOf(usage, a).find((l) => l.type === type && !l.model), now)?.utilization

const fableOf = (usage: RateLimit[], a: AccountProfile, now: number): number | undefined =>
  live(windowsOf(usage, a).find(isFable), now)?.utilization

/**
 * Claude Code, then Codex. A provider whose accounts haven't loaded is left out. The active account comes first, then the other signed-in
 * subscriptions in the order Kernel's own switch would pick them (`switchChoices`, most 5-hour room first), with any it wouldn't pick after them.
 * An account waiting for Keychain access is left out, since a turn on it would wait too (KERNEL-618), and so is a key that isn't in use, which has no number.
 */
export function footerGroups(accounts: AccountProfile[], usage: RateLimit[], now: number): FooterGroup[] {
  return PROVIDERS.filter((p) => accounts.some((a) => a.provider === p.id)).map((p) => {
    const mine = accounts.filter((a) => a.provider === p.id)
    const active = mine.find((a) => a.active)
    if (!active?.signedIn) return { provider: p.id, name: p.label, signedOut: true, chips: [] }
    const chip = (a: AccountProfile): FooterChip => {
      const billed = a.auth === 'apiKey'
      const five = billed ? undefined : windowOf(usage, a, 'five_hour', now)
      const week = billed ? undefined : windowOf(usage, a, 'seven_day', now)
      const fable = billed || p.id !== 'claude' ? undefined : fableOf(usage, a, now)
      return { id: a.id, name: a.label, active: a.active, billed, ...(five === undefined ? {} : { five }), ...(week === undefined ? {} : { week }), ...(fable === undefined ? {} : { fable }) }
    }
    const order = switchChoices(p.id, mine, usage, now).room.map((a) => a.id)
    const rank = (a: AccountProfile) => { const i = order.indexOf(a.id); return i < 0 ? order.length : i }
    const others = mine.filter((a) => !a.active && a.signedIn && !a.keychainWait && a.auth !== 'apiKey').sort((a, b) => rank(a) - rank(b))
    return { provider: p.id, name: p.label, signedOut: false, chips: [chip(active), ...others.map(chip)] }
  })
}

/** The window with the most use, for the Compact view: "Weekly 19%" when that is the closer one. Undefined with no number for either. */
export function tightest(w: { five?: number; week?: number }): { title: '5-hour' | 'Weekly'; value: number } | undefined {
  if (w.five === undefined && w.week === undefined) return undefined
  return (w.week ?? -1) > (w.five ?? -1) ? { title: 'Weekly', value: w.week! } : { title: '5-hour', value: w.five! }
}

/** The popover section's Compact window: the tightest of its 5-hour and weekly windows. */
export const tightestWindow = (windows: PlanWindow[]): { title: string; value: number } | undefined => {
  const mine = windows.filter((w) => (w.id === 'five_hour' || w.id === 'seven_day') && w.reported)
  const top = mine.sort((a, b) => b.value - a.value)[0]
  return top && { title: top.title, value: top.value }
}

/** Amber from 75%, red from 90%: the meters' steps, so the number and its bar change together. */
export const tone = (v: number | undefined): 'near' | 'full' | undefined => (v === undefined ? undefined : v >= 0.9 ? 'full' : v >= 0.75 ? 'near' : undefined)

/** A chip's accessible name: the provider and account, then the numbers and what pressing it does. */
export function chipLabel(g: FooterGroup, c: FooterChip, compact: boolean): string {
  const say = (title: string, v: number | undefined) => (v === undefined ? `${title} not reported yet` : `${title} ${pct(v)}`)
  if (!c.active) return `${g.name}, ${c.name}: ${say('5-hour', c.five)}. Switch to it`
  const numbers = c.billed ? 'billed per token' : compact ? (() => { const t = tightest(c); return t ? say(t.title.toLowerCase(), t.value) : 'no usage reported yet' })() : [say('5-hour', c.five), say('weekly', c.week), ...(c.fable === undefined ? [] : [say('Fable 5.1 weekly', c.fable)])].join(', ')
  return `${g.name}, ${c.name}, active: ${numbers}. Opens usage`
}
