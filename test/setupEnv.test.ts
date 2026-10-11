import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import { sessionEnv } from '../src/main/services/sessions'
import { parse as parseToml } from 'smol-toml'
import { readSetupEnv, setupEnvPath } from '../src/main/services/env'
import { defaultRepoSettings } from '../src/main/services/rooms'
import { workspaceSlug } from '../src/shared/kernelVars'
import { setUp, tempRepo, trustRoom } from './helpers'

// KERNEL-405: setup hands variables to the workspace through $KERNEL_ENV, like GitHub Actions' $GITHUB_ENV.

const sdk = vi.hoisted(() => ({ calls: [] as { options: any }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: unknown }) => {
    sdk.calls.push({ options })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 0 })
    }
  }
}))

const SETUP = [
  'echo A=1 >> "$KERNEL_ENV"',
  'echo "B=two words" >> "$KERNEL_ENV"',
  'echo KERNEL_PORT=1 >> "$KERNEL_ENV"',
  'echo 1BAD=x >> "$KERNEL_ENV"',
  'echo ANTHROPIC_BASE_URL=http://proxy.invalid >> "$KERNEL_ENV"'
].join(' && ')

async function roomWith(setup: string) {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.claude/agents/rowan.md': '---\nname: rowan\ndescription: Lead.\nlead: true\n---\nYou are Rowan.',
    '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
    '.kernel/settings.toml': `[scripts]\nsetup = '${setup}'\nrun = 'echo "$A $B $KERNEL_PORT $KERNEL_BRANCH" > run.txt'\n`
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  k.signedInReader = async () => true
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  const r = await k.addRoom(repo)
  await trustRoom(k, r.id)
  return { k, room: r, repo, dataDir }
}

describe('$KERNEL_ENV (KERNEL-405)', () => {
  it("hands setup's variables to Rowan's session, a run script and a terminal, and Kernel's own names keep Kernel's values", async () => {
    const { k, room, dataDir } = await roomWith(SETUP)
    const lines: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'script.output' && e.kind === 'setup') lines.push(...e.lines.map((l) => l.line)) }
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(room.id, { prompt: 'Plan it' })
    const ws = await setUp(k, chat.id)
    // The setup log names what it handed over, and never a value.
    expect(lines).toContain("Setup set A, ANTHROPIC_BASE_URL, B for this workspace's agents, run scripts and terminals. Skipped 1BAD, KERNEL_PORT: they aren't names Kernel passes on.")
    expect(lines.filter((l) => !l.startsWith('$ ')).join('\n')).not.toContain('two words')
    // Rowan's session, in its Bash.
    await vi.waitFor(() => expect(sdk.calls.filter((c) => c.options.cwd === ws.path)).toHaveLength(1))
    const env = sdk.calls.find((c) => c.options.cwd === ws.path)!.options.env as Record<string, string>
    expect(env).toMatchObject({ A: '1', B: 'two words', KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_NAME: ws.name, KERNEL_BRANCH: ws.branch, KERNEL_BASE_REF: ws.baseRef, KERNEL_DEFAULT_BRANCH: 'main' })
    expect(env).not.toHaveProperty('1BAD')
    expect(env.ANTHROPIC_BASE_URL).not.toBe('http://proxy.invalid')
    expect(env).not.toHaveProperty('KERNEL_ENV')
    // A terminal gets what a session gets.
    expect(sessionEnv(k.env.envFor(ws), {})).toMatchObject({ A: '1', B: 'two words', KERNEL_PORT: String(ws.port) })
    // A run script.
    await k.handlers()['scripts.run']({ workspaceId: ws.id, kind: 'run' })
    await vi.waitFor(async () => expect(await readFile(join(ws.path, 'run.txt'), 'utf8')).toBe(`1 two words ${ws.port} ${ws.branch}\n`))
    // Scripts get every layer whole, as with the room's variables (KERNEL-247). Sessions and terminals drop ANTHROPIC_* from it.
    expect(readSetupEnv(setupEnvPath(dataDir, ws.id))).toEqual({ vars: { A: '1', ANTHROPIC_BASE_URL: 'http://proxy.invalid', B: 'two words' }, dropped: ['1BAD', 'KERNEL_PORT'] })
    expect(sessionEnv(k.env.envFor(ws), {}).ANTHROPIC_BASE_URL).not.toBe('http://proxy.invalid')
  })

  it("passes nothing on until setup passed, or from a failed setup, and Run again writes the file over", async () => {
    const { k, room, repo } = await roomWith('echo A=1 >> "$KERNEL_ENV" && test -f ok.txt')
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
    expect(ws.status).toBe('failed')
    expect(k.env.envFor(ws)).not.toHaveProperty('A')
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = 'echo C=3 >> "$KERNEL_ENV"'\n`)
    await trustRoom(k, room.id)
    expect((await k.retrySetup(ws.id)).status).toBe('ready')
    const env = k.env.envFor(k.store.workspace(ws.id)!)
    expect(env).toMatchObject({ C: '3' })
    expect(env).not.toHaveProperty('A')
  })

  it('keeps the file through an archive, and Delete removes it', async () => {
    const { k, room, dataDir } = await roomWith('echo A=1 >> "$KERNEL_ENV"')
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
    const file = setupEnvPath(dataDir, ws.id)
    expect(existsSync(file)).toBe(true)
    await k.archiveWorkspace(ws.id)
    expect(existsSync(file)).toBe(true)
    await k.deleteWorkspaces([ws.id], { deleteUnpushed: true })
    expect(existsSync(file)).toBe(false)
  })
})

describe('One database per workspace (KERNEL-449)', () => {
  it("gives setup the workspace's database and Compose names, and fills them into what setup hands on", async () => {
    const { k, room, dataDir } = await roomWith('echo "$KERNEL_WORKSPACE_SLUG|$COMPOSE_PROJECT_NAME" > names.txt && echo DB=app_\\${KERNEL_WORKSPACE_SLUG} >> "$KERNEL_ENV"')
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'Build it', agentId: 'kai', title: 'Build' })
    expect(ws.status).toBe('ready')
    const slug = workspaceSlug(ws)
    expect(await readFile(join(ws.path, 'names.txt'), 'utf8')).toBe(`${slug}|${slug}\n`)
    // The file keeps what setup wrote. Agents get it with the workspace's own name filled in.
    expect(readSetupEnv(setupEnvPath(dataDir, ws.id)).vars).toEqual({ DB: 'app_${KERNEL_WORKSPACE_SLUG}' })
    expect(sessionEnv(k.env.envFor(k.store.workspace(ws.id)!), {})).toMatchObject({ DB: `app_${slug}`, COMPOSE_PROJECT_NAME: slug })
  })

  it('shows the example in the settings file Kernel writes, as comments that change nothing', () => {
    for (const setup of ['pnpm install', undefined]) {
      const text = defaultRepoSettings(setup)
      expect(parseToml(text)).toEqual(setup ? { files: { copy: ['.env', '.env.local'] }, scripts: { setup } } : { files: { copy: ['.env', '.env.local'] } })
      expect(text).toContain(`#   setup = "${setup ?? 'pnpm install'} && createdb $KERNEL_WORKSPACE_SLUG"`)
      expect(text).toContain('#   archive = "dropdb --if-exists $KERNEL_WORKSPACE_SLUG"')
      expect(text).toContain('#   DATABASE_URL=postgres://localhost:5432/${KERNEL_WORKSPACE_SLUG}')
    }
  })
})

