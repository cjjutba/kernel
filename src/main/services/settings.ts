import { appendFile, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { exec } from './exec'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { AppSettings, DeepPartial, RoomSettings, RoomSettingsPatch } from '@shared/types'

// The shapes live in src/shared/types.ts so the Settings screens can read them (KERNEL-8).
export type { AppSettings }
/** Per-repo settings in .kernel/settings.toml, with personal overrides in .kernel/settings.local.toml. */
export type RepoSettings = RoomSettings

export const DEFAULT_SETTINGS = (home: string): AppSettings => ({
  hookPort: 7420,
  worktreeRoot: join(home, 'kernel', 'worktrees'),
  general: { homeView: 'home', openAtLogin: false, menuBar: true, sendWith: 'enter' },
  floor: { style: 'isometric', nameTags: true, animate: true },
  appearance: { theme: 'dark', fontSize: 'default', density: 'comfortable', pointerCursors: false, reduceMotion: false },
  notifications: { permission: true, plan: true, merge: true, checkFailed: true, finished: true, idle: false, sound: 'subtle', quietHours: null },
  usage: { warnBeforeWeekly: true, pauseNearLimit: true },
  workspace: { mode: 'worktree', baseRef: 'origin/main', remote: 'origin', branchPattern: 'feat/{slug}', deleteBranchOnArchive: false, archiveOnMerge: true, setUpstream: true, baselineCurrentBranch: true, oneCurrentBranchPerRoom: true },
  scripts: { setupOnCreate: true, runAfterSetup: false, archiveOnArchive: true },
  models: { lead: 'claude-opus-5-5', engineers: 'claude-sonnet-5-5', qa: 'claude-sonnet-5-5', reviewer: 'claude-opus-5-5', effort: 'high', leadPlanMode: true, maxConcurrent: 4, agentTeams: true, leadUpdates: true, workspacePlanMode: false },
  team: { addNewAgents: true, showNames: true, defaultTemplate: 'starter' },
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

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const repoFile = (repo: string, name: string) => join(repo, '.kernel', name)

async function readToml(file: string): Promise<Record<string, any>> {
  try { return parseToml(await readFile(file, 'utf8')) as Record<string, any> } catch { return {} }
}

/** The room's workspace keys as the app names them (`base_ref` in the file is `baseRef` here). Unknown keys are dropped. */
function workspaceKeys(table: Record<string, any> | undefined): RoomSettings['workspace'] {
  const out: Record<string, unknown> = {}
  const known = Object.keys(DEFAULT_SETTINGS('').workspace)
  for (const [k, v] of Object.entries(table ?? {})) if (known.includes(camel(k))) out[camel(k)] = v
  return out as RoomSettings['workspace']
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export async function loadRepoSettings(repo: string): Promise<RepoSettings> {
  const merged = deepMerge(await readToml(repoFile(repo, 'settings.toml')), await readToml(repoFile(repo, 'settings.local.toml')))
  return {
    scripts: { setup: merged.scripts?.setup, run: merged.scripts?.run, archive: merged.scripts?.archive, runMode: merged.scripts?.run_mode },
    files: { copy: merged.files?.copy ?? ['.env', '.env.local'], symlinkNodeModules: merged.files?.symlink_node_modules },
    workspace: workspaceKeys(merged.workspace),
    disabled: { skills: strings(merged.disabled?.skills), mcp: strings(merged.disabled?.mcp) }
  }
}

/**
 * Apply a patch to one of the repo's settings files (`settings.local.toml` unless `shared`) and return what the room now reads.
 * A `null` or an empty script removes the key, so the app default applies again. The other file is left alone.
 */
export async function saveRepoSettings(repo: string, patch: RoomSettingsPatch, shared = false): Promise<RepoSettings> {
  const file = repoFile(repo, shared ? 'settings.toml' : 'settings.local.toml')
  const doc = await readToml(file)
  const set = (table: string, key: string, value: unknown) => {
    const t = (doc[table] ??= {}) as Record<string, unknown>
    if (value === null || value === undefined || (table === 'scripts' && value === '')) delete t[key]
    else t[key] = value
    if (!Object.keys(t).length) delete doc[table]
  }
  for (const [k, v] of Object.entries(patch.scripts ?? {})) set('scripts', snake(k), v)
  for (const [k, v] of Object.entries(patch.files ?? {})) set('files', snake(k), v)
  for (const [k, v] of Object.entries(patch.workspace ?? {})) set('workspace', snake(k), v)
  for (const [k, v] of Object.entries(patch.disabled ?? {})) set('disabled', k, v)
  // Nothing left to override locally: no file, rather than an empty one that shows up as a change (KERNEL-69).
  if (!shared && !Object.keys(doc).length) {
    await rm(file, { force: true })
    return loadRepoSettings(repo)
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, stringifyToml(doc) + '\n')
  if (!shared) await ignoreLocalSettings(repo)
  return loadRepoSettings(repo)
}

const LOCAL_SETTINGS = '.kernel/settings.local.toml'

/**
 * Keeps the personal settings file out of git. When the repo's ignore rules don't cover it, it goes in the repo's
 * `info/exclude`, which every worktree shares and no commit carries (KERNEL-69, the same way as `linkNodeModules`).
 * A repo whose `.gitignore` already covers it, or a folder that isn't a git repo, is left alone.
 */
export const ignoreLocalSettings = (repo: string) => excludeFromGit(repo, LOCAL_SETTINGS)

/** The same for any repo-relative path. A folder ends in `/`, like `.kernel/plans/`. */
export async function excludeFromGit(repo: string, entry: string): Promise<void> {
  if ((await exec('git', ['-C', repo, 'check-ignore', '-q', entry])).code !== 1) return
  const path = await exec('git', ['-C', repo, 'rev-parse', '--git-path', 'info/exclude'])
  if (path.code !== 0) return
  const exclude = resolve(repo, path.stdout.trim())
  await mkdir(dirname(exclude), { recursive: true })
  const text = await readFile(exclude, 'utf8').catch(() => '')
  await appendFile(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/${entry}\n`)
}

export function deepMerge<T>(base: T, over: any): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (over ?? base) as T
  const out: any = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? deepMerge((base as any)[k] ?? {}, v) : v
  return out
}
