import { describe, expect, it } from 'vitest'
import { bootDetail } from '../src/main/bootError'
import { NEWER_DATA } from '../src/main/migrations'

const home = '/Users/someone'
const logFile = `${home}/Library/Logs/Kernel/main.log`
const logLine = 'Details are in ~/Library/Logs/Kernel/main.log.'

describe('bootDetail', () => {
  it('shows the newer-data message exactly as written', () => {
    expect(bootDetail(new Error(NEWER_DATA), logFile, home)).toBe(NEWER_DATA)
  })

  it('shows an ordinary error as its message and the log, with no stack', () => {
    const err = new Error('  disk I/O error  ')
    const detail = bootDetail(err, logFile, home)
    expect(detail).toBe(`disk I/O error\n\n${logLine}`)
    expect(detail).not.toMatch(/\bat /)
  })

  it('falls back to the name when the message is empty', () => {
    expect(bootDetail(new TypeError(''), logFile, home)).toBe(`TypeError\n\n${logLine}`)
  })

  it('shows a thrown value that is not an Error as String(err)', () => {
    expect(bootDetail('the socket closed', logFile, home)).toBe('the socket closed')
    const obj = { code: 7 }
    expect(bootDetail(obj, logFile, home)).toBe(String(obj))
  })

  it('leaves the log line out when there is no log', () => {
    expect(bootDetail(new Error('disk I/O error'), undefined, home)).toBe('disk I/O error')
  })

  it('names a log outside the home folder by its full path', () => {
    expect(bootDetail(new Error('boom'), '/tmp/logs/main.log', home)).toBe('boom\n\nDetails are in /tmp/logs/main.log.')
  })
})
