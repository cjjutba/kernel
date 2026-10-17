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
import { defaultRepoSettings } from '../src/main/services/projects'
import { workspaceSlug } from '../src/shared/kernelVars'
import { setUp, tempRepo, freePort } from './helpers'

// KERNEL-405: setup hands variables to the workspace through $KERNEL_ENV, like GitHub Actions' $GITHUB_ENV.

const sdk = vi.hoisted(() => ({ calls: [] as { options: any; feed: (m: unknown) => void }[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...await original<object>(),
  query: ({ options }: { options: unknown }) => {
    // A turn runs until the test feeds it a result.
    const items: unknown[] = []
    const waiters: ((r: IteratorResult<unknown>) => void)[] = []
    sdk.calls.push({ options, feed: (m) => { const w = waiters.shift(); if (w) w({ value: m, done: false }); else items.push(m) } })
    return {
      [Symbol.asyncIterator]: () => ({ next: () => (items.length ? Promise.resolve({ value: items.shift(), done: false }) : new Promise((resolve) => waiters.push(resolve))) }),
      interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, getContextUsage: async () => ({ percentage: 0 })
    }
  }
}))

const result = { type: 'result', subtype: 'success', uuid: 'r1', duration_ms: 1000, session_id: 's' }

const SETUP = [
  'echo A=1 >> "$KERNEL_ENV"',
  'echo "B=two words" >> "$KERNEL_ENV"',
  'echo KERNEL_PORT=1 >> "$KERNEL_ENV"',
  'echo 1BAD=x >> "$KERNEL_ENV"',
  'echo ANTHROPIC_BASE_URL=http://proxy.invalid >> "$KERNEL_ENV"'
].join(' && ')

async function projectWith(setup: string, wait = true) {
  const repo = await tempRepo({
    'README.md': '# client\n',
    '.claude/agents/kernel.md': '---\nname: kernel\ndescription: Lead.\nlead: true\n---\nYou are Kernel.',
    '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.',
    '.kernel/settings.toml': `[scripts]\nsetup = '${setup}'\nrun = 'echo "$A $B $KERNEL_PORT $KERNEL_BRANCH" > run.txt'\n`
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), team: { leadMode: 'build' }, worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main', leadWaitForSetup: wait } }))
  const k = new Kernel({ dataDir, home })
  k.signedInReader = async () => true
  await k.start()
  onTestFinished(() => k.stop({ budgetMs: 0 }))
  const r = await k.addProject(repo)
  return { k, project: r, repo, dataDir }
}

describe('$KERNEL_ENV (KERNEL-405)', () => {
  it("hands setup's variables to Kernel's session, a run script and a terminal, and Kernel's own names keep Kernel's values", async () => {
    const { k, project, dataDir } = await projectWith(`sleep 1 && ${SETUP}`, false)
    const lines: string[] = []
    const on = (e: PushEvent) => { if (e.type === 'script.output' && e.kind === 'setup') lines.push(...e.lines.map((l) => l.line)) }
    bus.on('push', on)
    onTestFinished(() => { bus.off('push', on) })
    sdk.calls.length = 0
    const chat = await k.lead.startLeadChat(project.id, { prompt: 'Plan it' })
    // Kernel's sessions, not the one-turn call that names the chat.
    const inWs = () => sdk.calls.filter((c) => c.options.cwd === k.store.workspace(chat.workspaceId)!.path && c.options.mcpServers)
    // Kernel's first message goes at once, before setup hands anything over (KERNEL-490).
    await vi.waitFor(() => expect(inWs()).toHaveLength(1))
    expect(inWs()[0].options.env).not.toHaveProperty('A')
    const ws = await setUp(k, chat.id)
    // The setup log names what it handed over, and never a value.
    expect(lines).toContain("Setup set A, ANTHROPIC_BASE_URL, B for this workspace's agents, run scripts and terminals. Skipped 1BAD, KERNEL_PORT: they aren't names Kernel passes on.")
    expect(lines.filter((l) => !l.startsWith('$ ')).join('\n')).not.toContain('two words')
    // Once setup passed, the session ends when its turn does, and the next message starts Kernel with setup's variables.
    inWs()[0].feed(result)
    await vi.waitFor(() => expect(k.sessions['live'].has(chat.id)).toBe(false))
    await k.sessions.send(chat.id, [{ type: 'text', text: 'Go on' }])
    await vi.waitFor(() => expect(inWs()).toHaveLength(2))
    // Kernel's session, in its Bash.
    const env = inWs()[1].options.env as Record<string, string>
    expect(env).toMatchObject({ A: '1', B: 'two words', KERNEL_PORT: String(ws.port), KERNEL_WORKSPACE_NAME: ws.name, KERNEL_BRANCH: ws.branch, KERNEL_BASE_REF: ws.baseRef, KERNEL_DEFAULT_BRANCH: 'main' })
    expect(env).not.toHaveProperty('1BAD')
    expect(env.ANTHROPIC_BASE_URL).not.toBe('http://proxy.invalid')
    expect(env).not.toHaveProperty('KERNEL_ENV')
    // A terminal gets what a session gets.
    expect(sessionEnv(k.env.envFor(ws), {})).toMatchObject({ A: '1', B: 'two words', KERNEL_PORT: String(ws.port) })
    // A run script.
    await k.handlers()['scripts.run']({ workspaceId: ws.id, kind: 'run' })
    await vi.waitFor(async () => expect(await readFile(join(ws.path, 'run.txt'), 'utf8')).toBe(`1 two words ${ws.port} ${ws.branch}\n`))
    // Scripts get every layer whole, as with the project's variables (KERNEL-247). Sessions and terminals drop ANTHROPIC_* from it.
    expect(readSetupEnv(setupEnvPath(dataDir, ws.id))).toEqual({ vars: { A: '1', ANTHROPIC_BASE_URL: 'http://proxy.invalid', B: 'two words' }, dropped: ['1BAD', 'KERNEL_PORT'] })
    expect(sessionEnv(k.env.envFor(ws), {}).ANTHROPIC_BASE_URL).not.toBe('http://proxy.invalid')
  })

  it("passes nothing on until setup passed, or from a failed setup, and Run again writes the file over", async () => {
    const { k, project, repo } = await projectWith('echo A=1 >> "$KERNEL_ENV" && test -f ok.txt')
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Build' })
    expect(ws.status).toBe('failed')
    expect(k.env.envFor(ws)).not.toHaveProperty('A')
    await writeFile(join(repo, '.kernel', 'settings.toml'), `[scripts]\nsetup = 'echo C=3 >> "$KERNEL_ENV"'\n`)
    expect((await k.retrySetup(ws.id)).status).toBe('ready')
    const env = k.env.envFor(k.store.workspace(ws.id)!)
    expect(env).toMatchObject({ C: '3' })
    expect(env).not.toHaveProperty('A')
  })

  it('keeps the file through an archive, and Delete removes it', async () => {
    const { k, project, dataDir } = await projectWith('echo A=1 >> "$KERNEL_ENV"')
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Build' })
    const file = setupEnvPath(dataDir, ws.id)
    expect(existsSync(file)).toBe(true)
    await k.archiveWorkspace(ws.id)
    await k.archive.cleanedUp(ws.id)
    expect(existsSync(file)).toBe(true)
    await k.deleteWorkspaces([ws.id], { deleteUnpushed: true })
    expect(existsSync(file)).toBe(false)
  })
})

describe('One database per workspace (KERNEL-449)', () => {
  it("gives setup the workspace's database and Compose names, and fills them into what setup hands on", async () => {
    // As when Kernel runs inside a Kernel workspace: the parent's names are in the Mac's environment, and lose (KERNEL-710).
    vi.stubEnv('KERNEL_WORKSPACE_SLUG', 'kernel_9d0ef99c6011')
    vi.stubEnv('COMPOSE_PROJECT_NAME', 'kernel_9d0ef99c6011')
    vi.stubEnv('DB', 'app_kernel_9d0ef99c6011')
    onTestFinished(() => { vi.unstubAllEnvs() })
    const { k, project, dataDir } = await projectWith('echo "$KERNEL_WORKSPACE_SLUG|$COMPOSE_PROJECT_NAME" > names.txt && echo DB=app_\\${KERNEL_WORKSPACE_SLUG} >> "$KERNEL_ENV"')
    k.sessions.send = async () => ({ queued: false })
    const ws = await k.workspaces.createWorkspace(project.id, { prompt: 'Build it', agentId: 'christian', title: 'Build' })
    expect(ws.status).toBe('ready')
    const slug = workspaceSlug(ws)
    expect(await readFile(join(ws.path, 'names.txt'), 'utf8')).toBe(`${slug}|${slug}\n`)
    // The file keeps what setup wrote. Agents get it with the workspace's own name filled in.
    expect(readSetupEnv(setupEnvPath(dataDir, ws.id)).vars).toEqual({ DB: 'app_${KERNEL_WORKSPACE_SLUG}' })
    expect(sessionEnv(k.env.envFor(k.store.workspace(ws.id)!), {})).toMatchObject({ DB: `app_${slug}`, COMPOSE_PROJECT_NAME: slug })
  })

  it('shows the example in the settings file Kernel writes, as comments that change nothing', () => {
    for (const install of ['pnpm install', undefined]) {
      const text = defaultRepoSettings(install)
      // No script is live, whether or not Kernel knows the stack (KERNEL-682).
      expect(parseToml(text)).toEqual({ files: { copy: ['.env', '.env.local'] } })
      expect(text).toContain('# setup = "pnpm install"')
      expect(text).toContain(`#   setup = "${install ? `${install} && ` : ''}createdb $KERNEL_WORKSPACE_SLUG"`)
      expect(text).toContain('#   archive = "dropdb --if-exists $KERNEL_WORKSPACE_SLUG"')
      expect(text).toContain('#   DATABASE_URL=postgres://localhost:5432/${KERNEL_WORKSPACE_SLUG}')
    }
  })
})

