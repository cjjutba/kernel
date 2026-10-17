import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentDef, Chat, SharedFile, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { git } from '../src/main/services/exec'
import { Sessions } from '../src/main/services/sessions'
import { LEAD_RULE, LEAD_SHARING_RULE } from '../src/main/services/handoff'
import { bytesMatch, claimOf, imageSize, MAX_VERSIONS, outsideRefs, sizeLabel, textOf, titleOf } from '../src/main/services/sharedFiles'
import { tempRepo, freePort } from './helpers'

// KERNEL-302: any agent shares a file with share_file. Kernel checks it, keeps each version in its data folder, puts a card
// in the chat and tells the Lead.

// The SDK's server and tool keep their names and handlers, so the tools run against a real Kernel without a session.
// `query` keeps the options each session started with and never answers.
const sdk = vi.hoisted(() => ({ calls: [] as { cwd?: string; systemPrompt?: { append?: string }; mcpServers?: Record<string, { name: string; tools: string[] }>; settings?: unknown }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (o: { name: string; tools: { name: string }[] }) => ({ name: o.name, tools: o.tools.map((t) => t.name) }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  query: ({ options }: { options: { cwd?: string } }) => {
    sdk.calls.push(options)
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 10 })
    }
  }
}))

const AGENT = (id: string, extra = '') => `---\nname: ${id}\ndescription: ${id}.\n${extra}---\nYou are ${id}.`
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000300000002080600000000000000', 'hex')
const HTML = '<!doctype html><html><head><title>Checkout mockup</title><style>body{margin:0}</style></head><body><h1>Pay</h1></body></html>'

async function setup(o: { sharing?: boolean; opened?: string[]; capture?: (f: SharedFile, v: number) => Promise<Buffer | null> } = {}) {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/kernel.md': AGENT('kernel', 'lead: true\n'), '.claude/agents/christian.md': AGENT('christian'), '.claude/agents/artkin.md': AGENT('artkin', 'role: Reviewer\n') })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...(o.sharing === undefined ? {} : { experimental: { sharing: o.sharing } }) }))
  const revealed: string[] = []
  const make = async () => {
    const k = new Kernel({ dataDir, home, reveal: (p) => revealed.push(p), ...(o.opened ? { openFile: async (p: string) => { o.opened!.push(p) } } : {}), ...(o.capture ? { capture: { thumbnail: o.capture } } : {}) })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    return k
  }
  let k = await make()
  onTestFinished(() => k.stop())
  const project = await k.addProject(repo)
  const lead = await k.leadChat(project.id)
  const leadWs = k.store.workspace(lead.workspaceId)!
  const christian = await k.createWorkspace(project.id, { prompt: 'Build the checkout', agentId: 'christian', title: 'Checkout', leadChatId: lead.id })
  await git(christian.path, 'commit', '--allow-empty', '-qm', 'start')
  const review = await k.createWorkspace(project.id, { prompt: 'Review it', agentId: 'artkin', title: 'Review checkout', leadChatId: lead.id, reviewOf: christian.id })
  const agents = await k.agents(project.id)
  const agent = (id: string) => agents.find((a) => a.id === id) as AgentDef
  const chatOf = (ws: Workspace) => (ws.id === leadWs.id ? lead : k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!)
  const put = async (ws: Workspace, rel: string, data: string | Buffer) => { await mkdir(dirname(join(ws.path, rel)), { recursive: true }); await writeFile(join(ws.path, rel), data); return rel }
  /** Calls share_file as the workspace's agent would, in its first chat. */
  const share = async (ws: Workspace, args: { path: string; title?: string; note?: string }, chat: Chat = chatOf(ws)) => {
    const t = k.toolsFor(ws, agent(ws.agentId), chat).find((x) => x.name === 'share_file')!
    const r = await t.handler(args as never, {})
    return { text: (r.content[0] as { text: string }).text, isError: !!(r as { isError?: boolean }).isError }
  }
  const restart = async () => { await k.stop(); k = await make(); return k }
  return { k: () => k, repo, dataDir, project, lead, leadWs, christian, review, agent, chatOf, put, share, restart, revealed }
}

