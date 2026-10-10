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
import { bytesMatch, claimOf, imageSize, MAX_VERSIONS, outsideRefs, sizeLabel, textOf, titleOf } from '../src/main/services/sharedFiles'
import { tempRepo } from './helpers'

// KERNEL-302: any agent shares a file with share_file. Kernel checks it, keeps each version in its data folder, puts a card
// in the chat and tells the Lead.

// The SDK's server and tool keep their names and handlers, so the tools run against a real Kernel without a session.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (o: { name: string; tools: { name: string }[] }) => ({ name: o.name, tools: o.tools.map((t) => t.name) }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }), interrupt: async () => {} })
}))

const AGENT = (id: string, extra = '') => `---\nname: ${id}\ndescription: ${id}.\n${extra}---\nYou are ${id}.`
const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000300000002080600000000000000', 'hex')
const HTML = '<!doctype html><html><head><title>Checkout mockup</title><style>body{margin:0}</style></head><body><h1>Pay</h1></body></html>'

async function setup(o: { sharing?: boolean; capture?: (f: SharedFile, v: number) => Promise<Buffer | null> } = {}) {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': AGENT('rowan', 'lead: true\n'), '.claude/agents/kai.md': AGENT('kai'), '.claude/agents/theo.md': AGENT('theo', 'role: Reviewer\n') })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, experimental: { sharing: o.sharing ?? true } }))
  const revealed: string[] = []
  const make = async () => {
    const k = new Kernel({ dataDir, home, reveal: (p) => revealed.push(p), ...(o.capture ? { capture: { thumbnail: o.capture } } : {}) })
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    return k
  }
  let k = await make()
  onTestFinished(() => k.stop())
  const room = await k.addRoom(repo)
  const lead = await k.leadChat(room.id)
  const leadWs = k.store.workspace(lead.workspaceId)!
  const kai = await k.createWorkspace(room.id, { prompt: 'Build the checkout', agentId: 'kai', title: 'Checkout', leadChatId: lead.id })
  await git(kai.path, 'commit', '--allow-empty', '-qm', 'start')
  const review = await k.createWorkspace(room.id, { prompt: 'Review it', agentId: 'theo', title: 'Review checkout', leadChatId: lead.id, reviewOf: kai.id })
  const agents = await k.agents(room.id)
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
  return { k: () => k, repo, dataDir, room, lead, leadWs, kai, review, agent, chatOf, put, share, restart, revealed }
}

