import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { startHookServer } from '../src/main/services/hookServer'
import { Approvals } from '../src/main/services/approvals'
import { bus } from '../src/main/bus'

const port = 17420 + Math.floor(Math.random() * 500)
const approvals = new Approvals()
let server: Server
const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/hooks`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }).then((r) => r.json())
const base = { session_id: 'outside', transcript_path: '/t', cwd: '/repo/wt/invoice-table' }

beforeAll(async () => {
  server = await startHookServer({
    port, approvals, approvalTimeoutMs: 400,
    isManaged: (id) => id === 'managed',
    resolve: (cwd) => (cwd.startsWith('/repo') ? { roomId: 'room', workspaceId: 'ws', agentId: 'kai' } : {})
  })
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('hook server', () => {
  it('turns tool events into room activity, starting the session on its first event', async () => {
    const seen: any[] = []
    const off = (e: any) => seen.push(e)
    bus.on('activity', off)
    await post({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/table.tsx' }, tool_response: {}, tool_use_id: 't1' })
    await post({ ...base, hook_event_name: 'Stop' })
    bus.off('activity', off)
    expect(seen.map((e) => e.kind)).toEqual(['session.start', 'tool.end', 'turn.done'])
    expect(seen[1]).toMatchObject({ kind: 'tool.end', text: 'edited', object: 'table.tsx', roomId: 'room', agentId: 'kai', sessionId: 'outside' })
  })

  it('holds a permission request until it is approved', async () => {
    let id = ''
    const onPush = (e: any) => { if (e.type === 'approval' && e.approval.status === 'pending') id = e.approval.id }
    bus.on('push', onPush)
    const pending = post({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm drizzle-kit push' } })
    await new Promise((r) => setTimeout(r, 50))
    bus.off('push', onPush)
    expect(id).not.toBe('')
    approvals.decide(id, { behavior: 'allow' })
    expect(await pending).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  })

  it('falls back to the terminal prompt when nobody decides in time', async () => {
    const r = await post({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } })
    expect(r).toEqual({})
  })

  it('ignores sessions Kernel manages itself', async () => {
    const seen: any[] = []
    const off = (e: any) => seen.push(e)
    bus.on('activity', off)
    await post({ ...base, session_id: 'managed', hook_event_name: 'Stop' })
    bus.off('activity', off)
    expect(seen).toEqual([])
  })
})