const onlyFile = (k: Kernel) => { const [f] = k.store.sharedFiles(); return f }

/** Starts the workspace's chat for real (setup stubs send) and returns the options its session got. */
async function started(s: Awaited<ReturnType<typeof setup>>, ws: Workspace) {
  await Sessions.prototype.send.call(s.k().sessions, s.chatOf(ws).id, [{ type: 'text', text: 'hi' }])
  return vi.waitFor(() => { const c = sdk.calls.find((x) => x.cwd === ws.path); if (!c) throw new Error('no session yet'); return c })
}

describe('what a shared file is (KERNEL-302)', () => {
  it('takes the type from the extension and needs the first bytes to agree', () => {
    const ok: [string, Buffer | string][] = [
      ['a.png', PNG], ['a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])], ['a.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
      ['a.gif', 'GIF89a\x01\x00\x01\x00'], ['a.gif', 'GIF87a\x01\x00'], ['a.webp', 'RIFF\x24\x00\x00\x00WEBPVP8 '], ['a.pdf', '%PDF-1.7\n'],
      ['a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'], ['a.svg', '﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg>\n<svg>'],
      ['a.html', HTML], ['a.htm', '<p>hi</p>'], ['a.md', '# Notes\n'], ['a.markdown', 'text']
    ]
    for (const [name, data] of ok) expect(bytesMatch(Buffer.from(data as never), claimOf(name)!.mime), name).toBe(true)
    const wrong: [string, Buffer | string][] = [
      ['a.png', 'not a png'], ['a.jpg', PNG], ['a.gif', 'GIF90a'], ['a.webp', 'RIFF\x24\x00\x00\x00WAVE'], ['a.pdf', '<html>'],
      ['a.svg', '<html><svg></svg></html>'], ['a.svg', '<svg\x00>'], ['a.html', PNG], ['a.md', 'a\x00b']
    ]
    for (const [name, data] of wrong) expect(bytesMatch(Buffer.from(data as never), claimOf(name)!.mime), name).toBe(false)
    for (const name of ['a.txt', 'a.js', 'a', 'a.html.zip', 'a.tiff']) expect(claimOf(name), name).toBeUndefined()
    expect(claimOf('A.HTML')?.kind).toBe('html')
    expect(textOf(Buffer.from([0x61, 0xff, 0x62]))).toBeUndefined()
    expect(textOf(Buffer.from('﻿café'))).toBe('café')
  })

  it('titles a file from the argument, the HTML title, the first # heading, then the file name', () => {
    expect(titleOf({ title: '  Pay  page ', kind: 'html', text: HTML, name: 'a.html' })).toBe('Pay page')
    expect(titleOf({ kind: 'html', text: '<title>\n  Tom &amp; Jerry&#39;s </title>', name: 'a.html' })).toBe("Tom & Jerry's")
    expect(titleOf({ kind: 'html', text: '<title> </title><h1>x</h1>', name: 'a.html' })).toBe('a.html')
    expect(titleOf({ kind: 'markdown', text: 'intro\n## Two\n# One #\n', name: 'n.md' })).toBe('One')
    expect(titleOf({ kind: 'markdown', text: '#nospace\n', name: 'n.md' })).toBe('n.md')
    expect(titleOf({ kind: 'image', name: 'logo.png' })).toBe('logo.png')
  })

  it('counts references that would load from outside the file, and not links or data: URLs', () => {
    const html = `<link rel="stylesheet" href="app.css"><script src="https://cdn.x/app.js"></script><img src="data:image/png;base64,AA">
      <img src='logo.png' srcset="a.png 1x, data:image/png;base64,AA 2x, b.png 3x"><a href="https://x.dev">x</a><a href="#top">top</a>
      <style>@import "fonts.css"; .a{background:url( 'bg.png' )} .b{background:url(data:image/png;base64,AA)} .c{background:url(#g)}</style>
      <video poster=poster.jpg src="v.mp4"></video><div style="background-image:url(&quot;x.png&quot;)"></div>`
    // app.css, app.js, logo.png, a.png, b.png, fonts.css, bg.png, poster.jpg, v.mp4, x.png
    expect(outsideRefs(html)).toBe(10)
    expect(outsideRefs(HTML)).toBe(0)
  })

  it('reads image sizes from their headers and writes sizes plainly', () => {
    expect(imageSize(PNG, 'image/png')).toEqual({ width: 3, height: 2 })
    expect(imageSize(Buffer.from('GIF89a\x05\x00\x07\x00', 'latin1'), 'image/gif')).toEqual({ width: 5, height: 7 })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0])
    expect(imageSize(jpeg, 'image/jpeg')).toEqual({ width: 64, height: 32 })
    const vp8x = Buffer.alloc(30); vp8x.write('RIFF', 0); vp8x.write('WEBP', 8); vp8x.write('VP8X', 12); vp8x.writeUIntLE(99, 24, 3); vp8x.writeUIntLE(49, 27, 3)
    expect(imageSize(vp8x, 'image/webp')).toEqual({ width: 100, height: 50 })
    expect(imageSize(PNG.subarray(0, 12), 'image/png')).toBeUndefined()
    expect([sizeLabel(1), sizeLabel(312), sizeLabel(48 * 1024 + 100), sizeLabel(1024 * 1024), sizeLabel(1.25 * 1024 * 1024)]).toEqual(['1 byte', '312 bytes', '48 KB', '1 MB', '1.3 MB'])
  })
})

