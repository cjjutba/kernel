import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChatPart, SharedAnchor, SharedFile, Workspace } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { git } from '../src/main/services/exec'
import { Sessions } from '../src/main/services/sessions'
import { commentParts, commentText } from '../src/main/services/sharedComments'
import { newChat } from '../src/main/features/records'
import { NEW_CHAT } from '../src/main/features/shared'
import { tempRepo } from './helpers'

// KERNEL-310: a comment on a shared file goes to the agent that shared it, as a plain message naming the file, version
// and spot, with the crop around it attached. Comments are kept per version.

// `query` never answers, so a chat started for real stays busy.
const sdk = vi.hoisted(() => ({ calls: [] as { cwd?: string }[] }))
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
const PAGE = (n: number) => `<!doctype html><title>Pricing page draft</title><section class="hero"><div class="actions"><button class="cta">Start free trial ${n}</button></div></section>`
const ANCHOR: SharedAnchor = {
  x: 412, y: 188, viewport: { width: 1280, height: 800, scrollY: 0 },
  element: { selector: 'section.hero > div.actions > button.cta', tag: 'button', text: 'Start free trial', rect: { x: 380, y: 170, width: 140, height: 40 } }
}
const IMAGE = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 320, height: 200 }

async function setup() {
  const repo = await tempRepo({ 'README.md': '# client\n', '.claude/agents/rowan.md': AGENT('rowan', 'lead: true\n'), '.claude/agents/noor.md': AGENT('noor') })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, experimental: { sharing: true } }))
  const sent: { chatId: string; parts: ChatPart[] }[] = []
  const make = async () => {
    const k = new Kernel({ dataDir, home })
    await k.start()
    k.sessions.send = async (chatId, parts) => { sent.push({ chatId, parts }); return { queued: false } }
    return k
  }
  let k = await make()
  onTestFinished(() => k.stop())
  const room = await k.rooms.addRoom(repo)
  const lead = await k.lead.leadChat(room.id)
  const leadWs = k.store.workspace(lead.workspaceId)!
  const noor = await k.workspaces.createWorkspace(room.id, { prompt: 'Build the pricing page', agentId: 'noor', title: 'Pricing', leadChatId: lead.id })
  await git(noor.path, 'commit', '--allow-empty', '-qm', 'start')
  const firstChat = (ws: Workspace) => k.store.chats(ws.id).find((c) => c.kind !== 'terminal')!
  /** Writes the file in the workspace and shares it from a chat there, as share_file does. */
  const share = async (ws: Workspace, rel: string, data: string, chatId = ws.id === leadWs.id ? lead.id : firstChat(ws).id) => {
    await mkdir(dirname(join(ws.path, rel)), { recursive: true })
    await writeFile(join(ws.path, rel), data)
    const r = await k.sharing.shareFile(ws.id, chatId, { path: rel, title: 'Pricing page draft' })
    if (r.status === 'same') throw new Error('nothing new shared')
    return r.file
  }
  const comment = (file: SharedFile, version: number, note = 'Make this button the same blue as the header.', o: { anchor?: SharedAnchor; image?: typeof IMAGE } = {}) =>
    k.sharing.comment({ sharedId: file.id, version, note, anchor: o.anchor ?? ANCHOR, image: o.image ?? IMAGE })
  sent.length = 0
  const restart = async () => { await k.stop(); k = await make(); return k }
  return { k: () => k, room, lead, leadWs, noor, firstChat, share, comment, sent, restart }
}

