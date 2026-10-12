import { describe, expect, it } from 'vitest'
import { resetPhrase } from '../src/shared/usage'

// Local dates, so each case lands on the same calendar day in any timezone. Tuesday, Oct 13 2026.
const S = (d: Date) => d.getTime() / 1000
const now = new Date(2026, 9, 13, 10, 0).getTime()

describe('resetPhrase', () => {
  it('says only the time later today', () => {
    expect(resetPhrase(S(new Date(2026, 9, 13, 16, 0)), now)).toBe('at 4:00 PM')
  })

  it('says tomorrow by calendar day, even minutes away', () => {
    expect(resetPhrase(S(new Date(2026, 9, 14, 4, 0)), now)).toBe('tomorrow at 4:00 AM')
    expect(resetPhrase(S(new Date(2026, 9, 14, 4, 0)), new Date(2026, 9, 13, 23, 50).getTime())).toBe('tomorrow at 4:00 AM')
    // More than 24 hours out, still tomorrow.
    expect(resetPhrase(S(new Date(2026, 9, 14, 22, 0)), new Date(2026, 9, 13, 8, 0).getTime())).toBe('tomorrow at 10:00 PM')
  })

  it('names the weekday 2 to 6 days out', () => {
    expect(resetPhrase(S(new Date(2026, 9, 15, 9, 0)), now)).toBe('Thursday at 9:00 AM')
    expect(resetPhrase(S(new Date(2026, 9, 19, 9, 0)), now)).toBe('Monday at 9:00 AM')
  })

  it('gives the date from 7 days out, so a weekly reset is not read as this week', () => {
    expect(resetPhrase(S(new Date(2026, 9, 20, 10, 0)), now)).toBe('Oct 20 at 10:00 AM')
    expect(resetPhrase(S(new Date(2026, 9, 21, 9, 0)), now)).toBe('Oct 21 at 9:00 AM')
  })

  it('never says today or tomorrow in a notification', () => {
    const notice = { notice: true }
    expect(resetPhrase(S(new Date(2026, 9, 13, 16, 0)), now, notice)).toBe('Tuesday at 4:00 PM')
    expect(resetPhrase(S(new Date(2026, 9, 14, 4, 0)), now, notice)).toBe('Wednesday at 4:00 AM')
    expect(resetPhrase(S(new Date(2026, 9, 16, 9, 0)), now, notice)).toBe('Friday at 9:00 AM')
    expect(resetPhrase(S(new Date(2026, 9, 21, 9, 0)), now, notice)).toBe('Oct 21 at 9:00 AM')
  })
})
