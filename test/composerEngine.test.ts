import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { discoverSkills, searchFiles } from '../src/main/services/files'
import { commitHunks, listHunks } from '../src/main/services/hunks'
import { git } from '../src/main/services/exec'
import { chatMode } from '../src/main/services/permissions'
import { attachFiles, Held, numberImages, partOf, pastedText, pathOnlyFiles, previewOf, PLAN_FILES_ONLY, PLAN_SEND_BLOCKED } from '../src/renderer/src/screens/workspace/composer/attach'
import { mentionMenu, mentionPart } from '../src/renderer/src/screens/workspace/composer/autocomplete'
import { noteFromParts } from '../src/renderer/src/screens/workspace/cards/steps'
import { toUserMessage } from '../src/main/services/providers/claude'
import { ModeMenu } from '../src/renderer/src/screens/workspace/composer/ModeMenu'
import { MODE_ORDER, buttonName, modeAria, modePatch, modeRows, nextMode, offLine, shownMode, whyLine, type ComposerMode } from '../src/renderer/src/screens/workspace/composer/modes'
import { apply, getState } from '../src/renderer/src/store'
import { INLINE_TEXT_MAX, type AppSettings, type ChatPart, type ChatRunMode } from '../src/shared/types'
import { tempRepo } from './helpers'

describe('@ file search', () => {
  it('ranks file name matches first and skips ignored files', async () => {
    const repo = await tempRepo({ 'src/app/invoices/table.tsx': 'a\n', 'tests/invoices.spec.ts': 'b\n', 'src/pdf/invoice-pdf.ts': 'c\n', 'src/db/schema/invoices.ts': 'd\n', 'notes/in-voice.md': 'e\n', '.gitignore': 'dist\n' })
    await mkdir(join(repo, 'dist'), { recursive: true })
    await writeFile(join(repo, 'dist/invoice.js'), 'x\n')
    const hits = (await searchFiles(repo, 'inv', 4)).map((f) => f.path)
    expect(hits).toHaveLength(4)
    expect(hits).not.toContain('dist/invoice.js')
    expect(hits).not.toContain('src/app/invoices/table.tsx')
    expect((await searchFiles(repo, 'tbl')).map((f) => f.path)).toEqual(['src/app/invoices/table.tsx'])
    expect(await searchFiles(repo, 'zzz')).toEqual([])
  })

  it('lists folders from the parent paths, an exact folder name first', async () => {
    const repo = await tempRepo({ 'src/a.ts': 'a\n', 'src/lib/b.ts': 'b\n', 'docs/src-notes.md': 'c\n' })
    const hits = await searchFiles(repo, 'src')
    expect(hits[0]).toEqual({ path: 'src', dir: true })
    expect(hits.filter((h) => h.dir).map((h) => h.path)).toContain('src')
    expect((await searchFiles(repo, 'lib')).slice(0, 2)).toEqual([{ path: 'src/lib', dir: true }, { path: 'src/lib/b.ts', dir: false }])
    expect((await searchFiles(repo, '')).every((h) => !h.dir)).toBe(true)
  })
})

describe('picking a folder in the @ menu', () => {
  const entries = [{ path: 'src', dir: true }, { path: 'src/a.ts', dir: false }]
  const rows = entries.map((entry) => ({ kind: 'file' as const, entry }))
  it('turns a folder row into a chip with a trailing slash and a file row into the file', () => {
    expect(mentionMenu(entries)).toEqual([{ label: 'Files', rows }])
    expect(mentionPart(rows[0])).toEqual({ type: 'file', name: 'src/', path: 'src/', dir: true })
    expect(mentionPart(rows[1])).toEqual({ type: 'file', name: 'a.ts', path: 'src/a.ts' })
  })
  it('sends the folder path to the agent, not file contents', () => {
    const parts = [{ type: 'text' as const, text: 'look at' }, mentionPart(rows[0])]
    expect(noteFromParts(parts)).toBe('look at @src/')
    expect(JSON.stringify(toUserMessage(parts))).toContain('@src/')
  })
})

