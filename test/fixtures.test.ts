import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtures } from '../fixtures'
import { fixtureHandlers } from '../src/main/fixtures'

const entries = Object.entries(fixtures)
/** Fixtures for states the canvas doesn't draw, kept for screenshots (DECISIONS.md says which). */
const noCanvas = [
  'UsageFooterNoUpdate', // the usage footer with no update ready: the Help button alone at the right
  'FooterHelpMenu', // the Help menu open upward from the footer's bottom right: What's new, Keyboard shortcuts, Report a problem
  'SettingsTeamOrigins', // Room Agents grouped by origin, scrolled to In this repo, with a personal and two plugin agents (KERNEL-639)
  'SettingsHooksWorkspaceRun', // Settings, Hooks in a dev run started inside a workspace: hooks are off, no Install and no snippet (KERNEL-679)
  'SettingsAgents', // Settings, Agents with no room open: a personal agent and two plugin agents (KERNEL-641)
  'SettingsAgentEdit', // a personal agent's editor inside Settings, with Back to Agents (KERNEL-641)
  'SettingsAgentPlugin', // a plugin agent read only, with no Save changes or Retire (KERNEL-641)
  'SettingsSkillsMany', // a room's Skills and MCP with twenty-seven switches and the link to Settings, MCP servers (KERNEL-661)
  'SettingsMcpServersReady', // Settings, MCP servers on Work, every server ready and folded (KERNEL-661)
  'SettingsMcpServers', // Settings, MCP servers on Personal: sign-ins, a failure, connectors, one ignored (KERNEL-661)
  'SettingsMcpServersCodex', // Settings, MCP servers on the one Codex tab for accounts that share (KERNEL-661)
  'SettingsMcpServersMany', // Settings, MCP servers with twenty-seven servers on Personal (KERNEL-661)
  'SettingsMcpSetUp', // Set up this account: the checklist, everything ticked (KERNEL-661)
  'SettingsMcpSetUpRunning', // Set up this account while it signs in, with the claude.ai step (KERNEL-661)
  'SettingsMcpSetUpDone', // Set up this account at the end: what is done and what failed (KERNEL-661)
  'SettingsMcpNeededNotice', // the notice after adding an account that needs MCP sign-ins, with Set up (KERNEL-661)
  'WorkspaceHistoryButtons', // the sidebar strip with Back lit and Forward disabled (KERNEL-643)
  'WorkspaceHistoryButtonsNarrow', // the sidebar dragged to its 200px minimum, with Back and Forward both on (KERNEL-643)
  'WorkspaceHistoryButtonsHidden', // the same screen with the sidebar hidden: Back and Forward after Show sidebar (KERNEL-643)
  'WorkspaceTabStates',
  'WorkspaceSharedImageZoom', // the shared image zoomed to 200%, with the zoom control beside Comment (KERNEL-598)
  'RoomSetupTeamNoReviewer', // Room setup's team in a repo whose `[team] reviewer = "none"` turned review off: the picker says No reviewer (KERNEL-590)
  'IssuesJira', // a room on Jira, whose issues Kernel can't list yet: the plain state in NoTracker's layout (KERNEL-503)
  'WorkspaceRunEmpty', // the Run tab before the script has run, with the empty state's Run as its only button (KERNEL-423, KERNEL-512)
  'WorkspaceReplyMenu', // the "..." menu under a finished turn's reply, with Fork into new chat and Fork into new workspace (KERNEL-346)
  'WorkspaceTrustHeld', // the banner KERNEL-209's trust hold shows, with Review (KERNEL-218)
  'TrustScripts', // the dialog Review opens: the scripts and files.copy list to trust (KERNEL-218)
  'WorkspaceRowsOpen', // a Thinking, a Bash and an Edit row open in place, and a running tool (KERNEL-198)
  'WorkspaceRowsFolded', // the folded list with a Thinking, a Message and an Edit row opened inside it (KERNEL-198)
  'WorkspaceReadImage', // Read rows on image files: Read image with the image chip, folded and open (KERNEL-546)
  'WorkspaceReadImageTab', // a Read image row clicked: the image opens in a tab headed by its path (KERNEL-671)
  'WorkspaceReadImageMissing', // a Read image row whose file is gone, clicked: it opens to the path (KERNEL-671)
  'WorkspaceScrolledUp', // a long chat scrolled up, with the Scroll to bottom button over it; CJ skipped the design pass (KERNEL-532)
  'WorkspaceSuggestion', // Claude's guess at the next message in the empty box, in the placeholder's style (KERNEL-531)
  'WorkspaceDiffTab',
  'WorkspaceDiffImageAdded', // an added image in a diff tab shows the picture (KERNEL-410)
  'WorkspaceDiffImageModified', // a changed image shows Before and After (KERNEL-410)
  'WorkspaceQuestionStates', // a picked option, a hovered one and a keyboard-focused one: the pick reads strongest (KERNEL-676)
  'WorkspaceQuestionLong', // a long answer that wraps, and options with descriptions (KERNEL-407)
  'WorkspaceQuestionUrl', // a sign-in link in the question and an option's description wraps inside the card, with no AskUserQuestion row above it (KERNEL-591)
  'WorkspaceFilesTree', // All files drawn like VS Code's explorer, with every git status and compact folders (KERNEL-399)
  'WorkspaceChangesList', // the Changes tab as VS Code's Source Control list (KERNEL-399)
  'WorkspaceChangesTree', // the Changes tab as a folder tree, next to All changes (KERNEL-399)
  'WorkspaceFilesTreeLight', // WorkspaceFilesTree in the light theme (KERNEL-399)
  'WorkspaceLeadPlan', // Rowan's plan on the main checkout
  'WorkspaceLeadUpdate', // Kernel's Team update card in Rowan's chat (KERNEL-127, D-128)
  'TeamUpdatePrStates', // one PR in each state in a Team update and the PRs tab, each said the same way (KERNEL-417)
  'LeadPrsBlockers', // a PR with blockers on its latest commit under Still open, with Blockers found and a soft Merge anyway (KERNEL-501)
  'WorkspaceContextRing',
  'WorkspaceContextRingNear',
  'WorkspaceContextPopover',
  'WorkspaceContextPopoverFull',
  'WorkspaceQueuedCapacity',
  'WorkspaceNearLimit', // 91% of the 5-hour window: teammates' new work waits, the queued message says why (KERNEL-224)
  'WorkspaceWeeklyWarn', // 85% of the week used: the warning with a close button on hover and View usage (KERNEL-595)
  'WorkspaceQueuedMerge', // a brief held until another PR merges, with Send now (KERNEL-361)
  'WorkspaceWaitedOn', // a PR another workspace's brief waits for, naming that workspace above the box
  'InboxOverlap',
  'InboxCompact', // the inbox with Settings, Appearance, Density on Compact (KERNEL-538)
  'InboxTrustHeld', // a workspace held for script trust listed in the Inbox, its detail pane open on it (KERNEL-395)
  'LoadingError', // boot failed: the error and Try again (KERNEL-217)
  'SetupGhWarning', // gh signed out as a warning, with Continue on (KERNEL-217)
  'NavMemory',
  'SidebarLeadChats',
  'SidebarTrustHeld', // a workspace held for script trust next to an idle one, and a folded chat hiding another (KERNEL-342)
  'SidebarUnread', // chat, workspace and collapsed room rows with a bold title for a reply not yet seen, and an unread tab (KERNEL-508)
  'SidebarPlanChat', // chat rows in plan mode with a blue icon next to ordinary rows
  'LeadNoChats', // a room with no open chat: New chat with Rowan with no workspace yet, no chat row in the sidebar (KERNEL-366, KERNEL-405)
  'LeadNoChatsBranch', // New chat with Rowan with New branch from main open: the remote's branches, the default checked and marked
  'GroupedChatArchive', // a chat row's hover Archive, like a workspace row's (KERNEL-405)
  'ConfirmArchiveChat', // archiving a chat that would stop an open PR and uncommitted changes, laid out like ConfirmArchive (KERNEL-405)
  'WorkspaceLeadSetup', // a chat with Rowan setting up, its first message in the queue (KERNEL-405)
  'WorkspaceLeadSetupFailed', // the same chat once its setup failed, with Run again (KERNEL-405)
  'WorkspaceFolderMissing', // a worktree deleted outside Kernel, with Archive (KERNEL-291)
  'WhatsNewCurrent', // What's new with no update ready, showing the running version's notes (KERNEL-154)
  'UpdateReadyLight', // the update card in the light theme (KERNEL-164)
  'HistoryConfirmDelete', // the Delete confirm in History for every archived row, with two branches that hold unpushed commits (KERNEL-333)
  'HistoryConfirmDeleteOne', // the same confirm from one row (KERNEL-333)
  // The PR states the PR header canvas didn't draw (KERNEL-274, drawn in design/redesign/).
  ...['NoChanges', 'None', 'Creating', 'Open', 'Checks', 'Conflict', 'Resolving', 'Ready', 'Merging'].map((s) => `WorkspacePR${s}`),
  'WorkspacePRChecksOptional', // the Checks tab of a ready PR with a failed and a running optional check (KERNEL-388)
  'WorkspacePRBlocked', // a ready PR GitHub won't merge until someone approves it, which reads Open (KERNEL-388)
  // The header with the task title and the PR capsule, drawn in design/redesign/ (KERNEL-413).
  'PrMergedOpen',
  'PrMergedHidden',
  'PrReadyHidden',
  'PrBlockers', // Blockers on the latest commit: Blockers found in the band, with a soft Merge anyway (KERNEL-501)
  'PrCiFailHidden',
  'PrNoPrHidden', // the capsule's soft Create PR with its own menu square (KERNEL-528)
  'PrClosedHidden', // the capsule's Reopen and Archive on a closed PR (KERNEL-528)
  'PrMergedHiddenLong',
  'HeaderBranchTooltip',
  // Plan mode with nothing waiting, typing in it, and typing changes to a waiting plan (KERNEL-322, drawn in design/redesign/PlanStates.png).
  'WorkspacePlanMode',
  'WorkspacePlanModeTyping',
  'WorkspacePlanTyping',
  'WorkspacePlanApproved', // a plan once approved, with your Approved bubble under it
  'WorkspacePlanChanges', // a plan you asked changes for: your notes are the bubble, and the Kernel message that carried them stays hidden
  'WorkspacePlanReplaced', // a plan a newer plan replaced, which says Replaced by a newer plan
  'WorkspaceQuestionAnswered', // one question answered: the card keeps the question and your answer is the bubble below
  'WorkspaceKernelNote', // Kernel's own message as one note line
  'WorkspaceKernelNoteOpen', // the same note opened to its full text with Copy
  'WorkspaceRelaunch', // a quit note and Kernel's message after it, folded into one line
  'WorkspacePlanExit', // Kai's ExitPlanMode plan, which looks as it did before the Lead's write-up and rows (KERNEL-374)
  // The hire card's servers row in the states WorkspaceHireServers.png doesn't draw: needs sign-in is the PNG's (KERNEL-484).
  'WorkspaceHireServersReached',
  'WorkspaceHireServersFailed',
  'WorkspaceHireServersOff',
  'WorkspaceHireServersDisabled',
  'WorkspaceHireServersMissing',
  'WorkspaceHireServersMany',
  'WorkspaceHireTeam', // the hire card when the Lead proposes the agent to the team: the line says it opens a pull request (KERNEL-502)
  // A new chat waiting for setup, drawn in design/redesign/ (KERNEL-430).
  'SetupRunning',
  'SetupFollowUp',
  'SetupEditQueued',
  'SetupPanelHidden',
  'SetupFailed',
  'SetupStopped',
  'SetupCreatingWorktree', // a new chat whose worktree isn't made yet: the message reads as sent, with the Creating worktree line (KERNEL-543)
  'SetupWorktreeFailed', // git wouldn't make it: Couldn't create the worktree with git's reason and Try again (KERNEL-543)
  'SetupSentAnyway',
  'SetupDone',
  // The turn files card under a finished reply, drawn in design/redesign/ (KERNEL-586).
  'TurnFiles',
  'TurnFilesLong',
  'TurnFilesNoReply',
  'TurnFilesHover',
  'SettingsTeamEmpty',
  'NewAgentNoRoom',
  'SettingsTeamOwnAgents', // a repo's own agents in Settings, Agents: a warning on a row, Add a starter agent and New agent, and Retired with Restore (KERNEL-642)
  // KERNEL-680: Accounts and room setup states the settings canvas doesn't draw.
  'SettingsAccountsApiKey',
  'SettingsAccountsApiKeyActive',
  'SettingsAccountsCodex',
  'SettingsAccountsCodexApiKey',
  'SettingsAccountsKeychain',
  'SettingsAccountsLegacy',
  'SettingsAccountsLimitLight',
  'SettingsAccountsMcp',
  'SettingsAccountsMcpSignInFailed',
  'SettingsAccountsMcpSigningIn',
  'SettingsAccountsRemove',
  'SettingsAccountsRename',
  'SettingsAccountsSameOrg',
  'SettingsRoomSetupFiles',
  'SettingsRoomSetupProduction',
]

