import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { AppSettings, DeepPartial, RoomSettings } from '@shared/types'

// The shapes live in src/shared/types.ts so the Settings screens can read them (KERNEL-8).
export type { AppSettings }
/** Per-repo settings in .kernel/settings.toml, with personal overrides in .kernel/settings.local.toml. */
export type RepoSettings = RoomSettings

export const DEFAULT_SETTINGS = (home: string): AppSettings => ({
  hookPort: 7420,
  worktreeRoot: join(home, 'kernel', 'worktrees'),
  general: { homeView: 'home', openAtLogin: true, menuBar: true, sendWith: 'enter' },
  floor: { style: 'isometric', nameTags: true, animate: true },
  appearance: { theme: 'dark', fontSize: 'default', density: 'comfortable', pointerCursors: false, reduceMotion: false },
  notifications: { permission: true, plan: true, merge: true, checkFailed: true, finished: true, idle: false, sound: 'subtle', quietHours: null },
  usage: { warnBeforeWeekly: true, pauseNearLimit: true },
  workspace: { mode: 'worktree', baseRef: 'origin/main', remote: 'origin', branchPattern: 'feat/{slug}', deleteBranchOnArchive: false, archiveOnMerge: true, setUpstream: true, baselineCurrentBranch: true, oneCurrentBranchPerRoom: true },
  scripts: { setupOnCreate: true, runAfterSetup: false, archiveOnArchive: true },
  models: { lead: 'claude-opus-5-5', engineers: 'claude-sonnet-5-5', qa: 'claude-sonnet-5-5', reviewer: 'claude-opus-5-5', effort: 'high', leadPlanMode: true, maxConcurrent: 4, agentTeams: true },
  team: { addNewAgents: true, showNames: true },
  permissions: { mode: 'acceptEdits', network: true, alwaysAsk: ['rm -rf', 'git push --force', 'drizzle-kit push', 'pnpm db:reset'], neverAllow: ['git push origin main'], protectedBranches: ['main', 'dev'], approvalTimeoutSec: 300 },
  pr: {
    mergeMethod: 'squash', draft: false, requireGreen: true, requireReviewer: true,
    createInstructions: '# Create a pull request\n1. Rebase on the base branch and run the test suite.\n2. Title it as a Conventional Commit.\n3. Fill in summary, scope and risk.\n4. Open it with `gh pr create` and print the URL.',
    resolveInstructions: '# Resolve conflicts\n1. Rebase on the base branch.\n2. Keep both sides where they do not overlap.\n3. Re-run tests and typecheck.\n4. Push and summarize what you changed.'
  },
  hooks: { requireTestOutput: true, keepTeammatesWorking: false },
  experimental: { bigTerminal: true, bigTerminalWorktreeOnly: true, walking: true, floor3d: false, voice: false }
})

export async function loadAppSettings(file: string, home: string): Promise<AppSettings> {
  const defaults = DEFAULT_SETTINGS(home)
  try { return deepMerge(defaults, JSON.parse(await readFile(file, 'utf8'))) } catch { return defaults }
}

export async function saveAppSettings(file: string, s: AppSettings) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(s, null, 2))
}

/** Merge a patch from Settings and keep the numbers in a range the engine can use. */
export function applySettingsPatch(current: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const next = deepMerge(current, patch)
  const whole = (n: unknown, min: number, max: number, fallback: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n as number))) : fallback)
  next.models.maxConcurrent = whole(next.models.maxConcurrent, 1, 12, current.models.maxConcurrent)
  next.permissions.approvalTimeoutSec = whole(next.permissions.approvalTimeoutSec, 10, 3600, current.permissions.approvalTimeoutSec)
  return next
}

export async function loadRepoSettings(repo: string): Promise<RepoSettings> {
  const read = async (name: string) => { try { return parseToml(await readFile(join(repo, '.kernel', name), 'utf8')) as Record<string, any> } catch { return {} } }
  const merged = deepMerge(await read('settings.toml'), await read('settings.local.toml'))
  return {
    scripts: { setup: merged.scripts?.setup, run: merged.scripts?.run, archive: merged.scripts?.archive, runMode: merged.scripts?.run_mode },
    files: { copy: merged.files?.copy ?? ['.env', '.env.local'] },
    workspace: { baseRef: merged.workspace?.base_ref, branchPattern: merged.workspace?.branch_pattern, mode: merged.workspace?.mode }
  }
}

export function deepMerge<T>(base: T, over: any): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (over ?? base) as T
  const out: any = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? deepMerge((base as any)[k] ?? {}, v) : v
  return out
}