const onlyFile = (k: Kernel) => { const [f] = k.store.sharedFiles(); return f }

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
    const { k, kai, put, share, chatOf, dataDir, repo } = await setup()
    const pushed: PushEvent[] = []
    const on = (e: PushEvent) => pushed.push(e)
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    await put(kai, '.kernel/shared/checkout.html', HTML)
    expect(await share(kai, { path: '.kernel/shared/checkout.html', note: 'First pass' })).toEqual({ isError: false, text: `Shared "Checkout mockup" as v1 (HTML, ${HTML.length} bytes). The user sees a card for it in this chat and can open it in a tab. Share the same path again after changes to add a version.` })
    const f = onlyFile(k())
    expect(f).toMatchObject({ roomId: kai.roomId, workspaceId: kai.id, agentId: 'kai', source: '.kernel/shared/checkout.html', title: 'Checkout mockup', kind: 'html' })
    expect(f.versions).toEqual([expect.objectContaining({ n: 1, file: 'checkout.html', mime: 'text/html', bytes: HTML.length, chatId: chatOf(kai).id, note: 'First pass' })])
    expect(f.versions[0]).not.toHaveProperty('outside')
    expect(await readFile(join(dataDir, 'shared', f.id, 'v1', 'checkout.html'), 'utf8')).toBe(HTML)
    expect(k().store.items(chatOf(kai).id).filter((i) => i.kind === 'shared')).toEqual([expect.objectContaining({ kind: 'shared', sharedId: f.id, version: 1 })])
    expect(pushed).toContainEqual({ type: 'shared', file: f })
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.kernel/shared/\n')
    expect((await git(kai.path, 'status', '--porcelain')).trim()).toBe('')
  })

  it('adds a version for new bytes, nothing for the same bytes, and lets the newest title win', async () => {
    const { k, kai, put, share, chatOf } = await setup()
    await put(kai, 'mock.html', HTML)
    await share(kai, { path: 'mock.html' })
    expect(await share(kai, { path: 'mock.html' })).toEqual({ isError: false, text: 'Already shared: "Checkout mockup" v1 is the same file, so there is no new version.' })
    await put(kai, 'mock.html', HTML.replace('Pay', 'Pay now'))
    expect((await share(kai, { path: './mock.html', title: 'Checkout, take two' })).text).toMatch(/^Shared "Checkout, take two" as v2 \(HTML, /)
    // The same file by its absolute path is the same source.
    expect((await share(kai, { path: join(kai.path, 'mock.html') })).text).toBe('Already shared: "Checkout, take two" v2 is the same file, so there is no new version.')
    const f = onlyFile(k())
    expect(f.versions.map((v) => v.n)).toEqual([1, 2])
    expect(f.title).toBe('Checkout, take two')
    expect(k().store.items(chatOf(kai).id).filter((i) => i.kind === 'shared').map((i) => i.kind === 'shared' && i.version)).toEqual([1, 2])
    expect((await k().handlers()['shared.read']({ sharedId: f.id, version: 1 })).text).toBe(HTML)
    expect((await k().handlers()['shared.read']({ sharedId: f.id, version: 2 })).text).toContain('Pay now')
  })

  it('takes turns per file, so two calls at once make one version each and never the same number', async () => {
    const { k, kai, put, share } = await setup()
    await put(kai, 'a.md', '# A\n')
    const [one, two] = await Promise.all([share(kai, { path: 'a.md' }), share(kai, { path: 'a.md' })])
    expect([one.text, two.text].map((t) => t.split(' (')[0].split(' is ')[0]).sort()).toEqual(['Already shared: "A" v1', 'Shared "A" as v1'])
    expect(onlyFile(k()).versions).toHaveLength(1)
  })

  it('warns when outside references in HTML will not load', async () => {
    const { k, kai, put, share } = await setup()
    await put(kai, 'x.html', '<title>X</title><link rel="stylesheet" href="x.css"><img src="https://x.dev/a.png">')
    const r = await share(kai, { path: 'x.html' })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/Share the same path again after changes to add a version\. 2 references to other files or the network won't load: the preview has no network\./)
    expect(onlyFile(k()).versions[0].outside).toBe(2)
  })

  it('refuses what it cannot share, each with a reason that starts "Not shared:"', async () => {
    const { k, kai, put, share, dataDir } = await setup()
    const outside = join(await mkdtemp(join(tmpdir(), 'kernel-outside-')), 'secret.html')
    await writeFile(outside, HTML)
    await put(kai, 'folder.html/inner.md', '# x\n')
    await symlink(outside, join(kai.path, 'link.html'))
    await symlink(dirname(outside), join(kai.path, 'outdir'))
    await put(kai, 'notes.txt', 'plain')
    await put(kai, 'big.html', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))
    await put(kai, 'big.svg', Buffer.concat([Buffer.from('<svg>'), Buffer.alloc(2 * 1024 * 1024, 0x20)]))
    await put(kai, 'fake.png', 'hello')
    await put(kai, 'nul.html', 'a\x00b')
    await put(kai, 'latin1.md', Buffer.from([0x23, 0x20, 0xe9, 0x0a]))
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
    for (const [path, why] of refused) expect(await share(kai, { path }), path).toEqual({ isError: true, text: `Not shared: ${why}` })
    expect(k().store.sharedFiles()).toEqual([])

    // A file at its version limit, and a copy that fails, add nothing.
    await put(kai, 'full.md', '# Full\n')
    await share(kai, { path: 'full.md' })
    const f = onlyFile(k())
    k().store.saveSharedFile({ ...f, versions: Array.from({ length: MAX_VERSIONS }, (_, i) => ({ ...f.versions[0], n: i + 1 })) })
    await put(kai, 'full.md', '# Full\nmore\n')
    expect(await share(kai, { path: 'full.md' })).toEqual({ isError: true, text: 'Not shared: "Full" already has 100 versions. Save it under a new name to share more.' })
    await put(kai, 'other.md', '# Other\n')
    // The data folder's shared folder is a file now, so the copy can't be written.
    await rm(join(dataDir, 'shared'), { recursive: true })
    await writeFile(join(dataDir, 'shared'), 'not a folder')
    const failed = await share(kai, { path: 'other.md' })
    expect(failed.isError).toBe(true)
    expect(failed.text).toMatch(/^Not shared: Kernel couldn't copy other\.md \(/)
    expect(k().store.sharedFiles().map((x) => x.source)).toEqual(['full.md'])
  })

  it('shares from the Lead, whose workspace is the room, and from a reviewer, into their own chats', async () => {
    const { k, leadWs, review, put, share, lead, chatOf, room } = await setup()
    expect(leadWs.path).toBe(room.path)
    await put(leadWs, '.kernel/shared/plan.md', '# The plan\n')
    expect((await share(leadWs, { path: '.kernel/shared/plan.md' })).text).toMatch(/^Shared "The plan" as v1 \(Markdown, /)
    await put(review, 'diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')
    expect((await share(review, { path: 'diagram.svg' })).text).toMatch(/^Shared "diagram.svg" as v1 \(SVG, /)
    expect(k().store.items(lead.id).filter((i) => i.kind === 'shared')).toHaveLength(1)
    expect(k().store.items(chatOf(review).id).filter((i) => i.kind === 'shared')).toHaveLength(1)
    expect(k().store.sharedFiles({ workspaceId: leadWs.id }).map((f) => f.title)).toEqual(['The plan'])
    expect(k().store.sharedFiles({ roomId: room.id }).map((f) => f.title)).toEqual(['diagram.svg', 'The plan'])
    expect(await k().handlers()['shared.list']({ roomId: room.id, limit: 1 })).toHaveLength(1)
  })

  it("adds a teammate's share to the Lead's next Team update and nothing for the Lead's own", async () => {
    const { k, kai, leadWs, put, share } = await setup()
    await put(kai, 'a.png', PNG)
    await put(leadWs, 'b.png', PNG)
    await share(kai, { path: 'a.png', title: 'Logo' })
    await share(leadWs, { path: 'b.png' })
    const pending = (k().store.meta<{ pending: [string, { events: { kind: string; workspaceId: string; shared?: unknown }[] }][] }>('leadUpdates')?.pending ?? []).flatMap(([, p]) => p.events)
    expect(pending.filter((e) => e.kind === 'shared')).toEqual([expect.objectContaining({ workspaceId: kai.id, shared: expect.objectContaining({ title: 'Logo', kind: 'image', version: 1, source: 'a.png' }) })])
    expect(k().store.sharedFiles({ workspaceId: kai.id })[0].versions[0]).toMatchObject({ width: 3, height: 2, mime: 'image/png' })
  })

  it('serves images and PDFs as data URLs and reveals the source while it still matches, else the copy', async () => {
    const { k, kai, put, share, revealed, dataDir } = await setup()
    await put(kai, 'logo.png', PNG)
    await share(kai, { path: 'logo.png' })
    const f = onlyFile(k())
    expect(await k().handlers()['shared.read']({ sharedId: f.id, version: 1 })).toEqual({ kind: 'image', mime: 'image/png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` })
    await k().handlers()['shared.reveal']({ sharedId: f.id, version: 1 })
    await put(kai, 'logo.png', Buffer.concat([PNG, Buffer.from([0])]))
    await k().handlers()['shared.reveal']({ sharedId: f.id, version: 1 })
    expect(revealed).toEqual([join(kai.path, 'logo.png'), join(dataDir, 'shared', f.id, 'v1', 'logo.png')])
    await expect(k().handlers()['shared.read']({ sharedId: f.id, version: 9 })).rejects.toThrow('That shared file or version is gone.')
    expect(k().sharedFile(f.id, 1)?.path).toBe(join(dataDir, 'shared', f.id, 'v1', 'logo.png'))
    expect(k().sharedFile(f.id, 2)).toBeUndefined()
  })

  it('saves the thumbnail a capture draws, and has none without one', async () => {
    const thumbs: [string, number][] = []
    const { k, kai, put, share } = await setup({ capture: async (f, v) => { thumbs.push([f.id, v]); return PNG } })
    await put(kai, 'x.html', HTML)
    await share(kai, { path: 'x.html' })
    const f = onlyFile(k())
    await vi.waitFor(() => expect(k().store.sharedFile(f.id)?.versions[0].thumb).toBe(true))
    expect(thumbs).toEqual([[f.id, 1]])
    expect(await k().handlers()['shared.thumb']({ sharedId: f.id, version: 1 })).toBe(`data:image/png;base64,${PNG.toString('base64')}`)

    const plain = await setup()
    await plain.put(plain.kai, 'x.html', HTML)
    await plain.share(plain.kai, { path: 'x.html' })
    expect(await plain.k().handlers()['shared.thumb']({ sharedId: onlyFile(plain.k()).id, version: 1 })).toBeNull()
  })

  it('keeps the copies when the workspace is archived and after a restart, and deletes them with the room', async () => {
    const { k, kai, put, share, dataDir, restart, room } = await setup()
    await put(kai, 'x.html', HTML)
    await share(kai, { path: 'x.html' })
    const f = onlyFile(k())
    const copy = join(dataDir, 'shared', f.id, 'v1', 'x.html')
    await k().archiveWorkspace(kai.id)
    expect(k().store.workspace(kai.id)?.status).toBe('archived')
    expect(await readFile(copy, 'utf8')).toBe(HTML)
    await restart()
    expect(await k().handlers()['shared.list']({ workspaceId: kai.id })).toEqual([f])
    expect((await k().handlers()['shared.read']({ sharedId: f.id, version: 1 })).text).toBe(HTML)
    await k().removeRoom(room.id, false)
    expect(k().store.sharedFiles()).toEqual([])
    expect(existsSync(join(dataDir, 'shared', f.id))).toBe(false)
  })
})

describe('who gets share_file (KERNEL-302)', () => {
  it('gives every agent share_file next to its own tools while sharing is on, and nothing new while it is off', async () => {
    const on = await setup()
    const names = (s: typeof on, ws: Workspace, id: string) => s.k().toolsFor(ws, s.agent(id), s.chatOf(ws)).map((t) => t.name)
    const lead = names(on, on.leadWs, 'rowan')
    expect(lead).toEqual(expect.arrayContaining(['create_workspace', 'message_agent', 'share_file']))
    expect(lead.at(-1)).toBe('share_file')
    expect(names(on, on.review, 'theo')).toEqual(['submit_review', 'share_file'])
    expect(names(on, on.kai, 'kai')).toEqual(['wait_for_merge', 'share_file'])
    const mcp = (s: typeof on, ws: Workspace, id: string) => (s.k().sessions as unknown as { d: { mcpFor: (w: Workspace, a: AgentDef, c: Chat) => Record<string, { name: string; tools: string[] }> } }).d.mcpFor(ws, s.agent(id), s.chatOf(ws))
    expect(mcp(on, on.kai, 'kai')).toEqual({ kernel: { name: 'kernel', tools: ['wait_for_merge', 'share_file'] } })
    expect(mcp(on, on.leadWs, 'rowan').kernel.tools).toEqual(lead)

    const off = await setup({ sharing: false })
    expect(names(off, off.leadWs, 'rowan')).toEqual(lead.slice(0, -1))
    expect(mcp(off, off.review, 'theo')).toEqual({ kernel: { name: 'kernel', tools: ['submit_review'] } })
    expect(mcp(off, off.kai, 'kai')).toEqual({ kernel: { name: 'kernel', tools: ['wait_for_merge'] } })
    expect(mcp(off, off.leadWs, 'rowan').kernel.tools).toEqual(lead.slice(0, -1))
  })
})