const boards: Record<string, string> = JSON.parse(readFileSync('design/settings-redesign/boards.json', 'utf8'))

describe('fixtures', () => {
  it('every fixture key has a PNG in design/screens or a settings board, except the DevUi component gallery and noCanvas', () => {
    const missing = entries.map(([name]) => name).filter((name) => !name.startsWith('DevUi') && !noCanvas.includes(name) && !existsSync(join('design/screens', `${name}.png`)) && !boards[name])
    expect(missing).toEqual([])
  })

  // KERNEL-680: a Settings fixture drawn on the settings canvas names its board, in dark and light.
  it('every settings board a fixture names is rendered', () => {
    // The Calm boards are Accounts' states, drawn once; the page boards have a Light twin.
    const missing = Object.values(boards).flatMap((b) => (b.startsWith('Calm') ? [b] : [b, `${b}Light`])).filter((b) => !existsSync(join('design/settings-redesign', `${b}.png`)))
    expect(missing).toEqual([])
  })

  it.each(entries)('%s points only at things that exist', (_name, f) => {
    const rooms = new Set(f.rooms.map((r) => r.id))
    const workspaces = new Set(f.workspaces.map((w) => w.id))
    const chats = new Set(f.chats.map((c) => c.id))
    const agentIn = (roomId: string, agentId: string) => (f.agents[roomId] ?? []).some((a) => a.id === agentId)

    for (const w of f.workspaces) {
      expect(rooms.has(w.roomId), `workspace ${w.id} room`).toBe(true)
      expect(agentIn(w.roomId, w.agentId), `workspace ${w.id} agent`).toBe(true)
    }
    for (const c of f.chats) expect(workspaces.has(c.workspaceId), `chat ${c.id} workspace`).toBe(true)
    for (const id of Object.keys(f.items)) expect(chats.has(id), `items for chat ${id}`).toBe(true)
    for (const id of [...Object.keys(f.changes), ...Object.keys(f.diffs)]) expect(workspaces.has(id), `changes for ${id}`).toBe(true)
    for (const a of f.approvals) {
      if (a.roomId) expect(rooms.has(a.roomId), `approval ${a.id} room`).toBe(true)
      if (a.workspaceId) expect(workspaces.has(a.workspaceId), `approval ${a.id} workspace`).toBe(true)
      if (a.roomId && a.agentId) expect(agentIn(a.roomId, a.agentId), `approval ${a.id} agent`).toBe(true)
    }
    for (const [roomId, byAgent] of Object.entries(f.status)) for (const agentId of Object.keys(byAgent)) expect(agentIn(roomId, agentId), `status ${agentId}`).toBe(true)
    for (const e of f.push) {
      if ('workspaceId' in e) expect(workspaces.has(e.workspaceId), `push ${e.type} workspace`).toBe(true)
      if ('chatId' in e) expect(chats.has(e.chatId), `push ${e.type} chat`).toBe(true)
    }
    if (f.ui.route && 'roomId' in f.ui.route && f.ui.route.roomId) expect(rooms.has(f.ui.route.roomId)).toBe(true)
    if (f.ui.route?.name === 'workspace') expect(workspaces.has(f.ui.route.workspaceId)).toBe(true)
  })
})

