import type { AccountProfile, AgentDef, AppSettings, RoleModel, Role, AppUpdate, ChatItem, DevUiPage, HookProblem, HookStatus, Integration, McpAccount, McpAccountServer, McpServer, McpSignInAll, Modal, PreflightCheck, Provider, ProviderModel, PushCheck, RateLimit, Project, ProjectSettings, ProjectSettingsSection, ScriptLine, SettingsPage, Skill, TerminalPreset, Toast } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { mcpCounts } from '@shared/mcpCounts'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import type { Fixture } from './types'
import { teamFixtures } from './team'
import { along, leadAlong, SETUP_RAW, setupData, workspaceFixtures } from './workspace'
import { at, base, ids, invaderIcon, scene, tableItems, withWorkspace } from './base'

// Platform lane: setup checks (KERNEL-27), limits and setup failures (KERNEL-28).
// Check copy matches src/main/services/preflight.ts.

// The checks show above New chat's box with no project (KERNEL-942), so a failing check is drawn there.
const onboarding = { route: { name: 'leadNew', projectId: '' }, workspace: { right: 'changes', bottom: 'run' } } as const
const open = { route: { name: 'workspace', workspaceId: ids.table } } as const
const empty = { projects: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [] }

// The checks, in canvas order. Copy matches src/main/services/preflight.ts.
const claudeOk: PreflightCheck = { id: 'claude', ok: true, blocking: false, title: 'Claude Code', detail: 'Found on your PATH', meta: 'v2.1.284' }
const authOk: PreflightCheck = { id: 'auth', ok: true, blocking: true, title: 'Signed in', detail: 'Claude Max' }
const ghOk: PreflightCheck = { id: 'gh', ok: true, blocking: false, title: 'GitHub CLI', detail: 'Signed in as cjjutba', meta: 'gh 2.62' }
const hooksOk: PreflightCheck = { id: 'hooks', ok: true, blocking: true, title: 'Hook server', detail: 'Listening for events', meta: 'localhost:7420' }
const allOk = [claudeOk, authOk, ghOk, hooksOk]
/** Every check passing except the one at `id`, which is replaced by `failing`. */
const failing = (failed: PreflightCheck) => allOk.map((c) => (c.id === failed.id ? failed : c))
/** Every check passing, the one at `id` with more to say (KERNEL-437). */
const passing = (row: PreflightCheck) => allOk.map((c) => (c.id === row.id ? row : c))

// A launch after setup is done: the failing check is a toast on New chat, and nothing stops the app (KERNEL-1088).
const setup = (checks: PreflightCheck[]) => scene(() => ({ ...empty, preflight: checks, settings: setupDone(), ui: onboarding }))

// First run (KERNEL-1088): the four steps, with the checks the first one lists.
const gitOk: PreflightCheck = { id: 'git', ok: true, blocking: true, title: 'Git', detail: 'Found on your PATH', meta: 'git 2.45' }
const codexOff: PreflightCheck = { id: 'codex', ok: false, blocking: false, title: 'Codex', detail: 'Not set up' }
const stepChecks = (...over: PreflightCheck[]) => [claudeOk, gitOk, authOk, ghOk, hooksOk, codexOff].map((c) => over.find((o) => o.id === c.id) ?? c)
/** Your team as the Pen draws it: Teng left out, Artkin reviews on Opus. */
const teamSettings = (() => { const d = DEFAULT_SETTINGS('/Users/you'); return { ...d, models: { ...d.models, roles: { ...d.models.roles, reviewer: { ...d.models.roles.reviewer, claude: { model: 'claude-opus-5-5', effort: 'high' as const } } } }, onboarding: { done: false, out: ['teng'], reviewer: 'artkin' } } })()
const firstRun = (step: 'checks' | 'accounts' | 'team' | 'loop', extra: Partial<Fixture> = {}, menu?: 'obReviewer' | 'obMode' | 'obModel' | 'obAllowed' | 'obDenied') =>
  scene(() => ({ ...empty, preflight: stepChecks(), telemetry: { canSend: true }, ...extra, ui: { route: { name: 'onboarding', step }, ...(menu ? { menu } : {}) } }))

/** Six running sessions, the count the canvas shows: the seed's chats, topped up with copies. */
const sixRunning = (f: Fixture) => {
  const chats = Array.from({ length: 6 }, (_, i) => f.chats[i] ?? { ...f.chats[0], id: `${f.chats[0].id}-copy-${i}` })
  return { chats: [...f.chats, ...chats.filter((c) => !f.chats.includes(c))], push: chats.map((c) => ({ type: 'chat.running' as const, chatId: c.id, running: true })) }
}

const eventsAgo = (m: number | null) => (m === null ? undefined : Date.now() - m * 60_000)
const hookEvents: HookStatus['events'] = [
  ['SessionStart', 2], ['UserPromptSubmit', 12], ['PreToolUse', 0], ['PostToolUse', 0], ['PermissionRequest', 2], ['Notification', 2], ['Stop', 6], ['TaskCreated', 6], ['TaskCompleted', 18], ['TeammateIdle', null]
].map(([name, m]) => ({ name: name as string, installed: true, lastSeen: eventsAgo(m as number | null) }))

/** Check hooks when the hooks can't be written or can't run (KERNEL-461). The paths, disk and commands are the drawings' examples. */
const hooksProblem = (problem: HookProblem, installed = false) => scene((f) => ({
  ...sixRunning(f),
  hooks: { port: 7420, listening: true, installed, events: hookEvents.map((e) => ({ name: e.name, installed })), problem },
  ui: { route: { name: 'inbox' }, modal: { name: 'checkHooks' } }
}))

/** `resetsAt` is epoch seconds, as rate_limit_event sends it. */
const secs = (ms: number) => Math.round(ms / 1000)
/** The next h:m from now, so a reset is always ahead and within a day ("Resets at 3:40 PM"). */
const next = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime() }
/** Today at `h`:`m`, past or not: when a token account's last turn read its usage. */
const todayAt = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d.getTime() }
/** Christian's next turn on the invoice table, after a move to another account: the note, then three tool calls and the reply (KERNEL-569). */
const afterSwitch = (note: string): ChatItem[] => [
  ...tableItems,
  { kind: 'user', id: 'u-skeleton', ts: at(10, 43), parts: [{ type: 'text', text: 'Also add a loading skeleton.' }] },
  { kind: 'note', id: 'n-account', ts: at(10, 44), text: note },
  ...(['Read table.tsx', 'Edit table.tsx', 'Run unit tests'] as const).map((label, i): ChatItem => ({ kind: 'tool', id: `t-skeleton-${i}`, ts: at(10, 44, 10 + i * 10), toolUseId: `toolu_skeleton_${i}`, name: 'Bash', label, detail: label, status: 'done', durationMs: 100 })),
  { kind: 'text', id: 'x-skeleton', ts: at(10, 44, 40), text: 'Added a loading skeleton to the invoice table and held it for 200ms. The tests still pass.' },
  { kind: 'result', id: 'r-skeleton', ts: at(10, 44, 38), durationMs: 38_000, ok: true }
]
/** The invoice table chat with a change. */
const withChat = (f: Fixture, change: Partial<Fixture['chats'][number]>) => f.chats.map((c) => (c.id === ids.tableChat ? { ...c, ...change } : c))

// KERNEL-9: the component gallery in both themes. the `devUi` route shows it. No design PNG, so no compare.
const gallery = (page: DevUiPage) => scene(() => ({ ...empty, ui: { route: { name: 'devUi', page } } }))

// KERNEL-25: the app-wide settings pages. The seed's projects fill the nav; Account adds the three usage windows the canvas shows.
const settingsPage = (page: SettingsPage, extra: Partial<Fixture> = {}) => scene(() => ({ ...extra, ui: { route: { name: 'settings', page } } }))
/** Settings, About with the updater in one state, and the toasts that state raised (Redesign 15). */
const aboutPage = (update: AppUpdate, toasts: Toast[] = []): Fixture => { const f = settingsPage('about', { preflight: [], update }); return { ...f, ui: { ...f.ui, toasts } } }
/** One of Client A's project pages (KERNEL-191). */
const projectPage = (section: ProjectSettingsSection, extra: Partial<Fixture> = {}, menu?: 'settingsFiles') => scene(() => ({ ...extra, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section }, ...(menu ? { menu } : {}) } }))
/** Settings with some roles moved, the rest as Kernel ships them (KERNEL-406). */
const withRoles = (roles: Partial<Record<Role, RoleModel>>): AppSettings => {
  const d = DEFAULT_SETTINGS('/Users/you')
  const picked = Object.fromEntries(Object.entries(roles).map(([r, m]) => [r, { ...d.models.roles[r as Role], prefer: m.provider, [m.provider]: { model: m.model, effort: m.effort } }]))
  return { ...d, models: { ...d.models, roles: { ...d.models.roles, ...picked } } }
}
/** Settings with some roles' preferred provider or sides moved, the rest as Kernel ships them (KERNEL-1056). */
const withSides = (roles: Partial<Record<Role, Partial<AppSettings['models']['roles'][Role]>>>): AppSettings => {
  const d = DEFAULT_SETTINGS('/Users/you')
  const picked = Object.fromEntries(Object.entries(roles).map(([r, c]) => [r, { ...d.models.roles[r as Role], ...c }]))
  return { ...d, models: { ...d.models, roles: { ...d.models.roles, ...picked } } }
}
/** Codex's models as its model/list answers for a ChatGPT Plus account. */
const codexModels: ProviderModel[] = [
  { provider: 'codex', id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', isDefault: true },
  { provider: 'codex', id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
  { provider: 'codex', id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
  { provider: 'codex', id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }
]
const claudeAccounts: AccountProfile[] = [
  { id: 'cli', provider: 'claude', label: 'cj@example.com', email: 'cj@example.com', plan: 'Claude Max', cli: true, auth: 'subscription', active: true, signedIn: true },
  { id: 'work', provider: 'claude', label: 'Work', plan: 'Claude Team', cli: false, auth: 'subscription', active: false, signedIn: true, usageFromTurns: true }
]
const codexAccounts: AccountProfile[] = [{ id: 'cli', provider: 'codex', label: 'cj@example.com', email: 'cj@example.com', plan: 'ChatGPT Plus', cli: true, auth: 'subscription', active: true, signedIn: true }]
/** An API key account (KERNEL-524): no plan, no email, no usage windows. */
const keyAccount = (provider: Provider, active = false): AccountProfile => ({ id: 'key', provider, label: 'Work key', cli: false, auth: 'apiKey', active, signedIn: true })
const providerStatus: Fixture['providerStatus'] = {
  claude: { provider: 'claude', source: 'bundled', version: '2.1.292', signedIn: true, loginMethod: 'Claude account', plan: 'Claude Max', email: 'cj@example.com', configFile: '/Users/you/.claude/settings.json' },
  codex: { provider: 'codex', source: 'bundled', version: '0.153.4', signedIn: true, loginMethod: 'ChatGPT', plan: 'ChatGPT Plus', email: 'cj@example.com', configFile: '/Users/you/.codex/config.toml' }
}
/** The weekday `day` (0 is Sunday) at `h`:`m`, more than a day ahead, so a reset reads "Monday at 9:00 AM" whatever day the shot is taken. */
const nextOn = (day: number, h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); while (d.getDay() !== day || d.getTime() - Date.now() < 25 * 3600_000) d.setDate(d.getDate() + 1); return d.getTime() }
const subscription = (provider: Provider, id: string, label: string, email: string, plan: string, over: Partial<AccountProfile> = {}): AccountProfile => ({ id, provider, label, email, plan, cli: id === 'cli', auth: 'subscription', active: false, signedIn: true, ...over })
// KERNEL-561: the accounts the canvas draws. Work is Claude Code's own login with a nickname, and Codex's own login has none, so its name is its email.
const workClaude = subscription('claude', 'cli', 'Work', 'cj@example.com', 'Claude Max', { active: true })
const personalClaude = subscription('claude', 'personal', 'Personal', 'cj@jutba.example', 'Claude Pro')
const personalAccount = { signedIn: true, name: 'Sam Rivera', login: 'cjjutba', email: 'cj@jutba.example', plan: 'Claude Pro' }
const ownCodex = subscription('codex', 'cli', 'cj@example.com', 'cj@example.com', 'ChatGPT Plus', { active: true })
const personalCodex = subscription('codex', 'personal', 'Personal', 'cj@jutba.example', 'ChatGPT Pro')
const window5 = (provider: Provider, accountId: string, pct: number, resetsAt: number, readAt?: number): RateLimit => ({ type: 'five_hour', status: 'allowed', utilization: pct / 100, resetsAt: secs(resetsAt), ...(provider === 'codex' ? { provider } : {}), ...(accountId === 'cli' ? {} : { accountId }), ...(readAt ? { readAt } : {}) })
const windowWeek = (provider: Provider, accountId: string, pct: number, resetsAt: number, readAt?: number): RateLimit => ({ ...window5(provider, accountId, pct, resetsAt, readAt), type: 'seven_day' })
const providerUsage = (readAt?: number): RateLimit[] => [
  window5('claude', 'cli', 62, next(15, 40)), windowWeek('claude', 'cli', 38, nextOn(1, 9, 0)),
  window5('claude', 'personal', 8, next(17, 10), readAt), windowWeek('claude', 'personal', 14, nextOn(3, 18, 0), readAt),
  window5('codex', 'cli', 7, next(16, 15)), windowWeek('codex', 'cli', 21, nextOn(4, 8, 0)),
  window5('codex', 'personal', 3, next(18, 20)), windowWeek('codex', 'personal', 9, nextOn(5, 8, 0))
]
const richAccounts: AccountProfile[] = [workClaude, personalClaude, keyAccount('claude'), ownCodex, personalCodex, keyAccount('codex')]
/** Work's own login has Fable's weekly window at 90% beside its 5-hour and weekly ones (KERNEL-619). */
/** Reset times for the footer canvases: a clock time today, Monday for Claude's weekly window, and more than a week out for Codex's. */
const inDays = (days: number, h: number, m: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.getTime() }
// KERNEL-674, KERNEL-1101: the accounts the footer canvases draw (Pen 14.1 to 14.6). Main account is Claude Code's own login and the one in use, with 2nd account, 3rd account and an API key beside it. Codex runs on its own login.
const mainClaude = subscription('claude', 'cli', 'Main account', 'you@example.com', 'Claude Max', { active: true })
const secondClaude = subscription('claude', 'second', '2nd account', 'second@example.com', 'Claude Pro')
const thirdClaude = subscription('claude', 'third', '3rd account', 'third@example.com', 'Claude Pro')
const workClaudeAccount = subscription('claude', 'work', 'Work account', 'work@example.com', 'Claude Max')
const footerKey = (active = false): AccountProfile => ({ id: 'key', provider: 'claude', label: 'API Key', cli: false, auth: 'apiKey', active, signedIn: true })
const footerCodex = subscription('codex', 'cli', 'you@example.com', 'you@example.com', 'ChatGPT Plus', { active: true })
const footerAccounts = [mainClaude, secondClaude, thirdClaude, footerKey(), footerCodex]
/** Main account reports a Fable window at 0%, 2nd account reports 5-hour and weekly, and 3rd account only its weekly window, at 96%. The knobs are Codex's 5-hour, Main's 5-hour and Main's weekly use. */
const footerUsage = (codex5 = 12, claude5 = 11, claudeWeek = 58): RateLimit[] => [
  window5('claude', 'cli', claude5, next(20, 20)), windowWeek('claude', 'cli', claudeWeek, nextOn(4, 3, 0)),
  { type: 'seven_day_overage_included', status: 'allowed', utilization: 0, resetsAt: secs(nextOn(4, 3, 0)) },
  window5('claude', 'second', 36, next(22, 0)), windowWeek('claude', 'second', 53, nextOn(2, 3, 0)),
  windowWeek('claude', 'third', 96, nextOn(3, 3, 0)),
  window5('codex', 'cli', codex5, next(19, 5)), windowWeek('codex', 'cli', 31, nextOn(1, 3, 0))
]
/** Main account near its weekly limit and Codex's 5-hour window full: the footer icon is red (Pen 14.1 and 14.2). */
const hotUsage = () => footerUsage(100, 11, 90)
/** Claude Code with a fourth subscription, for the popover that lists many accounts. */
const manyAccounts = [mainClaude, secondClaude, thirdClaude, workClaudeAccount, footerKey(), footerCodex]
const manyUsage = (): RateLimit[] => [
  ...footerUsage().filter((l) => !(l.accountId === 'second' || l.accountId === 'third')),
  window5('claude', 'second', 36, next(22, 0)), windowWeek('claude', 'second', 63, nextOn(2, 3, 0)),
  window5('claude', 'third', 0, next(22, 30)), windowWeek('claude', 'third', 12, nextOn(3, 3, 0)),
  window5('claude', 'work', 4, next(21, 0)), windowWeek('claude', 'work', 22, nextOn(4, 3, 0))
]
/** The home screen with an update ready, so the footer has its pill, and the Claude Code and Codex accounts above (KERNEL-674). */
const usageHome = (extra: Partial<Fixture> = {}, ui: Partial<Fixture['ui']> = {}): Fixture => ({
  ...teamFixtures.UpdateReady, accounts: footerAccounts, usage: footerUsage(), ...extra, ui: { ...teamFixtures.UpdateReady.ui, ...ui }
})
/** The footer after a switch: the accounts push comes first, as it does from the engine, so the notice can name both accounts (KERNEL-699). */
const switchedHome = (accounts: AccountProfile[], switched: PushEvent): Fixture => usageHome({ accounts, push: [{ type: 'accounts', accounts }, switched] })
/** The popover open over the same home, in Detailed unless `view` says Compact. */
const usagePopover = (extra: Partial<Fixture> = {}, ui: Partial<Fixture['ui']> = {}): Fixture => usageHome(extra, { menu: 'plan', ...ui })
// Redesign 15 (Pen 15.4): Main account is Claude Code's own login, in use with two chats on it, beside a 2nd account and an API key, and Codex runs on its own login.
const pageMain: AccountProfile = { ...mainClaude, chats: 2, mcpSignIns: [] }
const pageSecond: AccountProfile = { ...secondClaude, mcpSignIns: [] }
const pageAccounts: AccountProfile[] = [pageMain, pageSecond, footerKey(), footerCodex]
const pageUsage = (): RateLimit[] => [
  window5('claude', 'cli', 11, next(20, 20)), windowWeek('claude', 'cli', 90, nextOn(4, 3, 0)),
  { type: 'seven_day_overage_included', status: 'allowed', utilization: 0, resetsAt: secs(nextOn(4, 3, 0)) },
  window5('claude', 'second', 36, next(19, 5)), windowWeek('claude', 'second', 53, nextOn(5, 9, 0)),
  window5('codex', 'cli', 12, next(19, 5)), windowWeek('codex', 'cli', 31, nextOn(1, 3, 0))
]
/** Settings, Accounts with each account's nickname, plan and usage windows (KERNEL-561, KERNEL-680). `tab` scrolls to that provider. */
const providersPage = (tab: Provider, extra: Partial<Fixture> = {}) => scene(() => ({
  accounts: pageAccounts,
  providerStatus,
  usage: pageUsage(),
  ...extra,
  ui: { route: { name: 'settings', page: 'accounts', tab }, ...extra.ui }
}))
/** Main account, the account in use, hit its 5-hour limit and is near its weekly one, with switching off: the row says At limit and the meters turn red and amber (Pen 15.31). */
const limitUsage = (): RateLimit[] => [
  { ...window5('claude', 'cli', 100, next(20, 20)), status: 'rejected' }, windowWeek('claude', 'cli', 91, nextOn(4, 3, 0)),
  window5('claude', 'second', 36, next(19, 5)), windowWeek('claude', 'second', 53, nextOn(5, 9, 0)),
  window5('codex', 'cli', 12, next(19, 5)), windowWeek('codex', 'cli', 31, nextOn(1, 3, 0))
]
/** Both Claude subscriptions at their weekly limit, so the page says Claude Code is on hold and offers the API key (KERNEL-1043). */
const holdUsage = (): RateLimit[] => [
  window5('claude', 'cli', 3, next(20, 20)), { ...windowWeek('claude', 'cli', 100, nextOn(4, 3, 0)), status: 'rejected' },
  window5('claude', 'second', 12, next(19, 5)), { ...windowWeek('claude', 'second', 100, nextOn(5, 9, 0)), status: 'rejected' },
  window5('codex', 'cli', 12, next(19, 5)), windowWeek('codex', 'cli', 31, nextOn(1, 3, 0))
]
const noSwitching = { ...DEFAULT_SETTINGS('/Users/you'), accounts: { ...DEFAULT_SETTINGS('/Users/you').accounts, switchAtLimit: { claude: false, codex: false } } }
const limitPage = () => providersPage('claude', { usage: limitUsage(), settings: noSwitching })
/** A switch to 2nd account that has started and is waiting on its call (Pen 15.31, A switch waits for running turns). */
const holdPage = () => providersPage('claude', { ui: { route: { name: 'settings', page: 'accounts', tab: 'claude' }, switching: { provider: 'claude', accountId: 'second' } } })
/** The Add account sheet is opened from the page's button, and a sign-in that waits on the browser is the engine's `account.add` step. */
const addAccountPage = (tab: Provider, waiting = false) => providersPage(tab, waiting ? { push: [{ type: 'account.add', add: { provider: tab, step: 'browser', url: tab === 'claude' ? 'https://claude.ai/oauth/authorize' : 'https://auth.openai.com/oauth/authorize' } }] } : {})

// KERNEL-26, KERNEL-191: the project pages read their own project's .kernel files, so the fixture gives Client A the values the canvas shows.
// `sources` says which file set what: both files are there, so the settings files button offers both.
const kernelFiles: ProjectSettings = {
  scripts: { setup: 'pnpm install\ncp ../../.env.local .env.local', run: 'pnpm dev --port $KERNEL_PORT', archive: 'docker compose down', runMode: 'concurrent' },
  runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }],
  files: { copy: ['.env.local', '.env.test', 'certs/*.pem'], symlinkNodeModules: false },
  workspace: { baseRef: 'origin/dev' },
  disabled: { skills: [], mcp: ['Figma'] },
  pr: { createInstructions: '# Create a pull request\n1. Rebase on origin/dev and run pnpm test\n2. Title it as a Conventional Commit\n3. Fill in summary, scope and risk\n4. Link the Linear issue in the description' },
  preview: { urls: [] },
  env: { files: [] },
  references: [],
  sources: { 'scripts.setup': 'shared', 'scripts.run': 'override', 'files.copy': 'shared', 'workspace.baseRef': 'override', 'pr.createInstructions': 'override' }
}
const fiscSetup = [
  'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"',
  'pnpm install --frozen-lockfile',
  'cp "$KERNEL_ROOT_PATH/.env" .env',
  'cp "$KERNEL_ROOT_PATH/src/backend/.env" src/backend/.env',
  'cp "$KERNEL_ROOT_PATH/src/frontend/.env" src/frontend/.env',
  '# Best-effort: make the copied .env self-consistent with this workspace\'s ports. The run',
  '# scripts inject the ports at run time regardless, so skip quietly if the (committed) script',
  '# is absent on this branch instead of failing setup.',
  '[ -f scripts/setup-worktree-env.sh ] && bash scripts/setup-worktree-env.sh || true',
  'pnpm --filter @fiscplus/realtime build',
  'pnpm --filter backend exec prisma generate',
  ''
].join('\n')
const clientA = (extra: Partial<ProjectSettings> = {}) => ({ projectSettings: { [ids.projectA]: { ...kernelFiles, ...extra } } })
/**
 * Client A's push check (KERNEL-460): both rows pass, gh can push but git isn't using its login, or origin is out of reach.
 * Checked two minutes before the shot, or just now for the unreachable one, as the drawings say.
 */
