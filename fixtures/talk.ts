import type { LinearIssueDetail, Workspace, ChangedFile, ChatItem, ChatPart, Chat, Checkpoint, CheckpointPreview, Effort, FileEntry, MenuId, ProviderModel, QueuedMessage, QueueReason, Skill, Toast } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { Fixture } from './types'
import { agent, at, ids, scene } from './base'
import { platformFixtures } from './platform'
import { J, ago, codexRoleSettings, jBrief, jDay, jRead, jIssue, jResult, jRest, jRun15, jSay, jShots, pastedLog, works, type Works } from './workspace'

// Workspace lane: Redesign 08, Talk to the agent (Pen Part 8, KERNEL-1095). Ivy's chat on the clean-account journey, in Bypass permissions on Sonnet 5.5 at Medium effort.

type Parts = ChatPart[]

/** A stand-in for a screenshot of the review screen: the Pen's dark mock, 2880 by 1800. */
const shot = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2880" height="1800" viewBox="0 0 300 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2a2a"/><stop offset="1" stop-color="#171717"/></linearGradient></defs><rect width="300" height="180" fill="url(#g)"/><rect width="60" height="180" fill="#ffffff" fill-opacity="0.04"/><rect x="90" y="40" width="135" height="9" rx="2" fill="#ffffff" fill-opacity="0.12"/><rect x="90" y="65" width="165" height="7" rx="2" fill="#ffffff" fill-opacity="0.07"/><rect x="90" y="86" width="114" height="7" rx="2" fill="#ffffff" fill-opacity="0.07"/><rect x="90" y="112" width="165" height="40" rx="3" fill="#ffffff" fill-opacity="0.05"/></svg>')}`

const text = (t: string): ChatPart => ({ type: 'text', text: t })
const image = (name: string): ChatPart => ({ type: 'image', name, width: 2880, height: 1800, dataUrl: shot })
const paste = (lines = 212): ChatPart => ({ type: 'file', name: 'pasted_text_1.txt', lines, text: pastedLog, pasted: true })
const banner: ChatPart = { type: 'file', name: 'banner.tsx', path: 'src/renderer/src/components/banner.tsx' }
const spec: ChatPart = { type: 'file', name: 'spec.pdf', src: '/Users/cjjutba/Downloads/spec.pdf', size: 2_516_582, kind: 'pdf', pages: 14 }
const serverLog: ChatPart = { type: 'file', name: 'server.log', src: '/Users/cjjutba/Library/Logs/server.log', size: 90_112, kind: 'text' }
const journeyTs: ChatPart = { type: 'file', name: 'journey.ts', src: '/Users/cjjutba/Projects/kernel/fixtures/journey.ts', size: 2_048, kind: 'text' }
const folder: ChatPart = { type: 'file', name: 'src/renderer/', path: 'src/renderer/', dir: true }
const issue: ChatPart = { type: 'issue', name: 'KERNEL-1084', title: 'Review screen is 2px taller', url: 'https://linear.app/kernel/issue/KERNEL-1084', source: 'linear' }
const pr: ChatPart = { type: 'pr', name: '#1153', number: 1153, title: 'Attention breakdown', url: 'https://github.com/cjjutba/kernel/pull/1153' }

/** The draft of 8.1: two screenshots, a file from the repo and a long log, with the caret after the last. */
const DRAFT: Parts = [text('Run step 6 again at 1280 wide. Before '), image('ReviewRc.png'), text(' and after '), image('Review.png'), text(' The margin moved in '), banner, text(' and the log from the last run is '), paste(), text(' ')]

/** A message that went out with the same tokens (8.4). */
const SENT: Parts = [text('Run step 6 again at 1280 wide. Before '), image('ReviewRc.png'), text(' and after '), image('Review.png'), text(' The margin moved in '), banner, text(' and the log from the last run is '), paste()]

/** Ivy, whose teal avatar the canvas draws, and Rio, whose red one it draws for Codex. */
const IVY = agent('ivy', 'Ivy', 'QA', 'sonnet')
const RIO = agent('rio', 'Rio', 'Platform', 'sonnet')