describe('a comment on a shared file (KERNEL-310)', () => {
  it('reaches the chat that shared the version, with the text and the crop', async () => {
    const s = await setup()
    const v1 = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(2))
    const pushed: PushEvent[] = []
    const on = (e: PushEvent) => pushed.push(e)
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    const chat = s.firstChat(s.noor)

    const r = await s.comment(v1, 2)

    expect(r).toEqual({ chatId: chat.id, workspaceId: s.noor.id, queued: false })
    expect(s.sent).toEqual([{
      chatId: chat.id,
      parts: [
        { type: 'text', text: 'Comment on "Pricing page draft" v2 (.kernel/shared/pricing.html).\nWhere: the <button> "Start free trial" (section.hero > div.actions > button.cta), at 412, 188 in a 1280 px wide window.\n> Make this button the same blue as the header.' },
        { type: 'image', name: 'pricing-page-draft-v2-comment.png', ...IMAGE }
      ]
    }])
    const [stored] = s.k().store.sharedComments(v1.id)
    expect(stored).toMatchObject({ sharedId: v1.id, version: 2, note: 'Make this button the same blue as the header.', anchor: ANCHOR, chatId: chat.id })
    expect(pushed).toContainEqual({ type: 'shared.comment', comment: stored })
  })

  it('says when newer versions were shared since', async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(2))
    await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(3))
    await s.comment(f, 2, 'Too much padding.\nAnd the font is small.')
    const text = (s.sent[0].parts[0] as { text: string }).text
    expect(text.split('\n')[0]).toBe('Comment on "Pricing page draft" v2 (.kernel/shared/pricing.html). You have shared v3 since.')
    expect(text.split('\n').slice(2)).toEqual(['> Too much padding.', '> And the font is small.'])
  })

  it("goes to the workspace's first open chat once the version's chat is closed, skipping terminals", async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    const k = s.k()
    const first = s.firstChat(s.noor)
    k.store.saveChat({ ...first, closed: true })
    newChat(k.store, s.noor.id, 'Terminal', { model: first.model, effort: first.effort, plan: false, kind: 'terminal' })
    const other = newChat(k.store, s.noor.id, 'Second', { model: first.model, effort: first.effort, plan: false })
    expect((await s.comment(f, 1)).chatId).toBe(other.id)
    expect(s.sent.map((x) => x.chatId)).toEqual([other.id])
  })

  it('opens a new chat when the workspace has none open', async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    const k = s.k()
    for (const c of k.store.chats(s.noor.id)) k.store.saveChat({ ...c, closed: true })
    const r = await s.comment(f, 1)
    const opened = k.store.chat(r.chatId)!
    expect(opened).toMatchObject({ workspaceId: s.noor.id, title: NEW_CHAT, kind: 'chat', plan: false })
    expect(opened.closed).toBeUndefined()
    expect(s.sent.map((x) => x.chatId)).toEqual([opened.id])
  })

  it('queues behind a busy turn, as a plain message with its image', async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    const k = s.k()
    const chat = s.firstChat(s.noor)
    k.sessions.send = Sessions.prototype.send.bind(k.sessions)
    await k.sessions.send(chat.id, [{ type: 'text', text: 'go' }])
    await vi.waitFor(() => { if (!sdk.calls.some((c) => c.cwd === s.noor.path)) throw new Error('no session yet') })

    expect(await s.comment(f, 1)).toEqual({ chatId: chat.id, workspaceId: s.noor.id, queued: true, why: 'running' })
    const [queued] = k.sessions.queued(chat.id)
    expect(queued.parts.map((p) => p.type)).toEqual(['text', 'image'])
    expect(queued.from).toBeUndefined()
    expect(k.store.sharedComments(f.id)[0].itemId).toBe('')
  })

  it('keeps the message it became in an idle chat', async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    const k = s.k()
    const chat = s.firstChat(s.noor)
    k.sessions.send = Sessions.prototype.send.bind(k.sessions)
    expect(await s.comment(f, 1)).toMatchObject({ chatId: chat.id, queued: false })
    const item = k.store.items(chat.id).filter((i) => i.kind === 'user').at(-1)!
    expect(item).toMatchObject({ kind: 'user', parts: [{ type: 'text' }, { type: 'image', dataUrl: IMAGE.dataUrl }] })
    expect('from' in item).toBe(false)
    expect(k.store.sharedComments(f.id)[0].itemId).toBe(item.id)
  })

  it('waits for setup', async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    const k = s.k()
    const chat = s.firstChat(s.noor)
    k.sessions.send = Sessions.prototype.send.bind(k.sessions)
    // What Run again does: the chat waits until setup passes.
    k.sessions.hold(chat.id, [{ type: 'text', text: 'Build the pricing page' }])
    expect(await s.comment(f, 1)).toMatchObject({ chatId: chat.id, queued: true, why: 'setup' })
    expect(k.sessions.queued(chat.id).map((q) => (q.parts[0] as { text: string }).text.split('\n')[0])).toEqual(['Build the pricing page', 'Comment on "Pricing page draft" v1 (.kernel/shared/pricing.html).'])
  })

  it('is refused for an archived workspace, with the way back', async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    await s.k().archive.archiveWorkspace(s.noor.id)
    await expect(s.comment(f, 1)).rejects.toThrow("Noor's workspace is archived, so the comment can't reach Noor. Restore it from History to send.")
    expect(s.sent).toEqual([])
    expect(s.k().store.sharedComments(f.id)).toEqual([])
  })

  it("routes a comment on the Lead's own file to the Lead's chat", async () => {
    const s = await setup()
    const f = await s.share(s.leadWs, '.kernel/shared/plan.html', PAGE(1))
    expect((await s.comment(f, 1)).chatId).toBe(s.lead.id)
    // With that chat closed, the room's Lead chat takes it.
    const k = s.k()
    k.store.saveChat({ ...s.lead, closed: true })
    const next = newChat(k.store, s.leadWs.id, 'Next', { model: s.lead.model, effort: s.lead.effort, plan: false })
    expect((await s.comment(f, 1)).chatId).toBe(next.id)
    expect(s.sent.map((x) => x.chatId)).toEqual([s.lead.id, next.id])
  })

  it('keeps comments per version, after a restart, and deletes them with the room', async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(2))
    await s.comment(f, 1, 'One')
    await s.comment(f, 2, 'Two')
    await s.comment(f, 1, 'Three')
    const k = await s.restart()
    expect(k.store.sharedComments(f.id, 1).map((c) => c.note)).toEqual(['One', 'Three'])
    expect(k.store.sharedComments(f.id, 2).map((c) => c.note)).toEqual(['Two'])
    expect((await k.sharing.handlers()['shared.comments']({ sharedId: f.id })).map((c) => [c.version, c.note])).toEqual([[1, 'One'], [2, 'Two'], [1, 'Three']])
    k.store.deleteRoom(s.room.id)
    expect(k.store.sharedComments(f.id)).toEqual([])
  })

  it('refuses a PDF, an empty note and a version Kernel lacks', async () => {
    const s = await setup()
    const f = await s.share(s.noor, '.kernel/shared/pricing.html', PAGE(1))
    await expect(s.comment(f, 1, '   ')).rejects.toThrow('Write a comment first.')
    await expect(s.comment(f, 9)).rejects.toThrow('That shared file or version is gone.')
    await s.share(s.noor, '.kernel/shared/terms.pdf', '%PDF-1.7\n')
    const pdf = s.k().store.sharedFiles().find((x) => x.kind === 'pdf')!
    await expect(s.comment(pdf, 1)).rejects.toThrow('PDFs take no comments.')
    expect(s.sent).toEqual([])
  })
})