const pushCheck = (state: 'ok' | 'failed' | 'unreachable'): Pick<Fixture, 'pushChecks'> => {
  const check: PushCheck = {
    remote: 'origin', repo: 'cjjutba/client-a', login: 'cjjutba', at: Date.now() - (state === 'unreachable' ? 0 : 2 * 60_000),
    reach: { state: 'ok', detail: 'git ls-remote origin' },
    push: state === 'failed'
      ? { state: 'fail', detail: 'gh is signed in as cjjutba, but git isn\u2019t using that login.', fix: 'gh auth setup-git' }
      : { state: 'ok', detail: 'From gh, signed in as cjjutba' }
  }
  if (state === 'unreachable') {
    check.reach = { state: 'fail', detail: 'git ls-remote origin', output: 'fatal: unable to access \'https://github.com/cjjutba/client-a.git/\': Could not resolve host: github.com', note: 'Check your connection or VPN, then check again.' }
    check.push = { state: 'unchecked', detail: 'Needs a reachable remote' }
  }
  return { pushChecks: { [ids.projectA]: check } }
}
/** Client A's Environment page: two variables and two env files from its personal file, `src/backend/.env` missing. */
const envFiles = ['.env', 'src/backend/.env']
const envProjectA: Partial<Fixture> = {
  ...clientA({ env: { files: envFiles }, sources: { ...kernelFiles.sources, 'env.files': 'local' } }),
  env: { projects: { [ids.projectA]: { names: ['DATABASE_URL', 'STRIPE_SECRET_KEY'], files: envFiles.map((path) => ({ path, missing: path.startsWith('src/') })) } } }
}
const prSettings = { ...DEFAULT_SETTINGS('/Users/you'), pr: { ...DEFAULT_SETTINGS('/Users/you').pr, autoMerge: { on: false, maxLines: 400, alwaysReview: ['src/main/db.ts', 'electron-builder.yml'], withoutReview: false }, fixChecksInstructions: '# Fix failing checks\n1. Read the failing job log\n2. Fix the cause, not the test\n3. Push and wait for the checks' } }
/** What approvals saved with Always allow in this project. The gh one is long enough to clamp to two lines. */
const projectRules = [
  'pnpm test', 'pnpm typecheck',
  'gh pr view --json number,title,state,statusCheckRollup,reviewDecision,mergeable,headRefName,baseRefName',
  'git log --oneline origin/main..HEAD',
  'mkdir .k109-scratch && git init -q -b main .k109-scratch/r && git -C .k109-scratch/r -c user.email=t@t -c user.name=t commit -q --allow-empty -m i && git -C .k109-scratch/r worktree add ../w feat-a && ls .k109-scratch',
  'rm -rf node_modules site/node_modules && pnpm install --frozen-lockfile 2>&1 | grep -E "Done|completed installing"; pnpm -C site install --frozen-lockfile 2>&1 | grep -E "Done|completed" | tail -3',
  'gh pr create --title "build: move the Kernel repo from npm to pnpm (KERNEL-110)" --body-file - <<\'EOF\'\n## Summary\nThe app at the root and the website in site/ now use pnpm 12.3.4.\nEOF'
]
/** Settings, Remote access switched on for the network, with two paired devices (remote-access-server). */
const remoteOn = (): Partial<Fixture> => ({
  settings: { ...DEFAULT_SETTINGS('/Users/you'), remote: { enabled: true, host: 'network', port: 47100 } },
  remote: {
    status: { enabled: true, running: true, host: '0.0.0.0', port: 47100, url: 'http://192.168.1.20:47100' },
    devices: [
      { id: 'dev-phone', name: 'Sam’s iPhone', createdAt: at(9, 12), lastSeenAt: Date.now() - 20_000, expiresAt: at(9, 12) + 30 * 24 * 3600_000, connected: true },
      { id: 'dev-laptop', name: 'MacBook Air', createdAt: at(8, 5), lastSeenAt: Date.now() - 3 * 3600_000, expiresAt: at(8, 5) + 30 * 24 * 3600_000, connected: false }
    ]
  }
})
/** The tools saved the same way (KERNEL-455), as Claude Code writes a rule. */
const projectToolRules = ['mcp__linear__get_issue', 'mcp__github__create_pull_request', 'WebFetch(domain:docs.stripe.com)']
/** Auto is the app's mode, as the canvas draws it (KERNEL-455). A8 makes it the default for new installs. */
const autoMode = (): AppSettings => { const d = DEFAULT_SETTINGS('/Users/you'); return { ...d, permissions: { ...d.permissions, mode: 'auto' } } }
/** Client A's Permissions page: the commands and tools saved with Always allow in this project, over an app that runs Auto. */
const projectPermissions = (f: Fixture): Partial<Fixture> => ({
  ...clientA(),
  agents: { ...f.agents, [ids.projectA]: sixAgents },
  settings: autoMode(),
  projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, allow: projectRules, allowTools: projectToolRules } : r))
})
/** Client A's General page (SettingsProject.png), which SettingsProjectIcon builds on. */
const settingsProject = (f: Fixture): Partial<Fixture> => ({
  ...clientA({ scripts: { setup: 'pnpm install' }, linear: { team: 'KERNEL' } }),
  projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, path: '/Users/you/Projects/client-a', repo: 'cjjutba/client-a' } : r)),
  agents: { ...f.agents, [ids.projectA]: sixAgents.slice(0, 5) },
  // KERNEL-161: Linear is connected and the project has a team, so the row shows its select.
  integrations: integrationRows.map((r) => (r.id === 'linear' ? { ...r, connected: true } : r)),
  linear: { scope: { teams: [{ id: 'team-kernel', key: 'KERNEL', name: 'Kernel' }, { id: 'team-web', key: 'WEB', name: 'Web' }], projects: [], cycles: [] } },
  ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA } }
})

/**
 * A project's General page with its issue tracker row (SettingsProjectTracker.png, SettingsProjectTrackerNone.png, KERNEL-472). Linear isn't
 * connected in either project, so the row follows the remote. `menu` opens the tracker menu.
 */
const trackerProject = (id: string, crew: string[], project: Partial<Project>, menu = false) => scene((f) => ({
  projectSettings: { [id]: kernelFiles },
  projects: f.projects.map((r) => (r.id === id ? { ...r, ...project } : r)),
  agents: { ...f.agents, [id]: sixAgents.filter((a) => crew.includes(a.id)) },
  integrations: integrationRows,
  ui: { route: { name: 'settings', page: 'project', projectId: id }, ...(menu ? { menu: 'projectTracker' as const } : {}) }
}))

