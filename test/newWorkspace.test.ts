import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { git } from '../src/main/services/exec'
import { listBranches, taskBranch } from '../src/main/services/worktrees'
import { parsePrList } from '../src/main/services/github'
import { NO_LINEAR_TOKEN, searchIssues } from '../src/main/services/linear'
import { Kernel } from '../src/main/kernel'

describe('branch naming', () => {
  it('uses feat/{task}-{slug} when a Linear issue is linked', () => {
    expect(taskBranch('feat/{slug}', 'Client portal login', 'KERNEL-16')).toBe('feat/kernel-16-client-portal-login')
    expect(taskBranch('feat/{task}-{slug}', 'Client portal login', 'T-16')).toBe('feat/t-16-client-portal-login')
  })
  it('uses the plain pattern without a task', () => {
    expect(taskBranch('feat/{slug}', 'Export invoices as PDF')).toBe('feat/export-invoices-as-pdf')
  })
})

describe('listBranches', () => {
  it('lists local and remote branches without origin/HEAD', async () => {
    const repo = await tempRepo()
    await git(repo, 'branch', 'feat/one')
    const remote = await tempRepo()
    await git(repo, 'remote', 'add', 'origin', remote)
    await git(repo, 'fetch', '-q', 'origin')
    await git(repo, 'remote', 'set-head', 'origin', 'main')
    const names = await listBranches(repo)
    expect(names).toEqual(expect.arrayContaining(['main', 'feat/one', 'origin/main']))
    expect(names.some((n) => n.endsWith('/HEAD') || n === 'origin')).toBe(false)
  })
})

describe('parsePrList', () => {
  it('maps gh pr list json', () => {
    const json = JSON.stringify([{ number: 44, title: 'feat(invoices): PDF renderer', headRefName: 'feat/pdf', author: { login: 'cjjutba' } }, { number: 43, title: 'fix(auth)', headRefName: 'fix/auth' }])
    expect(parsePrList(json)).toEqual([
      { number: 44, title: 'feat(invoices): PDF renderer', branch: 'feat/pdf', author: 'cjjutba' },
      { number: 43, title: 'fix(auth)', branch: 'fix/auth', author: undefined }
    ])
  })
  it('returns nothing for bad output', () => { expect(parsePrList('not json')).toEqual([]) })
})

describe('searchIssues', () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  it('asks for a token', async () => { await expect(searchIssues(undefined)).rejects.toThrow(NO_LINEAR_TOKEN) })
  it('maps issues and sends the token raw', async () => {
    let seen: { headers: Record<string, string>; body: string } | undefined
    const f = (async (_u: string, init: { headers: Record<string, string>; body: string }) => { seen = init; return new Response(JSON.stringify({ data: { issues: { nodes: [{ identifier: 'KERNEL-16', title: 'New workspace modal', url: 'https://linear.app/x' }] } } })) }) as unknown as typeof fetch
    expect(await searchIssues('lin_key', 'kernel-16', f)).toEqual([{ id: 'KERNEL-16', title: 'New workspace modal', url: 'https://linear.app/x' }])
    expect(seen?.headers.authorization).toBe('lin_key')
    expect(JSON.parse(seen!.body).variables.filter.and[1].or).toContainEqual({ number: { eq: 16 } })
  })
  it('explains a rejected token', async () => { await expect(searchIssues('bad', '', reply(401, {}))).rejects.toThrow(/rejected the token/) })
  it('surfaces GraphQL errors', async () => { await expect(searchIssues('k', '', reply(200, { errors: [{ message: 'Bad filter' }] }))).rejects.toThrow('Bad filter') })
})

describe('createWorkspace from a source', () => {
  it('names the branch from the Linear id, stores the source and sends attachments', async () => {
    const repo = await tempRepo({ '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    const sent: string[][] = []
    k.sessions.send = async (_c, parts) => { sent.push(parts.map((p) => p.type)); return { queued: false } }
    const room = await k.addRoom(repo)
    const source = { kind: 'issue', id: 'KERNEL-16', title: 'New workspace modal' } as const
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', source, parts: [{ type: 'file', name: 'spec.md', text: 'x' }] })
    expect(ws.branch).toBe('feat/kernel-16-new-workspace-modal')
    expect(ws.source).toEqual(source)
    expect(sent).toEqual([['text', 'file']])
    await k.stop()
  })
})
