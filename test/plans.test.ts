import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, freePort } from './helpers'
import { run } from '../src/main/services/exec'
import { searchFiles } from '../src/main/services/files'
import { attachedImages, attachmentNote, imagePart, saveAttachments, savePlan, withImageFiles } from '../src/main/services/plans'
import { Kernel } from '../src/main/kernel'
import type { Approval, ChatPart } from '@shared/types'

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

// D-134: images sent with a change request are saved in the workspace, out of git, and named in the denial.

const png = (bytes: string) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`

describe('change request attachments', () => {
  it('saves each message in a folder of its own under .kernel/attachments, keeping each image name, out of git', async () => {
    const repo = await tempRepo()
    const paths = await saveAttachments(repo, [
      { name: 'image.png', dataUrl: png('first') },
      { name: 'image.png', dataUrl: png('second') },
      { name: 'Screen Shot.jpeg', dataUrl: `data:image/jpeg;base64,${Buffer.from('third').toString('base64')}` }
    ])
    expect(paths).toEqual([
      join(repo, '.kernel/attachments/1/image.png'),
      join(repo, '.kernel/attachments/1/image-2.png'),
      join(repo, '.kernel/attachments/1/screen-shot.jpg')
    ])
    expect(await Promise.all(paths.map((p) => readFile(p, 'utf8')))).toEqual(['first', 'second', 'third'])
    expect(await status(repo)).toBe('')
    expect(await readFile(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.kernel/attachments/\n')
    // The next message starts at image.png again, in its own folder, and doesn't overwrite the first.
    expect(await saveAttachments(repo, [{ name: 'image.png', dataUrl: png('fourth') }])).toEqual([join(repo, '.kernel/attachments/2/image.png')])
    expect(await readFile(paths[0], 'utf8')).toBe('first')
  })

  it('refuses something that is not an image data URL, and writes none of the request', async () => {
    const repo = await tempRepo()
    await expect(saveAttachments(repo, [{ name: 'image.png', dataUrl: png('first') }, { name: 'notes.txt', dataUrl: 'data:text/plain;base64,aGk=' }])).rejects.toThrow("notes.txt isn't an image")
    await expect(access(join(repo, '.kernel/attachments'))).rejects.toThrow()
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

describe('images in a chat message (KERNEL-545)', () => {
  it('saves each image once, out of git, and gives it a path relative to the workspace', async () => {
    const repo = await tempRepo()
    const parts: ChatPart[] = [
      { type: 'text', text: 'look at' },
      { type: 'image', name: 'image.png', dataUrl: png('first'), width: 800, height: 600 },
      { type: 'text', text: 'and compare with' },
      { type: 'image', name: 'image.png', dataUrl: png('second') }
    ]
    const saved = await withImageFiles(repo, parts)
    expect(saved).toEqual([parts[0], { ...parts[1], path: '.kernel/attachments/1/image.png' }, parts[2], { ...parts[3], path: '.kernel/attachments/1/image-2.png' }])
    expect(await readFile(join(repo, '.kernel/attachments/1/image-2.png'), 'utf8')).toBe('second')
    expect(await status(repo)).toBe('')
    // Saved already, so nothing is written again.
    expect(await withImageFiles(repo, saved)).toBe(saved)
    await expect(access(join(repo, '.kernel/attachments/2'))).rejects.toThrow()
  })

  it('leaves the message as it was when the images can\'t be saved, so they go inline', async () => {
    const file = join(await tempRepo(), 'README.md')
    const parts: ChatPart[] = [{ type: 'image', name: 'image.png', dataUrl: png('first') }]
    expect(await withImageFiles(file, parts)).toBe(parts)
  })
})

describe("the user's images the Lead passes on (KERNEL-658)", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')])
  const GIF = Buffer.from('GIF89a pixels')
  /** A Lead workspace with `files` in `.kernel/attachments/`. */
  async function lead(files: Record<string, Buffer | string> = {}) {
    const root = await tempRepo()
    await mkdir(join(root, '.kernel/attachments'), { recursive: true })
    for (const [name, data] of Object.entries(files)) await writeFile(join(root, '.kernel/attachments', name), data)
    return root
  }

  it('reads each image as a part with its data URL and no path, by a relative or an absolute path', async () => {
    const root = await lead({ 'login.png': PNG, 'spinner.gif': GIF })
    expect(await attachedImages(root, ['.kernel/attachments/login.png', join(root, '.kernel/attachments/spinner.gif')])).toEqual([
      { type: 'image', name: 'login.png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
      { type: 'image', name: 'spinner.gif', dataUrl: `data:image/gif;base64,${GIF.toString('base64')}` }
    ])
  })

  it('sends the scaled image and its size, named for the type it became', async () => {
    const root = await lead({ 'wide.gif': GIF })
    const downscale = vi.fn(async () => ({ data: Buffer.from('small'), mime: 'image/png', width: 1568, height: 980 }))
    expect(await imagePart(join(root, '.kernel/attachments/wide.gif'), downscale)).toEqual({ type: 'image', name: 'wide.png', dataUrl: `data:image/png;base64,${Buffer.from('small').toString('base64')}`, width: 1568, height: 980 })
    expect(downscale).toHaveBeenCalledWith(GIF, 'image/gif')
  })

  it('refuses a path outside the attachments, a missing file and a file that is not an image', async () => {
    const root = await lead({ 'login.png': PNG, 'notes.txt': 'text', 'fake.png': 'not a png' })
    await writeFile(join(root, 'shot.png'), PNG)
    await symlink(join(root, 'shot.png'), join(root, '.kernel/attachments/link.png'))
    const outside = (p: string) => `${p} isn't in .kernel/attachments/ of your workspace. Send only images the user attached in this chat.`
    await expect(attachedImages(root, ['shot.png'])).rejects.toThrow(outside('shot.png'))
    await expect(attachedImages(root, ['.kernel/attachments/../../shot.png'])).rejects.toThrow(outside('.kernel/attachments/../../shot.png'))
    // A link inside the folder to a file outside it counts as outside.
    await expect(attachedImages(root, ['.kernel/attachments/link.png'])).rejects.toThrow(outside('.kernel/attachments/link.png'))
    await expect(attachedImages(root, ['.kernel/attachments/gone.png'])).rejects.toThrow('there is no file at .kernel/attachments/gone.png.')
    await expect(attachedImages(root, ['.kernel/attachments/notes.txt'])).rejects.toThrow(".kernel/attachments/notes.txt isn't a PNG, JPEG, GIF or WebP image.")
    await expect(attachedImages(root, ['.kernel/attachments/login.png', '.kernel/attachments/fake.png'])).rejects.toThrow("fake.png isn't a PNG, JPEG, GIF or WebP image.")
    // A workspace with no attachments at all has nothing to pass on.
    await expect(attachedImages(await tempRepo(), ['README.md'])).rejects.toThrow(outside('README.md'))
  })
})

describe('a plan change request with images, through approvals.decide', () => {
  async function kernel() {
    const repo = await tempRepo({ '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.' })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const k = new Kernel({ dataDir, home })
    await k.start()
    onTestFinished(() => k.stop())
    const room = await k.addRoom(repo)
    const chat = await k.leadChat(room.id)
    // The images go in the chat's worktree, which Kernel makes after the chat starts (KERNEL-542).
    await k.workspaces.worktreeMade(chat.workspaceId)
    const ws = k.store.workspace(chat.workspaceId)!
    const ask = (o: { kind?: Approval['kind']; toolName?: string } = { toolName: 'ExitPlanMode' }) =>
      k.approvals.request({ roomId: room.id, workspaceId: ws.id, chatId: chat.id, kind: o.kind ?? 'plan', source: 'sdk', toolName: o.toolName, title: 'Plan for lead', input: { plan: PLAN } })
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
