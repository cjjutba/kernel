import { appendFile, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { exec } from './exec'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { AppSettings, DeepPartial, PrInstructions, RoomSettings, RoomSettingsPatch } from '@shared/types'
import { effortMemory } from '@shared/effort'

// The shapes live in src/shared/types.ts so the Settings screens can read them (KERNEL-8).
export type { AppSettings }
/** Per-repo settings in .kernel/settings.toml, with personal overrides in .kernel/settings.local.toml. */
export type RepoSettings = RoomSettings

export const DEFAULT_SETTINGS = (home: string): AppSettings => ({
  hookPort: 7420,
  worktreeRoot: join(home, 'kernel', 'worktrees'),
  general: { openTo: 'lastPlace', openAtLogin: false, menuBar: true, sendWith: 'enter' },
  floor: { style: 'isometric', nameTags: true, animate: true },
  appearance: { theme: 'dark', fontSize: 'default', density: 'comfortable', pointerCursors: false, reduceMotion: false },
  notifications: { permission: true, plan: true, merge: true, checkFailed: true, finished: true, idle: false, sound: 'subtle', quietHours: null },
  usage: { warnBeforeWeekly: true, pauseNearLimit: true },
  workspace: { mode: 'worktree', baseRef: 'origin/main', remote: 'origin', branchPattern: '{type}/{task}-{slug}', deleteBranchOnArchive: false, archiveOnMerge: true, setUpstream: true, baselineCurrentBranch: true, oneCurrentBranchPerRoom: true },
  scripts: { setupOnCreate: true, runAfterSetup: false, archiveOnArchive: true },
  models: { lead: 'claude-opus-5-5', engineers: 'claude-sonnet-5-5', qa: 'claude-sonnet-5-5', reviewer: 'claude-opus-5-5', effort: 'high', leadPlanMode: true, agentLimit: 0, agentTeams: true, leadUpdates: true, workspacePlanMode: false, effortByModel: {} },
  team: { addNewAgents: true, showNames: true, defaultTemplate: 'starter' },
  permissions: { mode: 'acceptEdits', network: true, alwaysAsk: ['rm -rf', 'git push --force', 'drizzle-kit push', 'pnpm db:reset'], neverAllow: ['git push origin main'], protectedBranches: ['main', 'dev'], approvalTimeoutSec: 300 },
  pr: {
    mergeMethod: 'squash', draft: false, requireGreen: true, requireReviewer: true,
    createInstructions: '# Create a pull request\n1. Rebase on the base branch and run the test suite.\n2. Title it as a Conventional Commit.\n3. Fill in summary, scope and risk.\n4. Open it with `gh pr create` and print the URL.',
    resolveInstructions: '# Resolve conflicts\n1. Rebase on the base branch.\n2. Keep both sides where they do not overlap.\n3. Re-run tests and typecheck.\n4. Push and summarize what you changed.',
    fixChecksInstructions: '# Fix failing checks\n1. Run `gh pr checks` and read every failure.\n2. Reproduce it locally and fix the cause, not the test.\n3. Run the full suite, push, and summarize the fix.',
    addressReviewInstructions: '# Address review\n1. Make each requested change below. Ask if one is unclear.\n2. Run the tests and push.\n3. Reply to each comment with what changed.'
  },
  hooks: { requireTestOutput: true, keepTeammatesWorking: false },
  experimental: { bigTerminal: true, bigTerminalWorktreeOnly: true, walking: true, floor3d: false, voice: false }
})

export async function loadAppSettings(file: string, home: string): Promise<AppSettings> {
  const defaults = DEFAULT_SETTINGS(home)
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    const s = deepMerge(defaults, saved)
    // openTo replaced homeView. Every launch saved homeView: 'home', so nobody really chose it: only Inbox carries over, the rest open where you left off (D-094).
    // The check reads the file, since the merge above always fills openTo. Dropping homeView makes this run once.
    const old = (s.general as { homeView?: string }).homeView
    if (old !== undefined) {
      if (saved?.general?.openTo === undefined) s.general.openTo = old === 'inbox' ? 'inbox' : 'lastPlace'
      delete (s.general as { homeView?: string }).homeView
    }
    // Every launch saved the old limit's default of 4, so nobody really chose it. agentLimit starts at no limit (D-094).
    delete (s.models as { maxConcurrent?: number }).maxConcurrent
    s.models.effortByModel = effortMemory(s.models.effortByModel)
    // Every launch saved the old default pattern too, so it moves to the new one. A pattern someone typed stays (KERNEL-275).
    if (s.workspace.branchPattern === 'feat/{slug}') s.workspace.branchPattern = defaults.workspace.branchPattern
    return s
  } catch { return defaults }
}

export async function saveAppSettings(file: string, s: AppSettings) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(s, null, 2))
}