interface Talk extends Works {
  composer?: { parts: Parts; draft: string }
  menu?: MenuId
  modal?: NonNullable<Fixture['ui']['modal']>
  queue?: QueuedMessage[]
  why?: QueueReason
  contextOpen?: boolean
  /** Other workspaces of the project, changed: Rio's, whose PR a held message waits on. */
  others?: Record<string, Partial<Workspace>>
  extra?: Partial<Fixture>
}

/** Codex's models as the canvas lists them: three current, four legacy. */
const codexModels: ProviderModel[] = [['GPT-5.5', false], ['GPT-5.5 Codex', false], ['GPT-5.5 mini', false], ['GPT-5.4', true], ['GPT-5.3-Codex', true], ['GPT-5.2', true], ['GPT-5.1', true]].map(([label, legacy], i) => ({
  provider: 'codex' as const, id: String(label).toLowerCase().replace(/ /g, '-'), label: String(label), legacy: !!legacy, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] as Effort[], defaultEffort: 'medium' as Effort, isDefault: i === 0
}))

/** The chat on the clean-account journey, Ivy's, with the Session rail beside it. `composer` is what the box starts with, and `menu` a menu already open. */
function talk(f: Fixture, items: ChatItem[], o: Talk = {}): Partial<Fixture> {
  const { composer, menu, modal, queue, why, contextOpen, others, extra, ...rest } = o
  const codex = o.chat?.provider === 'codex'
  const who = codex ? RIO : IVY
  const base = works(f, items, { ...rest, ws: { agentId: who.id, ...rest.ws }, chat: { plan: false, mode: 'bypassPermissions', effort: 'medium', ...rest.chat } })
  const ui = base.ui!
  return {
    ...base,
    agents: { ...f.agents, [ids.projectA]: [...(f.agents[ids.projectA] ?? []), IVY, RIO] },
    ...(others ? { workspaces: base.workspaces!.map((w) => (others[w.id] ? { ...w, ...others[w.id] } : w)) } : {}),
    ...(queue ? { queue: { [ids.tableChat]: queue } } : {}),
    ...(queue && why ? { push: [...(base.push ?? f.push), { type: 'chat.queue', chatId: ids.tableChat, queue, why } as PushEvent] } : {}),
    ...extra,
    ui: { ...ui, ...(menu ? { menu } : {}), ...(modal ? { modal } : {}), workspace: { ...ui.workspace!, ...(composer ? { composer } : {}), ...(contextOpen ? { contextOpen } : {}) } }
  }
}

