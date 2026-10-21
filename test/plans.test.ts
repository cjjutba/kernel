import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, freePort } from './helpers'
import { run } from '../src/main/services/exec'
import { searchFiles } from '../src/main/services/files'
import { savePlan } from '../src/main/services/plans'
import { Kernel } from '../src/main/kernel'
import type { Approval } from '@shared/types'

// A chat with Kernel's held first message goes out through the real send once its setup passes (KERNEL-405).
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...await original<object>(), ...await import('./sdkStub') }))

// D-092: plan-mode plans are saved as files a later chat can build from, and git never sees them.

const status = async (repo: string) => (await run('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'])).trim()
const PLAN = '# Export invoices as PDF\n\n## Context\nThe table has row actions.\n\n## Steps\n1. Renderer\n2. Button\n'

describe('saved plans', () => {
  it('saves the first plan as plan.md under .kernel/plans and keeps it out of git (KERNEL-767)', async () => {
    const repo = await tempRepo()
    const file = await savePlan(repo, PLAN)
    expect(file).toBe('.kernel/plans/plan.md')
    expect(await readFile(join(repo, file), 'utf8')).toBe(PLAN)
    expect(await status(repo)).toBe('')
  })

  it('overwrites a revision in place, and gives a new plan the next free name', async () => {
    const repo = await tempRepo()
    const first = await savePlan(repo, PLAN)
    const revised = await savePlan(repo, `${PLAN}3. Tests`, { reuse: first })
    expect(revised).toBe('.kernel/plans/plan.md')
    expect(await readFile(join(repo, first), 'utf8')).toContain('3. Tests')
    // A plan with another heading still starts from plan.md, not its title.
    expect(await savePlan(repo, '## Context\nSomething else\n')).toBe('.kernel/plans/plan-2.md')
    // A reuse path that isn't a saved plan is ignored rather than written to.
    expect(await savePlan(repo, PLAN, { reuse: '../outside.md' })).toBe('.kernel/plans/plan-3.md')
    // A plan saved under an older, heading-based name is still overwritten by its revision.
    await writeFile(join(repo, '.kernel/plans/context.md'), 'old')
    expect(await savePlan(repo, PLAN, { reuse: '.kernel/plans/context.md' })).toBe('.kernel/plans/context.md')
    expect(await readFile(join(repo, '.kernel/plans/context.md'), 'utf8')).toBe(PLAN)
  })

  it('lists saved plans in the @ menu even though git ignores them', async () => {
    const repo = await tempRepo()
    await savePlan(repo, PLAN)
    expect((await searchFiles(repo, 'plans/plan')).map((f) => f.path)).toContain('.kernel/plans/plan.md')
  })
})

