import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, readFile, symlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '../src/main/kernel'
import { ensureRepoSettings } from '../src/main/services/rooms'
import { kernelTools } from '../src/main/services/kernelMcp'
import { tempRepo, freePort } from './helpers'

const KERNEL = '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.\n'
const KAI = '---\nname: kai\ndescription: Frontend engineer.\ntools: Read, Edit, Write, Bash, Grep, Glob\n---\nYou are Kai.\n'

async function boot(files: Record<string, string> = {}) {
  const repo = await tempRepo({ 'README.md': '# app\n', '.claude/agents/kernel.md': KERNEL, '.claude/agents/kai.md': KAI, ...files })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  onTestFinished(() => k.stop())
  await k.start()
  k.sessions.send = async () => ({ queued: false })
  const room = await k.rooms.addRoom(repo)
  const h = k.handlers()
  const lead = (await k.team.agents(room.id)).find((a) => a.lead)!
  const chat = await k.lead.leadChat(room.id)
  const tool = kernelTools(k.lead.leadToolDeps(room.id, lead, chat)).find((t) => t.name === 'set_room_scripts')!
  const ask = async (args: object, answer: string) => {
    const result = tool.handler(args as never, {}).then((r) => (r.content[0] as { text: string }).text)
    const card = await vi.waitFor(() => {
      const a = k.store.approvals({ roomId: room.id, pendingOnly: true }).find((x) => x.kind === 'question')
      expect(a).toBeTruthy()
      return a!
    })
    k.approvals.decide(card.id, { behavior: 'answer', text: answer })
    return { card, text: await result }
  }
  return { k, h, repo, room, ask, local: join(repo, '.kernel', 'settings.local.toml') }
}

// KERNEL-682 to 685, run end to end: each case is a fresh temp repo added as a room, driven through the channels.
describe('setup script feature end to end', () => {
  it('case 1: Conductor TOML, Use, new workspace runs setup', async () => {
    const toml = `[scripts]\nsetup = "echo p=$CONDUCTOR_PORT > setup.txt"\narchive = "echo bye"\n[scripts.run.web]\ncommand = "pnpm dev --port $CONDUCTOR_PORT"\ndefault = true\n[scripts.run.docs]\ncommand = "pnpm docs -p $CONDUCTOR_PORT"\n`
    const { k, h, repo, room } = await boot({ '.conductor/settings.toml': toml })
    const s = await h['scripts.suggest']({ roomId: room.id })
    expect(s[0].source).toBe('conductor')
    expect(s[0].patch.scripts?.setup).toContain('$KERNEL_PORT')
    expect(s[0].patch.scripts?.archive).toBe('echo bye')
    expect(s[0].patch.scripts?.run).toContain('--port $KERNEL_PORT')
    expect(s[0].patch.runScripts).toEqual({ docs: 'pnpm docs -p $KERNEL_PORT' })
    await h['settings.setRoom']({ roomId: room.id, patch: s[0].patch })
    const local = await readFile(join(repo, '.kernel', 'settings.local.toml'), 'utf8')
    expect(local).not.toContain('CONDUCTOR')
    const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'x', agentId: 'kai', title: 'x' })
    expect(ws.status).toBe('ready')
    expect(await readFile(join(ws.path, 'setup.txt'), 'utf8')).toBe(`p=${ws.port}\n`)
  })

  it('case 2: Superset config', async () => {
    const cfg = JSON.stringify({ setup: ['echo a > a.txt', 'echo b > b.txt'], teardown: ['echo down'], run: ['echo run $SUPERSET_WORKSPACE_NAME'] })
    const { k, h, room } = await boot({ '.superset/config.json': cfg })
    const s = await h['scripts.suggest']({ roomId: room.id })
    expect(s[0].source).toBe('superset')
    expect(s[0].patch.scripts?.setup).toBe('echo a > a.txt && echo b > b.txt')
    expect(s[0].patch.scripts?.archive).toBe('echo down')
    expect(s[0].patch.scripts?.run).toBe('echo run $KERNEL_WORKSPACE_NAME')
    await h['settings.setRoom']({ roomId: room.id, patch: s[0].patch })
    const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'x', agentId: 'kai', title: 'x' })
    expect(await readFile(join(ws.path, 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('case 3: lockfile only', async () => {
    const { h, room } = await boot({ 'package.json': '{"name":"a"}', 'pnpm-lock.yaml': 'lockfileVersion: 9\n' })
    const s = await h['scripts.suggest']({ roomId: room.id })
    expect(s).toHaveLength(1)
    expect(s[0].source).toBe('detected')
    expect(s[0].file).toBe('pnpm-lock.yaml')
    expect(s[0].patch.scripts?.setup).toBeTruthy()
    expect(s[0].patch.scripts?.run).toBeUndefined()
    expect(s[0].patch.runScripts ?? []).toEqual([])
  })

  it('case 4: nothing, then Cancel and Save', async () => {
    const { h, room, ask, local, repo } = await boot()
    expect(await h['scripts.suggest']({ roomId: room.id })).toEqual([])
    await ensureRepoSettings(repo)
    const settings = await readFile(join(repo, '.kernel', 'settings.toml'), 'utf8')
    expect(settings).not.toMatch(/^\s*(setup|archive|run)\s*=/m)
    const c = await ask({ setup: 'pnpm install' }, 'Cancel')
    expect(c.card.detail).toBe('Setup script\npnpm install')
    expect(c.text).toBe('Not saved: the user canceled.')
    await expect(readFile(local, 'utf8')).rejects.toThrow()
    const s = await ask({ setup: 'pnpm install' }, 'Save')
    expect(s.card.detail).toBe('Setup script\npnpm install')
    expect(s.text).toContain('Saved setup script to .kernel/settings.local.toml.')
    expect(await readFile(local, 'utf8')).toContain('pnpm install')
  })

  it('case 5: pasted Conductor config', async () => {
    const { ask, local } = await boot()
    const { card, text } = await ask({ setup: 'echo $CONDUCTOR_PORT\necho ${CONDUCTOR_ROOT_PATH}x\necho $CONDUCTOR_PORTAL $CONDUCTOR_FOO', run: 'dev -p $((CONDUCTOR_PORT+1))' }, 'Save')
    const saved = await readFile(local, 'utf8')
    expect(card.detail).toContain('echo $KERNEL_PORT\necho ${KERNEL_ROOT_PATH}x\necho $CONDUCTOR_PORTAL $CONDUCTOR_FOO')
    expect(saved).toContain('echo $KERNEL_PORT')
    expect(card.detail).toContain('Run script\ndev -p $((KERNEL_PORT+1))')
    expect(saved).toContain('dev -p $((KERNEL_PORT+1))')
    expect(saved).not.toContain('CONDUCTOR_PORT+1')
    expect(text).toContain('CONDUCTOR_FOO')
  })

  it('case 6: symlink out of repo, bad TOML', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'outside-'))
    await writeFile(join(outside, 's.toml'), '[scripts]\nsetup = "echo pwned"\n')
    const a = await boot()
    await mkdir(join(a.repo, '.conductor'), { recursive: true })
    await symlink(join(outside, 's.toml'), join(a.repo, '.conductor', 'settings.toml'))
    expect(await a.h['scripts.suggest']({ roomId: a.room.id })).toEqual([])
    const b = await boot({ '.conductor/settings.toml': '[scripts\nsetup = = =' })
    expect(await b.h['scripts.suggest']({ roomId: b.room.id })).toEqual([])
  })

  it('case 7: room with setup does not get that suggestion', async () => {
    const { h, room } = await boot({ '.conductor/settings.toml': '[scripts]\nsetup = "pnpm install"\n' })
    const s = await h['scripts.suggest']({ roomId: room.id })
    await h['settings.setRoom']({ roomId: room.id, patch: s[0].patch })
    expect(await h['scripts.suggest']({ roomId: room.id })).toEqual([])
  })
})