describe('skills discovery', () => {
  it('reads project skills and commands, then adds the built-ins', async () => {
    const repo = await tempRepo({
      '.claude/skills/verify/SKILL.md': '---\nname: verify\ndescription: Run tests and attach the output\n---\nBody\n',
      '.claude/skills/plain/SKILL.md': '# Plain skill\nBody\n',
      '.claude/commands/ship.md': '---\ndescription: Ship it\n---\nDo it\n',
      '.claude/commands/git/sync.md': 'Sync the branch\n'
    })
    const skills = await discoverSkills(repo)
    expect(skills.map((s) => s.name)).toEqual(['git:sync', 'plain', 'ship', 'verify', 'compact', 'review', 'init'])
    expect(skills.find((s) => s.name === 'verify')).toMatchObject({ description: 'Run tests and attach the output', source: 'project' })
    expect(skills.find((s) => s.name === 'plain')?.description).toBe('Plain skill')
    expect(skills.find((s) => s.name === 'git:sync')?.description).toBe('Sync the branch')
  })
})

describe('hunks', () => {
  const lines = (n: number, tweak: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => tweak[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

  it('splits a file into mine and agent hunks and commits only the picked ones', async () => {
    const repo = await tempRepo({ 'checkout.ts': lines(60) })
    // Before the workspace started: an edit near the top, snapshotted as the baseline.
    await writeFile(join(repo, 'checkout.ts'), lines(60, { 12: 'mine 12' }))
    const baseline = (await git(repo, 'stash', 'create')).trim()
    // The agent edits further down.
    await writeFile(join(repo, 'checkout.ts'), lines(60, { 12: 'mine 12', 45: 'agent 45' }))
    const hunks = await listHunks(repo, { baselineRef: baseline })
    expect(hunks.map((h) => [h.owner, h.lines, h.added, h.removed])).toEqual([['agent', '42-48', 1, 1], ['mine', '9-15', 1, 1]])

    await commitHunks(repo, [hunks[0]], 'Round once')
    const committed = await git(repo, 'show', 'HEAD:checkout.ts')
    expect(committed).toContain('agent 45')
    expect(committed).not.toContain('mine 12')
    expect(await readFile(join(repo, 'checkout.ts'), 'utf8')).toContain('mine 12')
    expect((await git(repo, 'log', '-1', '--format=%s')).trim()).toBe('Round once')

    // HEAD moved past the baseline. The committed hunk is gone, and the earlier change is still "mine", not reversed.
    const after = await listHunks(repo, { baselineRef: baseline })
    expect(after.map((h) => [h.owner, h.lines, h.added, h.removed])).toEqual([['mine', '9-15', 1, 1]])
    expect(after[0].patch).toContain('+mine 12')
    await commitHunks(repo, after, 'Mine too')
    expect(await git(repo, 'show', 'HEAD:checkout.ts')).toContain('mine 12')
    expect(await listHunks(repo, { baselineRef: baseline })).toEqual([])
  })

  it('treats a clean start as having no earlier changes, and lists agent hunks again after a commit', async () => {
    const repo = await tempRepo({ 'a.ts': lines(30) })
    const baseline = (await git(repo, 'rev-parse', 'HEAD')).trim()
    await writeFile(join(repo, 'a.ts'), lines(30, { 3: 'one', 25: 'two' }))
    const hunks = await listHunks(repo, { baselineRef: baseline })
    expect(hunks.map((h) => h.owner)).toEqual(['agent', 'agent'])
    await commitHunks(repo, [hunks[0]], 'First')
    const rest = await listHunks(repo, { baselineRef: baseline })
    expect(rest.map((h) => h.lines)).toEqual(['22-28'])
    await commitHunks(repo, rest, 'Second')
    expect(await listHunks(repo, { baselineRef: baseline })).toEqual([])
  })

  it('still lists a change on or next to a line that was already dirty at start', async () => {
    const same = await tempRepo({ 'a.ts': lines(30) })
    await writeFile(join(same, 'a.ts'), lines(30, { 12: 'mine 12' }))
    const b1 = (await git(same, 'stash', 'create')).trim()
    await writeFile(join(same, 'a.ts'), lines(30, { 12: 'agent 12' }))
    const h1 = await listHunks(same, { baselineRef: b1 })
    expect(h1).toHaveLength(1)
    await commitHunks(same, h1, 'Same line')
    expect(await git(same, 'show', 'HEAD:a.ts')).toContain('agent 12')

    const next = await tempRepo({ 'b.ts': lines(30) })
    await writeFile(join(next, 'b.ts'), lines(30, { 12: 'mine 12' }))
    const b2 = (await git(next, 'stash', 'create')).trim()
    await writeFile(join(next, 'b.ts'), lines(30, { 12: 'mine 12', 13: 'agent 13' }))
    const h2 = await listHunks(next, { baselineRef: b2 })
    expect(h2.map((h) => [h.owner, h.lines, h.added, h.removed])).toEqual([['agent', '9-16', 2, 2]])
    await commitHunks(next, h2, 'Adjacent')
    expect(await git(next, 'show', 'HEAD:b.ts')).toContain('agent 13')
    expect(await listHunks(next, { baselineRef: b2 })).toEqual([])
  })

  it.each([[14, '9-17'], [15, '9-18']])('commits an edit %i lines from an earlier one, which git merges into one hunk', async (line, range) => {
    const repo = await tempRepo({ 'c.ts': lines(30) })
    await writeFile(join(repo, 'c.ts'), lines(30, { 12: 'mine 12' }))
    const baseline = (await git(repo, 'stash', 'create')).trim()
    await writeFile(join(repo, 'c.ts'), lines(30, { 12: 'mine 12', [line]: `agent ${line}` }))
    const hunks = await listHunks(repo, { baselineRef: baseline })
    expect(hunks.map((h) => [h.owner, h.lines, h.added, h.removed])).toEqual([['agent', range, 2, 2]])
    await commitHunks(repo, hunks, 'Both')
    const committed = await git(repo, 'show', 'HEAD:c.ts')
    expect(committed).toContain('mine 12')
    expect(committed).toContain(`agent ${line}`)
    expect(await listHunks(repo, { baselineRef: baseline })).toEqual([])
  })

  it('commits the agent hunk alone when another dirty line is far enough away to stay separate', async () => {
    const repo = await tempRepo({ 'd.ts': lines(40) })
    await writeFile(join(repo, 'd.ts'), lines(40, { 12: 'mine 12' }))
    const baseline = (await git(repo, 'stash', 'create')).trim()
    await writeFile(join(repo, 'd.ts'), lines(40, { 12: 'mine 12', 20: 'agent 20' }))
    const hunks = await listHunks(repo, { baselineRef: baseline })
    expect(hunks.map((h) => [h.owner, h.lines])).toEqual([['agent', '17-23'], ['mine', '9-15']])
    await commitHunks(repo, [hunks[0]], 'Agent only')
    const committed = await git(repo, 'show', 'HEAD:d.ts')
    expect(committed).toContain('agent 20')
    expect(committed).not.toContain('mine 12')
    expect((await listHunks(repo, { baselineRef: baseline })).map((h) => h.owner)).toEqual(['mine'])
  })

  it('refuses an empty pick', async () => {
    const repo = await tempRepo()
    await expect(commitHunks(repo, [], 'x')).rejects.toThrow('Pick at least one')
  })
})

describe('permission mode from the composer', () => {
  const claude = { claude: { auto: true, bypass: true }, codex: { auto: false, bypass: true } }
  const all = () => true
  const bypassOnTheBranch: ChatRunMode = { mode: 'acceptEdits', picked: 'bypassPermissions', pickedIn: 'chat', why: 'worktreesOnly' }

  it('cycles Manual, Accept edits, Plan, Auto, Bypass and round again', () => {
    const order = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
    expect(MODE_ORDER).toEqual(order)
    expect(order.map((m) => nextMode(m as ComposerMode, all))).toEqual(['acceptEdits', 'plan', 'auto', 'bypassPermissions', 'default'])
  })

  it('skips a mode the chat can not run, and stays put when nothing else runs', () => {
    const can = (provider: 'claude' | 'codex') => (m: ComposerMode) => !offLine(m, provider, claude)
    expect(nextMode('plan', can('codex'))).toBe('bypassPermissions')
    expect(nextMode('plan', can('claude'))).toBe('auto')
    expect(nextMode('plan', (m) => m === 'plan')).toBe('plan')
  })

  it('words a provider limit as the canvas does, for the chat\'s provider alone', () => {
    expect(offLine('auto', 'codex', claude)).toBe('Auto isn’t available for Codex agents yet')
    expect(offLine('auto', 'claude', claude)).toBeUndefined()
    expect(offLine('bypassPermissions', 'codex', claude)).toBeUndefined()
    expect(offLine('plan', 'codex', claude)).toBeUndefined()
    expect(offLine('auto', 'codex', null)).toBeUndefined()
  })

  it('sets the chat\'s mode and clears plan, except Plan, which sets plan and leaves the mode', () => {
    expect(modePatch('plan')).toEqual({ plan: true })
    expect(modePatch('default')).toEqual({ mode: 'default', plan: false })
    expect(modePatch('acceptEdits')).toEqual({ mode: 'acceptEdits', plan: false })
    expect(modePatch('auto')).toEqual({ mode: 'auto', plan: false })
    expect(modePatch('bypassPermissions')).toEqual({ mode: 'bypassPermissions', plan: false })
  })

  it('shows the mode the chat runs in, and Plan while it plans', () => {
    expect(shownMode(true, bypassOnTheBranch, 'default')).toEqual({ runs: 'plan', picked: 'plan' })
    expect(shownMode(false, bypassOnTheBranch, 'default')).toEqual({ runs: 'acceptEdits', picked: 'bypassPermissions', why: 'worktreesOnly' })
    expect(shownMode(false, undefined, 'auto')).toEqual({ runs: 'auto', picked: 'auto' })
    expect(shownMode(false, { mode: 'plan', picked: 'auto', pickedIn: 'app', why: 'plan' }, 'auto')).toEqual({ runs: 'auto', picked: 'auto' })
    expect(buttonName('bypassPermissions')).toBe('Bypass')
    expect(modeAria(shownMode(false, bypassOnTheBranch, 'default'))).toBe('Permission mode: Accept edits. Bypass permissions is picked but can’t run here. Shift+Tab to change')
  })

  it('keeps the check on the pick that can not run, with what it runs as and why', () => {
    const rows = modeRows(shownMode(false, bypassOnTheBranch, 'default'), 'claude', claude)
    expect(rows.map((r) => r.name)).toEqual(['Manual', 'Accept edits', 'Plan', 'Auto', 'Bypass permissions'])
    expect(rows.filter((r) => r.checked).map((r) => r.mode)).toEqual(['bypassPermissions'])
    expect(rows[4]).toMatchObject({ desc: 'Runs as Accept edits, Only in worktrees is on', why: true, off: false })
    expect(rows.slice(0, 4).map((r) => r.why)).toEqual([false, false, false, false])
    expect(whyLine('turnRunning', 'acceptEdits')).toBe('Runs as Accept edits until the turn ends')
  })

  it('dims Auto on a Codex agent and checks the pick', () => {
    const rows = modeRows(shownMode(false, { mode: 'acceptEdits', picked: 'acceptEdits', pickedIn: 'chat' }, 'default'), 'codex', claude)
    expect(rows[3]).toMatchObject({ mode: 'auto', desc: 'Auto isn’t available for Codex agents yet', off: true, checked: false })
    expect(rows[1]).toMatchObject({ mode: 'acceptEdits', desc: 'Edits files without asking', checked: true })
  })

  it('draws the menu with its five modes, the check and the Shift+Tab line', () => {
    const noop = () => undefined
    const shown = shownMode(false, bypassOnTheBranch, 'default')
    const html = renderToStaticMarkup(createElement(ModeMenu, { anchorRef: { current: null }, provider: 'codex', availability: claude, shown, onPick: noop, onCycle: noop, onClose: noop }))
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(5)
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Permission mode"')
    expect(html).toContain('Runs as Accept edits, Only in worktrees is on')
    expect(html).toContain('Auto isn’t available for Codex agents yet')
    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('cycles the modes')
  })

  it('keeps the chat\'s own mode through Plan, and falls back to the project\'s and then the app\'s', () => {
    const ws = { mode: 'worktree' } as const
    const on = { auto: true, bypass: true }
    const settings = { permissions: { mode: 'default', bypassOnlyInWorktrees: true } } as AppSettings
    expect(chatMode({ plan: true, mode: 'auto' }, ws, undefined, settings, on)).toMatchObject({ mode: 'plan', picked: 'auto', why: 'plan' })
    expect(chatMode({ plan: false, mode: 'auto' }, ws, { permissionMode: 'acceptEdits' }, settings, on)).toEqual({ mode: 'auto', picked: 'auto', pickedIn: 'chat' })
    expect(chatMode({ plan: false }, ws, { permissionMode: 'acceptEdits' }, settings, on)).toEqual({ mode: 'acceptEdits', picked: 'acceptEdits', pickedIn: 'project' })
    expect(chatMode({ plan: false }, ws, undefined, settings, on)).toEqual({ mode: 'default', picked: 'default', pickedIn: 'app' })
  })

  it('keeps each chat\'s run mode from its push event', () => {
    apply({ type: 'chat.runMode', chatId: 'c-mode', mode: bypassOnTheBranch })
    expect(getState().runModes['c-mode']).toEqual(bypassOnTheBranch)
    apply({ type: 'chat.runMode', chatId: 'c-mode', mode: { mode: 'auto', picked: 'auto', pickedIn: 'app' } })
    expect(getState().runModes['c-mode']).toEqual({ mode: 'auto', picked: 'auto', pickedIn: 'app' })
  })
})

describe('attaching files', () => {
  // KERNEL-1079: the engine counts a message of nothing but pastes as the user's words, so only the composer may mark one.
  it('marks a long paste as pasted, numbered after the pastes already in the draft', () => {
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    expect(pastedText('short', [])).toBeNull()
    expect(pastedText(long, [{ type: 'file', name: 'pasted_text_1.txt', text: 'x', pasted: true }])).toEqual({ type: 'file', name: 'pasted_text_2.txt', lines: 12, text: long, pasted: true })
  })

  const file = (name: string) => ({ name }) as File
  const host = (log: string[]) => ({
    hold: (part: ChatPart) => { const name = part.type === 'text' ? '' : part.name; log.push(`hold ${name}`); return `id-${name}` },
    settle: (id: string, part: ChatPart) => log.push(`settle ${id} ${part.type === 'text' ? '' : part.name}`),
    drop: (id: string) => log.push(`drop ${id}`)
  })

  it('holds a place for every file before the first one is read, then settles them in order', async () => {
    const log: string[] = []
    await attachFiles([file('a.png'), file('b.txt')], host(log), async (f) => { log.push(`read ${f.name}`); return { type: 'file', name: f.name, lines: 1, text: 'x' } })
    expect(log).toEqual(['hold a.png', 'hold b.txt', 'read a.png', 'settle id-a.png a.png', 'read b.txt', 'settle id-b.txt b.txt'])
  })

  it('lands each chip as it will look, with no loading state, before its read ends', () => {
    expect(previewOf(new File(['x'], 'image-2.png', { type: 'image/png' }))).toEqual({ type: 'image', name: 'image-2.png' })
    expect(previewOf(new File(['a\nb'], 'notes.md', { type: 'text/markdown' }))).toEqual({ type: 'file', name: 'notes.md' })
  })

  it('names images by their place in the message, after the images already in it, and leaves other files alone', async () => {
    const shot = (name: string, type: string) => new File(['x'], name, { type })
    const named = numberImages([shot('3552ac34.png', 'image/png'), shot('notes.txt', 'text/plain'), shot('Photo.JPEG', 'image/jpeg')])
    expect(named.map((f) => f.name)).toEqual(['image.png', 'notes.txt', 'image-2.jpg'])
    expect(await named[0].text()).toBe('x')
    expect(numberImages([shot('a.png', 'image/png')], ['image.png', 'image-3.webp', 'pasted_text_1.txt']).map((f) => f.name)).toEqual(['image-4.png'])
  })

  it('reads a text file and refuses any other in a plan change request, which carries no files by path', async () => {
    const text = new File(['a\nb\n'], 'notes.md', { type: 'text/markdown' })
    expect(await partOf(text, true)).toMatchObject({ type: 'file', name: 'notes.md', text: 'a\nb\n' })
    await expect(partOf(new File(['a\0b'], 'data.bin'), true)).rejects.toThrow(PLAN_FILES_ONLY)
    await expect(partOf(new File([new Uint8Array(INLINE_TEXT_MAX + 1)], 'big.txt'), true)).rejects.toThrow(PLAN_FILES_ONLY)
    const log: string[] = []
    const before = getState().ui.toasts.length
    await attachFiles([new File(['a\0b'], 'data.bin')], { ...host(log), textOnly: true })
    expect(log).toEqual(['hold data.bin', 'drop id-data.bin'])
    expect(getState().ui.toasts[before].sub).toBe(PLAN_FILES_ONLY)
    const byPath: ChatPart = { type: 'file', name: 'brief.pdf', src: '/Users/cj/brief.pdf', size: 10 }
    const inlined: ChatPart = { type: 'file', name: 'notes.md', src: '/Users/cj/notes.md', text: 'a', lines: 1 }
    expect(pathOnlyFiles([{ type: 'text', text: 'x' }, byPath, inlined, { type: 'file', name: 'a.ts', path: 'src/a.ts' }])).toEqual([byPath])
    expect(PLAN_SEND_BLOCKED).toBe('Plan change requests take images and text files only. Remove the other files to send.')
  })

  it('removes the place of a file that cannot be attached, toasts, and still attaches the rest', async () => {
    const log: string[] = []
    const before = getState().ui.toasts.length
    await attachFiles([file('big.bin'), file('ok.txt')], host(log), async (f) => {
      if (f.name === 'big.bin') throw new Error('big.bin is too large to attach (2048 KB).')
      return { type: 'file', name: f.name, lines: 1, text: 'x' }
    })
    expect(log).toEqual(['hold big.bin', 'hold ok.txt', 'drop id-big.bin', 'settle id-ok.txt ok.txt'])
    const toasts = getState().ui.toasts.slice(before)
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toBe('Could not attach')
    expect(toasts[0].sub).toContain('too large')
  })

  it('stops counting a cancelled file at once, and ignores its read when it ends', () => {
    const held = new Held()
    held.add('a', { type: 'image', name: 'a.png' })
    held.add('b', { type: 'image', name: 'b.png' })
    expect(held.release('a')).toBe(true)
    expect(held.size).toBe(1)
    // The cancelled file's read ends later: nothing is left to settle, and the count stays right.
    expect(held.release('a')).toBe(false)
    expect(held.size).toBe(1)
    expect(held.release('b')).toBe(true)
    expect(held.size).toBe(0)
  })
})