const skill = (name: string): Skill => ({ name, description: '', source: 'project', enabled: true })
const mcpServers: McpServer[] = ['GitHub', 'Linear', 'Vercel', 'Figma'].map((name) => ({ name, source: 'user', enabled: true }))
/** KERNEL-647: every server the page lists comes from the accounts, so a project's own list only needs the ones that differ. */
const mcpAcrossServers: McpServer[] = [
  { name: 'GitHub', source: 'user', enabled: true }, { name: 'Linear', source: 'user', enabled: true }, { name: 'Vercel', source: 'user', enabled: true },
  { name: 'claude.ai Gmail', source: 'claudeai', enabled: true }, { name: 'claude.ai Google Drive', source: 'claudeai', enabled: true },
  { name: 'Supabase', source: 'user', provider: 'codex', enabled: true }
]
const connectUrl = 'https://claude.ai/settings/connectors'
const server = (name: string, kind: McpAccountServer['kind'], state: McpAccountServer['state'] = 'ready', more: Partial<McpAccountServer> = {}): McpAccountServer => ({ name, kind, connector: kind === 'connector', state, ...more })
/** An account with the counts Kernel gives it (KERNEL-660). */
const counted = (a: Omit<McpAccount, 'needsYou' | 'ready'>): McpAccount => ({ ...a, ...mcpCounts(a.servers) })
/** KERNEL-647: Work has everything ready. Personal has Linear and Gmail waiting on a sign-in, Vercel failed, Google Drive and Notion not set up, and Figma ignored. Codex has a sign-in, and a server switched off in config.toml and a plugin's server Codex never starts, both off (KERNEL-660). */
const mcpAcrossAccounts: McpAccount[] = [
  counted({
    provider: 'claude', accountId: 'cli', label: 'Work', email: 'cj@example.com', checkedAt: Date.now(),
    servers: [
      server('GitHub', 'user'), server('Linear', 'user'), server('Vercel', 'user'),
      server('claude.ai Gmail', 'connector'), server('claude.ai Google Drive', 'connector'), server('claude.ai Notion', 'connector'), server('claude.ai Figma', 'connector'),
      server('plugin:github:github', 'plugin'), server('plugin:vercel:vercel', 'plugin', 'ready', { note: 'Covered by claude.ai Vercel on this account.' })
    ]
  }),
  counted({
    provider: 'claude', accountId: 'personal', label: 'Personal', email: 'cj@jutba.example', checkedAt: Date.now(),
    servers: [
      server('GitHub', 'user'), server('Linear', 'user', 'needs-sign-in'), server('Vercel', 'user', 'failed', { error: 'Connection closed' }),
      server('claude.ai Gmail', 'connector', 'needs-sign-in'), server('claude.ai Google Drive', 'connector', 'not-set-up', { connectUrl }), server('claude.ai Notion', 'connector', 'not-set-up', { connectUrl }),
      server('claude.ai Figma', 'connector', 'ignored', { connectUrl }),
      server('plugin:github:github', 'plugin'), server('plugin:vercel:vercel', 'plugin', 'not-set-up', { note: 'Needs the claude.ai Vercel connector.' })
    ]
  }),
  counted({
    provider: 'codex', accountId: 'cli', label: 'cj@example.com', email: 'cj@example.com', checkedAt: Date.now(),
    servers: [
      server('Supabase', 'user'), server('Linear', 'user', 'needs-sign-in'), server('vapi', 'user', 'off', { note: 'Off in Codex config' }),
      server('code-review', 'plugin', 'off', { note: 'Not started by Codex' })
    ]
  })
]
/** KERNEL-647: twenty-seven servers on one account, to check the page reads at 1440x900. */
const manyServers = (): McpAccount[] => {
  const user = ['GitHub', 'Linear', 'Vercel', 'Supabase', 'Sentry', 'Stripe', 'PostHog', 'Neon', 'Figma', 'Mobbin', 'Porkbun', 'Slack'].map((n, i): McpAccountServer => server(n, 'user', i === 1 ? 'needs-sign-in' : i === 5 ? 'failed' : 'ready', i === 5 ? { error: 'Connection closed' } : {}))
  const connectors = ['Gmail', 'Google Drive', 'Google Calendar', 'Notion', 'Asana', 'Canva', 'Zapier', 'Box', 'Atlassian'].map((n, i): McpAccountServer => server(`claude.ai ${n}`, 'connector', i < 4 ? 'ready' : i < 7 ? 'needs-sign-in' : i === 7 ? 'not-set-up' : 'ignored', i === 7 ? { connectUrl } : {}))
  const plugins = ['github', 'vercel', 'figma', 'linear', 'sentry', 'superpowers'].map((n): McpAccountServer => server(`plugin:${n}:${n}`, 'plugin'))
  return [mcpAcrossAccounts[0], counted({ ...mcpAcrossAccounts[1], servers: [...user, ...connectors, ...plugins] })]
}
const mcpPage = (extra: Partial<Fixture>, route: { tab?: Provider; account?: string } = { account: 'personal' }) => scene(() => ({ ...clientA(), mcp: mcpAcrossServers, mcpAccounts: mcpAcrossAccounts, accounts: [workClaude, personalClaude, ownCodex], ...extra, ui: { route: { name: 'settings', page: 'mcp', ...route }, ...extra.ui } }))
const setUpModal: Modal = { name: 'mcpSetUp', provider: 'claude', accountId: 'personal' }
// Redesign 15 (Pen 15.31): two MCP servers on 2nd account need a sign-in. The run is on Linear, then ends with Linear refused.
const secondNeeds = [{ server: 'Linear', connector: false }, { server: 'Figma', connector: false }]
const secondRun: McpSignInAll = { accountId: 'second', servers: ['Linear', 'Figma'], current: 'Linear', done: [], failed: [] }
const secondFailed: McpSignInAll = { ...secondRun, current: undefined, finished: true, failed: [{ server: 'Linear', error: 'The browser window closed before sign-in finished.' }] }
/** Two Codex accounts that list the same servers, which the page shows as one Codex tab (KERNEL-660). */
const sharedCodex = (): McpAccount[] => {
  const [, , codex] = mcpAcrossAccounts
  return [mcpAcrossAccounts[0], mcpAcrossAccounts[1], { ...codex, sharedWith: ['personal'] }, { ...codex, accountId: 'personal', label: 'Personal', email: 'cj@jutba.example', sharedWith: ['cli'] }]
}
const setUpRun: McpSignInAll = { accountId: 'personal', servers: ['Linear', 'Vercel', 'claude.ai Gmail', 'claude.ai Google Drive', 'claude.ai Notion'], current: 'Vercel', done: ['Linear'], failed: [], ignored: ['plugin:vercel:vercel'] }
const setUpConnect = { provider: 'claude' as const, accountId: 'personal', email: 'cj@jutba.example', url: connectUrl, servers: ['claude.ai Gmail', 'claude.ai Google Drive', 'claude.ai Notion'] }
/** As Kernel resolves them (KERNEL-397): Kernel leads, and Artkin reviews with tools that can't open a PR, so takes no tasks. */
const agentFile = (id: string, name: string, role: string, description: string): AgentDef => ({ id, name, role, description, lead: id === 'kernel-lead', reviewer: id === 'artkin', member: id !== 'kernel-lead' && id !== 'artkin', prompt: '', ...(id === 'kernel-lead' ? { builtIn: 'lead' as const, file: '' } : { file: `.claude/agents/${id}.md` }), model: id === 'kernel-lead' || id === 'artkin' ? 'opus' : 'sonnet' })
const sixAgents: AgentDef[] = [
  agentFile('kernel-lead', 'Kernel', 'Lead', 'Plans and hands out tasks'), agentFile('christian', 'Christian', 'Frontend', 'UI work, follows DESIGN.md'),
  agentFile('sean', 'Sean', 'Backend', 'Schema, API, migrations'), agentFile('teng', 'Teng', 'QA', 'Runs tests, attaches output'),
  agentFile('artkin', 'Artkin', 'Reviewer', 'Types, security, tenancy'), agentFile('wren', 'Wren', 'Designer', 'Joined today')
]
/** Christian as Pen 15.9 draws him: a repo file with a model, tools and skills of his own. */
const christianProfile: AgentDef = { ...agentFile('christian', 'Christian', 'Frontend', 'Builds UI from approved plans and checks each screen.'), model: 'sonnet', effort: 'medium', tools: ['Read', 'Edit', 'Write', 'Bash'], skills: ['/shots', '/issue'], prompt: 'You are Christian, the frontend engineer.\nBuild UI from approved plans. Follow DESIGN.md when the repo has one.\nMatch the screenshot or mock in the brief. Check your work with pnpm shots.\n\nKeep each PR to one task.' }
const christianTeam = sixAgents.map((a) => (a.id === 'christian' ? christianProfile : a))
/** The agents Settings, Models lists under each row: Frontend and Backend in two projects, one pinned to a model, one with a custom role. */
/** Settings once onboarding is finished, so a failing check shows as a toast instead of the first-run steps (KERNEL-1088). */
function setupDone(): AppSettings { const d = DEFAULT_SETTINGS('/Users/you'); return { ...d, onboarding: { ...d.onboarding, done: true } } }
const modelsPage = (roles: Partial<Record<Role, RoleModel>> = {}) => settingsPage('models', { agents: modelsAgents(), status: {}, settings: withRoles({ frontend: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' }, engineers: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, ...roles }), models: { codex: codexModels } })
const modelsAgents = (): Fixture['agents'] => {
  const christian = agentFile('christian', 'Christian', 'Frontend', 'UI work, follows DESIGN.md')
  const sean = { ...agentFile('sean', 'Sean', 'Backend', 'Schema, API, migrations'), model: undefined }
  const rio = { ...agentFile('rio', 'Rio', 'Data analyst', 'Reports and queries'), model: undefined }
  const mira = { ...agentFile('mira', 'Mira', 'Frontend', 'Design systems'), model: 'claude-opus-5-5' }
  const artkin = { ...agentFile('artkin', 'Artkin', 'Reviewer', 'Types, security, tenancy'), model: undefined }
  const lead = agentFile('kernel-lead', 'Kernel', 'Lead', 'Plans and hands out tasks')
  return { [ids.projectA]: [{ ...lead, model: undefined }, { ...christian, model: undefined }, sean, artkin], [ids.projectB]: [{ ...christian, model: undefined }, mira, sean, rio], [ids.projectOwn]: [{ ...lead, model: undefined }], [ids.projectPortfolio]: [{ ...christian, model: undefined }] }
}
/** KERNEL-995: the real setup, four projects and about sixty agents. Most Backend agents pin their own model, so the row follows few of them, and helpers and a retired agent sit beside them. */
const REAL_PROJECTS: Record<string, string> = { [ids.projectA]: 'Kernel', [ids.projectB]: 'Fiscplus', [ids.projectOwn]: 'Cjjutba Dev', [ids.projectPortfolio]: 'aurahire' }
const specialists = [
  'Abdel Message Drafter', 'Accessibility Specialist', 'Ai Architect', 'Auth Security Specialist', 'Belgian Compliance Specialist', 'Code Architect', 'Code Explorer', 'Code Reviewer',
  'Data Table Specialist', 'Database Architect', 'Database Migration Specialist', 'Deployment Expert', 'Email Template Specialist', 'Export Report Generator', 'File Upload Storage Specialist',
  'Form Validation Expert', 'Integration Api Specialist', 'Nestjs Backend Api', 'Notification Toast Specialist', 'Performance Optimizer', 'Scheduling Cron Job Specialist', 'Search Filter Specialist',
  'Tanstack Query Expert', 'Unit Test Specialist', 'Websocket Realtime Specialist', 'Workflow State Machine Specialist'
]
const slug = (n: string) => n.toLowerCase().replace(/[^a-z]+/g, '-')
const largeAgents = (): Fixture['agents'] => {
  const mk = (name: string, role: string, model?: string, over: Partial<AgentDef> = {}): AgentDef => ({ ...agentFile(slug(name), name, role, `${name} for this project`), model, ...over })
  const team = (n: number): AgentDef[] => [
    { ...agentFile('kernel-lead', 'Kernel', 'Lead', 'Plans and hands out tasks'), model: undefined },
    mk('Christian', 'Frontend'), mk('Sean', 'Backend'), mk('Teng', 'QA'), mk('Artkin', 'Reviewer'), mk('Rio', 'Backend', 'claude-sonnet-5-5'), mk('Mira', 'Backend', 'claude-opus-5-5'), mk('Sol', 'Backend', 'haiku'),
    ...specialists.filter((_, i) => (i + n) % 2 === 0 || n === 1).map((name, i) => mk(name, 'Specialist', i % 9 === 0 ? undefined : i % 4 === 0 ? 'opus' : 'sonnet')),
    mk('Frontend Component Dev', 'Frontend Specialist', 'sonnet'),
    mk('Explore', 'Backend', undefined, { member: false }), mk('Plan', 'Backend', undefined, { member: false }), mk('Old Migrator', 'Backend', undefined, { retired: true })
  ]
  return { [ids.projectA]: team(1), [ids.projectB]: team(2), [ids.projectOwn]: team(3).slice(0, 14), [ids.projectPortfolio]: team(4).slice(0, 14) }
}
const largeModels = () => scene((f) => ({
  projects: f.projects.map((r) => ({ ...r, name: REAL_PROJECTS[r.id] ?? r.name })),
  agents: largeAgents(),
  status: {},
  settings: withRoles({ frontend: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' }, engineers: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, lead: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' } }),
  models: { codex: codexModels },
  ui: { route: { name: 'settings', page: 'models' } }
}))
const longExample = 'Use this agent to design AI features and pick models. <example>Context: The user is adding chat. user: "Which SDK should I use?" assistant: "I will use the ai-architect agent."</example> <commentary>The request is about architecture, so hand it over.</commentary> Covers streaming, tool calling and cost.'
const extraAgents: AgentDef[] = [
  { ...agentFile('ops', 'Ops', 'Ops', 'Deploys and watches logs'), origin: 'personal', file: '/Users/you/.claude/agents/ops.md', member: true, tools: ['Read', 'Bash', 'Grep'], prompt: 'You are Ops. You deploy, watch the logs and say what you saw.\n\nNever deploy on a red build. Roll back first and ask questions after.' },
  { ...agentFile('vercel:ai-architect', 'Ai Architect', 'Ai Architect', longExample), origin: 'plugin', file: '', member: true },
  { ...agentFile('vercel:deployment-expert', 'Deployment Expert', 'Specialist', 'Debugs failed deployments'), origin: 'plugin', file: '', member: true, prompt: 'You debug failed deployments. Read the build log first, then the config that produced it.' }
]
const integrationRows: Integration[] = [
  { id: 'github', name: 'GitHub', connected: true, detail: 'Signed in with gh as cjjutba. Repos, pull requests, checks and issues.' },
  { id: 'linear', name: 'Linear', connected: false, detail: 'Not connected. Issues open as workspaces once it is.' }
]

/** The same screen as `src`, drawn in the light theme (HomeLight.png, WorkspaceLight.png). */
const light = (src: Fixture): Fixture => ({ ...src, ui: { ...src.ui, theme: 'light' } })

// What's new (Redesign 17): 0.43.0's notes as the updater reads them (scripts/notes.ts renderApp). New features have titles, and
// Improved and Fixed come as one note per area, shown as rows.
const whatsNewNotes = [
  { title: 'Automatic review is on by default', body: "Every pull request gets a review unless you turn it off in Settings, Pull requests. If you turned it off before, it stays off." },
  { title: 'Evidence on the pull request', body: 'Kernel can keep one comment on GitHub that lists each acceptance criterion and its state. Turn it on in Settings, Pull requests.' },
  { title: 'Improved: Pull requests', body: 'The PRs panel shows each check as it finishes.\nMerge waits for required checks, then tries once more.' },
  { title: 'Improved: Chat with Kernel', body: 'A reply that changed files ends with the files it changed.' },
  { title: 'Fixed: Chat with Kernel', body: 'Fixed a chat losing its draft after a restart.\nFixed a long command running past the edge of a step.' },
  { title: 'Fixed: Pull requests', body: 'Fixed the PRs panel showing a merged PR as open.' },
  { title: 'Fixed: Settings', body: 'Fixed a rule in Settings, Hooks being forgotten after a restart.' }
]
const whatsNewModal = { ...teamFixtures.UpdateReady.ui, modal: { name: 'whatsNew' as const } }
const whatsNew: Fixture = {
  ...teamFixtures.UpdateReady,
  update: { status: 'ready', current: '0.42.0', version: '0.43.0', notes: whatsNewNotes },
  ui: whatsNewModal
}
// What's new opened from the sidebar with no update ready (KERNEL-154): the running version's notes and Done.
const whatsNewCurrent: Fixture = { ...teamFixtures.UpdateReady, update: { status: 'idle', current: '0.43.0', currentNotes: whatsNewNotes }, ui: whatsNewModal }
/** What's new opened from the sidebar while the updater is in `update`'s state, over the running 0.43.0's notes. */
const whatsNewWith = (update: Partial<AppUpdate>): Fixture => ({ ...whatsNewCurrent, update: { status: 'idle', current: '0.43.0', currentNotes: whatsNewNotes, ...update } })
// 0.39.0's notes, published before titles and areas: a flat list for each section, folded into one row.
const flatNotes = [
  { title: 'Improved', body: 'Chats remember their scroll position.\nThe composer keeps a draft per chat.\nSearch finds archived chats.' },
  { title: 'Fixed', body: 'Fixed a chat jumping to the top after a restart.\nFixed Search missing a chat renamed a moment ago.' }
]
const whatsNewFlat: Fixture = { ...whatsNew, update: { status: 'ready', current: '0.38.2', version: '0.39.0', notes: flatNotes } }
// A patch with one short Fixed list: it lists open, with no row to fold it.
const whatsNewPatch: Fixture = {
  ...whatsNew,
  update: { status: 'ready', current: '0.43.0', version: '0.43.1', notes: [{ title: 'Fixed', body: 'Fixed a chat losing its draft after a restart.\nFixed the PRs panel showing a merged PR as open.' }] }
}
/** The toast that says a restart failed (Pen 17.4, WhatsNewRestartFailed). */
const restartFailedToast: Toast = { id: 'upd-restart', title: "Couldn't restart Kernel", sub: "The installer didn't start. Your agents kept working.", glyph: 'error', action: { label: 'Try again', retry: 'update-install', primary: true } }
/** The toast that says a check failed (Pen 17.4, WhatsNewCheckFailed). */
const checkFailedToast: Toast = { id: 'upd-check', title: "Couldn't check for updates", sub: "GitHub releases didn't answer.", glyph: 'error', action: { label: 'Try again', retry: 'update-check', primary: true } }
/** A check that failed on the running version, with no notes to show: a calm body and a toast. */
const whatsNewCheckFailed: Fixture = { ...whatsNewWith({ status: 'error', error: 'net::ERR_CONNECTION_TIMED_OUT', currentNotes: undefined }), ui: { ...whatsNewModal, toasts: [checkFailedToast] } }

/** KERNEL-251: Codex is on the PATH and one custom command is saved, as SettingsBigTerminal.png and WorkspaceTerminalPresets.png draw them. */
const codex: TerminalPreset = { id: 'codex', name: 'Codex', command: 'codex', builtin: true, skipsPermissions: false }
const bigTerminal: Partial<Fixture> = {
  settings: { ...DEFAULT_SETTINGS('/Users/you'), terminal: { ...DEFAULT_SETTINGS('/Users/you').terminal, custom: [{ id: 'custom-dev-server-logs', name: 'Dev server logs', command: 'tail -f logs/dev.log' }] } },
  terminalClis: [codex]
}


const projectGitToast: Fixture = (() => { const f = projectPage('git', { ...clientA({}), branches: ['origin/main'], ...pushCheck('ok') }); return { ...f, ui: { ...f.ui, toasts: [{ id: 'esc', title: 'Could not save the setting' }] } } })()

/** The Scripts page of Client A (KERNEL-914): a twelve-line setup script that overrides settings.toml, an empty archive script and three run scripts. */
const scriptsPage = projectPage('setup', clientA({
    scripts: { ...kernelFiles.scripts, setup: fiscSetup, archive: '' },
    runScripts: [
      { name: 'run', command: 'pnpm dev --port $KERNEL_PORT' },
      { name: 'frontend', command: 'pnpm --filter web dev --port $KERNEL_PORT' },
      { name: 'backend', command: 'pnpm --filter api dev --port $((KERNEL_PORT + 1))' }
    ],
    preview: { urls: [{ name: 'Web app', url: 'http://localhost:$KERNEL_PORT' }, { name: 'API docs', url: 'http://localhost:$((KERNEL_PORT + 1))/docs' }] },
    sources: { ...kernelFiles.sources, 'scripts.setup': 'override', 'runScripts.run': 'override', 'runScripts.frontend': 'local', 'runScripts.backend': 'local', 'preview.urls': 'shared' }
  }))

/** Client A's Pull requests page: three reviews with their own agents and models, rules from both files, and a custom Create PR instruction. */
const projectPrs = scene((f) => ({
  ...clientA({
    review: {
      rounds: 2,
      kinds: {
        code: { enabled: true, paths: [], required: true, model: 'claude-opus-5-5', provider: 'claude' },
        security: { enabled: true, paths: ['src/api/**', 'src/auth/**', 'db/migrations/**'], required: true, agent: 'artkin', model: 'claude-opus-5-5', provider: 'claude' },
        ux: { enabled: true, paths: ['src/renderer/**/*.tsx', '**/*.css'], required: false, agent: 'wren', model: 'claude-sonnet-5-5', provider: 'claude' }
      }
    },
    // KERNEL-594: the shared `[merge] always_review`, as the canvas's box lists it.
    merge: { alwaysReview: ['src/billing/**', 'db/migrations/**'] },
    pr: { ...kernelFiles.pr, mergeMethod: 'rebase', optionalChecks: ['Vercel*', 'codecov/patch'] },
    sources: { ...kernelFiles.sources, 'pr.mergeMethod': 'local', 'pr.optionalChecks': 'shared' }
  }),
  agents: { ...f.agents, [ids.projectA]: sixAgents.map((a) => ({ ...a, reviewer: false })) },
  ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'prs' } }
}))

/** Client A's Environment page (KERNEL-914): variables, env files with one missing from the checkout, and Files to copy with what they match. */
const projectEnvPage: Fixture = scene((f) => ({
    ...envProjectA,
    ...clientA({ env: { files: envFiles }, files: { copy: ['.env*', 'certs/*.pem', '.npmrc'], symlinkNodeModules: false }, sources: { ...kernelFiles.sources, 'env.files': 'local', 'files.copy': 'shared' } }),
    projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, path: '/Users/you/Projects/client-a' } : r)),
    localFiles: { [ids.projectA]: ['.env', '.env.development', '.env.local', '.env.production', '.env.test', '.npmrc', 'certs/ca.pem', 'certs/dev.pem', 'certs/localhost.pem'].map((path, i) => ({ path, size: 96 + i * 31 })) },
    ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'environment' } }
  }))