describe('share_file (KERNEL-302)', () => {
  it("copies a teammate's file as v1, puts its card in the chat, tells the renderer and keeps the folder out of git", async () => {
    const { k, christian, put, share, chatOf, dataDir, repo } = await setup()
    const pushed: PushEvent[] = []
    const on = (e: PushEvent) => pushed.push(e)
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    await put(christian, '.kernel/shared/checkout.html', HTML)
    expect(await share(christian, { path: '.kernel/shared/checkout.html', note: 'First pass' })).toEqual({ isError: false, text: `Shared "Checkout mockup" as v1 (HTML, ${HTML.length} bytes). The user sees a card for it in this chat and can open it in a tab. Share the same path again after changes to add a version.` })
    const f = onlyFile(k())
    expect(f).toMatchObject({ projectId: christian.projectId, workspaceId: christian.id, agentId: 'christian', source: '.kernel/shared/checkout.html', title: 'Checkout mockup', kind: 'html' })
    expect(f.versions).toEqual([expect.objectContaining({ n: 1, file: 'checkout.html', mime: 'text/html', bytes: HTML.length, chatId: chatOf(christian).id, note: 'First pass' })])
    expect(f.versions[0]).not.toHaveProperty('outside')
    expect(await readFile(join(dataDir, 'shared', f.id, 'v1', 'checkout.html'), 'utf8')).toBe(HTML)
    expect(k().store.items(chatOf(christian).id).filter((i) => i.kind === 'shared')).toEqual([expect.objectContaining({ kind: 'shared', sharedId: f.id, version: 1 })])
    expect(pushed).toContainEqual({ type: 'shared', file: f })
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.kernel/shared/\n')
    expect((await git(christian.path, 'status', '--porcelain')).trim()).toBe('')
  })

  it('adds a version for new bytes, nothing for the same bytes, and lets the newest title win', async () => {
    const { k, christian, put, share, chatOf } = await setup()
    await put(christian, 'mock.html', HTML)
    await share(christian, { path: 'mock.html' })
    expect(await share(christian, { path: 'mock.html' })).toEqual({ isError: false, text: 'Already shared: "Checkout mockup" v1 is the same file, so there is no new version.' })
    await put(christian, 'mock.html', HTML.replace('Pay', 'Pay now'))
    expect((await share(christian, { path: './mock.html', title: 'Checkout, take two' })).text).toMatch(/^Shared "Checkout, take two" as v2 \(HTML, /)
    // The same file by its absolute path is the same source.
    expect((await share(christian, { path: join(christian.path, 'mock.html') })).text).toBe('Already shared: "Checkout, take two" v2 is the same file, so there is no new version.')
    const f = onlyFile(k())
    expect(f.versions.map((v) => v.n)).toEqual([1, 2])
    expect(f.title).toBe('Checkout, take two')
    expect(k().store.items(chatOf(christian).id).filter((i) => i.kind === 'shared').map((i) => i.kind === 'shared' && i.version)).toEqual([1, 2])
    expect((await k().handlers()['shared.read']({ sharedId: f.id, version: 1 })).text).toBe(HTML)
    expect((await k().handlers()['shared.read']({ sharedId: f.id, version: 2 })).text).toContain('Pay now')
  })

  it('takes turns per file, so two calls at once make one version each and never the same number', async () => {
    const { k, christian, put, share } = await setup()
    await put(christian, 'a.md', '# A\n')
    const [one, two] = await Promise.all([share(christian, { path: 'a.md' }), share(christian, { path: 'a.md' })])
    expect([one.text, two.text].map((t) => t.split(' (')[0].split(' is ')[0]).sort()).toEqual(['Already shared: "A" v1', 'Shared "A" as v1'])
    expect(onlyFile(k()).versions).toHaveLength(1)
  })

  it('warns when outside references in HTML will not load', async () => {
    const { k, christian, put, share } = await setup()
    await put(christian, 'x.html', '<title>X</title><link rel="stylesheet" href="x.css"><img src="https://x.dev/a.png">')
    const r = await share(christian, { path: 'x.html' })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/Share the same path again after changes to add a version\. 2 references to other files or the network won't load: the preview has no network\./)
    expect(onlyFile(k()).versions[0].outside).toBe(2)
  })

  it('refuses what it cannot share, each with a reason that starts "Not shared:"', async () => {
    const { k, christian, put, share, dataDir } = await setup()
    const outside = join(await mkdtemp(join(tmpdir(), 'kernel-outside-')), 'secret.html')
    await writeFile(outside, HTML)
    await put(christian, 'folder.html/inner.md', '# x\n')
    await symlink(outside, join(christian.path, 'link.html'))
    await symlink(dirname(outside), join(christian.path, 'outdir'))
    await put(christian, 'notes.txt', 'plain')
    await put(christian, 'big.html', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))
    await put(christian, 'big.svg', Buffer.concat([Buffer.from('<svg>'), Buffer.alloc(2 * 1024 * 1024, 0x20)]))
    await put(christian, 'fake.png', 'hello')
    await put(christian, 'nul.html', 'a\x00b')
    await put(christian, 'latin1.md', Buffer.from([0x23, 0x20, 0xe9, 0x0a]))
    const refused: [string, string][] = [
      ['nope.html', 'there is no file at nope.html.'],
      ['folder.html', 'folder.html is a folder. Share one file.'],
      ['../escape.html', '../escape.html is outside this workspace. Save it under .kernel/shared/ in the workspace and share that.'],
      [outside, `${outside} is outside this workspace. Save it under .kernel/shared/ in the workspace and share that.`],
      ['link.html', 'link.html is outside this workspace. Save it under .kernel/shared/ in the workspace and share that.'],
      ['outdir/secret.html', 'outdir/secret.html is outside this workspace. Save it under .kernel/shared/ in the workspace and share that.'],
      ['notes.txt', 'Kernel shows HTML, images (PNG, JPEG, GIF, WebP, SVG), PDF and Markdown, and notes.txt is none of these.'],
      ['big.html', 'big.html is 10 MB, over the 10 MB limit for HTML.'],
      ['big.svg', 'big.svg is 2 MB, over the 2 MB limit for SVG.'],
      ['fake.png', "fake.png doesn't hold PNG inside, so its contents don't match its extension."],
      ['nul.html', "nul.html doesn't hold HTML inside, so its contents don't match its extension."],
      ['latin1.md', "latin1.md isn't UTF-8 text. Save Markdown as UTF-8."],
      ['  ', 'give the path of the file to share.']
    ]
    for (const [path, why] of refused) expect(await share(christian, { path }), path).toEqual({ isError: true, text: `Not shared: ${why}` })
    expect(k().store.sharedFiles()).toEqual([])

    // A file at its version limit, and a copy that fails, add nothing.
    await put(christian, 'full.md', '# Full\n')
    await share(christian, { path: 'full.md' })
    const f = onlyFile(k())
    k().store.saveSharedFile({ ...f, versions: Array.from({ length: MAX_VERSIONS }, (_, i) => ({ ...f.versions[0], n: i + 1 })) })
    await put(christian, 'full.md', '# Full\nmore\n')
    expect(await share(christian, { path: 'full.md' })).toEqual({ isError: true, text: 'Not shared: "Full" already has 100 versions. Save it under a new name to share more.' })
    await put(christian, 'other.md', '# Other\n')
    // The data folder's shared folder is a file now, so the copy can't be written.
    await rm(join(dataDir, 'shared'), { recursive: true })
    await writeFile(join(dataDir, 'shared'), 'not a folder')
    const failed = await share(christian, { path: 'other.md' })
    expect(failed.isError).toBe(true)
    expect(failed.text).toMatch(/^Not shared: Kernel couldn't copy other\.md \(/)
    expect(k().store.sharedFiles().map((x) => x.source)).toEqual(['full.md'])
  })

  it('shares from the Lead, in its own worktree, and from a reviewer, into their own chats', async () => {
    const { k, leadWs, review, put, share, lead, chatOf, project } = await setup()
    expect(leadWs.path).not.toBe(project.path)
    await put(leadWs, '.kernel/shared/plan.md', '# The plan\n')
    expect((await share(leadWs, { path: '.kernel/shared/plan.md' })).text).toMatch(/^Shared "The plan" as v1 \(Markdown, /)
    await put(review, 'diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')
    expect((await share(review, { path: 'diagram.svg' })).text).toMatch(/^Shared "diagram.svg" as v1 \(SVG, /)
    expect(k().store.items(lead.id).filter((i) => i.kind === 'shared')).toHaveLength(1)
    expect(k().store.items(chatOf(review).id).filter((i) => i.kind === 'shared')).toHaveLength(1)
    expect(k().store.sharedFiles({ workspaceId: leadWs.id }).map((f) => f.title)).toEqual(['The plan'])
    expect(k().store.sharedFiles({ projectId: project.id }).map((f) => f.title)).toEqual(['diagram.svg', 'The plan'])
    expect(await k().handlers()['shared.list']({ projectId: project.id, limit: 1 })).toHaveLength(1)
  })

  it("adds a teammate's share to the Lead's next Team update and nothing for the Lead's own", async () => {
    const { k, christian, leadWs, put, share } = await setup()
    await put(christian, 'a.png', PNG)
    await put(leadWs, 'b.png', PNG)
    await share(christian, { path: 'a.png', title: 'Logo' })
    await share(leadWs, { path: 'b.png' })
    const pending = (k().store.meta<{ pending: [string, { events: { kind: string; workspaceId: string; shared?: unknown }[] }][] }>('leadUpdates')?.pending ?? []).flatMap(([, p]) => p.events)
    expect(pending.filter((e) => e.kind === 'shared')).toEqual([expect.objectContaining({ workspaceId: christian.id, shared: expect.objectContaining({ title: 'Logo', kind: 'image', version: 1, source: 'a.png' }) })])
    expect(k().store.sharedFiles({ workspaceId: christian.id })[0].versions[0]).toMatchObject({ width: 3, height: 2, mime: 'image/png' })
  })

  it('serves images and PDFs as data URLs and reveals the source while it still matches, else the copy', async () => {
    const { k, christian, put, share, revealed, dataDir } = await setup()
    await put(christian, 'logo.png', PNG)
    await share(christian, { path: 'logo.png' })
    const f = onlyFile(k())
    expect(await k().handlers()['shared.read']({ sharedId: f.id, version: 1 })).toEqual({ kind: 'image', mime: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` })
    await k().handlers()['shared.reveal']({ sharedId: f.id, version: 1 })
    await put(christian, 'logo.png', Buffer.concat([PNG, Buffer.from([0])]))
    await k().handlers()['shared.reveal']({ sharedId: f.id, version: 1 })
    expect(revealed).toEqual([join(christian.path, 'logo.png'), join(dataDir, 'shared', f.id, 'v1', 'logo.png')])
    await expect(k().handlers()['shared.read']({ sharedId: f.id, version: 9 })).rejects.toThrow('That shared file or version is gone.')
    expect(k().sharedFile(f.id, 1)?.path).toBe(join(dataDir, 'shared', f.id, 'v1', 'logo.png'))
    expect(k().sharedFile(f.id, 2)).toBeUndefined()
  })

  it("opens Kernel's copy of a PDF in the default app, and nothing else", async () => {
    const opened: string[] = []
    const { k, christian, put, share, dataDir } = await setup({ opened })
    await put(christian, 'sample.pdf', Buffer.from('%PDF-1.7\n'))
    await put(christian, 'logo.png', PNG)
    await share(christian, { path: 'sample.pdf' })
    await share(christian, { path: 'logo.png' })
    const [pdf, png] = [k().store.sharedFiles({}).find((f) => f.kind === 'pdf')!, k().store.sharedFiles({}).find((f) => f.kind === 'image')!]
    await k().handlers()['shared.open']({ sharedId: pdf.id, version: 1 })
    expect(opened).toEqual([join(dataDir, 'shared', pdf.id, 'v1', 'sample.pdf')])
    await expect(k().handlers()['shared.open']({ sharedId: png.id, version: 1 })).rejects.toThrow('Only a PDF opens in Preview.')
    await expect(k().handlers()['shared.open']({ sharedId: pdf.id, version: 9 })).rejects.toThrow('That shared file or version is gone.')
    expect(opened).toHaveLength(1)
  })

  it('saves the thumbnail a capture draws, and has none without one', async () => {
    const thumbs: [string, number][] = []
    const { k, christian, put, share } = await setup({ capture: async (f, v) => { thumbs.push([f.id, v]); return PNG } })
    await put(christian, 'x.html', HTML)
    await share(christian, { path: 'x.html' })
    const f = onlyFile(k())
    await vi.waitFor(() => expect(k().store.sharedFile(f.id)?.versions[0].thumb).toBe(true))
    expect(thumbs).toEqual([[f.id, 1]])
    expect(await k().handlers()['shared.thumb']({ sharedId: f.id, version: 1 })).toBe(`data:image/png;base64,${PNG.toString('base64')}`)

    const plain = await setup()
    await plain.put(plain.christian, 'x.html', HTML)
    await plain.share(plain.christian, { path: 'x.html' })
    expect(await plain.k().handlers()['shared.thumb']({ sharedId: onlyFile(plain.k()).id, version: 1 })).toBeNull()
  })

  it('keeps the copies when the workspace is archived and after a restart, and deletes them with the project', async () => {
    const { k, christian, put, share, dataDir, restart, project } = await setup()
    await put(christian, 'x.html', HTML)
    await share(christian, { path: 'x.html' })
    const f = onlyFile(k())
    const copy = join(dataDir, 'shared', f.id, 'v1', 'x.html')
    await k().archiveWorkspace(christian.id)
    expect(k().store.workspace(christian.id)?.status).toBe('archived')
    expect(await readFile(copy, 'utf8')).toBe(HTML)
    await restart()
    expect(await k().handlers()['shared.list']({ workspaceId: christian.id })).toEqual([f])
    expect((await k().handlers()['shared.read']({ sharedId: f.id, version: 1 })).text).toBe(HTML)
    await k().removeProject(project.id, false)
    expect(k().store.sharedFiles()).toEqual([])
    expect(existsSync(join(dataDir, 'shared', f.id))).toBe(false)
  })
})

describe('who gets share_file (KERNEL-302)', () => {
  it("keeps Kernel's own server, share_file included, when the project switches off MCP servers named kernel (KERNEL-226)", async () => {
    const s = await setup()
    await mkdir(join(s.project.path, '.kernel'), { recursive: true })
    await writeFile(join(s.project.path, '.kernel', 'settings.local.toml'), '[disabled]\nmcp = ["kernel", "chrome-devtools"]\n')
    for (const [ws, id] of [[s.leadWs, 'kernel-lead'], [s.review, 'artkin'], [s.christian, 'christian']] as const) {
      const c = await started(s, ws)
      const tools = s.k().toolsFor(ws, s.agent(id), s.chatOf(ws)).map((t) => t.name)
      expect(tools, id).toContain('share_file')
      expect(c.mcpServers, id).toEqual({ kernel: { name: 'kernel', tools } })
      expect(c.settings, id).toEqual({ deniedMcpServers: [{ serverName: 'chrome-devtools' }] })
    }
  })

  it('gives a new Lead, reviewer and teammate session share_file, and the Lead its rule, with no setting in settings.json (KERNEL-308)', async () => {
    // setup writes no experimental table unless asked, so these sessions run on the defaults.
    const s = await setup()
    for (const ws of [s.leadWs, s.review, s.christian]) {
      const c = await started(s, ws)
      expect(c.mcpServers?.kernel.tools, ws.agentId).toContain('share_file')
      if (ws === s.leadWs) expect(c.systemPrompt?.append).toContain(LEAD_SHARING_RULE)
    }
  })

  it('gives every agent share_file next to its own tools while sharing is on, and nothing new while it is off', async () => {
    const on = await setup({ sharing: true })
    const names = (s: typeof on, ws: Workspace, id: string) => s.k().toolsFor(ws, s.agent(id), s.chatOf(ws)).map((t) => t.name)
    const lead = names(on, on.leadWs, 'kernel-lead')
    expect(lead).toEqual(expect.arrayContaining(['create_workspace', 'message_agent', 'share_file']))
    expect(lead.at(-1)).toBe('share_file')
    expect(names(on, on.review, 'artkin')).toEqual(['submit_review', 'get_issue', 'share_file'])
    expect(names(on, on.christian, 'christian')).toEqual(['wait_for_merge', 'ask_lead', 'propose_handoff', 'get_issue', 'share_file'])
    const mcp = (s: typeof on, ws: Workspace, id: string) => (s.k().sessions as unknown as { d: { mcpFor: (w: Workspace, a: AgentDef, c: Chat) => Record<string, { name: string; tools: string[] }> } }).d.mcpFor(ws, s.agent(id), s.chatOf(ws))
    expect(mcp(on, on.christian, 'christian')).toEqual({ kernel: { name: 'kernel', tools: ['wait_for_merge', 'ask_lead', 'propose_handoff', 'get_issue', 'share_file'] } })
    expect(mcp(on, on.leadWs, 'kernel-lead').kernel.tools).toEqual(lead)

    const off = await setup({ sharing: false })
    expect(names(off, off.leadWs, 'kernel-lead')).toEqual(lead.slice(0, -1))
    expect(mcp(off, off.review, 'artkin')).toEqual({ kernel: { name: 'kernel', tools: ['submit_review', 'get_issue'] } })
    expect(mcp(off, off.christian, 'christian')).toEqual({ kernel: { name: 'kernel', tools: ['wait_for_merge', 'ask_lead', 'propose_handoff', 'get_issue'] } })
    expect(mcp(off, off.leadWs, 'kernel-lead').kernel.tools).toEqual(lead.slice(0, -1))

    // The Lead's prompt names shared files only while sharing is on. With it off, each session starts as on main: the
    // same server and tools, and no word about sharing in any prompt.
    const onPrompt = (await started(on, on.leadWs)).systemPrompt?.append ?? ''
    expect(onPrompt).toContain(LEAD_RULE)
    expect(onPrompt).toContain(LEAD_SHARING_RULE)
    const offLead = await started(off, off.leadWs)
    expect(offLead.systemPrompt?.append).toContain(LEAD_RULE)
    expect(offLead.mcpServers).toEqual({ kernel: { name: 'kernel', tools: lead.slice(0, -1) } })
    const offReview = await started(off, off.review)
    expect(offReview.mcpServers).toEqual({ kernel: { name: 'kernel', tools: ['submit_review', 'get_issue'] } })
    const offKai = await started(off, off.christian)
    expect(offKai.mcpServers).toEqual({ kernel: { name: 'kernel', tools: ['wait_for_merge', 'ask_lead', 'propose_handoff', 'get_issue'] } })
    for (const c of [offLead, offReview, offKai]) {
      expect(c.systemPrompt?.append).not.toContain(LEAD_SHARING_RULE)
      expect(c.systemPrompt?.append).not.toMatch(/share_file|shared/i)
    }
  })
})
