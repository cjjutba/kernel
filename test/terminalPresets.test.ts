import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { Kernel } from '../src/main/kernel'
import { DEFAULT_SETTINGS, loadAppSettings } from '../src/main/services/settings'
import { foundClis } from '../src/main/services/terminalPresets'

const launchPath = process.env.PATH
afterEach(() => { process.env.PATH = launchPath })

/** A PATH folder with `codex` runnable, `amp` present but not executable, and a folder named `gemini`. */
async function binDir() {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-bin-'))
  await writeFile(join(dir, 'codex'), '#!/bin/sh\necho codex\n')
  await chmod(join(dir, 'codex'), 0o755)
  await writeFile(join(dir, 'amp'), '#!/bin/sh\n')
  await chmod(join(dir, 'amp'), 0o644)
  await mkdir(join(dir, 'gemini'))
  return dir
}

/** A Kernel on a temp repo whose big terminals record the command they would type instead of starting a shell. */
async function kernel(settings: object = {}) {
  const repo = await tempRepo({ 'README.md': '# x\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.' })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' }, ...settings }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const started = new Map<string, string | undefined>()
  k.ptys.start = (id, o) => { started.set(id, o.command) }
  const room = await k.addRoom(repo)
  const h = k.handlers()
  /** Opens a terminal tab with `preset` and returns what its pty types in. */
  const run = async (workspaceId: string, preset?: string) => {
    const chat = await h['chats.create']({ workspaceId, kind: 'terminal', preset })
    await h['terminal.resize']({ chatId: chat.id, cols: 100, rows: 30 })
    return { chat, command: started.get(chat.id) }
  }
  return { k, h, room, dataDir, run, started }
}

