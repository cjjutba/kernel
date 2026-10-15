import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, trustProject, freePort } from './helpers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import type { PushEvent } from '../src/shared/ipc'

// KERNEL-256: the integration pass on project settings and the Conductor features. These cover the paths no other suite reaches.

vi.mock('../src/renderer/src/api', () => ({ call: vi.fn() }))
process.env.SHELL = '/bin/sh'

const kai = { 'README.md': '# demo\n', '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend.\n---\nKai.' }
const events: PushEvent[] = []
bus.on('push', (e) => { if (e.type === 'script.output') events.push(e) })
const kernels: Kernel[] = []
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop()
  events.length = 0
})

async function kernelWith(...tomls: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
  const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
  const k = new Kernel({ dataDir, home })
  await k.start()
  kernels.push(k)
  k.sessions.send = async () => ({ queued: false })
  const projects = []
  for (const toml of tomls) {
    const project = await k.addProject(await tempRepo({ ...kai, '.kernel/settings.toml': toml }))
    await trustProject(k, project.id)
    projects.push(project)
  }
  return { k, h: k.handlers(), projects, dataDir }
}

const until = async (ok: () => boolean, what: string, ms = 15000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('two projects keep their own scripts', () => {
  it('reads, saves and runs each project\'s scripts without touching the other', async () => {
    const { k, h, projects: [a, b] } = await kernelWith(
      '[scripts]\nrun = "echo project-a-$KERNEL_PORT"\n',
      '[scripts]\nrun = "echo project-b-$KERNEL_PORT"\n\n[run_scripts]\nweb = "echo web-b"\n'
    )
    expect((await h['settings.project']({ projectId: a.id })).scripts.run).toBe('echo project-a-$KERNEL_PORT')
    expect((await h['settings.project']({ projectId: b.id })).scripts.run).toBe('echo project-b-$KERNEL_PORT')

    // A personal change in project A stays in project A.
    await h['settings.setProject']({ projectId: a.id, patch: { scripts: { run: 'echo mine-a' } } })
    expect((await h['settings.project']({ projectId: a.id })).scripts.run).toBe('echo mine-a')
    const untouched = await h['settings.project']({ projectId: b.id })
    expect(untouched.scripts.run).toBe('echo project-b-$KERNEL_PORT')
    expect(untouched.sources['scripts.run']).toBe('shared')

    // Each project's workspace runs its own project's script.
    const wsA = await k.createWorkspace(a.id, { prompt: 'a', agentId: 'kai', title: 'A' })
    const wsB = await k.createWorkspace(b.id, { prompt: 'b', agentId: 'kai', title: 'B' })
    await h['scripts.run']({ workspaceId: wsA.id, kind: 'run' })
    await h['scripts.run']({ workspaceId: wsB.id, kind: 'run' })
    const said = (id: string, line: string) => events.some((e) => e.type === 'script.output' && e.workspaceId === id && e.lines.some((l) => l.line === line))
    await until(() => said(wsA.id, 'mine-a') && said(wsB.id, `project-b-${wsB.port}`), 'both projects to print their own line')
    expect(events.some((e) => e.type === 'script.output' && e.workspaceId === wsA.id && e.lines.some((l) => l.line.startsWith('project-b')))).toBe(false)
    expect(events.some((e) => e.type === 'script.output' && e.workspaceId === wsB.id && e.lines.some((l) => l.line === 'mine-a'))).toBe(false)
  })
})

describe('a personal override in a project', () => {
  it('is Changed for this project while it differs, and Reset brings back the shared value', async () => {
    const { isOverride } = await import('../src/renderer/src/screens/settings/kit')
    const { h, projects: [project] } = await kernelWith('[scripts]\nsetup = "pnpm install"\n')
    const path = 'scripts.setup'
    expect(isOverride(await h['settings.project']({ projectId: project.id }), path)).toBe(false)

    const overridden = await h['settings.setProject']({ projectId: project.id, patch: { scripts: { setup: 'npm ci' } } })
    expect(overridden.scripts.setup).toBe('npm ci')
    expect(isOverride(overridden, path)).toBe(true)

    // Reset is a null on the personal file.
    const reset = await h['settings.setProject']({ projectId: project.id, patch: { scripts: { setup: null } } })
    expect(reset.scripts.setup).toBe('pnpm install')
    expect(isOverride(reset, path)).toBe(false)
  })

  it('shows the app value and where it is set for a project that sets nothing, and no row state without a project', async () => {
    const { projectValue } = await import('../src/renderer/src/screens/settings/kit')
    const from = { to: { page: 'git' as const }, label: 'Settings, Git' }
    expect(projectValue(null, 'workspace.mode', () => undefined, from)).toEqual({ inherited: from })
    expect(projectValue(null, 'scripts.setup', () => undefined)).toEqual({})
    const reset = () => undefined
    expect(projectValue({ sources: { 'workspace.mode': 'local' } } as never, 'workspace.mode', reset, from)).toEqual({ changed: true, onReset: reset })
    expect(projectValue({ sources: { 'workspace.mode': 'override' } } as never, 'workspace.mode', reset, from)).toEqual({ changed: true, onReset: reset })
  })

  it('reads a value from settings.toml as changed for the project, never as the app default, and offers no Reset for it', async () => {
    const { projectValue } = await import('../src/renderer/src/screens/settings/kit')
    const from = { to: { page: 'prs' as const }, label: 'Settings, Pull requests' }
    expect(projectValue({ sources: { 'pr.mergeMethod': 'shared' } } as never, 'pr.mergeMethod', () => undefined, from)).toEqual({ changed: true })
  })
})