describe('Use from the Setup tab on a room that already has run and archive scripts', () => {
  // The suggestion leaves out every script the room has, so Use saves only what is missing (KERNEL-707).
  it('keeps the run and archive the room already has', async () => {
    const toml = `[scripts]\nsetup = "pnpm install"\narchive = "echo conductor-archive"\nrun = "conductor run"\n`
    const { h, room } = await boot({ '.conductor/settings.toml': toml })
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { run: 'my own run', archive: 'my own archive' } } })
    const s = await h['scripts.suggest']({ roomId: room.id })
    await h['settings.setRoom']({ roomId: room.id, patch: s[0].patch })
    const after = await h['settings.room']({ roomId: room.id })
    expect(after.scripts.run).toBe('my own run')
    expect(after.scripts.archive).toBe('my own archive')
    expect(after.scripts.setup).toBe('pnpm install')
  })

  it('offers a room with only a run script just the setup, archive and named run scripts it lacks', async () => {
    const toml = `[scripts]\nsetup = "pnpm install"\narchive = "echo bye"\nrun_mode = "nonconcurrent"\n[scripts.run.web]\ncommand = "pnpm dev"\ndefault = true\n[scripts.run.docs]\ncommand = "pnpm docs"\n[scripts.run.site]\ncommand = "pnpm site"\n`
    const { h, room } = await boot({ '.conductor/settings.toml': toml })
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { run: 'my own run', runMode: 'concurrent' }, runScripts: { site: 'my own site' } } })
    const [s] = await h['scripts.suggest']({ roomId: room.id })
    expect(s.patch).toEqual({ scripts: { setup: 'pnpm install', archive: 'echo bye' }, runScripts: { docs: 'pnpm docs' } })
    await h['settings.setRoom']({ roomId: room.id, patch: s.patch })
    const after = await h['settings.room']({ roomId: room.id })
    expect(after.scripts).toMatchObject({ run: 'my own run', runMode: 'concurrent', setup: 'pnpm install', archive: 'echo bye' })
    expect(after.runScripts.find((r) => r.name === 'site')?.command).toBe('my own site')
    expect(await h['scripts.suggest']({ roomId: room.id })).toEqual([])
  })

  it('offers only setup to a room with a run script, from a repo with setup and run', async () => {
    const { h, room } = await boot({ '.conductor/settings.toml': '[scripts]\nsetup = "pnpm install"\nrun = "conductor run"\n' })
    await h['settings.setRoom']({ roomId: room.id, patch: { scripts: { run: 'my own run' } } })
    const s = await h['scripts.suggest']({ roomId: room.id })
    expect(s.map((x) => x.patch)).toEqual([{ scripts: { setup: 'pnpm install' } }])
  })
})
