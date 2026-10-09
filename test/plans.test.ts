import { describe, expect, it, onTestFinished } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { run } from '../src/main/services/exec'
import { searchFiles } from '../src/main/services/files'
import { attachmentNote, planName, saveAttachments, savePlan } from '../src/main/services/plans'
import { Kernel } from '../src/main/kernel'

// D-092: plan-mode plans are saved as files a later chat can build from, and git never sees them.

const status = async (repo: string) => (await run('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'])).trim()
const PLAN = '# Export invoices as PDF\n\n## Context\nThe table has row actions.\n\n## Steps\n1. Renderer\n2. Button\n'

describe('saved plans', () => {
  it('names the file after the opening heading, or the fallback without one', () => {
    expect(planName(PLAN, 'Plan for lead')).toBe('export-invoices-as-pdf')
    expect(planName('1. Do it\n2. Test it', 'Plan for invoice-table')).toBe('plan-for-invoice-table')
    expect(planName('## KERNEL-83 Fix batch B1: floor renderer, sequence and moments', 'x')).toBe('kernel-83-fix-batch-b1-floor-renderer-sequence-and-moments')
    expect(planName('# ¿¿??', '!!')).toBe('plan')
  })

  it('writes the plan under .kernel/plans and keeps it out of git', async () => {
    const repo = await tempRepo()
    const file = await savePlan(repo, PLAN, { fallback: 'Plan for lead' })
    expect(file).toBe('.kernel/plans/export-invoices-as-pdf.md')
    expect(await readFile(join(repo, file), 'utf8')).toBe(PLAN)
    expect(await status(repo)).toBe('')
  })

  it('overwrites a revision in place, and gives a new plan with the same title a file of its own', async () => {
    const repo = await tempRepo()
    const first = await savePlan(repo, PLAN, { fallback: 'x' })
    const revised = await savePlan(repo, `${PLAN}3. Tests`, { fallback: 'x', reuse: first })
    expect(revised).toBe(first)
    expect(await readFile(join(repo, first), 'utf8')).toContain('3. Tests')
    const another = await savePlan(repo, PLAN, { fallback: 'x' })
    expect(another).toBe('.kernel/plans/export-invoices-as-pdf-2.md')
    // A reuse path that isn't a saved plan is ignored rather than written to.
    expect(await savePlan(repo, PLAN, { fallback: 'x', reuse: '../outside.md' })).toBe('.kernel/plans/export-invoices-as-pdf-3.md')
  })

  it('lists saved plans in the @ menu even though git ignores them', async () => {
    const repo = await tempRepo()
    await savePlan(repo, PLAN, { fallback: 'x' })
    expect((await searchFiles(repo, 'exportpdf')).map((f) => f.path)).toContain('.kernel/plans/export-invoices-as-pdf.md')
  })
})

// D-131: images sent with a change request are saved in the workspace, out of git, and named in the denial.

const png = (bytes: string) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`

describe('change request attachments', () => {
  it('saves each image under .kernel/attachments with a name of its own, out of git', async () => {
    const repo = await tempRepo()
    const paths = await saveAttachments(repo, [
      { name: 'image.png', dataUrl: png('first') },
      { name: 'image.png', dataUrl: png('second') },
      { name: 'Screen Shot.jpeg', dataUrl: `data:image/jpeg;base64,${Buffer.from('third').toString('base64')}` }
    ])
    expect(paths).toEqual([
      join(repo, '.kernel/attachments/image.png'),
      join(repo, '.kernel/attachments/image-2.png'),
      join(repo, '.kernel/attachments/screen-shot.jpg')
    ])
    expect(await Promise.all(paths.map((p) => readFile(p, 'utf8')))).toEqual(['first', 'second', 'third'])
    expect(await status(repo)).toBe('')
    expect(await readFile(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.kernel/attachments/\n')
    // A later request doesn't overwrite an earlier one's images.
    expect(await saveAttachments(repo, [{ name: 'image.png', dataUrl: png('fourth') }])).toEqual([join(repo, '.kernel/attachments/image-3.png')])
  })

  it('refuses something that is not an image data URL', async () => {
    const repo = await tempRepo()
    await expect(saveAttachments(repo, [{ name: 'notes.txt', dataUrl: 'data:text/plain;base64,aGk=' }])).rejects.toThrow("notes.txt isn't an image")
  })

  it('adds one line per image after the typed change, or stands alone without one', () => {
    expect(attachmentNote('Move the button left', ['/w/.kernel/attachments/image.png', '/w/.kernel/attachments/image-2.png'])).toBe(
      'Move the button left\n\n' +
      'Attached image: /w/.kernel/attachments/image.png. Read it before revising the plan.\n' +
      'Attached image: /w/.kernel/attachments/image-2.png. Read it before revising the plan.'
    )
    expect(attachmentNote('', ['/w/a.png'])).toBe('Attached image: /w/a.png. Read it before revising the plan.')
  })
})

describe('a plan change request with images, through approvals.decide', () => {
  async function kernel() {
    const repo = await tempRepo({ '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    const room = await k.addRoom(repo)
    const chat = await k.leadChat(room.id)
    const ws = k.store.workspace(chat.workspaceId)!
    const ask = (toolName = 'ExitPlanMode') => k.approvals.request({ roomId: room.id, workspaceId: ws.id, chatId: chat.id, kind: 'plan', source: 'sdk', toolName, title: 'Plan for lead', input: { plan: PLAN } })
    return { k, ws, ask, decide: k.handlers()['approvals.decide'] }
  }

  it('saves the images in the workspace and lists their paths in the denial', async () => {
    const { ws, ask, decide } = await kernel()
    const { approval, decision } = ask()
    const a = await decide({ id: approval.id, decision: { behavior: 'deny', message: 'Match this', images: [{ name: 'image.png', dataUrl: png('a') }, { name: 'image.png', dataUrl: png('b') }] } })
    expect(a.status).toBe('denied')
    const one = join(ws.path, '.kernel/attachments/image.png')
    const two = join(ws.path, '.kernel/attachments/image-2.png')
    expect(await decision).toEqual({ behavior: 'deny', message: `Match this\n\nAttached image: ${one}. Read it before revising the plan.\nAttached image: ${two}. Read it before revising the plan.` })
    expect(await readFile(two, 'utf8')).toBe('b')
    expect(await status(ws.path)).toBe('')
  })

  it('sends an image-only request, and leaves a text-only one as it was', async () => {
    const { ws, ask, decide } = await kernel()
    const first = ask()
    await decide({ id: first.approval.id, decision: { behavior: 'deny', message: '', images: [{ name: 'shot.png', dataUrl: png('a') }] } })
    expect(await first.decision).toEqual({ behavior: 'deny', message: `Attached image: ${join(ws.path, '.kernel/attachments/shot.png')}. Read it before revising the plan.` })
    const second = ask()
    await decide({ id: second.approval.id, decision: { behavior: 'deny', message: 'Smaller steps' } })
    expect(await second.decision).toEqual({ behavior: 'deny', message: 'Smaller steps' })
  })
})