const png = (bytes: string) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`

describe('a plan change request with images, through approvals.decide', () => {
  async function kernel() {
    const repo = await tempRepo({ '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    const project = await k.addProject(repo)
    const chat = await k.leadChat(project.id)
    // The images go in the chat's worktree, which Kernel makes after the chat starts (KERNEL-542).
    await k.workspaces.worktreeMade(chat.workspaceId)
    const ws = k.store.workspace(chat.workspaceId)!
    const ask = (o: { kind?: Approval['kind']; toolName?: string } = { toolName: 'ExitPlanMode' }) =>
      k.approvals.request({ projectId: project.id, workspaceId: ws.id, chatId: chat.id, kind: o.kind ?? 'plan', source: 'sdk', toolName: o.toolName, title: 'Plan for lead', input: { plan: PLAN } })
    return { k, ws, ask, decide: k.handlers()['approvals.decide'] }
  }

  it('saves the images in the workspace and lists their paths in the denial', async () => {
    const { ws, ask, decide } = await kernel()
    const { approval, decision } = ask()
    const a = await decide({ id: approval.id, decision: { behavior: 'deny', message: 'Match this', images: [{ name: 'image.png', dataUrl: png('a') }, { name: 'image.png', dataUrl: png('b') }] } })
    expect(a.status).toBe('denied')
    const one = join(ws.path, '.kernel/attachments/1/image.png')
    const two = join(ws.path, '.kernel/attachments/1/image-2.png')
    expect(await decision).toEqual({ behavior: 'deny', message: `Match this\n\nAttached image: ${one}. Read it before revising the plan.\nAttached image: ${two}. Read it before revising the plan.` })
    expect(await readFile(two, 'utf8')).toBe('b')
    expect(await status(ws.path)).toBe('')
  })

  it('sends an image-only request, and leaves a text-only one as it was', async () => {
    const { k, ws, ask, decide } = await kernel()
    const first = ask()
    await decide({ id: first.approval.id, decision: { behavior: 'deny', message: '', images: [{ name: 'shot.png', dataUrl: png('a') }] } })
    expect(await first.decision).toEqual({ behavior: 'deny', message: `Attached image: ${join(ws.path, '.kernel/attachments/1/shot.png')}. Read it before revising the plan.` })
    const second = ask()
    await decide({ id: second.approval.id, decision: { behavior: 'deny', message: 'Smaller steps' } })
    expect(await second.decision).toEqual({ behavior: 'deny', message: 'Smaller steps' })
    // Only the request with an image keeps one on its approval.
    expect(k.store.approval(first.approval.id)?.images).toEqual([{ type: 'image', name: 'shot.png', dataUrl: png('a'), path: '.kernel/attachments/1/shot.png' }])
    expect(k.store.approval(second.approval.id)).not.toHaveProperty('images')
  })

  it("saves them for the Lead's task list too, which has no tool name", async () => {
    const { ws, ask, decide } = await kernel()
    const { approval, decision } = ask({ kind: 'plan' })
    await decide({ id: approval.id, decision: { behavior: 'deny', message: 'Split T-2', images: [{ name: 'tasks.png', dataUrl: png('a') }] } })
    expect(await decision).toEqual({ behavior: 'deny', message: `Split T-2\n\nAttached image: ${join(ws.path, '.kernel/attachments/1/tasks.png')}. Read it before revising the plan.` })
  })

  it('drops images from any other denial and writes nothing', async () => {
    const { ws, ask, decide } = await kernel()
    const { approval, decision } = ask({ kind: 'tool', toolName: 'Bash' })
    await decide({ id: approval.id, decision: { behavior: 'deny', message: 'No', images: [{ name: 'image.png', dataUrl: png('a') }] } })
    expect(await decision).toEqual({ behavior: 'deny', message: 'No' })
    await expect(access(join(ws.path, '.kernel/attachments'))).rejects.toThrow()
  })

  it('keeps the plan waiting when the workspace folder is gone, and refuses a second answer', async () => {
    const { k, ws, ask, decide } = await kernel()
    const gone = ask()
    k.store.workspace = () => ({ ...ws, path: join(ws.path, 'missing') })
    const images = [{ name: 'image.png', dataUrl: png('a') }]
    await expect(decide({ id: gone.approval.id, decision: { behavior: 'deny', message: 'x', images } })).rejects.toThrow("The workspace folder is gone, so the images can't be saved.")
    expect(k.approvals.isPending(gone.approval.id)).toBe(true)
    await decide({ id: gone.approval.id, decision: { behavior: 'deny', message: 'x' } })
    await expect(decide({ id: gone.approval.id, decision: { behavior: 'deny', message: 'x', images } })).rejects.toThrow('already timed out or was answered')
  })
})

describe('who does each plan step (plan-step-owners)', () => {
  async function kernel() {
    const repo = await tempRepo({
      '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
      '.claude/agents/sean.md': '---\nname: sean\ndescription: Engine engineer.\n---\nYou are Sean. Open a PR for each task.',
      '.claude/agents/artkin.md': '---\nname: artkin\ndescription: Reviewer.\nrole: reviewer\n---\nYou review.'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop({ budgetMs: 0 }))
    const project = await k.addProject(repo)
    const chat = await k.leadChat(project.id)
    const ask = () => k.approvals.request({
      projectId: project.id, workspaceId: chat.workspaceId, chatId: chat.id, agentId: 'kernel-lead', kind: 'plan', source: 'sdk', title: 'Plan', detail: PLAN,
      steps: [{ title: 'T-1 Renderer', criteria: [], taskId: 'T-1', agentId: 'sean' }, { title: 'T-2 Button', criteria: [], taskId: 'T-2' }, { title: 'T-3 Docs', criteria: [], taskId: 'T-3' }]
    })
    return { k, project, ask, decide: k.handlers()['approvals.decide'] }
  }

  it('keeps the proposed owners when the user changes none, and Kernel owns a step with none', async () => {
    const { k, project, ask, decide } = await kernel()
    const { approval } = ask()
    const done = await decide({ id: approval.id, decision: { behavior: 'allow' } })
    expect(done.steps?.map((s) => s.agentId)).toEqual(['sean', undefined, undefined])
    expect(done.steps?.some((s) => s.ownerChanged)).toBe(false)
    expect(k.tasks.list(project.id).map((t) => [t.id, t.agentId])).toEqual([['T-1', 'sean'], ['T-2', 'kernel-lead'], ['T-3', 'kernel-lead']])
  })

  it("saves the user's owners on the plan and its tasks, and tells the Lead which steps moved", async () => {
    const { k, project, ask, decide } = await kernel()
    const { approval, decision } = ask()
    const done = await decide({ id: approval.id, decision: { behavior: 'allow', owners: [null, 'sean', null] } })
    expect(await decision).toMatchObject({ behavior: 'allow', owners: [null, 'sean', null] })
    expect(done.steps?.map((s) => [s.agentId, !!s.ownerChanged])).toEqual([[undefined, true], ['sean', true], [undefined, false]])
    expect(k.tasks.list(project.id).map((t) => [t.id, t.agentId])).toEqual([['T-1', 'kernel-lead'], ['T-2', 'sean'], ['T-3', 'kernel-lead']])
    expect(await k.lead.ownerNote(project.id, approval.id)).toBe([
      'Who does each step:', '1. T-1 Renderer: you do it yourself', '2. T-2 Button: hand it to Sean', '3. T-3 Docs: you do it yourself',
      'The user changed who does steps 1, 2. Keep their choice.'
    ].join('\n'))
  })

  it('ignores an owner that is not a teammate who takes tasks, or is past the last step', async () => {
    const { ask, decide } = await kernel()
    const { approval } = ask()
    const done = await decide({ id: approval.id, decision: { behavior: 'allow', owners: ['nobody', 'artkin', 'kernel', 'sean'] as never } })
    expect(done.steps?.map((s) => s.agentId)).toEqual(['sean', undefined, undefined])
    expect(done.steps?.some((s) => s.ownerChanged)).toBe(false)
  })

  it('leaves the steps alone when a plan is denied with owners', async () => {
    const { ask, decide } = await kernel()
    const { approval } = ask()
    const done = await decide({ id: approval.id, decision: { behavior: 'deny', message: 'No', owners: [null, null, null] } as never })
    expect(done.steps?.map((s) => s.agentId)).toEqual(['sean', undefined, undefined])
  })
})