describe('terminal presets', () => {
  it('finds a CLI on the PATH by an executable file only, and never lists a missing one', async () => {
    const dir = await binDir()
    expect((await foundClis(dir)).map((p) => p.id)).toEqual(['codex'])
    expect(await foundClis('')).toEqual([])
    expect(await foundClis(join(dir, 'nowhere'))).toEqual([])
  })

  it('lists the built-ins, then the CLIs found on the PATH, then the custom commands', async () => {
    const { k, h } = await kernel({ terminal: { custom: [{ id: 'logs', name: 'Dev server logs', command: 'tail -f logs/dev.log' }, { id: 'yolo', name: 'Yolo', command: 'claude --dangerously-skip-permissions --verbose' }] } })
    process.env.PATH = await binDir()
    const list = await h['terminal.presets']()
    expect(list.map((p) => p.id)).toEqual(['claude', 'claude-skip', 'shell', 'codex', 'logs', 'yolo'])
    expect(list.find((p) => p.id === 'codex')).toEqual({ id: 'codex', name: 'Codex', command: 'codex', builtin: true, skipsPermissions: false })
    expect(list.find((p) => p.id === 'logs')).toMatchObject({ builtin: false, skipsPermissions: false })
    expect(list.find((p) => p.id === 'yolo')).toMatchObject({ builtin: false, skipsPermissions: true })
    expect(list.find((p) => p.id === 'shell')?.command).toBeNull()
    await k.stop()
  })

  it('starts each built-in, a found CLI and a custom preset with its own command, titled after the preset', async () => {
    const { k, room, run } = await kernel({ terminal: { custom: [{ id: 'logs', name: 'Dev server logs', command: 'tail -f logs/dev.log' }] } })
    const ws = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Presets' })
    expect(ws.mode).toBe('worktree')
    process.env.PATH = await binDir()

    const claude = await run(ws.id, 'claude')
    expect(claude.command).toBe('claude')
    expect(claude.chat).toMatchObject({ title: 'Terminal (claude)', terminal: { preset: 'claude', command: 'claude' } })
    expect(await run(ws.id, 'claude-skip')).toMatchObject({ command: 'claude --dangerously-skip-permissions', chat: { title: 'Terminal (claude-skip)' } })
    const shell = await run(ws.id, 'shell')
    expect(shell.command).toBeUndefined()
    expect(shell.chat).toMatchObject({ title: 'Terminal (shell)', terminal: { preset: 'shell', command: null } })
    const codex = await run(ws.id, 'codex')
    expect(codex).toMatchObject({ command: 'codex', chat: { title: 'Terminal (codex)' } })
    const logs = await run(ws.id, 'logs')
    expect(logs).toMatchObject({ command: 'tail -f logs/dev.log', chat: { title: 'Terminal (Dev server logs)' } })
    // The preset survives a reload of the chat from the database.
    expect(k.store.chat(logs.chat.id)?.terminal).toEqual({ preset: 'logs', command: 'tail -f logs/dev.log' })
    await k.stop()
  })

  it('opens the settings\' preset when none is picked, Claude when that one is gone, and refuses an unknown one', async () => {
    const { k, h, room, run } = await kernel({ terminal: { preset: 'codex' } })
    const ws = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Default' })
    process.env.PATH = await binDir()
    expect((await run(ws.id)).command).toBe('codex')
    process.env.PATH = ''
    expect((await run(ws.id)).command).toBe('claude')
    await expect(h['chats.create']({ workspaceId: ws.id, kind: 'terminal', preset: 'codex' })).rejects.toThrow('preset is gone')
    await k.stop()
  })

  it('drops the skip flag on a current-branch workspace with Only in worktrees on, and keeps it in a worktree or with the switch off', async () => {
    const { k, h, room, run } = await kernel({ terminal: { custom: [{ id: 'yolo', name: 'Yolo', command: 'claude --dangerously-skip-permissions --verbose' }] } })
    const current = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Here', mode: 'current' })
    const tree = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'There' })
    expect(current.mode).toBe('current')

    const dropped = await run(current.id, 'claude-skip')
    expect(dropped.command).toBe('claude')
    expect(dropped.chat.terminal).toEqual({ preset: 'claude-skip', command: 'claude' })
    expect((await run(current.id, 'yolo')).command).toBe('claude --verbose')
    expect((await run(tree.id, 'claude-skip')).command).toBe('claude --dangerously-skip-permissions')
    expect((await run(tree.id, 'yolo')).command).toBe('claude --dangerously-skip-permissions --verbose')

    await h['settings.set']({ patch: { terminal: { onlyInWorktrees: false } } })
    expect((await run(current.id, 'claude-skip')).command).toBe('claude --dangerously-skip-permissions')
    await k.stop()
  })

  it('finds and drops the skip flag in every form the shell still hands to claude', async () => {
    // The shell takes off quotes and backslashes, so each of these still skips permissions.
    const rows: [string, string][] = [
      ['claude "--dangerously-skip-permissions"', 'claude'],
      ["claude '--dangerously-skip-permissions' --verbose", 'claude --verbose'],
      ['claude \\--dangerously-skip-permissions', 'claude'],
      ['claude --dangerously-skip-permissions>log', 'claude>log'],
      ['claude --dangerously-skip-permissions<in', 'claude<in'],
      ['claude --dangerously-skip-permissions=true --verbose', 'claude --verbose'],
      ['claude "--dangerously-skip-permissions=true"', 'claude'],
      ['claude\t--dangerously-skip-permissions --dangerously-skip-permissions', 'claude'],
      ['cd app;--dangerously-skip-permissions', 'cd app;'],
      ['claude --dangerously-skip-permissions|tee log', 'claude|tee log'],
      ['claude --dangerously-skip-permissions&&echo done', 'claude&&echo done']
    ]
    const custom = rows.map(([command], i) => ({ id: `c${i}`, name: `C${i}`, command }))
    const { k, h, room, run } = await kernel({ terminal: { custom: [...custom, { id: 'other', name: 'Other', command: 'claude --dangerously-skip-permissions-x' }] } })
    const current = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Here', mode: 'current' })
    const list = await h['terminal.presets']()
    for (const [i, [command, stripped]] of rows.entries()) {
      expect(list.find((p) => p.id === `c${i}`)?.skipsPermissions, command).toBe(true)
      expect((await run(current.id, `c${i}`)).command, command).toBe(stripped)
    }
    // Another word that starts with the flag isn't the flag.
    expect(list.find((p) => p.id === 'other')?.skipsPermissions).toBe(false)
    expect((await run(current.id, 'other')).command).toBe('claude --dangerously-skip-permissions-x')
    await k.stop()
  })

  it('restarts a terminal chat from before presets with claude', async () => {
    const { k, h, room, started } = await kernel()
    const ws = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Old' })
    const first = k.store.chats(ws.id)[0]
    const old = k.store.saveChat({ ...first, id: 'old-terminal', kind: 'terminal', title: 'Terminal (claude)', sessionId: undefined, autoTitle: undefined })
    expect(old.terminal).toBeUndefined()
    await h['terminal.write']({ chatId: old.id, data: '' })
    expect(started.get(old.id)).toBe('claude')
    await k.stop()
  })

  it('refuses a new terminal tab while big terminal tabs are off', async () => {
    const { k, h, room } = await kernel({ terminal: { enabled: false } })
    const ws = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Off' })
    await expect(h['chats.create']({ workspaceId: ws.id, kind: 'terminal' })).rejects.toThrow('Big terminal tabs are off')
    expect((await h['chats.create']({ workspaceId: ws.id })).kind).toBe('chat')
    await k.stop()
  })
})

