import { describe, expect, it } from 'vitest'
import { IDLE_NUDGES, TEST_COMMAND, teamGates } from '../src/main/services/providers/claude'

// KERNEL-537: Settings, Hooks gates for Kernel's own sessions.
const signal = new AbortController().signal
const call = (h: (input: any, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>, input: Record<string, unknown>) => h(input, undefined, { signal })

describe('team gates', () => {
  it('knows a test command', () => {
    for (const c of ['pnpm test', 'pnpm test:changed', 'npm run test', 'cd api && pytest -q', 'go test ./...', 'cargo test', 'npx vitest run', 'yarn test --watch=false', 'python -m pytest', 'xcodebuild -scheme App test', './gradlew test'])
      expect(TEST_COMMAND.test(c), c).toBe(true)
    for (const c of ['git status', 'cat test/a.ts', 'ls tests', 'echo latest', 'pnpm typecheck'])
      expect(TEST_COMMAND.test(c), c).toBe(false)
  })

  it('sends a task back once when no test ran, and lets it through after a test or a second try', async () => {
    const g = teamGates(() => ({ requireTestOutput: true, keepTeammatesWorking: false }))
    expect(await call(g.onTaskCompleted, { task_id: '1', task_subject: 'Add login' })).toMatchObject({ decision: 'block' })
    expect(await call(g.onTaskCompleted, { task_id: '1', task_subject: 'Add login' })).toEqual({})
    expect(await call(g.onTaskCompleted, { task_id: '2' })).toMatchObject({ decision: 'block' })
    await call(g.onBash, { tool_input: { command: 'pnpm test' } })
    expect(await call(g.onTaskCompleted, { task_id: '2' })).toEqual({})
    // The next task needs its own test run.
    expect(await call(g.onTaskCompleted, { task_id: '3' })).toMatchObject({ decision: 'block' })
  })

  it('does nothing with the switches off', async () => {
    const g = teamGates(() => ({ requireTestOutput: false, keepTeammatesWorking: false }))
    await call(g.onTaskCreated, { task_id: '1', task_subject: 'Add login' })
    expect(await call(g.onTaskCompleted, { task_id: '9' })).toEqual({})
    expect(await call(g.onIdle, { teammate_name: 'kai' })).toEqual({})
  })

  it('sends an idle teammate back while tasks are open, a few times at most', async () => {
    const g = teamGates(() => ({ requireTestOutput: false, keepTeammatesWorking: true }))
    expect(await call(g.onIdle, { teammate_name: 'kai' })).toEqual({})
    await call(g.onTaskCreated, { task_id: '1', task_subject: 'Add login' })
    const r = await call(g.onIdle, { teammate_name: 'kai' }) as { decision: string; reason: string }
    expect(r.decision).toBe('block')
    expect(r.reason).toContain('"Add login"')
    for (let i = 1; i < IDLE_NUDGES; i++) expect(await call(g.onIdle, { teammate_name: 'kai' })).toMatchObject({ decision: 'block' })
    expect(await call(g.onIdle, { teammate_name: 'kai' })).toEqual({})
    await call(g.onTaskCompleted, { task_id: '1' })
    expect(await call(g.onIdle, { teammate_name: 'kai' })).toEqual({})
  })
})
