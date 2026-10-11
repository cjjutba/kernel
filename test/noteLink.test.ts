import { describe, expect, it } from 'vitest'
import { floorRoomId, noteLinkTarget } from '../src/renderer/src/screens/workspace/noteLink'

describe('noteLinkTarget', () => {
  it.each([
    ['a room link', 'kernel://floor/room-1', 'room'],
    ['https', 'https://example.com/pr/1', 'external'],
    ['http', 'http://localhost:3000/', 'external'],
    ['file:', 'file:///Users/you/Downloads/page.html', 'text'],
    ['javascript:', 'javascript:alert(1)', 'text'],
    ['mailto:', 'mailto:you@example.com', 'text'],
    ['a kernel link that is not a room', 'kernel://settings', 'text'],
    ['a relative path', '/etc/passwd', 'text'],
    ['junk', 'not a url', 'text'],
    ['an empty href', '', 'text']
  ])('%s', (_name, href, expected) => {
    expect(noteLinkTarget(href)).toBe(expected)
  })
})

describe('floorRoomId', () => {
  it('reads the room id', () => {
    expect(floorRoomId('kernel://floor/room-1')).toBe('room-1')
    expect(floorRoomId('https://example.com')).toBeNull()
  })
})
