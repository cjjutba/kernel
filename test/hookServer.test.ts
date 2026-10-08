import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { startHookServer } from '../src/main/services/hookServer'
import { Approvals } from '../src/main/services/approvals'
import { bus } from '../src/main/bus'
import { hookCommand } from '@shared/hookEntry'

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

/** Runs the installed hook command the way Claude Code does: through a shell, with the payload on stdin. */
function runHook(command: string, payload: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('/bin/sh', ['-c', command])
    let stdout = '', stderr = ''
    p.stdout.on('data', (c) => (stdout += c))
    p.stderr.on('data', (c) => (stderr += c))
    p.on('close', (code) => resolve({ code, stdout, stderr }))
    p.stdin.end(JSON.stringify(payload))
  })
}

const closedPort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) })
})

describe('the installed hook command', () => {
  it('prints nothing and exits 0 when Kernel is not running', async () => {
    const port = await closedPort()
    for (const event of ['Stop', 'PermissionRequest']) {
      expect(await runHook(hookCommand(port, 8), { ...base, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({ code: 0, stdout: '', stderr: '' })
    }
  })

  it('posts the event and passes the server answer through', async () => {
    const seen: any[] = []
    const off = (e: any) => seen.push(e)
    bus.on('activity', off)
    const r = await runHook(hookCommand(port, 8), { ...base, session_id: 'cmd', hook_event_name: 'Stop' })
    bus.off('activity', off)
    expect(r).toEqual({ code: 0, stdout: '{}', stderr: '' })
    expect(seen.map((e) => e.kind)).toEqual(['session.start', 'turn.done'])
  })

  it('returns the decision from Kernel, and nothing once the approval times out', async () => {
    let id = ''
    const onPush = (e: any) => { if (e.type === 'approval' && e.approval.status === 'pending') id = e.approval.id }
    bus.on('push', onPush)
    const pending = runHook(hookCommand(port, 8), { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'pnpm drizzle-kit push' } })
    while (!id) await new Promise((r) => setTimeout(r, 10))
    bus.off('push', onPush)
    approvals.decide(id, { behavior: 'allow' })
    const allowed = await pending
    expect(allowed.code).toBe(0)
    expect(JSON.parse(allowed.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    const timedOut = await runHook(hookCommand(port, 8), { ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } })
    expect(timedOut).toEqual({ code: 0, stdout: '{}', stderr: '' })
  })
})
