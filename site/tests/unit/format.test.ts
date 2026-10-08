import { describe, expect, it } from 'vitest'
import { formatDate, formatStars, latestVersionLabel } from '@/lib/format'
import { DOWNLOAD_URL } from '@/lib/links'

describe('formatStars', () => {
  it.each([
    [0, '0'],
    [9, '9'],
    [999, '999'],
    [1000, '1k'],
    [1234, '1.2k'],
    [12345, '12k']
  ])('%i stars reads %s', (n, label) => {
    expect(formatStars(n)).toBe(label)
  })
})

describe('formatDate', () => {
  it('keeps the calendar date whatever the time zone', () => {
    expect(formatDate('2026-10-08')).toBe('October 8, 2026')
  })
})

describe('latestVersionLabel', () => {
  it('drops the patch number', () => {
    expect(latestVersionLabel('0.1.0')).toBe('0.1')
  })
})

describe('DOWNLOAD_URL', () => {
  it('downloads the DMG from the latest release', () => {
    expect(DOWNLOAD_URL).toBe('https://github.com/cjjutba/kernel/releases/latest/download/Kernel-arm64.dmg')
  })
})