/** Merge a patch from Settings and keep the numbers in a range the engine can use. */
export function applySettingsPatch(current: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const next = deepMerge(current, patch)
  const whole = (n: unknown, min: number, max: number, fallback: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n as number))) : fallback)
  next.models.agentLimit = whole(next.models.agentLimit, 0, 12, current.models.agentLimit)
  next.permissions.approvalTimeoutSec = whole(next.permissions.approvalTimeoutSec, 10, 3600, current.permissions.approvalTimeoutSec)
  next.models.effortByModel = effortMemory(next.models.effortByModel)
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

const PR_KEYS = ['createInstructions', 'resolveInstructions', 'fixChecksInstructions', 'addressReviewInstructions'] as const

/** The tables a room's settings files may hold. Anything else in a patch or a file is left alone. */
const GROUPS = ['scripts', 'files', 'workspace', 'disabled', 'linear', 'pr'] as const
type Group = (typeof GROUPS)[number]

/** The keys `table` sets, picked from the file's snake-case names. A key the file doesn't set stays out. */
function picked(table: Record<string, any> | undefined, keys: readonly string[], ok: (v: unknown) => boolean = () => true): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (table?.[snake(k)] !== undefined && ok(table[snake(k)])) out[k] = table[snake(k)]
  return out
}

/** One settings file's values by app-side name, with the same whitelist for both files. */
function roomValues(doc: Record<string, any>): Record<Group, Record<string, unknown>> {
  const isString = (v: unknown) => typeof v === 'string'
  return {
    scripts: picked(doc.scripts, ['setup', 'run', 'archive', 'runMode']),
    files: picked(doc.files, ['copy', 'symlinkNodeModules']),
    workspace: workspaceKeys(doc.workspace) as Record<string, unknown>,
    disabled: Object.fromEntries(Object.entries(picked(doc.disabled, ['skills', 'mcp'])).map(([k, v]) => [k, strings(v)])),
    linear: picked(doc.linear, ['team'], isString),
    pr: picked(doc.pr, PR_KEYS, isString)
  }
}

/**
 * The room's settings: the personal file, then `settings.toml`, key by key, with where each value came from (KERNEL-190).
 * An array is one value, so a `files.copy` both files set is the personal one's and counts as `override`.
 */
export async function loadRepoSettings(repo: string): Promise<RepoSettings> {
  const shared = roomValues(await readToml(repoFile(repo, 'settings.toml')))
  const local = roomValues(await readToml(repoFile(repo, 'settings.local.toml')))
  const merged = {} as Record<Group, Record<string, any>>
  const sources: RoomSettings['sources'] = {}
  for (const g of GROUPS) {
    merged[g] = { ...shared[g], ...local[g] }
    for (const k of Object.keys(merged[g])) sources[`${g}.${k}`] = k in shared[g] && k in local[g] ? 'override' : k in local[g] ? 'local' : 'shared'
  }
  const { scripts, files, workspace, disabled, linear, pr } = merged
  return {
    scripts: { setup: scripts.setup, run: scripts.run, archive: scripts.archive, runMode: scripts.runMode },
    files: { copy: files.copy ?? ['.env', '.env.local'], symlinkNodeModules: files.symlinkNodeModules },
    workspace,
    disabled: { skills: disabled.skills ?? [], mcp: disabled.mcp ?? [] },
    ...(linear.team ? { linear: { team: linear.team } } : {}),
    ...(Object.keys(pr).length ? { pr } : {}),
    sources
  }
}

/**
 * Apply a patch to one of the repo's settings files (`settings.local.toml` unless `shared`) and return what the room now reads.
 * A `null` or an empty string removes the key, so the other file or the app default applies again. The other file is left alone.
 */
export async function saveRepoSettings(repo: string, patch: RoomSettingsPatch, shared = false): Promise<RepoSettings> {
  const file = repoFile(repo, shared ? 'settings.toml' : 'settings.local.toml')
  const doc = await readToml(file)
  const set = (table: string, key: string, value: unknown) => {
    const t = (doc[table] ??= {}) as Record<string, unknown>
    if (value === null || value === undefined || value === '') delete t[key]
    else t[key] = value
    if (!Object.keys(t).length) delete doc[table]
  }
  for (const g of GROUPS) for (const [k, v] of Object.entries(patch[g] ?? {})) set(g, snake(k), v)
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

/** The PR instructions for a room: the room's text per action, else the app's, else the default (KERNEL-190). */
export function prInstructions(app: PrInstructions, room?: Partial<PrInstructions>): PrInstructions {
  const defaults = DEFAULT_SETTINGS('').pr
  const pick = (k: keyof PrInstructions) => [room?.[k], app[k]].find((t) => t?.trim()) ?? defaults[k]
  return { createInstructions: pick('createInstructions'), resolveInstructions: pick('resolveInstructions'), fixChecksInstructions: pick('fixChecksInstructions'), addressReviewInstructions: pick('addressReviewInstructions') }
}

/** The git remote a room fetches from and pushes to: the room's, then the app's, then `origin` (KERNEL-190). */
export const remoteOf = (room: Pick<RoomSettings, 'workspace'>, app: Pick<AppSettings, 'workspace'> | undefined): string =>
  room.workspace.remote?.trim() || app?.workspace.remote?.trim() || 'origin'

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