const sessionOf = { sessionId: 'session-ivy' }
const withComposer = (parts: Parts, draft = '') => ({ composer: { parts, draft } })
const q = (id: string, line: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({ id, chatId: ids.tableChat, ts: ago(30), parts: [text(line)], ...extra })
const QA = q('q1', 'Also attach the screenshots to the issue.')
const QB = q('q2', 'Then post the summary on KERNEL-232.')
const QC = q('q3', 'And close KERNEL-1084 if the fix holds.')

/** A turn still running, up to the step in flight. */
const running = (): ChatItem[] => [jBrief(ago(74)), jRead(ago(70)), jIssue(ago(64)), jRun15(ago(60)), jSay('t-s1', ago(16), 'Steps 1 to 5 pass on a clean account. Capturing every screen now, so step 6 can compare the review screen with the release candidate.'), jShots(ago(12), { status: 'running', durationMs: undefined, output: undefined })]

const TURNS = [
  'Rerun step 3 on the fresh account.', 'Run step 6 again at 1280 wide.', 'Post both shots on KERNEL-232 as well, so the Lead sees it.', 'Also attach the screenshots to the issue.', 'Check the 1440 width too.', 'Close KERNEL-1084 if the fix holds.',
  'Did the Dock bounce slow step 2?', 'Retry step 4 with the network off.', 'List every screen that moved by more than 1px.', 'Put the list in the issue.', 'Use the release candidate for the next run.',
  'Skip step 5 on the second pass.', 'Why did step 1 take 9s?', 'Record the install time in the comment.', 'Rerun on the other Mac.', 'Compare the two runs.', 'Which run was faster?', 'File the 3px one separately.', 'Link both issues from KERNEL-232.', 'Rerun the journey from a clean DMG.', 'Post the final numbers.'
]
const ONE_LINE = ['Step 3 passes on the fresh account too.', 'At 1280 wide the banner\'s top margin is 2px larger than the release candidate\'s. I filed it as KERNEL-1084.', 'Posted both shots on KERNEL-232.', 'Attached the screenshots to KERNEL-1084.', 'The 1440 width matches the release candidate.', 'The fix holds, so I closed KERNEL-1084.']

/** The journey's first turn, then twenty more messages from you with a short reply each: 22 in all, the length the rail and the jump are drawn for. */
const longChat = (): ChatItem[] => [
  ...jDay(),
  ...TURNS.flatMap((line, i): ChatItem[] => [
    { kind: 'user', id: `tl-u${i}`, ts: J(50 + Math.floor(i / 2), (i % 2) * 30), parts: [text(line)] },
    jSay(`tl-r${i}`, J(50 + Math.floor(i / 2), (i % 2) * 30 + 20), ONE_LINE[i % ONE_LINE.length]),
    { ...jResult(J(50 + Math.floor(i / 2), (i % 2) * 30 + 22), 20_000), id: `tl-res${i}` }
  ])
]

const contextOf = (messages: number): Partial<Chat> => {
  const max = 200_000
  const rows = [['System prompt', 9_100], ['System tools', 9_200], ['MCP tools', 5_000], ['Memory files', 2_400], ['Skills', 1_000], ['Messages', messages]] as const
  const used = rows.reduce((n, [, t]) => n + t, 0)
  const usage: NonNullable<Chat['contextUsage']> = { used, max, rows: [...rows.map(([name, tokens]) => ({ name, tokens, kind: 'used' as const })), { name: 'Free space', tokens: max - used, kind: 'free' as const }] }
  return { context: Math.round((used / max) * 100), contextUsage: usage }
}

const codexSettings = () => codexRoleSettings()
/** The picker over the box. A chat that has not started offers both providers, and one that has locks the other (`sessionOf`). */
const pickerScene = (f: Fixture, o: Partial<Talk> = {}) => talk(f, jRest(), { menu: 'model', extra: { settings: codexSettings(), models: { codex: codexModels }, ...o.extra }, ...o })

/** KERNEL-1084 as Linear has it, which the preview over its token reads. */
const ISSUE_1084: LinearIssueDetail = {
  id: 'KERNEL-1084', uuid: 'k-1084', title: 'Review screen is 2px taller on a clean account', url: 'https://linear.app/kernel/issue/KERNEL-1084', branchName: 'kernel-1084-review-screen-2px',
  state: { id: 's-prog', name: 'In Progress', type: 'started', position: 2 }, priority: 3, assignee: { name: 'Ivy', me: false }, labels: ['Bug', 'Workspace'],
  team: { id: 'team-k', key: 'KERNEL', name: 'Kernel' }, updatedAt: '2026-10-21T13:52:00.000Z',
  description: "The banner's top margin adds 2px at 1280 wide. Found by the clean-account journey.", comments: []
}
const file = (path: string, extra: Partial<FileEntry> = {}): FileEntry => ({ path, dir: false, ...extra })
const dir = (path: string, extra: Partial<FileEntry> = {}): FileEntry => ({ path, dir: true, ...extra })
/** What @ban finds, @src/re finds, and @kernel-docs finds with a reference folder in the project's settings. */
const BAN = [file('src/renderer/src/components/banner.tsx'), file('src/renderer/src/screens/workspace/Banners.tsx'), file('src/shared/types/banner.ts'), file('test/banner.test.ts')]
const SRC = [dir('src/renderer'), dir('src/renderer/src'), dir('src/renderer/src/screens'), dir('src/renderer/src/components')]
const DOCS = [dir('/Users/cjjutba/Projects/kernel-docs', { reference: 'kernel-docs' }), file('/Users/cjjutba/Projects/kernel-docs/DESIGN.md', { reference: 'kernel-docs/' }), file('/Users/cjjutba/Projects/kernel-docs/PRODUCT.md', { reference: 'kernel-docs/' }), file('docs/kernel-docs/design-notes.md')]
const SKILLS: Skill[] = [['review', 'Reviews the branch against its issue, AGENTS.md and DESIGN.md.'], ['issue', 'Works a Linear issue end to end and opens the PR.'], ['shots', 'Renders fixtures and saves screenshots to shots/.'], ['release', 'Cuts a release from main.']].map(([name, description]) => ({ name, description, source: 'project' as const, enabled: true }))

/** Two turns, so the first reply is an older one: its "..." menu offers Revert files to here, and a revert confirm can name what changed. */
const turnFiles: ChangedFile[] = [{ path: 'test/journey.test.ts', status: 'M', added: 3, removed: 1 }, { path: 'fixtures/journey.ts', status: 'A', added: 64, removed: 0 }]
const twoTurns = (): ChatItem[] => [
  jBrief(), jRead(), jIssue(), jRun15(),
  jSay('j-reply', J(49, 10), 'Steps 1 to 5 pass on a clean account. Step 6 compares the review screen with the release candidate, so it needs the full screenshot run before I can call it.'),
  { kind: 'result', id: 'j-res', ts: J(49, 12), durationMs: 372_000, ok: true, files: turnFiles, checkpointId: 'cp1' },
  { kind: 'user', id: 'tk-u2', ts: J(50), parts: [text('Run step 6 again at 1280 wide.')] },
  jSay('tk-r2', J(51, 40), "At 1280 wide the banner's top margin is 2px larger than the release candidate's. I filed it as KERNEL-1084."),
  { kind: 'result', id: 'tk-res2', ts: J(51, 50), durationMs: 100_000, ok: true, checkpointId: 'cp2' }
]
const cp = (id: string, h: number, m: number, title: string, files: number, added: number, removed: number): Checkpoint => ({
  id, workspaceId: ids.table, chatId: ids.tableChat, ts: at(h, m), title, stat: { files, added, removed }, ref: `refs/kernel/checkpoints/${ids.table}/${id}`, current: id === 'cp2', ...(id === 'cp0' ? { start: true } : {})
})
const checkpoints: Checkpoint[] = [cp('cp2', 13, 51, 'Run step 6 again at 1280 wide.', 0, 0, 0), cp('cp1', 13, 49, 'Run every step of KERNEL-31 on a fresh Mac account.', 2, 67, 1), cp('cp0', 13, 41, 'Run every step of KERNEL-31 on a fresh Mac account.', 0, 0, 0)]
const REVERT_FILES: ChangedFile[] = [{ path: 'test/journey.test.ts', status: 'M', added: 3, removed: 1 }, { path: 'fixtures/journey.ts', status: 'D', added: 0, removed: 64 }, { path: 'docs/qa/kernel-31.md', status: 'M', added: 4, removed: 2 }]
const preview = (o: Partial<CheckpointPreview> = {}): CheckpointPreview => ({ files: REVERT_FILES, stat: { files: 3, added: 7, removed: 67 }, commitsAhead: 0, pushed: false, conflicts: [], ...o })
const reverting = (f: Fixture, o: { plan?: CheckpointPreview; ws?: Talk['ws']; menu?: MenuId; modal?: boolean } = {}) => talk(f, twoTurns(), {
  ws: o.ws, ...(o.menu ? { menu: o.menu } : {}),
  extra: { checkpoints: { [ids.table]: checkpoints }, checkpointPreviews: { [ids.table]: { cp1: o.plan ?? preview() } } },
  ...(o.modal ? { modal: { name: 'confirm', kind: 'revert', workspaceId: ids.table, checkpointId: 'cp1' } } : {})
})

const toast = (t: Omit<Toast, 'id'>): Toast => ({ id: `t-${t.title}`, ...t })

export const talkFixtures: Record<string, Fixture> = {
  /** 8.1: writing a message. Two screenshots, a file from the repo and a long log are tokens in the text, and the screenshots are thumbnails across the top. */
  ChatComposer: scene((f) => talk(f, jRest(), withComposer(DRAFT))),
  /** 8.2: files dragged over the chat. scripts/shots.ts starts the drag, and the overlay covers the pane. */
  ComposerDragOver: scene((f) => talk(f, jRest(), withComposer(DRAFT))),
  /** 8.3: the model picker, over the box. */
  WorkspaceModelPicker: scene((f) => pickerScene(f)),
  /** 8.4: a message just sent. The bubble holds its screenshots and its tokens, Working counts under it, and Stop took the send button's place. */
  WorkspaceJustSent: scene((f) => talk(f, [...jRest(), { kind: 'user', id: 'tk-sent', ts: ago(2), parts: SENT }], { running: true })),
  /** 8.5: reading back through a long chat, with Scroll to bottom over the box. The shot scrolls the transcript up. */
  WorkspaceScrolledUp: scene((f) => talk(f, longChat(), { view: { toolCalls: 'open' } })),
  /** 8.6: jumping through a long chat. The rail at the transcript's edge, and the message under the pointer. */
  ChatRail: scene((f) => talk(f, longChat())),
  /** 8.7: the ... under a reply opens below its button. */
  WorkspaceReplyMenu: scene((f) => talk(f, jRest(), { menu: 'reply:j-reply' })),
  /** 8.8: reverting files to an older reply. */
  ConfirmRevert: scene((f) => reverting(f, { modal: true })),
  WorkspaceMention: scene((f) => talk(f, jRest(), { ...withComposer([], 'Run step 6 again at 1280 wide. @ban'), extra: { tree: { [ids.table]: BAN } } })),
  ComposerMentionFolders: scene((f) => talk(f, jRest(), { ...withComposer([], 'Run step 6 again at 1280 wide. @src/re'), extra: { tree: { [ids.table]: SRC } } })),
  ComposerMentionReference: scene((f) => talk(f, jRest(), { ...withComposer([], 'Run step 6 again at 1280 wide. @kernel-docs'), extra: { tree: { [ids.table]: DOCS } } })),
  WorkspaceSlash: scene((f) => talk(f, jRest(), { ...withComposer([], '/'), extra: { skills: SKILLS } })),
  ComposerPlusMenu: scene((f) => talk(f, jRest(), { menu: 'plus' })),
  ComposerPermissionMenu: scene((f) => talk(f, jRest(), { menu: 'mode' })),
  WorkspaceIssueChip: scene((f) => talk(f, jRest(), withComposer([text('Fix '), issue, text(' before the release. ')]))),
  WorkspaceIssuePreview: scene((f) => talk(f, jRest(), { ...withComposer([text('Fix '), issue, text(' before the release. ')]), extra: { linear: { issues: [ISSUE_1084] } } })),
  WorkspacePaste: scene((f) => talk(f, jRest(), withComposer([paste(), text(' ')]))),
  WorkspacePasteWrap: scene((f) => talk(f, jRest(), withComposer([text("Here's the shot "), image('ReviewRc.png'), text(' the spec '), spec, text(' and the server log '), serverLog, text(' from the same run '), paste(), text(' ')]))),
  WorkspacePasteAfter: scene((f) => talk(f, jRest(), withComposer([paste(), text(' These are the last 212 lines of the run log. ')]))),
  WorkspacePasteImagePreview: scene((f) => talk(f, jRest(), withComposer([text('Before '), image('ReviewRc.png'), text(' and after '), image('Review.png'), text(' ')]))),
  WorkspacePasteTextPreview: scene((f) => talk(f, jRest(), withComposer([text('The log from the last run is '), paste(), text(' ')]))),
  ComposerAttaching: scene((f) => talk(f, jRest(), withComposer([text('Compare '), image('ReviewRc.png'), text(' with ')]))),
  ComposerChipKinds: scene((f) => talk(f, jRest(), withComposer([image('ReviewRc.png'), text(' '), paste(), text(' '), issue, text(' '), pr, text(' '), journeyTs, text(' '), folder, text(' '), spec, text(' '), serverLog, text(' ')]))),
  ComposerChipKindsSent: scene((f) => talk(f, [...jRest(), { kind: 'user', id: 'tk-kinds', ts: J(55), parts: [text('Everything the release check needs: '), image('ReviewRc.png'), paste(), issue, pr, journeyTs, folder, spec, serverLog] }])),
  ComposerFileMixed: scene((f) => talk(f, jRest(), withComposer([text('The spec '), spec, text(' both shots '), image('ReviewRc.png'), image('Review.png'), text(' the log '), serverLog, text(' and the fixture '), journeyTs, text(' ')]))),
  ComposerFilePdf: scene((f) => talk(f, jRest(), withComposer([text('Check the review screen against section 4 of '), spec, text(' ')]))),
  ComposerFileTip: scene((f) => talk(f, jRest(), withComposer([text('Check the review screen against section 4 of '), spec, text(' ')]))),
  ComposerFileCap: scene((f) => talk(f, jRest(), { ...withComposer([text("The recording didn't attach, but here's the shot "), image('ReviewRc.png'), text(' ')]), toasts: [toast({ title: 'demo.mov is over 50 MB', sub: 'Kernel attaches files up to 50 MB each.', glyph: 'error' })] })),
  ComposerFileUnreadable: scene((f) => talk(f, jRest(), { ...withComposer([text('And the design file '), image('ReviewRc.png'), text(' ')]), toasts: [toast({ title: "Couldn't read design.sketch", sub: 'Kernel attaches images, PDFs and text files.', glyph: 'error' })] })),
  ComposerFileGone: scene((f) => talk(f, [...jRest(), { kind: 'user', id: 'tk-gone', ts: J(55), parts: [text('Same margin at 1440? '), { type: 'image', name: 'ReviewRc.png', path: '.kernel/attachments/ReviewRc.png', width: 2880, height: 1800 }] }], { ws: { status: 'archived' } })),
  WorkspaceComposerLoadFailed: scene((f) => talk(f, jRest(), { extra: { fails: { 'chats.queue': 'Kernel did not answer.', 'chats.queueReason': 'Kernel did not answer.', 'chats.runMode': 'Kernel did not answer.' } } })),
  WorkspaceModelPickerEffort: scene((f) => pickerScene(f)),
  WorkspaceModelPickerFavorites: scene((f) => pickerScene(f)),
  WorkspaceModelPickerCodex: scene((f) => pickerScene(f, { chat: { ...sessionOf, provider: 'codex', model: 'gpt-5.5', effort: 'high' } })),
  WorkspaceModelPickerLegacy: scene((f) => pickerScene(f)),
  WorkspaceModelPickerLegacyChat: scene((f) => pickerScene(f, { chat: { model: 'claude-sonnet-4-6' } })),
  WorkspaceModelPickerLocked: scene((f) => pickerScene(f, { chat: sessionOf })),
  WorkspaceContextRing: scene((f) => talk(f, jRest(), { chat: contextOf(41_300) })),
  WorkspaceContextRingNear: scene((f) => talk(f, jRest(), { chat: contextOf(137_300) })),
  WorkspaceContextPopover: scene((f) => talk(f, jRest(), { chat: contextOf(41_300), contextOpen: true })),
  WorkspaceContextPopoverFull: scene((f) => talk(f, jRest(), { chat: contextOf(167_300), contextOpen: true })),
  WorkspaceModelSwitchToast: scene((f) => talk(f, jRest(), { chat: { ...sessionOf, model: 'claude-opus-5-5', effort: 'xhigh', ...contextOf(41_300) }, toasts: [toast({ title: 'Switched to Opus 5.5', sub: 'The next turn re-reads 68k tokens on Opus 5.5.', glyph: 'switch', action: { label: 'Undo', retry: 'composer-model' } })] })),
  WorkspaceStop: { ...scene((f) => talk(f, running(), { running: true, queue: [QA, QB], ...withComposer([], 'And check the 1440 width too.'), extra: { lag: { 'chats.interrupt': 600 } } })), motion: { action: { press: ['Meta+l', 'Escape'] }, ms: 1400, area: '.ws-main' } },
  WorkspaceQueuedOne: scene((f) => talk(f, running(), { running: true, queue: [QA] })),
  WorkspaceQueued: scene((f) => talk(f, running(), { running: true, queue: [QA, QB, QC] })),
  WorkspaceQueuedLong: scene((f) => talk(f, running(), { running: true, queue: [q('q1', 'Before you post, rerun step 6 at 1280, 1440 and 1680 wide and put the shots of each width side by side in the comment.', { parts: [text('Before you post, rerun step 6 at 1280, 1440 and 1680 wide and put the shots of each width side by side in the comment.'), image('ReviewRc.png'), image('Review.png')] })] })),
  WorkspaceQueuedMoving: scene((f) => talk(f, running(), { running: true, queue: [QA], why: 'moving' })),
  WorkspaceQueuedMerge: scene((f) => talk(f, running(), { running: true, queue: [q('q1', 'Rebase on main and rerun the journey.')], why: 'merge' })),
  WorkspaceQueuedCapacity: scene((f) => talk(f, jRest(), { queue: [q('q1', 'Start the soak harness for 24 hours.')], why: 'capacity' })),
  WorkspaceQueuedFolder: scene((f) => {
    // A second tab of the same workspace is writing in the folder, so this chat's message waits for it.
    const t = talk(f, jRest(), { queue: [q('q1', 'Rename the column in the migration too.')], why: 'folder' })
    const writing: Chat = { id: 'chat-invoice-migration', workspaceId: ids.table, title: 'Invoice migration', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: ago(20) }
    return { ...t, chats: [...(t.chats ?? f.chats), writing], push: [...(t.push ?? f.push), { type: 'chat.running', chatId: writing.id, running: true } as PushEvent] }
  }),
  WorkspaceQueuedOffline: scene((f) => talk(f, running(), { running: true, queue: [QA, QB], why: 'offline' })),
  WorkspaceWaitedOn: scene((f) => talk(f, running(), { running: true, queue: [q('q1', 'Rebase on main and rerun the journey.')], why: 'merge', ws: { waitsFor: { on: [ids.schema], held: true } }, others: { [ids.schema]: { agentId: 'rio', prNumber: 1153, prState: 'open', prUrl: 'https://github.com/cjjutba/kernel/pull/1153' } } })),
  ChatNewMessages: scene((f) => talk(f, longChat())),
  ChatRailOpen: scene((f) => talk(f, longChat())),
  WorkspaceRevertMenu: scene((f) => reverting(f, { menu: 'reply:j-reply' })),
  ConfirmRevertCommits: scene((f) => reverting(f, { modal: true, plan: preview({ commitsAhead: 2, pushed: false }) })),
  ConfirmRevertMerged: scene((f) => reverting(f, { modal: true, ws: { prNumber: 1157, prState: 'merged', prUrl: 'https://github.com/cjjutba/kernel/pull/1157' }, plan: preview({ commitsAhead: 2, pushed: true, conflicts: ['test/journey.test.ts'] }) })),
  ConfirmRevertConflicts: scene((f) => reverting(f, { modal: true, plan: preview({ conflicts: ['test/journey.test.ts'] }) })),
  ComposerTooManyFiles: scene((f) => talk(f, jRest(), { toasts: [toast({ title: 'Too many files', sub: 'A message can hold up to 20 files.', glyph: 'error' })] })),
  ComposerMessageTooLarge: scene((f) => talk(f, jRest(), { toasts: [toast({ title: 'Message is too large', sub: 'Files in one message can add up to 200 MB.', glyph: 'error' })] })),
  ModelPickerCompactAt: platformFixtures.SettingsModelsPicker,
  ContextPopoverEmpty: scene((f) => talk(f, jRest(), { contextOpen: true }))
}