export const platformFixtures: Record<string, Fixture> = {
  WhatsNew: whatsNew,
  // Restart to update stays busy as Restarting while the install call is out, with Later gone beside it.
  WhatsNewRestarting: { ...whatsNew, lag: { 'update.install': 60_000 }, motion: { action: { click: 'Restart to update' }, ms: 400, area: '.modal' } },
  // A restart that fails leaves the dialog as it was, and a toast says why with Try again.
  WhatsNewRestartFailed: { ...whatsNew, ui: { ...whatsNewModal, toasts: [restartFailedToast] } },
  WhatsNewPatch: whatsNewPatch,
  WhatsNewInstalled: { ...whatsNew, update: { status: 'idle', current: '0.43.0', version: '0.43.0', installed: true, notes: whatsNewNotes } },
  WhatsNewLight: light(whatsNew),
  WhatsNewCurrent: whatsNewCurrent,
  // A release from before titles and areas: each list folds into one row, and the second opens on its changes.
  WhatsNewFlat: whatsNewFlat,
  WhatsNewFlatOpen: { ...whatsNewFlat, motion: { action: { click: 'Show 3 changes' }, ms: 300, area: '.modal' } },
  WhatsNewGroupOpen: { ...whatsNew, motion: { action: { click: 'Pull requests 2' }, ms: 300, area: '.modal' } },
  // Opened before Kernel answers update.get: Loading release notes.
  WhatsNewLoading: { ...whatsNewCurrent, update: undefined, lag: { 'update.get': 60_000 } },
  // A dev run, or a release without notes.
  WhatsNewEmpty: { ...whatsNew, update: { status: 'ready', current: '0.43.1', version: '0.43.2', notes: [] } },
  // The next version's notes while it downloads, with the percentage in the footer and Restart to update waiting.
  WhatsNewDownloading: { ...whatsNew, update: { status: 'downloading', current: '0.43.0', version: '0.44.0', progress: 62, notes: [{ title: 'Several projects in one chat', body: 'Mention a second project with @ and Kernel works in both.' }] } },
  WhatsNewCheckFailed: whatsNewCheckFailed,
  // Try again on a failed check spins as Trying again until the check answers.
  WhatsNewCheckRetrying: { ...whatsNewCheckFailed, ui: whatsNewModal, lag: { 'update.check': 60_000 }, motion: { action: { click: 'Try again' }, ms: 400, area: '.modal' } },
  // The title bar's Update pill in a workspace, where it sits left of the right panel's toggle.
  UpdateReadyWorkspaceNoSidebar: { ...workspaceFixtures.Workspace, update: { status: 'ready', current: '0.42.0', version: '0.43.0' }, ui: { ...workspaceFixtures.Workspace.ui, sidebar: false } },
  // The update card in the light theme (KERNEL-164). UpdateReady shows it in dark; no PNG draws it.
  UpdateReadyLight: light(teamFixtures.UpdateReady),
  WorkspaceLight: light(workspaceFixtures.Workspace),
  // The VS Code file icons and git colors in the light theme (KERNEL-399).
  WorkspaceFilesTreeLight: light(workspaceFixtures.WorkspaceFilesTree),
  // Open at login is off by default since KERNEL-57; the canvas draws it on.
  Settings: settingsPage('general', { settings: { ...DEFAULT_SETTINGS('/Users/you'), general: { ...DEFAULT_SETTINGS('/Users/you').general, openTo: 'lastPlace', openAtLogin: true } } }),
  SettingsAppearance: settingsPage('appearance'),
  // Redesign 15: quiet hours on for the night, and a finished workspace stays quiet.
  SettingsNotifications: settingsPage('notifications', { settings: { ...DEFAULT_SETTINGS('/Users/you'), notifications: { ...DEFAULT_SETTINGS('/Users/you').notifications, finished: false, quietHours: { from: '22:00', to: '08:00' } } } }),
  SettingsShortcuts: settingsPage('shortcuts'),
  // configurable-hotkeys: the command palette and Merge PR rebound, each with its reset, and Reset all on.
  SettingsShortcutsChanged: settingsPage('shortcuts', { settings: { ...DEFAULT_SETTINGS('/Users/you'), hotkeys: { palette: 'meta+alt+KeyP', mergePr: 'ctrl+meta+KeyM' } } }),
  // KERNEL-406, KERNEL-974: Frontend runs on Codex and Backend on Opus, each on its own row. The rest stay on their defaults.
  // KERNEL-974: Christian and Sean in two projects, Mira on her own model, and Rio with a custom role that lands under Backend. QA has no one.
  SettingsModels: settingsPage('models', { agents: modelsAgents(), status: {}, settings: withRoles({ frontend: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' }, engineers: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' } }), models: { codex: codexModels } }),
  // KERNEL-1056: every role holds a Claude and a Codex pick. Frontend prefers Codex, QA prefers Claude with its own Codex fallback, and the rest keep their defaults.
  SettingsModelsFallback: settingsPage('models', { agents: modelsAgents(), status: {}, settings: withSides({ frontend: { prefer: 'codex', codex: { model: 'gpt-6-astra', effort: 'medium' } }, qa: { codex: { model: 'gpt-5.6-sol', effort: 'low' } }, engineers: { claude: { model: 'claude-opus-5-5', effort: 'xhigh' } } }), models: { codex: codexModels } }),
  // KERNEL-988: a role's Model cell opens the model picker under it, on Claude, on Codex, and with the Legacy models flyout open.
  SettingsModelsPicker: modelsPage(),
  SettingsModelsPickerCodex: modelsPage(),
  // Pen 15.34: Backend on a legacy model with the flyout open, Frontend moving from Claude to Codex, and QA on Haiku with a search typed.
  SettingsModelsPickerLegacy: modelsPage({ engineers: { provider: 'claude', model: 'claude-sonnet-4-6', effort: 'medium' } }),
  // KERNEL-995: one chip per role and an agent count. The large fixture is the real setup, to check every row is as tall as the next.
  SettingsModelsLarge: largeModels(),
  SettingsModelsAgents: largeModels(),
  // No agent follows the QA row, but Teng pins its own model, so QA says "No agents" and the count still opens and lists only that agent.
  SettingsModelsAgentsNone: settingsPage('models', { agents: { ...modelsAgents(), [ids.projectA]: [...modelsAgents()[ids.projectA], agentFile('teng', 'Teng', 'QA', 'Runs tests, attaches output')] }, status: {}, settings: withRoles({ frontend: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' }, engineers: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' } }), models: { codex: codexModels } }),
  SettingsModelsPickerEffort: modelsPage(),
  // Pen 15.38: Agent teams on, with its two rules under it.
  SettingsModelsAgentTeams: settingsPage('models', { agents: modelsAgents(), status: {}, settings: ((d) => ({ ...d, models: { ...d.models, agentTeams: true, agentLimit: 4 }, hooks: { ...d.hooks, requireTestOutput: true, keepTeammatesWorking: false } }))(DEFAULT_SETTINGS('/Users/you')), models: { codex: codexModels } }),
  // KERNEL-1116: the five-step track on a Codex model (Pen 8.3, 8.11), and a Claude role's picker with Codex open (Pen 15.34).
  SettingsModelsPickerEffortCodex: modelsPage(),
  SettingsModelsPickerBoth: modelsPage(),
  SettingsModelsPickerCompact: modelsPage({ qa: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' } }),
  SettingsModelsPickerCodexRole: modelsPage({ frontend: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } }),
  SettingsModelsNarrow: largeModels(),
  // Redesign 15 (Pen 15.4): Claude Code's accounts with their meters, then Limits and Chats and accounts. The window is tall, so the whole page is in the shot.
  SettingsAccounts: providersPage('claude'),
  // Pen 15.31: one account's row in each state it has. Main account is Claude Code's own login in use, and 2nd account is one added in Kernel.
  // A window about to reset: Main account's 5-hour window is at 98%.
  SettingsAccountsReset: providersPage('claude', { usage: [window5('claude', 'cli', 98, Date.now() + 12 * 60_000), windowWeek('claude', 'cli', 58, nextOn(4, 3, 0)), window5('claude', 'second', 36, next(19, 5)), windowWeek('claude', 'second', 53, nextOn(5, 9, 0)), window5('codex', 'cli', 12, next(19, 5)), windowWeek('codex', 'cli', 31, nextOn(1, 3, 0))] }),
  // KERNEL-701: Main account is added in Kernel and is also Claude Code's own login in Terminal, so it shows once, with its note.
  SettingsAccountsAlsoCli: providersPage('claude', { accounts: [{ ...pageMain, cli: false, alsoCli: true }, pageSecond, footerKey(), footerCodex] }),
  // KERNEL-1056: the fallback switch under Switch accounts at a limit, on with both providers signed in, and off with a reason while Codex is signed out.
  SettingsAccountsFallback: providersPage('claude'),
  SettingsAccountsFallbackDisabled: providersPage('claude', { accounts: [pageMain, pageSecond, footerKey(), { ...footerCodex, signedIn: false }] }),
  SettingsAccountsCodex: providersPage('codex'),
  SettingsAccountsCodexSignedOut: providersPage('codex', { accounts: [pageMain, { ...footerCodex, signedIn: false }], providerStatus: { codex: { provider: 'codex', source: 'bundled', version: '0.153.4', signedIn: false, configFile: '/Users/you/.codex/config.toml' } } }),
  // KERNEL-524: an API key account beside the login, on each tab, then with the key in use and the dialog that adds one.
  SettingsAccountsApiKey: providersPage('claude', { accounts: [pageMain, footerKey(), footerCodex] }),
  SettingsAccountsApiKeyActive: providersPage('claude', {
    accounts: [{ ...pageMain, active: false }, footerKey(true), footerCodex],
    providerStatus: { ...providerStatus, claude: { provider: 'claude', source: 'bundled', version: '2.1.292', signedIn: true, loginMethod: 'API key', configFile: '/Users/you/.claude/settings.json' } }
  }),
  SettingsAccountsCodexApiKey: providersPage('codex', { accounts: [pageMain, footerCodex, { id: 'key', provider: 'codex', label: 'OpenAI API key', cli: false, auth: 'apiKey', active: false, signedIn: true }] }),
  SettingsAddAccountApiKey: providersPage('claude'),
  // Redesign 15 (Pen 15.5, 15.32): Add account opens three cards, Continue opens what the pick needs. Claude's sign-in waits on the browser, which is the engine's `account.add` step.
  SettingsAddAccount: addAccountPage('claude'),
  SettingsAddAccountBrowser: addAccountPage('claude', true),
  SettingsAddAccountCodex: addAccountPage('codex'),
  SettingsAddAccountCodexBrowser: addAccountPage('codex', true),
  // KERNEL-561: 2nd account being renamed, and a Claude account from before the full login that asks to move to one, with the usage its last turn read.
  SettingsAccountsRename: providersPage('claude'),
  SettingsAccountsLegacy: providersPage('claude', {
    accounts: [pageMain, { ...pageSecond, id: 'legacy', label: 'Claude Code login', email: undefined, plan: undefined, usageFromTurns: true, legacyToken: true }, footerKey(), footerCodex],
    usage: pageUsage()
  }),
  // KERNEL-619: Claude Code found two MCP servers on 2nd account that need a sign-in. Main account has none.
  SettingsAccountsMcp: providersPage('claude', { mcpAccounts: mcpAcrossAccounts, accounts: [pageMain, { ...pageSecond, mcpSignIns: secondNeeds }, footerKey(), footerCodex] }),
  // KERNEL-627: Sign in to all on the account's row while it runs, then what failed, with a toast that says why.
  SettingsAccountsMcpSigningIn: providersPage('claude', { mcpAccounts: mcpAcrossAccounts, accounts: [pageMain, { ...pageSecond, mcpSignIns: secondNeeds }, footerKey(), footerCodex], push: [{ type: 'account.mcpSignInAll', run: secondRun }] }),
  SettingsAccountsMcpSignInFailed: providersPage('claude', { mcpAccounts: mcpAcrossAccounts, accounts: [pageMain, { ...pageSecond, mcpSignIns: secondNeeds.slice(0, 1) }, footerKey(), footerCodex], push: [{ type: 'account.mcpSignInAll', run: secondFailed }] }),
  // KERNEL-661: the notice after adding 2nd account, which opens its servers on Settings, MCP servers.
  SettingsMcpNeededNotice: scene(() => ({
    ...clientA(),
    accounts: [pageMain, { ...pageSecond, mcpSignIns: secondNeeds }, footerKey(), footerCodex],
    providerStatus,
    usage: pageUsage(),
    ui: { route: { name: 'settings', page: 'accounts', tab: 'claude' }, toasts: [{ id: 'mcp-needed', title: '2 MCP servers need a sign-in', sub: 'Linear and Figma, for 2nd account.', action: { label: 'Open MCP servers', route: { name: 'settings', page: 'mcp', tab: 'claude', account: 'second' } } }] }
  })),
  // KERNEL-619: 2nd account's Keychain item waits on a macOS prompt. It reads as waiting, not signed out, keeps no usage lines, and can't be switched to or signed out.
  SettingsAccountsKeychain: providersPage('claude', {
    accounts: [pageMain, { ...pageSecond, keychainWait: true }, footerKey(), footerCodex],
    usage: pageUsage().filter((l) => l.accountId !== 'second')
  }),
  // KERNEL-619: both logins are seats in one Claude Team organization, so 2nd account says it shares limits with Main account.
  SettingsAccountsSameOrg: providersPage('claude', {
    accounts: [{ ...pageMain, plan: 'Claude Team', sameOrg: ['second'] }, { ...pageSecond, plan: 'Claude Team', sameOrg: ['cli'] }, footerKey(), footerCodex],
    providerStatus: { ...providerStatus, claude: { ...providerStatus.claude!, plan: 'Claude Team' } }
  }),
  // Main account at its 5-hour limit with switching off, the page in light, and 2nd account's switch in flight.
  SettingsAccountsLimit: limitPage(),
  SettingsAccountsLimitLight: light(limitPage()),
  SettingsAccountsHold: holdPage(),
  // KERNEL-1043: every Claude subscription at its weekly limit, so the page says Claude Code is on hold and offers the API key.
  SettingsAccountsOnHold: providersPage('claude', { usage: holdUsage() }),
  SettingsAccountsLight: light(providersPage('claude')),
  // 2nd account's menu, its name turned into a field, and Remove asking first. A chat runs on it, so the dialog says where it moves.
  SettingsAccountsMenu: providersPage('claude'),
  SettingsAccountsRemove: providersPage('claude', { accounts: [pageMain, { ...pageSecond, chats: 1 }, footerKey(), footerCodex] }),
  // Advanced opened: each provider's executable and config file, and Codex's personality.
  SettingsAccountsAdvanced: providersPage('claude'),
  // KERNEL-619: the engine has refused the account Add account opened the browser for, because Kernel already has it.
  SettingsAddAccountDuplicate: providersPage('claude', { push: [{ type: 'account.add', add: { provider: 'claude', step: 'failed', error: 'That account is already in Kernel.' } }] }),
  // KERNEL-561: the menu lists every account of both providers with its plan and usage, and Cmd+K switches to any that isn't in use.
  AccountMenu: { ...teamFixtures.Inbox, accounts: footerAccounts, usage: footerUsage(), ui: { route: { name: 'inbox' }, menu: 'account' } },
  AccountMenuFooter: usageHome({}, { menu: 'account' }),
  // KERNEL-986: the menu and the footer in the middle of a switch to 2nd account. The menu stays open with a spinner on that row, and the footer chip names the new account with no numbers.
  AccountMenuSwitching: { ...teamFixtures.Inbox, accounts: footerAccounts, usage: footerUsage(), ui: { route: { name: 'inbox' }, menu: 'account', switching: { provider: 'claude', accountId: secondClaude.id } } },
  AccountMenuFooterSwitching: usageHome({}, { menu: 'account', switching: { provider: 'claude', accountId: secondClaude.id } }),
  UsageFooterSwitching: usageHome({}, { switching: { provider: 'claude', accountId: secondClaude.id } }),
  // KERNEL-674: usage is in the footer all the time. Detailed gives the active account of each provider its name and both windows, and Compact gives it one number.
  UsageFooter: usageHome({ usage: hotUsage() }),
  // The Help button stays at the footer's right with no update, and its menu opens upward from it.
  UsageFooterNoUpdate: usageHome({ update: undefined }),
  FooterHelpMenu: usageHome({ update: undefined }, { menu: 'help' }),
  // KERNEL-674: Codex's 5-hour window is full, so its bar and number go red.
  UsageFooterCodexFull: usageHome({ usage: footerUsage(100) }),
  // KERNEL-1027: Anthropic reported 101% for the 5-hour window, and the chip reads 100%.
  UsageFooterOverLimit: usagePopover({ usage: footerUsage(12, 101, 64) }),
  // KERNEL-949: the footer shows only the account each provider runs on, however many there are. Switching is in the account menu. A narrow window drops the Fable number.
  UsageFooterManyAccounts: usageHome({ accounts: manyAccounts, usage: manyUsage() }),
  // KERNEL-699: every switch shows a notice with Undo. Your own says what you now use, and Kernel's at a limit says why it moved.
  UsageSwitchToast: switchedHome([{ ...mainClaude, active: false }, { ...secondClaude, active: true }, thirdClaude, footerKey(), footerCodex], { type: 'accountSwitched', provider: 'claude', from: 'cli', to: 'second', reason: 'user' }),
  UsageSwitchToastAtLimit: switchedHome([{ ...mainClaude, active: false }, { ...secondClaude, active: true }, thirdClaude, footerKey(), footerCodex], { type: 'accountSwitched', provider: 'claude', from: 'cli', to: 'second', reason: 'limit', limit: 'five_hour' }),
  // KERNEL-697: Codex's chip opens the popover with Codex expanded and Claude Code folded.
  UsagePopoverFromCodex: usagePopover({}, { usageOpen: ['codex'] }),
  UsagePopoverManyAccounts: usagePopover({ accounts: manyAccounts, usage: manyUsage() }),
  // KERNEL-674: the popover opens upward from the footer. Claude Code is open in Detailed and Codex shows both windows folded.
  UsagePopover: usagePopover({ usage: hotUsage() }),
  UsagePopoverOverLimit: usagePopover({ usage: footerUsage(12, 100, 86) }),
  UsagePopoverCompact: usagePopover({}, { usageView: 'compact', usageOpen: [] }),
  UsagePopoverCompactCodex: usagePopover({}, { usageView: 'compact', usageOpen: ['codex'] }),
  // KERNEL-619: a key is in use on Claude Code, so it says Billed per token and Switch lists the subscriptions.
  UsagePopoverApiKey: usagePopover({ accounts: [{ ...mainClaude, active: false }, secondClaude, thirdClaude, footerKey(true), footerCodex] }),
  // KERNEL-619: Codex isn't signed in, so its row is one line with Sign in.
  UsagePopoverSignedOut: usagePopover({ accounts: [mainClaude, secondClaude, thirdClaude, footerKey(), { ...footerCodex, signedIn: false }] }),
  SearchSwitchAccount: { ...teamFixtures.CommandPalette, workspaces: teamFixtures.CommandPalette.workspaces.map((w) => (w.id === ids.schema ? { ...w, status: 'archived' as const } : w)), accounts: richAccounts, usage: providerUsage() },
  // KERNEL-455: Auto is the pick, and the fixture's availability has it working on Claude Code and not on Codex.
  SettingsPermissions: settingsPage('permissions', { settings: { ...autoMode(), permissions: { ...autoMode().permissions, neverAllow: ['git push origin main', 'curl * | sh'] } } }),
  SettingsBigTerminal: settingsPage('bigterm', bigTerminal),
  SettingsBigTerminalPreset: settingsPage('bigterm', { terminalClis: [codex] }),
  SettingsAbout: aboutPage({ status: 'idle', current: '0.42.0' }),
  // KERNEL-397: usage data is opt-in. This build can send, and the user hasn't said yes, so every event is kept on the Mac.
  SettingsPrivacy: settingsPage('privacy', { telemetry: { canSend: true, recent: [
    { event: { name: 'team.resolved', leadFrom: 'builtin', reviewerFrom: 'file', agents: '1-5', helpers: '1-5', warnings: '1-5' }, at: at(10, 42), sent: false },
    { event: { name: 'agent.warning', kind: 'cant-open-pr' }, at: at(10, 42), sent: false },
    { event: { name: 'room.created', source: 'folder' }, at: at(10, 41), sent: false },
    { event: { name: 'app.started' }, at: at(10, 40), sent: false }
  ] } }),
  // remote-access-server: off by default, with nothing paired.
  SettingsRemoteOff: settingsPage('remote'),
  // remote-access-server: on for the network, one phone connected and one laptop that was last seen a while ago.
  SettingsRemote: settingsPage('remote', remoteOn()),
  // remote-access-server: Pair a device shows the one-time link and its QR code over the device list.
  SettingsRemotePairing: { ...settingsPage('remote', remoteOn()), motion: { action: { click: 'Pair a device' }, ms: 600 } },
  // KERNEL-397: the one question about usage data, over Home, in a build that can send.
  TelemetryAsk: { ...scene(() => ({ telemetry: { canSend: true }, ui: { route: { name: 'inbox' }, modal: { name: 'telemetryAsk' } } })), motion: { action: { press: ['Escape'] }, ms: 600 } },
  SettingsGit: settingsPage('git', { branches: ['origin/main', 'origin/dev', 'main'] }),
  // KERNEL-371: Archive on merge is off in the personal file over settings.toml, and Delete branch on archive follows the app.
  // KERNEL-401: the optional checks come from settings.toml.
  SettingsProjectGit: projectPage('git', {
    ...clientA({
      workspace: { ...kernelFiles.workspace, archiveOnMerge: false },
      pr: { ...kernelFiles.pr, optionalChecks: ['Vercel*', 'codecov/patch'] },
      sources: { ...kernelFiles.sources, 'workspace.archiveOnMerge': 'override', 'pr.optionalChecks': 'shared' }
    }),
    branches: ['origin/main', 'origin/dev', 'main'],
    ...pushCheck('ok')
  }, 'settingsFiles'),
  // KERNEL-460: gh can push, but git has no login of its own, so the fix is gh auth setup-git.
  SettingsProjectGitPushFailed: projectPage('git', {
    ...clientA({ workspace: { ...kernelFiles.workspace, archiveOnMerge: false }, sources: { ...kernelFiles.sources, 'workspace.archiveOnMerge': 'override' } }),
    branches: ['origin/main', 'origin/dev', 'main'],
    ...pushCheck('failed')
  }),
  // KERNEL-460: git ls-remote couldn't resolve github.com, so the permission wasn't asked.
  SettingsProjectGitUnreachable: projectPage('git', {
    ...clientA({ workspace: { ...kernelFiles.workspace, archiveOnMerge: false }, sources: { ...kernelFiles.sources, 'workspace.archiveOnMerge': 'override' } }),
    branches: ['origin/main', 'origin/dev', 'main'],
    ...pushCheck('unreachable')
  }),
  // KERNEL-914: the Scripts page. A twelve-line setup script that overrides settings.toml, an empty archive script, and run scripts as rows. The list is one value, so the preview URLs' source shows on the first row.
  SettingsProjectScripts: scriptsPage,
  // KERNEL-914: the same page scrolled to the archive script, the run scripts as rows, Run mode and Ports.
  SettingsProjectScriptsRuns: scriptsPage,
  // KERNEL-914: a fresh project: both scripts empty, no run scripts, and nothing from settings.toml.
  SettingsProjectScriptsEmpty: projectPage('setup', clientA({
    scripts: { ...kernelFiles.scripts, setup: '', archive: '', run: '' },
    runScripts: [],
    sources: {}
  })),
  // KERNEL-914: Add a run script over the Scripts page, with a name and a command typed (scripts/shots.ts).
  SettingsRunScriptAdd: scriptsPage,
  // Redesign 15.38: Add preview URL over the Scripts page, with a name and an address typed (scripts/shots.ts).
  SettingsPreviewUrlForm: scriptsPage,
  // KERNEL-684: Setup is empty, and Kernel found a script in the repo's .conductor file. Archive has a value, so it offers nothing.
  SettingsProjectScriptsSuggestion: scene((f) => ({
    ...clientA({ scripts: { ...kernelFiles.scripts, setup: '' }, sources: Object.fromEntries(Object.entries(kernelFiles.sources ?? {}).filter(([k]) => k !== 'scripts.setup')) }),
    scriptSuggestions: { [ids.projectA]: [{ source: 'conductor', file: '.conductor/settings.toml', patch: { scripts: { setup: 'pnpm install\ncp ../../.env.local .env.local' } }, notes: ['The archive script was left out because this project already has one.'] }] },
    ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'setup' } }
  })),
  // KERNEL-254: names only, since a value only ever comes from env.reveal. Client A's list is its personal file, and one of the two files isn't there.
  SettingsEnvironment: settingsPage('env', { env: { app: ['GH_TOKEN', 'NPM_TOKEN', 'NODE_OPTIONS'] } }),
  // KERNEL-914: Files to copy sits under the env files, with the files it matches in the checkout.
  SettingsProjectEnvironment: projectEnvPage,
  // Redesign 15.27: Add env file over the project's Environment page, with a path typed (scripts/shots.ts).
  SettingsEnvironmentAdd: projectEnvPage,
  // Redesign 15.38: Add variable over the page, with the name and the value empty.
  SettingsEnvVariableForm: scene(() => ({ ...envProjectA, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'environment' }, modal: { name: 'envVar', projectId: ids.projectA } } })),
  // KERNEL-914: the Agents page with Permissions, Skills and MCP servers under the agents.
  SettingsProjectAgents: scene((f) => ({ ...projectPermissions(f), skills: ['setup', 'plan', 'feature'].map(skill), mcp: mcpServers, mcpAccounts: mcpAcrossAccounts, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  // Redesign 15.38: a retired agent under the team, with the folded Retired section opened (scripts/shots.ts).
  SettingsProjectAgentsRetired: scene((f) => ({ ...projectPermissions(f), agents: { ...f.agents, [ids.projectA]: [...sixAgents, { ...agentFile('mira', 'Mira', 'Brand designer', 'Designs logos and app icons'), member: false, retired: true, file: '.claude/retired-agents/mira.md' }] }, skills: ['setup', 'plan', 'feature'].map(skill), mcp: mcpServers, mcpAccounts: mcpAcrossAccounts, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  SettingsProjectPermissions: scene((f) => ({ ...projectPermissions(f), ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  // KERNEL-455: the project's mode menu is open, over Use app default.
  SettingsProjectPermissionsMode: scene((f) => ({ ...projectPermissions(f), ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' }, menu: 'projectMode' } })),
  // KERNEL-726: Client A changes the merge method, so the app page says so under the row and links to the project.
  SettingsPRs: settingsPage('prs', { settings: prSettings, ...clientA({ pr: { ...kernelFiles.pr, mergeMethod: 'rebase' }, sources: { ...kernelFiles.sources, 'pr.mergeMethod': 'local' } }) }),
  SettingsPRsWithoutReview: settingsPage('prs', { settings: { ...prSettings, pr: { ...prSettings.pr, autoMerge: { ...prSettings.pr.autoMerge, on: true, withoutReview: true } } } }),
  SettingsPRsMergeWithoutReview: settingsPage('prs', { settings: { ...prSettings, pr: { ...prSettings.pr, autoMerge: { ...prSettings.pr.autoMerge, on: true, withoutReview: true } } } }),
  // Redesign 15: Create PR's text in its sheet, with one edit saved so the footer says Saved. The edit is in scripts/shots.ts.
  SettingsPRsInstructions: settingsPage('prs', { settings: prSettings }),
  // KERNEL-727: a search for "size limit" landed here: the row is highlighted and its field has focus.
  SettingsPRsLanded: scene(() => ({ settings: prSettings, ...clientA({ pr: { ...kernelFiles.pr, mergeMethod: 'rebase' }, sources: { ...kernelFiles.sources, 'pr.mergeMethod': 'local' } }), ui: { route: { name: 'settings', page: 'prs', row: 'merge-method' } } })),
  // KERNEL-1066: the evidence comment setting, off by default, landed on from a search.
  SettingsPRsEvidenceComment: scene(() => ({ settings: prSettings, ui: { route: { name: 'settings', page: 'prs', row: 'evidence-comment' } } })),
  // KERNEL-721: Size limit typed and left, shown while main is still saving, just after it answered and after main clamped it. The typing is in scripts/shots.ts.
  SettingsPRsSaving: settingsPage('prs', { settings: prSettings }),
  SettingsPRsSaved: settingsPage('prs', { settings: prSettings }),
  SettingsPRsClamped: settingsPage('prs', { settings: prSettings }),
  SettingsPRsSavedLight: settingsPage('prs', { settings: { ...prSettings, appearance: { ...prSettings.appearance, theme: 'light' } } }),
  // KERNEL-252: the list and the ignored files in Client A's checkout, so the preview shows the 11 the canvas lists.
  SettingsProjectSetupFiles: scene((f) => ({
    ...clientA({ files: { copy: ['.env*', 'certs/*.pem', '.npmrc'], symlinkNodeModules: false } }),
    projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, path: '/Users/you/Projects/client-a' } : r)),
    localFiles: { [ids.projectA]: [...['.env', '.env.development', '.env.local', '.env.production', '.env.test', '.npmrc', 'certs/ca.pem', 'certs/dev.pem', 'certs/localhost.pem', 'certs/staging.pem', 'certs/wildcard.pem', '.DS_Store', 'certs/README.txt', 'dist/index.js'].map((path, i) => ({ path, size: 96 + i * 31 }))] },
    ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'environment' } }
  })),
  // KERNEL-449: two of those files look like production, so the warning sits above the list, by file and variable name.
  SettingsProjectSetupProduction: scene((f) => ({
    ...clientA({ files: { copy: ['.env*', 'certs/*.pem', '.npmrc'], symlinkNodeModules: false } }),
    projects: f.projects.map((r) => (r.id === ids.projectA ? { ...r, path: '/Users/you/Projects/client-a' } : r)),
    localFiles: { [ids.projectA]: [...['.env', '.env.development', '.env.local', '.env.production', '.env.test', '.npmrc', 'certs/ca.pem', 'certs/dev.pem', 'certs/localhost.pem', 'certs/staging.pem', 'certs/wildcard.pem', '.DS_Store', 'certs/README.txt', 'dist/index.js'].map((path, i) => ({ path, size: 96 + i * 31 }))] },
    production: { [ids.projectA]: [{ path: '.env', name: 'DATABASE_URL', why: 'remote-database' }, { path: '.env.production', name: 'STRIPE_SECRET_KEY', why: 'live-key' }] },
    ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'environment' } }
  })),
  // KERNEL-727: a search for "hook server port" lands inside the folded Advanced section, which opens first.
  SettingsHooksLanded: scene(() => ({ hooks: { port: 7420, listening: true, installed: true, events: hookEvents.filter((e) => e.name !== 'SessionStart') }, ui: { route: { name: 'settings', page: 'hooks', row: 'hook-port' } } })),
  SettingsHooks: settingsPage('hooks', { hooks: { port: 7420, listening: true, installed: true, events: hookEvents.filter((e) => e.name !== 'SessionStart') } }),
  // KERNEL-679: a dev run started inside a workspace says hooks are off in place of Install, with no snippet. No PNG.
  SettingsHooksWorkspaceRun: settingsPage('hooks', { hooks: { port: 4669, listening: true, installed: false, build: 'run', problem: { kind: 'workspace-run' }, events: hookEvents.map((e) => ({ ...e, installed: false, lastSeen: undefined })) } }),
  // KERNEL-493: Agents working at once is 4, so the Open workspaces row's first option reads "Same as agents working at once (4)".
  SettingsTeam: scene((f) => ({ ...clientA(), settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, agentLimit: 4 } }, agents: { ...f.agents, [ids.projectA]: sixAgents }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  // KERNEL-696: Kernel row in Roles as it ships (Default, Customize), and with the project's kernel.md (Customized, Open file, Reset to default).
  SettingsTeamKernelDefault: scene((f) => ({ ...clientA(), settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, agentLimit: 4 } }, agents: { ...f.agents, [ids.projectA]: sixAgents }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  SettingsTeamKernelCustomized: scene((f) => ({ ...clientA(), settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, agentLimit: 4 } }, agents: { ...f.agents, [ids.projectA]: sixAgents.map((a) => (a.lead ? { ...a, file: '/Users/you/Projects/client-a/.claude/agents/kernel.md' } : a)) }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  // KERNEL-742: the project's Lead file is rowan.md, so Kernel's row reads "Customized in rowan.md" with Open file and Move to kernel.md.
  SettingsTeamKernelElsewhere: scene((f) => ({ ...clientA(), settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, agentLimit: 4 } }, agents: { ...f.agents, [ids.projectA]: sixAgents.map((a) => (a.lead ? { ...a, file: '/Users/you/Projects/client-a/.claude/agents/rowan.md' } : a)) }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  // An empty project with another project that has agents: Add the team, Copy from another project and New agent. No PNG, built from the Settings kit.
  SettingsTeamEmpty: scene((f) => ({ ...clientA(), ...empty, projects: f.projects, agents: { ...f.agents, [ids.projectA]: [] }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  // KERNEL-639: the project's agents grouped by where they come from, scrolled to In this repo. Yours has a personal agent, and From plugins two with View, one with a long description cleaned to two lines.
  SettingsTeamOrigins: scene((f) => ({ ...clientA(), settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, agentLimit: 4 } }, agents: { ...f.agents, [ids.projectA]: [...sixAgents.filter((a) => ['kernel-lead', 'christian', 'sean', 'teng', 'artkin'].includes(a.id)), ...extraAgents] }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents' } } })),
  // KERNEL-641: Settings, Agents with no project open: Yours has a personal agent and From plugins two. No PNG, built from the Settings kit and AgentProfile.png's fields.
  SettingsAgents: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.projectA]: [...sixAgents, ...extraAgents] }, ui: { route: { name: 'settings', page: 'agents' } } })),
  // KERNEL-641: a personal agent's editor, opened from Settings, Agents: Back says Agents, and there is no status, workspace or recent work.
  // Pen 15.9: a repo agent, so Retire is there, and Pen 15.38: its description changed and Save changes pressed, which asks who gets the change.
  SettingsAgentEdit: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.projectA]: christianTeam }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents', agentId: 'christian' } } })),
  // Redesign 16.5: what Kernel noticed in an agent's file, above its fields, with Use Settings for a model Kernel doesn't recognize.
  AgentEditorNotices: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.projectA]: sixAgents.map((a) => (a.id === 'christian' ? { ...christianProfile, model: 'sonnet-4', warnings: [{ kind: 'model-unknown' as const }, { kind: 'cant-open-pr' as const }] } : a)) }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents', agentId: 'christian' } } })),
  SettingsAgentSaveScope: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.projectA]: sixAgents.map((a) => (a.id === 'christian' ? { ...christianProfile, description: 'Builds UI from plans.' } : a)) }, ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'agents', agentId: 'christian' } } })),
  // A personal agent's editor, opened from Settings, Agents (KERNEL-641): Back says Agents, and there is no Retire.
  SettingsAgentEditPersonal: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.projectA]: [...sixAgents, ...extraAgents] }, ui: { route: { name: 'settings', page: 'agents', agentId: 'ops' } } })),
  // KERNEL-641: a plugin's agent read only: the fields are disabled, the line names the plugin, and there is no Save changes or Retire.
  SettingsAgentEditPicker: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.projectA]: [...sixAgents, ...extraAgents] }, ui: { route: { name: 'settings', page: 'agents', agentId: 'ops' } } })),
  SettingsAgentPlugin: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.projectA]: [...sixAgents, ...extraAgents] }, ui: { route: { name: 'settings', page: 'agents', agentId: 'vercel:deployment-expert' } } })),
  // KERNEL-557: Client A's `[review]` as the canvas draws it (KERNEL-594: and its always-review paths). The code review runs as Kernel, so the project has no agent that reviews. Security runs as Artkin, and the UX review as Wren, which is optional.
  SettingsProjectPrs: projectPrs,
  // Redesign 15: the code review's details open, where it runs, who runs it, its model and whether it is required.
  SettingsProjectPrsDetails: projectPrs,
  // KERNEL-1064: no model or provider set on any review, so each reads Other provider from the builder (KERNEL-1059). Redesign 15: the merge method is the app's, so its row says so.
  SettingsProjectPrsDefault: scene((f) => ({
    ...clientA({
      review: {
        rounds: 2,
        kinds: {
          code: { enabled: true, paths: [], required: true },
          security: { enabled: true, paths: ['src/api/**', 'src/auth/**', 'db/migrations/**'], required: true, agent: 'artkin' },
          ux: { enabled: true, paths: ['src/renderer/**/*.tsx', '**/*.css'], required: false, agent: 'wren' }
        }
      },
      merge: { alwaysReview: ['src/billing/**', 'db/migrations/**'] },
      pr: { ...kernelFiles.pr },
      sources: { ...kernelFiles.sources }
    }),
    agents: { ...f.agents, [ids.projectA]: sixAgents.map((a) => ({ ...a, reviewer: false })) },
    ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'prs' } }
  })),
  // KERNEL-726: a shared review setting was just changed, so the page says to commit settings.toml.
  // KERNEL-726: settings.toml sets the merge method, so the row says Changed for this project and has no Reset.
  SettingsProjectPrsShared: scene((f) => ({
    ...clientA({
      review: {
        rounds: 2,
        kinds: {
          code: { enabled: true, paths: [], required: true, model: 'claude-opus-5-5', provider: 'claude' },
          security: { enabled: true, paths: ['src/api/**', 'src/auth/**', 'db/migrations/**'], required: true, agent: 'artkin', model: 'claude-opus-5-5', provider: 'claude' },
          ux: { enabled: true, paths: ['src/renderer/**/*.tsx', '**/*.css'], required: false, agent: 'wren', model: 'claude-sonnet-5-5', provider: 'claude' }
        }
      },
      // KERNEL-594: the shared `[merge] always_review`, as the canvas's box lists it.
      merge: { alwaysReview: ['src/billing/**', 'db/migrations/**'] },
      pr: { ...kernelFiles.pr, mergeMethod: 'rebase' },
      sources: { ...kernelFiles.sources, 'pr.mergeMethod': 'shared' }
    }),
    agents: { ...f.agents, [ids.projectA]: sixAgents.map((a) => ({ ...a, reviewer: false })) },
    ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'prs' } }
  })),
  // KERNEL-726: a shared review setting was just changed, so the page says to commit settings.toml.
  SettingsProjectPrsSaved: scene((f) => ({
    ...clientA({
      review: {
        rounds: 2,
        kinds: {
          code: { enabled: true, paths: [], required: true, model: 'claude-opus-5-5', provider: 'claude' },
          security: { enabled: true, paths: ['src/api/**', 'src/auth/**', 'db/migrations/**'], required: true, agent: 'artkin', model: 'claude-opus-5-5', provider: 'claude' },
          ux: { enabled: true, paths: ['src/renderer/**/*.tsx', '**/*.css'], required: false, agent: 'wren', model: 'claude-sonnet-5-5', provider: 'claude' }
        }
      },
      // KERNEL-594: the shared `[merge] always_review`, as the canvas's box lists it.
      merge: { alwaysReview: ['src/billing/**', 'db/migrations/**'] },
      pr: { ...kernelFiles.pr, mergeMethod: 'rebase' },
      sources: { ...kernelFiles.sources, 'pr.mergeMethod': 'local' }
    }),
    agents: { ...f.agents, [ids.projectA]: sixAgents.map((a) => ({ ...a, reviewer: false })) },
    ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA, section: 'prs' } }
  })),
  SettingsSkills: projectPage('agents', { ...clientA(), skills: ['setup', 'plan', 'feature', 'verify', 'image'].map(skill), mcp: mcpServers, mcpAccounts: mcpAcrossAccounts }),
  // KERNEL-893: the skills read is slow, so three skeleton rows stand in, and it fails, so the page says so and offers Try again.
  SettingsSkillsLoading: projectPage('agents', { ...clientA(), skills: ['setup', 'plan'].map(skill), mcp: mcpServers, mcpAccounts: mcpAcrossAccounts, lag: { 'skills.list': 60000 } }),
  SettingsSkillsFailed: projectPage('agents', { ...clientA(), mcp: mcpServers, mcpAccounts: mcpAcrossAccounts, fails: { 'skills.list': 'Could not read the skills folder.' } }),
  // KERNEL-661: twenty-seven servers as switches in a project, each with one word of status and the link to the global page.
  SettingsSkillsMany: projectPage('agents', { ...clientA(), skills: ['setup', 'plan'].map(skill), mcp: mcpAcrossServers, mcpAccounts: manyServers() }),
  // KERNEL-661: Settings, MCP servers opens on the active account, Work, with every server ready and folded into one line per group.
  SettingsMcpServersReady: mcpPage({}, {}),
  // KERNEL-661: the notice or Providers opens the page on Personal: sign-ins, a failure, connectors not set up and one ignored.
  SettingsMcpServers: mcpPage({}),
  // KERNEL-937: saved results on screen while both Claude Code accounts are checked again, Personal for the first time in 3 minutes.
  McpServersChecking: mcpPage({ mcpAccounts: [mcpAcrossAccounts[0], counted({ ...mcpAcrossAccounts[1], checking: true, checkedAt: undefined, servers: mcpAcrossAccounts[1].servers.map((s) => ({ ...s, state: 'checking' as const, error: undefined, note: undefined })) }), mcpAcrossAccounts[2]] }),
  // The check ran again while the saved results stayed on screen (KERNEL-937).
  McpServersCheckingSaved: mcpPage({ mcpAccounts: mcpAcrossAccounts.map((a) => ({ ...a, checking: true, checkedAt: Date.now() - 3 * 60_000 })) }),
  // KERNEL-937: Linear was just signed in by copying a login, and Claude Code hasn't said yet.
  McpServersCopiedSignIn: mcpPage({ mcpAccounts: [mcpAcrossAccounts[0], counted({ ...mcpAcrossAccounts[1], checking: true, servers: mcpAcrossAccounts[1].servers.map((s) => (s.name === 'Linear' ? { ...s, state: 'checking' as const } : s)) }), mcpAcrossAccounts[2]] }),
  // The Mac is offline, so what was ready reads Offline and the checks wait until it is back (Pen 15.35).
  McpServersOffline: mcpPage({ mcpAccounts: [{ ...mcpAcrossAccounts[0], checkedAt: Date.now() - 3 * 3600_000 }, mcpAcrossAccounts[1], mcpAcrossAccounts[2]], push: [{ type: 'online', online: false }] }, { account: 'cli' }),
  // KERNEL-937: the check failed, so Personal keeps the servers from 3 hours ago and a toast says why.
  McpServersCheckFailed: mcpPage({ mcpAccounts: [mcpAcrossAccounts[0], { ...mcpAcrossAccounts[1], checkedAt: Date.now() - 3 * 3600_000, error: 'Claude Code did not answer' }, mcpAcrossAccounts[2]] }),
  // KERNEL-661: Codex accounts that read the same show as one Codex tab, with a sign-in and two servers that are off on purpose.
  SettingsMcpServersCodex: mcpPage({ mcpAccounts: sharedCodex(), accounts: [workClaude, personalClaude, ownCodex, personalCodex] }, { tab: 'codex', account: 'cli' }),
  // KERNEL-661: twenty-seven servers on Personal at 1440x900.
  SettingsMcpServersMany: mcpPage({ mcpAccounts: manyServers() }),
  // KERNEL-661: Set up this account over Settings, MCP servers, with everything that needs Personal ticked.
  SettingsMcpSetUp: mcpPage({}),
  // KERNEL-661: Set up this account over Settings, MCP servers, with everything that needs Personal ticked.
  SettingsMcpSetUpAccount: mcpPage({ ui: { route: { name: 'settings', page: 'mcp', account: 'personal' }, modal: setUpModal } }),
  // KERNEL-661: signing in to Vercel, the second of five, with the claude.ai step waiting for the connectors.
  SettingsMcpSetUpAccountRunning: mcpPage({ ui: { route: { name: 'settings', page: 'mcp', account: 'personal' }, modal: setUpModal }, push: [{ type: 'account.mcpSignInAll', run: { ...setUpRun, connect: setUpConnect } }, { type: 'account.mcpConnect', connect: setUpConnect }] }),
  // Pen 15.35: one server is being added while the rest wait, so its row reads Setting up.
  SettingsMcpSetUpRunning: mcpPage({ mcpAccounts: [mcpAcrossAccounts[0], counted({ ...mcpAcrossAccounts[1], servers: mcpAcrossAccounts[1].servers.map((s) => (s.name === 'Linear' ? { ...s, state: 'checking' as const } : s)) }), mcpAcrossAccounts[2]], push: [{ type: 'account.mcpSignInAll', run: { accountId: 'personal', servers: ['Linear', 'claude.ai Google Drive'], current: 'claude.ai Google Drive', done: ['Linear'], failed: [] } }] }),
  // KERNEL-661: it ended with Vercel failed, the connectors left for claude.ai and one server ignored.
  SettingsMcpSetUpDone: mcpPage({ mcpAccounts: [mcpAcrossAccounts[0], counted({ ...mcpAcrossAccounts[1], servers: mcpAcrossAccounts[1].servers.map((s) => (s.name === 'Linear' ? { ...s, state: 'ready' as const } : s)) }), mcpAcrossAccounts[2]], push: [{ type: 'account.mcpSignInAll', run: { accountId: 'personal', servers: ['Linear'], done: ['Linear'], failed: [], finished: true } }] }),
  SettingsMcpSetUpAccountDone: mcpPage({ ui: { route: { name: 'settings', page: 'mcp', account: 'personal' }, modal: setUpModal }, push: [{ type: 'account.mcpSignInAll', run: { ...setUpRun, current: undefined, done: ['Linear'], failed: [{ server: 'Vercel', error: 'The sign-in was not finished in the browser.' }], finished: true, connect: setUpConnect } }] }),
  // Redesign 15: both services connected, as the page usually reads.
  SettingsIntegrations: settingsPage('integrations', { integrations: integrationRows.map((r) => (r.id === 'linear' ? { ...r, connected: true, detail: 'Read with an API token. Issues and comments.' } : r)) }),
  // Redesign 15: Connect pressed on Linear and a token typed.
  SettingsIntegrationsLinearToken: settingsPage('integrations', { integrations: integrationRows }),
  // Redesign 15: the read failed, so the card keeps a calm row with Try again and a toast carries the error.
  SettingsIntegrationsFailed: settingsPage('integrations', { integrations: integrationRows, fails: { 'integrations.list': 'gh did not answer within 10 seconds.' } }),
  // KERNEL-893: the integrations read is slow, so each row shows its name and a skeleton, with no Connect.
  SettingsIntegrationsLoading: settingsPage('integrations', { integrations: integrationRows, lag: { 'integrations.list': 60000 } }),
  SettingsProject: scene(settingsProject),
  SettingsProjectArchived: scene((f) => { const b = settingsProject(f); return { ...b, projects: (b.projects ?? f.projects).map((r) => (r.id === ids.projectA ? { ...r, archived: true } : r)) } }),
  // KERNEL-253: the project has its GitHub avatar and the Icon row's menu is open. The sidebar row for Client A shows it too.
  SettingsProjectIcon: scene((f) => {
    const project = settingsProject(f)
    return {
      ...project,
      projects: project.projects!.map((r) => (r.id === ids.projectA ? { ...r, icon: { kind: 'github' as const, file: `${ids.projectA}-1.png`, at: at(9, 0) } } : r)),
      projectIcons: { [ids.projectA]: invaderIcon },
      ui: { route: { name: 'settings', page: 'project', projectId: ids.projectA }, menu: 'projectIcon' }
    }
  }),
  // KERNEL-472: Client B's repo is on GitHub and Linear isn't connected, so detection says GitHub Issues, and the menu marks it.
  SettingsProjectTracker: trackerProject(ids.projectB, ['kernel-lead', 'sean', 'artkin'], { path: '/Users/you/Projects/client-b', repo: 'cjjutba/client-b' }, true),
  // KERNEL-472: Portfolio is a folder with no GitHub remote and no Linear, so there is nothing to detect and the tracker is None.
  SettingsProjectTrackerNone: trackerProject(ids.projectPortfolio, ['kernel-lead', 'christian'], { path: '/Users/you/Projects/portfolio', repo: undefined, kind: 'folder' }),
  // KERNEL-750: Client A's General page with no reference folders, then with two, one of them gone from this Mac.
  SettingsReferenceFoldersEmpty: scene(settingsProject),
  SettingsReferenceFolders: scene((f) => {
    const project = settingsProject(f)
    const rs = project.projectSettings![ids.projectA]
    return { ...project, projectSettings: { [ids.projectA]: { ...rs, references: ['/Users/you/Projects/client-a-api', '/Users/you/Projects/design-system'], missingReferences: ['/Users/you/Projects/design-system'] } } }
  }),
  DevUi: { ...gallery('components'), motion: { action: { hold: 'Deny' }, ms: 400, area: '.devui-row' } },
  DevUiDisplay: { ...gallery('display'), motion: { action: { press: [] }, ms: 800, area: '.devui-row' } },
  DevUiStates: gallery('states'),
  DevUiOverlays: gallery('overlays'),
  DevUiDialogs: gallery('dialogs'),
  // KERNEL-1088: the K mark. The settings save that follows it is held, as the shot's finished animation would open New chat otherwise.
  Splash: { ...scene(() => ({ ...empty, settings: setupDone(), ui: { route: { name: 'onboarding', step: 'splash' } } })), hold: ['settings.set'] },
  // KERNEL-217: boot failed. The Loading layout with the error and Try again. No PNG.
  LoadingError: scene(() => ({ ...empty, ui: { route: { name: 'onboarding', step: 'loading' }, startError: 'Could not read the Kernel database. Quit Kernel and open it again.' } })),
  LoadingApp: scene((f) => ({ ...sixRunning(f), ui: { route: { name: 'onboarding', step: 'loading' } } })),
  CheckHooks: scene((f) => ({
    ...sixRunning(f),
    hooks: { port: 7420, listening: true, installed: true, events: hookEvents },
    ui: { route: { name: 'inbox' }, modal: { name: 'checkHooks' } }
  })),
  CheckHooksNotWritable: hooksProblem({ kind: 'not-writable', code: 'EACCES', file: '~/.claude/settings.json', dir: '~/.claude', fix: 'sudo chown -R "$USER" ~/.claude' }),
  CheckHooksReadOnly: hooksProblem({ kind: 'read-only', code: 'EROFS', dir: '~/.claude', disk: 'Work', fix: 'sudo mount -uw /Volumes/Work' }),
  CheckHooksSymlink: hooksProblem({ kind: 'symlink', code: 'EROFS', file: '~/.claude/settings.json', store: '/nix/store', nix: true, fix: 'rm ~/.claude/settings.json &&\ncp /nix/store/p3v8kq-settings.json ~/.claude/settings.json' }),
  CheckHooksManaged: hooksProblem({ kind: 'managed', setting: 'allowManagedHooksOnly', source: '/Library/Application Support/ClaudeCode/managed-settings.json', block: '{\n  "hooks": {}\n}' }, true),
  CheckHooksOff: hooksProblem({ kind: 'off', file: '~/.claude/settings.json' }, true),
  // The four Setup PNGs below draw a failing check as a blocking one (red x, Continue off), so these fixtures mark theirs blocking. preflight.ts decides which checks block in real runs (KERNEL-213).
  SetupClaudeMissing: setup(failing({ id: 'claude', ok: false, blocking: true, title: 'Claude Code not found', detail: 'Kernel runs agents with its own copy. Install Claude Code to sign in from Terminal.', meta: 'v2.1.284', fix: { command: 'curl -fsSL https://claude.ai/install.sh | bash' } })),
  SetupClaudeOld: setup(failing({ id: 'claude', ok: false, blocking: true, title: 'Claude Code is too old', detail: 'Found v2.0.14. Agent teams need v2.1.32 and Channels need v2.1.80 or later. Update Kernel to get a newer one.', meta: 'v2.0.14' })),
  SetupGhSignedOut: setup(failing({ id: 'gh', ok: false, blocking: true, title: 'GitHub CLI is not signed in', detail: 'Kernel uses gh to open and merge pull requests. Everything else works without it.', fix: { command: 'gh auth login' } })),
  // KERNEL-217: what a failing gh really looks like. A warning icon and Continue on. No PNG.
  SetupGhWarning: setup(failing({ id: 'gh', ok: false, blocking: false, title: 'GitHub CLI is not signed in', detail: 'Kernel uses gh to open and merge pull requests. Everything else works without it.', fix: { command: 'gh auth login' } })),
  SetupPortBusy: setup(failing({ id: 'hooks', ok: false, blocking: true, title: 'Port 7420 is taken', detail: 'Another process (node, pid 4821) is using it. Kernel can listen on 7421 and update your hooks.', fix: { action: 'use-next-port' } })),
  // KERNEL-865: the fix fails with checks already on screen, so the status bar says why. The motion clicks the fix.
  SetupPortBusyFixFailed: { ...setup(failing({ id: 'hooks', ok: false, blocking: true, title: 'Port 7420 is taken', detail: 'Another process (node, pid 4821) is using it. Kernel can listen on 7421 and update your hooks.', fix: { action: 'use-next-port' } })), preflightFixError: 'Port 7421 is also in use.', motion: { action: { click: 'Use 7421' }, ms: 600 } },
  // KERNEL-448: what Kernel read from the login shell, as the KERNEL-437 PNGs draw it.
  SetupGhIdentity: setup(passing({ ...ghOk, detail: 'Signed in as cjjutba, from the keyring', note: '`GH_TOKEN` is set in your shell. Kernel leaves it out, because gh would use it instead of this login.' })),
  SetupGhToken: setup(passing({ ...ghOk, detail: 'Signed in as cjjutba-bot, from `GH_TOKEN` in your shell', note: 'Kernel passes it on because gh has no stored login.' })),
  SetupShellTimeout: setup([{ id: 'shell', ok: false, blocking: false, title: 'Reading your shell timed out', detail: 'Kernel reads PATH and proxy settings from your login shell and gave up after 10 seconds. Tools from nvm, or a proxy set in `.zshrc`, may be missing until it can.', note: 'Look in `.zshrc` for a slow command, or one that waits for an answer, like an update prompt.', fix: { action: 'recheck' } }, ...allOk]),
  SetupBedrock: setup(passing({ id: 'auth', ok: true, blocking: true, title: 'Using Bedrock from your shell', detail: 'Agents bill your AWS account. No Claude sign-in needed.', note: '`CLAUDE_CODE_USE_BEDROCK` is set in your shell.', meta: 'us-east-1' })),
  // KERNEL-1088: the four first-run steps. Each state of the 1.12 sheet is one fixture, named as the sheet names it.
  OnboardingChecks: firstRun('checks'),
  OnboardingChecksRunning: firstRun('checks', { hold: ['preflight.run'] }),
  ChecksRequiredFailed: firstRun('checks', { preflight: stepChecks({ id: 'claude', ok: false, blocking: true, title: 'Claude Code not found', detail: 'Kernel runs agents with its own copy. Install Claude Code to sign in from Terminal.', fix: { command: 'curl -fsSL https://claude.ai/install.sh | bash' } }) }),
  ChecksOptionalMissing: firstRun('checks', { preflight: stepChecks({ id: 'gh', ok: false, blocking: false, title: 'GitHub CLI is not installed', detail: 'Kernel uses gh to open and merge pull requests. Everything else works without it.', fix: { command: 'brew install gh' } }) }),
  ChecksPortTaken: firstRun('checks', { preflight: stepChecks({ id: 'hooks', ok: false, blocking: true, title: 'Port 7420 is taken', detail: 'Another app is using it. Kernel can listen on 7421 and update your hooks.', fix: { action: 'use-next-port' } }) }),
  OnboardingAccounts: firstRun('accounts', { accounts: [claudeAccounts[0]!] }),
  ClaudeSignedOut: firstRun('accounts', { accounts: [], preflight: stepChecks({ id: 'auth', ok: false, blocking: true, title: 'Not signed in to Claude', detail: 'Agents run on your own Claude plan.', fix: { command: 'claude auth login' } }) }),
  ClaudeBedrock: firstRun('accounts', { accounts: [], preflight: stepChecks({ id: 'auth', ok: true, blocking: true, title: 'Using Bedrock from your shell', detail: 'Agents bill your AWS account. No Claude sign-in needed.', note: '`CLAUDE_CODE_USE_BEDROCK` is set in your shell.', meta: 'us-east-1' }) }),
  SecondAccount: firstRun('accounts', { accounts: claudeAccounts }),
  OnboardingTeam: firstRun('team', { accounts: [claudeAccounts[0]!], models: { codex: codexModels }, settings: teamSettings }),
  OnboardingTeamModel: firstRun('team', { accounts: [claudeAccounts[0]!, ...codexAccounts], models: { codex: codexModels }, settings: teamSettings }, 'obModel'),
  CodexUnavailable: firstRun('team', { accounts: [claudeAccounts[0]!], models: { codex: codexModels }, settings: withRoles({ qa: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }) }),
  ReviewerMenu: firstRun('team', { accounts: [claudeAccounts[0]!], models: { codex: codexModels }, settings: teamSettings }, 'obReviewer'),
  PermissionMenu: firstRun('team', { accounts: [claudeAccounts[0]!], models: { codex: codexModels }, settings: teamSettings }, 'obMode'),
  OnboardingNewAgent: ({ ...firstRun('team', { accounts: [claudeAccounts[0]!], models: { codex: codexModels } }), ui: { route: { name: 'onboarding', step: 'team' }, modal: { name: 'newAgent', step: 'describe', prefill: { name: 'Wren', model: 'sonnet' } } } }),
  OnboardingLoop: firstRun('loop'),
  UsageUnpicked: firstRun('loop', {}, 'obAllowed'),
  NotificationsAllowed: firstRun('loop', {}, 'obAllowed'),
  NotificationsDenied: firstRun('loop', {}, 'obDenied'),
  SettingsRunOnboarding: settingsPage('general'),
  // KERNEL-28: failure banners. Each one is the state main would push: usage, account, network, retry, setup, hooks.
  WorkspaceSessionLimit: scene(() => ({ usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }], ui: open })),
  // KERNEL-406: Christian on Claude hit its 5-hour limit while Codex runs other roles, and a second Claude account has headroom.
  WorkspaceProviderLimit: scene(() => ({
    settings: withRoles({ qa: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }),
    accounts: claudeAccounts,
    usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }, { type: 'five_hour', status: 'allowed', utilization: 0.12, resetsAt: secs(next(15, 40)), accountId: 'work' }],
    ui: open
  })),
  // KERNEL-1056: Christian's chat started on Codex because every Claude account was at its limit, so one plain line says so above the composer.
  WorkspaceFellBack: scene((f) => ({
    chats: f.chats.map((c) => (c.id === ids.tableChat ? { ...c, provider: 'codex' as const, model: 'gpt-6-astra' } : c)),
    push: [...f.push, { type: 'providerFellBack', workspaceId: ids.table, from: 'claude', to: 'codex' }],
    ui: open
  })),
  // KERNEL-524: the account on offer is an API key, so the banner says it is billed per token. Christian's project runs on Codex too, as in the one above.
  WorkspaceProviderLimitApiKey: scene(() => ({
    settings: withRoles({ qa: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }),
    accounts: [claudeAccounts[0], keyAccount('claude')],
    usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }],
    ui: open
  })),
  // KERNEL-619: the only other account is signed out, so the banner says so and offers its sign-in beside Notify me. Christian's project runs on Codex too, as in the ones above.
  WorkspaceProviderLimitSignedOut: scene(() => ({
    settings: withRoles({ qa: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }),
    accounts: [workClaude, { ...personalClaude, signedIn: false }],
    usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }],
    ui: open
  })),
  // KERNEL-569: Work is at 90% of its 5-hour window and Personal has headroom, so the banner offers the move before the limit. Switching at a limit is off.
  WorkspaceProviderNearLimit: scene(() => ({
    accounts: [workClaude, personalClaude],
    usage: [window5('claude', 'cli', 90, next(15, 40)), window5('claude', 'personal', 8, next(17, 10))],
    ui: open
  })),
  // KERNEL-569: the chat after a switch to Personal, plain and after Work hit its 5-hour limit. The footer says Personal's plan.
  WorkspaceAccountNote: scene(() => ({
    account: personalAccount,
    accounts: [{ ...workClaude, active: false }, { ...personalClaude, active: true }],
    items: { [ids.tableChat]: afterSwitch('Moved to Personal and re-read 310k tokens') },
    ui: open
  })),
  WorkspaceAccountNoteLimit: scene(() => ({
    account: personalAccount,
    accounts: [{ ...workClaude, active: false }, { ...personalClaude, active: true }],
    items: { [ids.tableChat]: afterSwitch('Moved to Personal and re-read 310k tokens (Work hit its 5-hour limit)') },
    ui: open
  })),
  // KERNEL-619: after a switch to Personal, whose plan lacks Opus 5.5, which Artkin and Sean use. The banner offers the way back and the place to pick another model.
  WorkspaceSwitchWarning: scene(() => ({
    account: personalAccount,
    accounts: [{ ...workClaude, active: false }, { ...personalClaude, active: true, missingModels: [{ model: 'claude-opus-5-5', label: 'Opus 5.5', agents: ['Artkin', 'Sean'] }] }],
    ui: open
  })),
  WorkspaceWeeklyLimit: scene(() => ({ usage: [{ type: 'seven_day', status: 'rejected', utilization: 1, resetsAt: secs(nextMonday()) }], ui: open })),
  // Fable has no window name of its own in rate_limit_event, so the fixture tags a per-model window with the model.
  WorkspaceModelLimit: scene((f) => ({
    chats: withChat(f, { model: 'claude-fable-5-1' }),
    usage: [{ type: 'seven_day_opus', status: 'rejected', utilization: 1, resetsAt: secs(Date.now() + 3 * 24 * 3600_000 - 3600_000), model: 'claude-fable-5-1' }],
    ui: open
  })),
  WorkspaceContext: scene((f) => ({ chats: withChat(f, { context: 92 }), ui: open })),
  // KERNEL-224: the 5-hour window is at 91%, so teammates' new work waits, and the queued message says why. Same banner layout as WorkspaceSessionLimit, not blocking. No PNG.
  WorkspaceNearLimit: scene((f) => {
    const queue = [{ id: 'q-near', chatId: ids.tableChat, parts: [{ type: 'text' as const, text: 'Also add a loading skeleton to the table.' }], ts: at(10, 40) }]
    return {
      usage: [{ type: 'five_hour', status: 'allowed', utilization: 0.91, resetsAt: secs(next(15, 40)) }],
      queue: { [ids.tableChat]: queue },
      push: [...f.push, { type: 'chat.queue', chatId: ids.tableChat, queue, why: 'limit' }],
      ui: open
    }
  }),
  // KERNEL-595: 85% of the week is used, so any workspace says so, with a close button on hover. Same banner layout as WorkspaceNearLimit, not blocking. No PNG.
  WorkspaceWeeklyWarn: scene(() => ({ usage: [{ type: 'seven_day', status: 'allowed', utilization: 0.85, resetsAt: secs(nextMonday()) }], ui: open })),
  // The retry is between attempts, so the turn shows as the canvas draws it: no Stop button.
  WorkspaceOverloaded: scene((f) => ({
    items: { [ids.tableChat]: [...tableItems, { kind: 'user', id: 'u-shorten', ts: at(10, 40), parts: [{ type: 'text', text: 'Shorten the empty state copy.' }] }] },
    push: [...f.push, { type: 'retry', chatId: ids.tableChat, retry: { attempt: 2, of: 5, nextAt: Date.now() + 14_000 } }],
    ui: open
  })),
  WorkspaceOffline: scene((f) => {
    const queue = [{ id: 'q-offline', chatId: ids.tableChat, parts: [{ type: 'text' as const, text: 'Also add a loading skeleton.' }], ts: at(10, 40) }]
    // The queue's note comes from the reason the engine pushes with it (KERNEL-273).
    return {
      queue: { [ids.tableChat]: queue },
      push: [...f.push, { type: 'online', online: false }, { type: 'chat.queue', chatId: ids.tableChat, queue, why: 'offline' }],
      ui: open
    }
  }),
  // Main keeps the last name it read when a session reports the sign-out, so the account menu still says who.
  WorkspaceSignedOut: scene(() => ({ account: { signedIn: false, name: 'Sam Rivera', login: 'cjjutba', plan: 'Claude Max' }, ui: open })),
  // KERNEL-941: an added account in use signed out. The banner names it and its Sign in opens its row in Settings, Accounts.
  WorkspaceSignedOutAdded: scene(() => ({ account: { signedIn: false, name: 'Personal', plan: 'Claude Pro' }, accounts: [{ ...workClaude, active: false }, { ...personalClaude, active: true, signedIn: false }], ui: open })),
  // KERNEL-218: the dialog the banner's Review opens, over the held workspace.
  // KERNEL-1093: the Setup tab after a run failed. The log keeps pnpm's output and its last line, with Edit script and Run again under it. The toast already said so and has gone.
  WorkspaceSetupFailed: scene((f) => {
    const w = along(f, { setup: 'failed', steps: 3, pane: true, right: 'files', secs: 72, quiet: true })
    return {
      ...clientA({ scripts: { ...kernelFiles.scripts, setup: 'pnpm install --frozen-lockfile' } }),
      ...w,
      push: [
        ...f.push,
        { type: 'chat.running', chatId: ids.tableChat, running: true },
        { type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line: '$ pnpm install --frozen-lockfile', stream: 'stdout' }] },
        { type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date', stream: 'stderr' }] },
        { type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line: 'Setup failed with exit code 1', stream: 'stderr' }] },
        setupData(ids.table, SETUP_RAW.frozen),
        { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 1 }
      ]
    }
  }),
  // The Lead's chat sets up the same way, silently, and when its setup fails Kernel keeps working (KERNEL-1093).
  WorkspaceLeadSetup: scene((f) => leadAlong(f, false)),
  WorkspaceLeadSetupFailed: scene((f) => leadAlong(f, true)),
  // A worktree deleted outside Kernel (KERNEL-291): the banner says so and offers Archive, and the composer waits.
  WorkspaceFolderMissing: scene((f) => ({ workspaces: withWorkspace(f, ids.table, { folderGone: true }), ui: open })),
  WorkspaceHooksDown: scene(() => ({ hooks: { port: 7420, listening: false, installed: true, events: hookEvents }, ui: open })),
  // KERNEL-401: a GitHub rate limit holds PR reads off until 3:41 PM, over a PR that passed its checks.
  // Pen 12.1: a branch that is up to date archives with one button.
  ConfirmArchive: scene((f) => ({
    gitStatus: { [ids.table]: { branch: 'feat/t-14-invoice-table', ahead: 0, behind: 0, dirty: { files: 0, added: 0, removed: 0 } } },
    push: f.push,
    ui: { ...open, modal: { name: 'confirm', kind: 'archive', workspaceId: ids.table } }
  })),
  // Two commits that never reached GitHub: the main button pushes first, and Archive anyway leaves them on the local branch.
  ConfirmArchiveUnpushed: scene((f) => ({
    gitStatus: { [ids.table]: { branch: 'feat/t-14-invoice-table', ahead: 2, behind: 0, dirty: { files: 0, added: 0, removed: 0 } } },
    push: f.push,
    ui: { ...open, modal: { name: 'confirm', kind: 'archive', workspaceId: ids.table } }
  })),
  // Its PR is still open: archiving stops Kernel watching it but leaves it open on GitHub, and the box says so before it goes (Pen 12.3).
  ConfirmArchiveOpenPr: scene((f) => ({
    workspaces: withWorkspace(f, ids.table, { prNumber: 43, prState: 'ready' }),
    gitStatus: { [ids.table]: { branch: 'feat/t-14-invoice-table', ahead: 0, behind: 0, dirty: { files: 2, added: 34, removed: 6 } } },
    push: f.push,
    ui: { ...open, modal: { name: 'confirm', kind: 'archive', workspaceId: ids.table } }
  })),
  ConfirmDiscard: scene(() => ({ ui: { ...open, modal: { name: 'confirm', kind: 'discard', workspaceId: ids.table } } })),
  // KERNEL-455: the first switch into Bypass permissions, with Only in worktrees on.
  ConfirmBypass: scene(() => ({ ui: { ...open, modal: { name: 'confirm', kind: 'bypass' } } })),
  // UX audit (app shell and platform): states the screens above leave out. See docs/audits/ux-platform.md.
  // Redesign 15: the Version card for each thing the updater does. A failed check or install is a toast, and the card stays calm. Kernel raises the install toast itself when it loads.
  AuditAboutChecking: aboutPage({ status: 'checking', current: '0.43.2' }),
  AuditAboutDownloading: aboutPage({ status: 'downloading', current: '0.43.2', version: '0.44.0', progress: 62 }),
  AuditAboutUpdateError: aboutPage({ status: 'error', current: '0.43.2', error: 'net::ERR_CONNECTION_TIMED_OUT' }, [{ id: 'upd', title: "Couldn't check for updates", sub: 'Could not reach the update server.', glyph: 'error', action: { label: 'Try again', retry: 'update', primary: true } }]),
  AboutInstallFailedSignature: aboutPage({ status: 'idle', current: '0.43.2', installFailed: { version: '0.44.0', reason: 'signature' } }),
  AboutInstallFailedOther: aboutPage({ status: 'idle', current: '0.43.2', installFailed: { version: '0.44.0', reason: 'other' } }),
  AuditAboutUpdateBlocked: aboutPage({ status: 'idle', current: '0.43.2', blocked: 'Kernel 0.44.0 is ready, but this copy runs from Downloads. Move Kernel to Applications to update.' }),
  // The home screen while an update downloads, a quiet footer line, or when the download failed: the footer goes back to its round button and a toast says why.
  AuditHomeUpdateDownloading: { ...teamFixtures.UpdateReady, update: { status: 'downloading', current: '0.43.0', version: '0.44.0', progress: 62 } },
  AuditHomeUpdateError: { ...teamFixtures.UpdateReady, update: { status: 'error', current: '0.43.0', version: '0.44.0', error: 'net::ERR_CONNECTION_TIMED_OUT' }, ui: { ...teamFixtures.UpdateReady.ui, toasts: [{ id: 'upd-download', title: "Couldn't download Kernel 0.44.0", sub: "GitHub releases didn't answer.", glyph: 'error', action: { label: 'Try again', retry: 'update-check', primary: true } }] } },
  // Redesign 18 (Pen 18.3): three toasts at once (merged, failed, plain), one with a long title and sub, and one over the Session rail and the composer, to see where a toast sits.
  AuditToastsStacked: { ...workspaceFixtures.WorkspaceTurnRunning, ui: { ...workspaceFixtures.WorkspaceTurnRunning.ui, toasts: [
    { id: 't1', glyph: 'merged', title: 'PR #1151 merged', sub: 'Noor squashed it into main.', action: { label: 'View', href: 'https://github.com/kernel/kernel/pull/1151' } },
    { id: 't2', glyph: 'error', title: "Couldn't push to origin", sub: 'git rejected the push: authentication failed.', action: { label: 'Try again', primary: true, route: { name: 'inbox' } } },
    { id: 't3', glyph: 'done', title: 'Copied', sub: 'The message is on the clipboard.' }
  ] } },
  AuditToastLong: { ...workspaceFixtures.WorkspaceTurnRunning, ui: { ...workspaceFixtures.WorkspaceTurnRunning.ui, toasts: [
    { id: 'long', glyph: 'error', title: "Couldn't start the dev server for kernel-232a-clean-account", sub: "Port 4400 is in use by another process, and Kernel couldn't free it. Stop that process, or change the port in Project settings, Scripts.", other: { label: 'Open Scripts', route: { name: 'inbox' } }, action: { label: 'Try again', primary: true, route: { name: 'inbox' } } }
  ] } },
  AuditToastPlacement: { ...workspaceFixtures.Workspace, ui: { ...workspaceFixtures.Workspace.ui, toasts: [
    { id: 'place', glyph: 'done', title: 'Branch copied', sub: 'test/kernel-232a-clean-account' }
  ] } },
  // A turn running and a toast up, and Settings with a toast up: Escape goes to the open thing first, the screen next, the toast last (KERNEL-878).
  AuditEscapeTurnToast: { ...workspaceFixtures.WorkspaceTurnRunning, ui: { ...workspaceFixtures.WorkspaceTurnRunning.ui, toasts: [{ id: 'esc', title: 'Could not save the setting' }] } },
  AuditEscapeSettingsFieldToast: projectGitToast,
  AuditEscapeSettingsToast: { ...settingsPage('general'), ui: { ...settingsPage('general').ui, toasts: [{ id: 'esc', title: 'Could not save the setting' }] }, motion: { action: { press: ['Escape', 'Escape'] }, ms: 800 } },
  // First launch: no project, no chat, no workspace, on Home and in the checks that hang.
  AuditFirstLaunchHome: scene(() => ({ ...empty, ui: { route: { name: 'inbox' } } })),
  AuditSetupChecksWaiting: { ...setup([]), hold: ['preflight.run'] },
  // The same call past the time limit, drawn with the limit shortened so a shot can reach it.
  AuditSetupChecksSlow: { ...setup([]), hold: ['preflight.run'], ui: { ...onboarding, preflightLimitMs: 300 } },
  AuditSidebarWide: teamFixtures.UpdateReady
}