describe('terminal settings', () => {
  const file = async (saved: object) => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-settings-'))
    await writeFile(join(dir, 'settings.json'), JSON.stringify(saved))
    return join(dir, 'settings.json')
  }

  it('moves the two experimental switches of an existing settings file into terminal', async () => {
    const s = await loadAppSettings(await file({ experimental: { bigTerminal: false, bigTerminalWorktreeOnly: false, walking: false, floor3d: true, voice: true } }), '/home')
    expect(s.terminal).toEqual({ enabled: false, preset: 'claude', onlyInWorktrees: false, custom: [] })
    expect(s.experimental).toEqual({ walking: false, floor3d: true, voice: true })
  })

  it('keeps a terminal value already saved over the old switch, and defaults a file without either', async () => {
    const both = await loadAppSettings(await file({ terminal: { enabled: true }, experimental: { bigTerminal: false, bigTerminalWorktreeOnly: false } }), '/home')
    expect(both.terminal).toMatchObject({ enabled: true, onlyInWorktrees: false })
    expect(both.experimental).not.toHaveProperty('bigTerminal')
    expect((await loadAppSettings(await file({}), '/home')).terminal).toEqual(DEFAULT_SETTINGS('/home').terminal)
  })

  it('leaves out a custom command with no id, name or command, and a repeated id', async () => {
    const custom = [
      { id: 'a', name: 'A', command: 'echo a' }, { id: 'a', name: 'Again', command: 'echo again' }, { id: '', name: 'No id', command: 'x' },
      { id: 'b', name: 'Blank', command: '  ' }, { id: 'c', command: 'echo c' }, 'nonsense'
    ]
    const s = await loadAppSettings(await file({ terminal: { custom, preset: 7 } }), '/home')
    expect(s.terminal.custom).toEqual([{ id: 'a', name: 'A', command: 'echo a' }])
    expect(s.terminal.preset).toBe('claude')
  })

  it('leaves out a custom command whose id a built-in or a known CLI uses', async () => {
    const custom = ['claude', 'claude-skip', 'shell', 'codex', 'opencode', 'amp', 'copilot', 'gemini', 'mine'].map((id) => ({ id, name: id, command: `echo ${id}` }))
    const s = await loadAppSettings(await file({ terminal: { custom } }), '/home')
    expect(s.terminal.custom).toEqual([{ id: 'mine', name: 'mine', command: 'echo mine' }])
    const { k, h } = await kernel()
    expect((await h['settings.set']({ patch: { terminal: { custom: [{ id: 'codex', name: 'My codex', command: 'codex --yolo' }] } } })).terminal.custom).toEqual([])
    await k.stop()
  })

  it('saves the migrated file without the old keys', async () => {
    const { k, h, dataDir } = await kernel({ experimental: { bigTerminal: false, bigTerminalWorktreeOnly: true } })
    await h['settings.set']({ patch: { terminal: { preset: 'shell' } } })
    const saved = JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8'))
    expect(saved.terminal).toEqual({ enabled: false, preset: 'shell', onlyInWorktrees: true, custom: [] })
    expect(saved.experimental).not.toHaveProperty('bigTerminal')
    expect(saved.experimental).not.toHaveProperty('bigTerminalWorktreeOnly')
    await k.stop()
  })
})
