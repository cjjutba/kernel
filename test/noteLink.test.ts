import { describe, expect, it } from 'vitest'
import { floorProjectId, noteLinkTarget } from '../src/renderer/src/screens/workspace/noteLink'

describe('noteLinkTarget', () => {
  it.each([
    ['a project link', 'kernel://floor/project-1', 'project'],
    ['https', 'https://example.com/pr/1', 'external'],
    ['http', 'http://localhost:3000/', 'external'],
    ['file:', 'file:///Users/you/Downloads/page.html', 'text'],
    ['javascript:', 'javascript:alert(1)', 'text'],
    ['mailto:', 'mailto:you@example.com', 'text'],
    ['a kernel link that is not a project', 'kernel://settings', 'text'],
    ['a relative path', '/etc/passwd', 'text'],
    ['junk', 'not a url', 'text'],
    ['an empty href', '', 'text']
  ])('%s', (_name, href, expected) => {
    expect(noteLinkTarget(href)).toBe(expected)
  })
})

describe('floorProjectId', () => {
  it('reads the project id', () => {
    expect(floorProjectId('kernel://floor/project-1')).toBe('project-1')
    expect(floorProjectId('https://example.com')).toBeNull()
  })
})
