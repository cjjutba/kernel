import { describe, expect, it } from 'vitest'
import { parseHook, permissionResponse } from '@shared/hookSchemas'

const base = { session_id: 's1', transcript_path: '/t.jsonl', cwd: '/repo' }

describe('parseHook', () => {
  it('parses a known event and keeps unknown fields', () => {
    const r = parseHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tu1', future_field: 1 })
    expect(r.ok && r.known).toBe(true)
    if (r.ok) expect((r.event as any).future_field).toBe(1)
  })
  it('accepts events Kernel does not know yet', () => {
    const r = parseHook({ ...base, hook_event_name: 'BrandNewEvent' })
    expect(r).toMatchObject({ ok: true, known: false })
  })
  it('rejects bodies without the base fields', () => {
    expect(parseHook({ hook_event_name: 'Stop' }).ok).toBe(false)
  })
  it('rejects a known event missing required fields', () => {
    expect(parseHook({ ...base, hook_event_name: 'PreToolUse' }).ok).toBe(false)
  })
  it('builds PermissionRequest responses', () => {
    expect(permissionResponse(null)).toEqual({})
    expect(permissionResponse({ behavior: 'allow' })).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  })
})
