import { describe, expect, it, vi } from 'vitest'
import type { AgentDef, ChatPart, RoleModel } from '../src/shared/types'
import { leadHasNoChat, newChatOnScreen, newChatTab, showsNewChat, tabInFront, tabStop } from '../src/renderer/src/screens/workspace/leadNoChat'

// KERNEL-366: a room with no chats opens on New chat with Kernel, and + and ⌘T there start no chat.

describe('the Lead workspace with no chat', () => {
  it('picks the New chat state when no chat tab is open, and not for a chat, a closed chat or another agent', () => {
    expect(leadHasNoChat(true, [])).toBe(true)
    expect(leadHasNoChat(true, [{ kind: 'chat', closed: true }])).toBe(true)
    expect(leadHasNoChat(true, [{ kind: 'terminal' }])).toBe(true)
    expect(leadHasNoChat(true, [{ kind: 'chat' }])).toBe(false)
    expect(leadHasNoChat(true, [{ kind: 'chat', closed: true }, { kind: 'chat' }])).toBe(false)
    expect(leadHasNoChat(false, [])).toBe(false)
  })
})

describe('+ and ⌘T', () => {
  it('put the caret in the New chat box and never call chats.create while no chat is open', async () => {
    const focus = vi.fn()
    const create = vi.fn(async () => 'chat-1')
    expect(await newChatTab(true, focus, create)).toBeUndefined()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('add a tab to the open chat as before', async () => {
    const focus = vi.fn()
    const create = vi.fn(async () => 'chat-1')
    expect(await newChatTab(false, focus, create)).toBe('chat-1')
    expect(create).toHaveBeenCalledTimes(1)
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('a big terminal open in a room with no chat', () => {
  const terminal = { id: 't1', kind: 'terminal' as const }

  it('still counts as no chat, so + and ⌘T focus the box and never call chats.create', async () => {
    const noChat = leadHasNoChat(true, [terminal])
    expect(noChat).toBe(true)
    const focus = vi.fn()
    const create = vi.fn(async () => 'chat-1')
    await newChatTab(noChat, focus, create)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('shows the terminal until the box is asked for, then the box, and the box for a file, diff or shared tab', () => {
    expect(showsNewChat(true, false, [terminal], 't1')).toBe(false)
    expect(showsNewChat(true, true, [terminal], 't1')).toBe(true)
    expect(showsNewChat(true, false, [terminal], 'file:a.ts')).toBe(true)
    expect(showsNewChat(true, false, [terminal], 'diff:')).toBe(true)
    expect(showsNewChat(true, false, [terminal], 'shared:s1')).toBe(true)
    expect(showsNewChat(true, false, [terminal], undefined)).toBe(true)
    expect(showsNewChat(false, true, [{ id: 'c1' }], 'c1')).toBe(false)
  })
})

describe("a room's New chat box draft", () => {
  const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]

  it('is its own per room, survives a prune', async () => {
    vi.resetModules()
    const { loadDraft, newChatDraftOf, pruneDrafts, saveDraft } = await import('../src/renderer/src/screens/workspace/composer/draftStore')
    saveDraft(newChatDraftOf('room-a'), words('plan the week'), '')
    expect(loadDraft(newChatDraftOf('room-a'))).toEqual(words('plan the week'))
    expect(loadDraft(newChatDraftOf('room-b'))).toBeUndefined()
    pruneDrafts({ workspaces: [], chats: {} }, () => true)
    expect(loadDraft(newChatDraftOf('room-a'))).toEqual(words('plan the week'))
  })
})

describe('the tab row in a room with no chat', () => {
  const terminal = { id: 't1' }

  it('selects no tab only while the box is what is on screen, and keeps a file, diff, shared or terminal tab selected in front', () => {
    expect(newChatOnScreen(true, false, [], undefined)).toBe(true)
    expect(newChatOnScreen(true, true, [terminal], 't1')).toBe(true)
    for (const tab of ['file:a.ts', 'diff:', 'diff:a.ts', 'shared:s1', 'image:1', 'text:1']) {
      expect(showsNewChat(true, false, [terminal], tab)).toBe(true)
      expect(tabInFront(tab)).toBe(true)
      expect(newChatOnScreen(true, false, [terminal], tab)).toBe(false)
    }
    expect(newChatOnScreen(true, false, [terminal], 't1')).toBe(false)
    expect(newChatOnScreen(false, false, [{ id: 'c1' }], 'c1')).toBe(false)
  })
})

describe('focusComposerIn', () => {
  it('leaves a request waiting for its workspace to bring the box up, until the box takes it', async () => {
    vi.resetModules()
    const bus = await import('../src/renderer/src/screens/workspace/composer/bus')
    expect(bus.composerFocusWantedIn('ws-lead')).toBe(false)
    bus.focusComposerIn('ws-lead')
    expect(bus.composerFocusWantedIn('ws-lead')).toBe(true)
    expect(bus.composerFocusWantedIn('ws-other')).toBe(false)
    expect(bus.takeComposerFocus({ id: '', workspaceId: 'ws-lead' })).toBe(true)
    expect(bus.composerFocusWantedIn('ws-lead')).toBe(false)
    bus.focusComposerWhenOpen('chat-1')
    expect(bus.composerFocusWantedIn('ws-lead')).toBe(false)
  })
})

describe('the tab order while the New chat box is on screen', () => {
  it('puts the first tab in it when none is active, and the active tab otherwise', () => {
    expect(tabStop(['t1', 'file:a.ts'], undefined)).toBe('t1')
    expect(tabStop(['t1', 'file:a.ts'], 'gone')).toBe('t1')
    expect(tabStop(['t1', 'file:a.ts'], 'file:a.ts')).toBe('file:a.ts')
    expect(tabStop([], undefined)).toBeUndefined()
  })
})

describe('bringing the box up when the composer is asked for', () => {
  it('looks when it starts and when asked, so opening a file later never switches to the box', async () => {
    vi.resetModules()
    const bus = await import('../src/renderer/src/screens/workspace/composer/bus')
    const { bringBoxOnAsk } = await import('../src/renderer/src/screens/workspace/leadNoChat')
    let state: { noChat: boolean; tab?: string } = { noChat: true, tab: 't1' }
    const bringUp = vi.fn()
    // A Lead row click with a terminal in front: the request waits, since the box isn't what a terminal gives way to.
    bus.focusComposerIn('ws-lead')
    const stop = bringBoxOnAsk('ws-lead', () => state, bringUp)
    expect(bringUp).not.toHaveBeenCalled()
    // A file opens while the request is still waiting. Nothing asks again, so nothing switches.
    state = { noChat: true, tab: 'file:a.ts' }
    expect(bringUp).not.toHaveBeenCalled()
    // Asked again with the file in front, the box comes up.
    bus.focusComposerIn('ws-lead')
    expect(bringUp).toHaveBeenCalledTimes(1)
    stop()
    bus.focusComposerIn('ws-lead')
    expect(bringUp).toHaveBeenCalledTimes(1)
  })

  it('finds a request made before the screen mounted', async () => {
    vi.resetModules()
    const bus = await import('../src/renderer/src/screens/workspace/composer/bus')
    const { bringBoxOnAsk } = await import('../src/renderer/src/screens/workspace/leadNoChat')
    const bringUp = vi.fn()
    bus.focusComposerIn('ws-lead')
    bringBoxOnAsk('ws-lead', () => ({ noChat: true, tab: 'diff:' }), bringUp)()
    expect(bringUp).toHaveBeenCalledTimes(1)
  })
})

describe("a New chat box opens on the Lead's pick (KERNEL-544)", () => {
  const settings = (lead: RoleModel, over: { leadPlanMode?: boolean; engineers?: RoleModel; effortByModel?: Record<string, string> } = {}) => ({
    models: {
      roles: {
        lead, engineers: over.engineers ?? { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'xhigh' },
        qa: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, reviewer: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }
      },
      leadPlanMode: over.leadPlanMode ?? false, effortByModel: over.effortByModel ?? {}
    }
  }) as Parameters<typeof import('../src/renderer/src/screens/workspace/composer/modelPrefs').leadStart>[1]
  const opusMedium: RoleModel = { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }
  const astra: RoleModel = { provider: 'codex', model: 'gpt-6-astra', effort: 'max' }
  const words = (t: string): ChatPart[] => [{ type: 'text', text: t }]
  const kernel = (over: Partial<AgentDef> = {}) => ({ id: 'kernel', name: 'Kernel', role: 'Lead', description: '', lead: true, prompt: '', file: '', ...over }) as AgentDef

  it("shows the Lead row's model and effort, not the Frontend and Backend row or the effort a model was last picked at", async () => {
    const { boxPick, leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
    const s = settings(opusMedium, { effortByModel: { 'claude-opus-5-5': 'high' } })
    expect(leadStart(kernel(), s, true)).toEqual({ ...opusMedium, plan: false })
    expect(boxPick(leadStart(kernel(), s, true), undefined)).toEqual({ model: 'claude-opus-5-5', effort: 'medium', plan: false })
  })

  it("takes the Lead's plan mode from Settings, Models and effort", async () => {
    const { leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
    expect(leadStart(kernel(), settings(opusMedium, { leadPlanMode: true }), true).plan).toBe(true)
    expect(leadStart(kernel(), settings(opusMedium, { leadPlanMode: false }), true).plan).toBe(false)
  })

  it('opens on a fresh install\'s Lead before Settings has loaded', async () => {
    const { leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
    expect(leadStart(undefined, null, true)).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high', plan: false })
  })

  it("follows a change in Settings while the box is open and nothing is picked, and only for what is not picked", async () => {
    const { boxPick, leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
    const view = (s: ReturnType<typeof settings>, picks?: Parameters<typeof boxPick>[1]) => boxPick(leadStart(kernel(), s, true), picks)
    const before = settings(opusMedium)
    const after = settings({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' }, { leadPlanMode: true })
    expect(view(before)).toEqual({ model: 'claude-opus-5-5', effort: 'medium', plan: false })
    expect(view(after)).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', plan: true })
    expect(view(after, { plan: false })).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', plan: false })
    expect(view(after, { model: 'claude-haiku-4-5-20251001', effort: 'high' })).toEqual({ model: 'claude-haiku-4-5-20251001', effort: 'high', plan: true })
  })

  it("shows Kernel's agent file pin over the Lead row, with the file's effort or else the row's", async () => {
    const { boxPick, leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
    const s = settings(opusMedium)
    expect(boxPick(leadStart(kernel({ model: 'sonnet', effort: 'low' }), s, true), undefined)).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', plan: false })
    expect(leadStart(kernel({ model: 'claude-haiku-4-5-20251001' }), s, true)).toMatchObject({ provider: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'medium' })
    expect(leadStart(kernel({ effort: 'xhigh' }), s, true)).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(leadStart(kernel({ model: 'inherit' }), s, true)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
    expect(leadStart(kernel({ model: 'gpt-5.6-luna' }), s, true)).toMatchObject({ provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' })
  })

  it('stays on Codex while it can run', async () => {
    const { leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
    expect(leadStart(kernel(), settings(astra), true)).toEqual({ ...astra, plan: false })
  })

  it("starts on Claude Code's default model when the Lead row is on Codex and Codex can't run, at an effort that model takes", async () => {
    const { leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
    expect(leadStart(kernel(), settings(astra), false)).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', plan: false })
    expect(leadStart(kernel(), settings({ ...astra, effort: 'ultra' }), false).effort).toBe('xhigh')
    expect(leadStart(kernel(), settings({ ...astra, effort: 'low' }), false)).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
    expect(leadStart(kernel({ model: 'gpt-5.6-luna' }), settings(opusMedium), false)).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' })
    expect(leadStart(kernel(), settings(opusMedium), false)).toEqual({ ...opusMedium, plan: false })
  })

  it('keeps a pick through the box closing and opening, and through a relaunch', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const disk = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) })
    try {
      const { boxPick, leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
      const drafts = await import('../src/renderer/src/screens/workspace/composer/draftStore')
      const key = drafts.newChatDraftOf('room-a')
      const start = leadStart(kernel(), settings(opusMedium), true)
      drafts.savePicks(key, { model: 'claude-sonnet-5-5', effort: 'low', plan: true })
      // The box unmounts, and the next one to mount reads the same picks, with no text in the box.
      expect(boxPick(start, drafts.loadPicks(key))).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', plan: true })
      expect(drafts.loadDraft(key)).toBeUndefined()
      // Another room's box is its own.
      expect(boxPick(start, drafts.loadPicks(drafts.newChatDraftOf('room-b')))).toEqual({ model: 'claude-opus-5-5', effort: 'medium', plan: false })
      vi.advanceTimersByTime(500)
      vi.resetModules()
      const again = await import('../src/renderer/src/screens/workspace/composer/draftStore')
      expect(boxPick(start, again.loadPicks(key))).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', plan: true })
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('goes back to the Lead when the message is sent', async () => {
    vi.resetModules()
    const { boxPick, leadStart } = await import('../src/renderer/src/screens/workspace/composer/modelPrefs')
    const drafts = await import('../src/renderer/src/screens/workspace/composer/draftStore')
    const key = drafts.newChatDraftOf('room-a')
    const start = leadStart(kernel(), settings(opusMedium), true)
    drafts.saveDraft(key, words('plan the week'), '')
    drafts.savePicks(key, { model: 'claude-haiku-4-5-20251001', effort: 'low', plan: true })
    drafts.clearDraft(key)
    expect(drafts.loadDraft(key)).toBeUndefined()
    expect(boxPick(start, drafts.loadPicks(key))).toEqual({ model: 'claude-opus-5-5', effort: 'medium', plan: false })
  })
})
