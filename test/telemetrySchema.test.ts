import { describe, expect, it } from 'vitest'
import { checkEvent, countRange, EVENTS } from '../src/shared/telemetry'

// KERNEL-397: an event can only carry fixed values, yes or no, or a short code a pattern checks, so no path, name or prompt
// can reach one.
describe('telemetry events', () => {
  it('has no property that takes free text', () => {
    for (const [name, props] of Object.entries(EVENTS)) {
      for (const [key, rule] of Object.entries(props as Record<string, object>)) {
        const kind = Object.keys(rule)[0]
        expect(['enum', 'bool', 'id'], `${name}.${key}`).toContain(kind)
        if (kind === 'enum') for (const v of (rule as { enum: string[] }).enum) expect(v, `${name}.${key}`).toMatch(/^[A-Za-z0-9.+-]{1,30}$/)
      }
    }
  })

  it('takes a well-formed event', () => {
    expect(checkEvent({ name: 'app.started' })).toBeUndefined()
    expect(checkEvent({ name: 'handoff.refused', reason: 'helper' })).toBeUndefined()
    expect(checkEvent({ name: 'app.error', kind: 'exception', errorClass: 'TypeError', frame: 'index.js:1234:56' })).toBeUndefined()
    expect(checkEvent({ name: 'team.resolved', leadFrom: 'builtin', reviewerFrom: 'file', agents: '6-20', helpers: '0', warnings: '1-5' })).toBeUndefined()
  })

  it('refuses unknown events, extra or missing properties and values outside their rule', () => {
    expect(checkEvent({ name: 'repo.opened' })).toMatch(/unknown event/)
    expect(checkEvent({ name: 'app.started', room: 'client-portal' })).toMatch(/no property room/)
    expect(checkEvent({ name: 'handoff.refused' })).toMatch(/reason/)
    expect(checkEvent({ name: 'handoff.refused', reason: 'Kai is busy' })).toMatch(/reason/)
    expect(checkEvent({ name: 'pr.ready_unreviewed', hasReviewer: 'yes' })).toMatch(/hasReviewer/)
  })

  it('refuses a path, a long string or a token where a short code goes', () => {
    const bad = ['/Users/cj/Projects/client/src/index.ts:12', '~/Projects/x.ts:1', 'a'.repeat(200), 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'Error: ENOENT /Users/cj']
    for (const frame of bad) expect(checkEvent({ name: 'app.error', kind: 'exception', errorClass: 'Error', frame }), frame).toMatch(/frame/)
    for (const errorClass of ['Error at /Users/cj', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789aaaa', 'x y']) {
      expect(checkEvent({ name: 'app.error', kind: 'exception', errorClass, frame: 'unknown' }), errorClass).toMatch(/errorClass/)
    }
  })

  it('sends the agent warnings about unreadable files and MCP servers (KERNEL-432)', () => {
    for (const kind of ['unreadable-file', 'mcp-missing', 'mcp-failed', 'mcp-needs-auth', 'mcp-off']) expect(checkEvent({ name: 'agent.warning', kind }), kind).toBeUndefined()
    expect(checkEvent({ name: 'agent.warning', kind: 'mcp-linear' })).toMatch(/kind/)
  })

  it('sends the warning about an agent written as a subagent (KERNEL-465)', () => {
    expect(checkEvent({ name: 'agent.warning', kind: 'looks-like-subagent' })).toBeUndefined()
  })

  it('sends agent counts as ranges', () => {
    expect([0, 1, 5, 6, 20, 21, 400].map(countRange)).toEqual(['0', '1-5', '1-5', '6-20', '6-20', '21+', '21+'])
  })
})