describe('the message a comment makes', () => {
  const file = (kind: SharedFile['kind'], o: Partial<SharedFile> = {}): SharedFile => ({
    id: 'f', roomId: 'r', workspaceId: 'w', agentId: 'noor', source: '.kernel/shared/x', title: 'Logo ideas', kind,
    versions: [{ n: 1, at: 0, file: 'x', mime: 'x', bytes: 0, sha256: '', width: 616, height: 400 }], createdAt: 0, updatedAt: 0, ...o
  })

  it('names a point in an image in its natural pixels', () => {
    expect(commentText(file('image'), 1, 'Rounder', { x: 117.4, y: 70 })).toBe('Comment on "Logo ideas" v1 (.kernel/shared/x).\nWhere: a point, at 117, 70 in a 616 px wide image.\n> Rounder')
    expect(commentParts(file('image'), 1, 'Rounder', { x: 117, y: 70 }, IMAGE)[1]).toEqual({ type: 'image', name: 'logo-ideas-v1-comment.png', ...IMAGE })
  })

  it('names a Markdown block by its first 80 characters, and attaches no image', () => {
    const text = `${'word '.repeat(30)}end`
    const parts = commentParts(file('markdown'), 1, 'Cut this', { x: 0, y: 0, block: { index: 4, text } }, IMAGE)
    expect(parts).toHaveLength(1)
    expect((parts[0] as { text: string }).text.split('\n')[1]).toBe(`Where: the block "${text.slice(0, 80).trimEnd()}" (block 4).`)
  })

  it('names an HTML point with no element, and an element with no text', () => {
    expect(commentText(file('html'), 1, 'x', { x: 3, y: 4, viewport: { width: 900, height: 600, scrollY: 0 } }).split('\n')[1]).toBe('Where: a point, at 3, 4 in a 900 px wide window.')
    expect(commentText(file('html'), 1, 'x', { ...ANCHOR, element: { ...ANCHOR.element!, text: undefined } }).split('\n')[1])
      .toBe('Where: the <button> (section.hero > div.actions > button.cta), at 412, 188 in a 1280 px wide window.')
  })
})