describe('fixture handlers', () => {
  const f = fixtures.Workspace
  const h = fixtureHandlers(f)

  it('serve the fixture', async () => {
    expect(await h['rooms.list']()).toEqual(f.rooms)
    const [chat] = await h['chats.list']({ workspaceId: 'ws-invoice-table' })
    expect((await h['chats.items']({ chatId: chat.id })).length).toBeGreaterThan(0)
    expect(await h['workspaces.changes']({ workspaceId: 'ws-invoice-table' })).toHaveLength(4)
    const activity = await h['activity.recent']({ roomId: 'room-a' })
    expect(activity.map((e) => e.ts)).toEqual([...activity.map((e) => e.ts)].sort((a, b) => b - a))
  })

  it('answer writes without changing later reads', async () => {
    const before = structuredClone(f)
    await h['rooms.setPaused']({ roomId: 'room-a', paused: true })
    await h['chats.send']({ chatId: 'chat-invoice-table', parts: [{ type: 'text', text: 'hi' }] })
    await h['chats.configure']({ chatId: 'chat-invoice-table', plan: true })
    await h['chats.create']({ workspaceId: 'ws-invoice-table', kind: 'terminal' })
    const decided = await h['approvals.decide']({ id: 'ap-migrate', decision: { behavior: 'allow' } })
    expect(decided.status).toBe('allowed')
    await h['workspaces.archive']({ workspaceId: 'ws-invoice-table' })
    expect(f).toEqual(before)
    expect((await h['approvals.list']({})).find((a) => a.id === 'ap-migrate')?.status).toBe('pending')
  })

  it('refuse to create a workspace', async () => {
    await expect(h['workspaces.create']({ roomId: 'room-a', prompt: 'x' })).rejects.toThrow(/Fixture mode/)
  })

  it("list a fixture's Lead chats, by room when asked (KERNEL-337)", async () => {
    const threads = [{ id: 't1', roomId: 'room-a', title: 'Release plan', createdAt: 1 }, { id: 't2', roomId: 'room-b', title: 'Icons', createdAt: 2 }]
    const withThreads = fixtureHandlers({ ...f, threads })
    expect(await withThreads['threads.list']({})).toEqual(threads)
    expect(await withThreads['threads.list']({ roomId: 'room-b' })).toEqual([threads[1]])
    expect(await h['threads.list']({})).toEqual(f.threads)
  })

  it("opens a room's newest chat with Rowan, or none, and previews what archiving a chat stops (KERNEL-405)", async () => {
    expect((await h['lead.open']({ roomId: f.rooms[0].id }))?.id).toBe('ws-lead')
    const none = fixtureHandlers({ ...f, workspaces: f.workspaces.filter((w) => !w.lead) })
    expect(await none['lead.open']({ roomId: f.rooms[0].id })).toBeNull()
    expect(await h['threads.archivePreview']({ threadId: 't-lead' })).toEqual({ threadId: 't-lead', title: 'Lead', workspaces: [{ id: 'ws-lead', name: 'lead', own: true, running: false, dirty: 0, unpushed: 0 }] })
  })
})
