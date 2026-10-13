import type { AccountProfile, AgentDef, AppSettings, ChatItem, DevUiPage, HookProblem, HookStatus, Integration, McpAccount, McpAccountServer, McpServer, McpSignInAll, Modal, PreflightCheck, Provider, ProviderModel, PushCheck, RateLimit, Room, RoomSettings, RoomSettingsSection, ScriptLine, SettingsPage, Skill, TerminalPreset } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { mcpCounts } from '@shared/mcpCounts'
import { DEFAULT_SETTINGS } from '../src/main/services/settings'
import type { Fixture } from './types'
import { teamFixtures } from './team'
import { SETUP_RAW, setupData, workspaceFixtures } from './workspace'
import { at, base, ids, invaderIcon, scene, tableItems, withWorkspace } from './base'

// Platform lane: setup checks (KERNEL-27), limits and setup failures (KERNEL-28).
// Check copy matches src/main/services/preflight.ts.

const onboarding = { route: { name: 'onboarding', step: 'checks' } } as const
const permissionStep = { route: { name: 'onboarding', step: 'permissions' } } as const
const open = { route: { name: 'workspace', workspaceId: ids.table } } as const
const empty = { rooms: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [] }

// The checks, in canvas order. Copy matches src/main/services/preflight.ts.
const claudeOk: PreflightCheck = { id: 'claude', ok: true, blocking: false, title: 'Claude Code', detail: 'Found on your PATH', meta: 'v2.1.284' }
const authOk: PreflightCheck = { id: 'auth', ok: true, blocking: true, title: 'Signed in', detail: 'Claude Max' }
const ghOk: PreflightCheck = { id: 'gh', ok: true, blocking: false, title: 'GitHub CLI', detail: 'Signed in as samrivera', meta: 'gh 2.62' }
const hooksOk: PreflightCheck = { id: 'hooks', ok: true, blocking: true, title: 'Hook server', detail: 'Listening for events', meta: 'localhost:7420' }
const allOk = [claudeOk, authOk, ghOk, hooksOk]
/** Every check passing except the one at `id`, which is replaced by `failing`. */
const failing = (failed: PreflightCheck) => allOk.map((c) => (c.id === failed.id ? failed : c))
/** Every check passing, the one at `id` with more to say (KERNEL-437). */
const passing = (row: PreflightCheck) => allOk.map((c) => (c.id === row.id ? row : c))

const setup = (checks: PreflightCheck[]) => scene(() => ({ ...empty, preflight: checks, ui: onboarding }))

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
  ui: { route: { name: 'home' }, modal: { name: 'checkHooks' } }
}))

/** `resetsAt` is epoch seconds, as rate_limit_event sends it. */
const secs = (ms: number) => Math.round(ms / 1000)
/** The next h:m from now, so a reset is always ahead and within a day ("Resets at 3:40 PM"). */
const next = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime() }
/** Today at `h`:`m`, past or not: when a token account's last turn read its usage. */
const todayAt = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() }
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d.getTime() }
/** Kai's next turn on the invoice table, after a move to another account: the note, then three tool calls and the reply (KERNEL-569). */
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

// KERNEL-25: the app-wide settings pages. The seed's rooms fill the nav; Account adds the three usage windows the canvas shows.
const settingsPage = (page: SettingsPage, extra: Partial<Fixture> = {}) => scene(() => ({ ...extra, ui: { route: { name: 'settings', page } } }))
/** One of Client A's room pages (KERNEL-191). */
const roomPage = (section: RoomSettingsSection, extra: Partial<Fixture> = {}, menu?: 'settingsFiles') => scene(() => ({ ...extra, ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section }, ...(menu ? { menu } : {}) } }))
/** Settings with some roles moved, the rest as Kernel ships them (KERNEL-406). */
const withRoles = (roles: Partial<AppSettings['models']['roles']>): AppSettings => {
  const d = DEFAULT_SETTINGS('/Users/you')
  return { ...d, models: { ...d.models, roles: { ...d.models.roles, ...roles } } }
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
const personalAccount = { signedIn: true, name: 'Sam Rivera', login: 'samrivera', email: 'cj@jutba.example', plan: 'Claude Pro' }
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
const fableWindow: RateLimit = { type: 'seven_day_opus', status: 'allowed_warning', utilization: 0.9, resetsAt: secs(nextOn(1, 9, 0)), model: 'claude-fable-5-1' }
/** The home screen with the Usage popover open over the sidebar (KERNEL-619). */
const usagePopover = (extra: Partial<Fixture>): Fixture => ({ ...teamFixtures.Home, usage: [...providerUsage(), fableWindow], ...extra, ui: { route: { name: 'home' }, menu: 'plan' } })
/** Settings, Providers on one tab, with each account's nickname, plan and usage windows (KERNEL-561). */
const providersPage = (tab: Provider, extra: Partial<Fixture> = {}) => scene(() => ({
  accounts: richAccounts,
  providerStatus,
  usage: providerUsage(),
  ...extra,
  ui: { route: { name: 'settings', page: 'providers', tab } }
}))
/** The Add account sheet is opened from the page's button, and a sign-in that waits on the browser is the engine's `account.add` step. */
const addAccountPage = (tab: Provider, step?: 'browser' | 'code') => providersPage(tab, step ? { push: [{ type: 'account.add', add: { provider: tab, step, url: tab === 'claude' ? 'https://claude.ai/oauth/authorize' : 'https://auth.openai.com/oauth/authorize' } }] } : {})
const accountUsage: RateLimit[] = [
  { type: 'five_hour', status: 'allowed', utilization: 0.62, resetsAt: secs(next(15, 40)) },
  { type: 'seven_day', status: 'allowed', utilization: 0.38, resetsAt: secs(nextMonday()) },
  { type: 'seven_day_opus', status: 'allowed_warning', utilization: 0.9, resetsAt: secs(nextMonday()), model: 'claude-fable-5-1' }
]

// KERNEL-26, KERNEL-191: the room pages read their own room's .kernel files, so the fixture gives Client A the values the canvas shows.
// `sources` says which file set what: both files are there, so the settings files button offers both.
const kernelFiles: RoomSettings = {
  scripts: { setup: 'pnpm install\ncp ../../.env.local .env.local', run: 'pnpm dev --port $KERNEL_PORT', archive: 'docker compose down', runMode: 'concurrent' },
  runScripts: [{ name: 'run', command: 'pnpm dev --port $KERNEL_PORT' }],
  files: { copy: ['.env.local', '.env.test', 'certs/*.pem'], symlinkNodeModules: false },
  workspace: { baseRef: 'origin/dev' },
  disabled: { skills: [], mcp: ['Figma'] },
  pr: { createInstructions: '# Create a pull request\n1. Rebase on origin/dev and run pnpm test\n2. Title it as a Conventional Commit\n3. Fill in summary, scope and risk\n4. Link the Linear issue in the description' },
  preview: { urls: [] },
  env: { files: [] },
  sources: { 'scripts.setup': 'shared', 'scripts.run': 'override', 'files.copy': 'shared', 'workspace.baseRef': 'override', 'pr.createInstructions': 'override' }
}
const clientA = (extra: Partial<RoomSettings> = {}) => ({ roomSettings: { [ids.roomA]: { ...kernelFiles, ...extra } } })
/**
 * Client A's push check (KERNEL-460): both rows pass, gh can push but git isn't using its login, or origin is out of reach.
 * Checked two minutes before the shot, or just now for the unreachable one, as the drawings say.
 */
const pushCheck = (state: 'ok' | 'failed' | 'unreachable'): Pick<Fixture, 'pushChecks'> => {
  const check: PushCheck = {
    remote: 'origin', repo: 'samrivera/client-a', login: 'samrivera', at: Date.now() - (state === 'unreachable' ? 0 : 2 * 60_000),
    reach: { state: 'ok', detail: 'git ls-remote origin' },
    push: state === 'failed'
      ? { state: 'fail', detail: 'gh is signed in as samrivera, but git isn\u2019t using that login.', fix: 'gh auth setup-git' }
      : { state: 'ok', detail: 'From gh, signed in as samrivera' }
  }
  if (state === 'unreachable') {
    check.reach = { state: 'fail', detail: 'git ls-remote origin', output: 'fatal: unable to access \'https://github.com/samrivera/client-a.git/\': Could not resolve host: github.com', note: 'Check your connection or VPN, then check again.' }
    check.push = { state: 'unchecked', detail: 'Needs a reachable remote' }
  }
  return { pushChecks: { [ids.roomA]: check } }
}
/** Client A's Environment page: two variables and two env files from its personal file, `src/backend/.env` missing. */
const envFiles = ['.env', 'src/backend/.env']
const envRoomA: Partial<Fixture> = {
  ...clientA({ env: { files: envFiles }, sources: { ...kernelFiles.sources, 'env.files': 'local' } }),
  env: { rooms: { [ids.roomA]: { names: ['DATABASE_URL', 'STRIPE_SECRET_KEY'], files: envFiles.map((path) => ({ path, missing: path.startsWith('src/') })) } } }
}
const prSettings = { ...DEFAULT_SETTINGS('/Users/you'), pr: { ...DEFAULT_SETTINGS('/Users/you').pr, autoMerge: { on: false, maxLines: 200, alwaysReview: ['infra/**', 'scripts/release.sh'] }, createInstructions: '# Create a pull request\n1. Rebase on origin/main and run pnpm test\n2. Title it as a Conventional Commit\n3. Fill in summary, scope and risk', resolveInstructions: '# Resolve conflicts\n1. Rebase on origin/main\n2. Re-run pnpm test and pnpm typecheck', fixChecksInstructions: '# Fix failing checks\n1. Read the failing job log\n2. Fix the cause, not the test\n3. Push and wait for the checks', addressReviewInstructions: '# Address review comments\n1. Read every open thread\n2. Change the code or reply with a reason\n3. Push and resolve the threads' } }
/** What approvals saved with Always allow in this room. The gh one is long enough to clamp to two lines. */
const roomRules = [
  'pnpm test', 'pnpm typecheck',
  'gh pr view --json number,title,state,statusCheckRollup,reviewDecision,mergeable,headRefName,baseRefName',
  'git log --oneline origin/main..HEAD'
]
/** The tools saved the same way (KERNEL-455), as Claude Code writes a rule. */
const roomToolRules = ['mcp__linear__get_issue', 'mcp__github__create_pull_request', 'WebFetch(domain:docs.stripe.com)']
/** Auto is the app's mode, as the canvas draws it (KERNEL-455). A8 makes it the default for new installs. */
const autoMode = (): AppSettings => { const d = DEFAULT_SETTINGS('/Users/you'); return { ...d, permissions: { ...d.permissions, mode: 'auto' } } }
/** Client A's Permissions page: the commands and tools saved with Always allow in this room, over an app that runs Auto. */
const roomPermissions = (f: Fixture): Partial<Fixture> => ({
  ...clientA(),
  settings: autoMode(),
  rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, allow: roomRules, allowTools: roomToolRules } : r))
})
/** Client A's General page (SettingsRoom.png), which SettingsRoomIcon builds on. */
const settingsRoom = (f: Fixture): Partial<Fixture> => ({
  ...clientA({ scripts: { setup: 'pnpm install' }, linear: { team: 'KERNEL' } }),
  rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, path: '/Users/you/Projects/client-a', repo: 'cjjutba/client-a' } : r)),
  agents: { ...f.agents, [ids.roomA]: sixAgents.slice(0, 5) },
  // KERNEL-161: Linear is connected and the room has a team, so the row shows its select.
  integrations: integrationRows.map((r) => (r.id === 'linear' ? { ...r, connected: true } : r)),
  linear: { scope: { teams: [{ id: 'team-kernel', key: 'KERNEL', name: 'Kernel' }, { id: 'team-web', key: 'WEB', name: 'Web' }], projects: [], cycles: [] } },
  ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA } }
})

/**
 * A room's General page with its issue tracker row (SettingsRoomTracker.png, SettingsRoomTrackerNone.png, KERNEL-472). Linear isn't
 * connected in either room, so the row follows the remote. `menu` opens the tracker menu.
 */
const trackerRoom = (id: string, crew: string[], room: Partial<Room>, menu = false) => scene((f) => ({
  roomSettings: { [id]: kernelFiles },
  rooms: f.rooms.map((r) => (r.id === id ? { ...r, ...room } : r)),
  agents: { ...f.agents, [id]: sixAgents.filter((a) => crew.includes(a.id)) },
  integrations: integrationRows,
  ui: { route: { name: 'settings', page: 'room', roomId: id }, ...(menu ? { menu: 'roomTracker' as const } : {}) }
}))

const skill = (name: string): Skill => ({ name, description: '', source: 'project', enabled: true })
const mcpServers: McpServer[] = ['GitHub', 'Linear', 'Vercel', 'Figma'].map((name) => ({ name, source: 'user', enabled: true }))
/** KERNEL-647: every server the page lists comes from the accounts, so a room's own list only needs the ones that differ. */
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
const signInAllRun: McpSignInAll = { accountId: 'personal', servers: ['Linear', 'claude.ai Gmail', 'claude.ai Google Drive'], current: 'claude.ai Gmail', done: ['Linear'], failed: [] }
const signInAllFailed: McpSignInAll = { ...signInAllRun, current: undefined, done: ['Linear', 'claude.ai Gmail'], failed: [{ server: 'claude.ai Google Drive', error: 'The sign-in was not finished in the browser.' }], finished: true }
const mcpPage = (extra: Partial<Fixture>, route: { tab?: Provider; account?: string } = { account: 'personal' }) => scene(() => ({ ...clientA(), mcp: mcpAcrossServers, mcpAccounts: mcpAcrossAccounts, accounts: [workClaude, personalClaude, ownCodex], ...extra, ui: { route: { name: 'settings', page: 'mcp', ...route }, ...extra.ui } }))
const setUpModal: Modal = { name: 'mcpSetUp', provider: 'claude', accountId: 'personal' }
/** Two Codex accounts that list the same servers, which the page shows as one Codex tab (KERNEL-660). */
const sharedCodex = (): McpAccount[] => {
  const [, , codex] = mcpAcrossAccounts
  return [mcpAcrossAccounts[0], mcpAcrossAccounts[1], { ...codex, sharedWith: ['personal'] }, { ...codex, accountId: 'personal', label: 'Personal', email: 'cj@jutba.example', sharedWith: ['cli'] }]
}
const setUpRun: McpSignInAll = { accountId: 'personal', servers: ['Linear', 'Vercel', 'claude.ai Gmail', 'claude.ai Google Drive', 'claude.ai Notion'], current: 'Vercel', done: ['Linear'], failed: [], ignored: ['plugin:vercel:vercel'] }
const setUpConnect = { provider: 'claude' as const, accountId: 'personal', email: 'cj@jutba.example', url: connectUrl, servers: ['claude.ai Gmail', 'claude.ai Google Drive', 'claude.ai Notion'] }
const personalMcpSignIns = [{ server: 'Linear', connector: false }, { server: 'claude.ai Gmail', connector: true }, { server: 'claude.ai Google Drive', connector: true }]
/** As Kernel resolves them (KERNEL-397): Rowan leads, and Theo reviews with tools that can't open a PR, so takes no tasks. */
const agentFile = (id: string, name: string, role: string, description: string): AgentDef => ({ id, name, role, description, lead: id === 'rowan', reviewer: id === 'theo', member: id !== 'rowan' && id !== 'theo', prompt: '', file: `.claude/agents/${id}.md`, model: id === 'rowan' || id === 'theo' ? 'opus' : 'sonnet' })
const sixAgents: AgentDef[] = [
  agentFile('rowan', 'Rowan', 'Lead', 'Plans and hands out tasks'), agentFile('kai', 'Kai', 'Frontend', 'UI work, follows DESIGN.md'),
  agentFile('noor', 'Noor', 'Backend', 'Schema, API, migrations'), agentFile('ivy', 'Ivy', 'QA', 'Runs tests, attaches output'),
  agentFile('theo', 'Theo', 'Reviewer', 'Types, security, tenancy'), agentFile('lumi', 'Lumi', 'Designer', 'Joined today')
]
const longExample = 'Use this agent to design AI features and pick models. <example>Context: The user is adding chat. user: "Which SDK should I use?" assistant: "I will use the ai-architect agent."</example> <commentary>The request is about architecture, so hand it over.</commentary> Covers streaming, tool calling and cost.'
const extraAgents: AgentDef[] = [
  { ...agentFile('ops', 'Ops', 'Ops', 'Deploys and watches logs'), origin: 'personal', file: '/Users/you/.claude/agents/ops.md', member: true, tools: ['Read', 'Bash', 'Grep'], prompt: 'You are Ops. You deploy, watch the logs and say what you saw.\n\nNever deploy on a red build. Roll back first and ask questions after.' },
  { ...agentFile('vercel:ai-architect', 'Ai Architect', 'Ai Architect', longExample), origin: 'plugin', file: '', member: true },
  { ...agentFile('vercel:deployment-expert', 'Deployment Expert', 'Specialist', 'Debugs failed deployments'), origin: 'plugin', file: '', member: true, prompt: 'You debug failed deployments. Read the build log first, then the config that produced it.' }
]
const integrationRows: Integration[] = [
  { id: 'github', name: 'GitHub', connected: true, detail: 'Through the GitHub CLI as samrivera' },
  { id: 'linear', name: 'Linear', connected: false, detail: 'Create workspaces from issues' }
]

/** The same screen as `src`, drawn in the light theme (HomeLight.png, WorkspaceLight.png). */
const light = (src: Fixture): Fixture => ({ ...src, ui: { ...src.ui, theme: 'light' } })

// What's new (KERNEL-30): the canvas's four notes on a ready 0.2.0, over UpdateReady's home.
const whatsNewNotes = [
  { title: 'Checkpoints', body: 'Every turn saves the worktree. Revert any workspace to an earlier turn without losing the chat.' },
  { title: 'Pause room', body: 'Freeze every agent in a room with one click. They finish the current step, then wait.' },
  { title: 'Big terminal', body: 'Open Claude Code itself in a tab with ⌘⇧T, in the same worktree as your chats.' },
  { title: 'Overlap warnings', body: 'Rowan flags it when two agents edit the same file in different worktrees.' }
]
const whatsNew: Fixture = {
  ...teamFixtures.UpdateReady,
  update: { status: 'ready', current: '0.1.0', version: '0.2.0', notes: whatsNewNotes },
  ui: { ...teamFixtures.UpdateReady.ui, modal: { name: 'whatsNew' } }
}
// What's new opened from the sidebar with no update ready (KERNEL-154): the running 0.1.1's notes and Done. No PNG
// draws it; it reuses the layout What's new has after an update installs.
const whatsNewCurrent: Fixture = {
  ...teamFixtures.UpdateReady,
  update: {
    status: 'idle',
    current: '0.1.1',
    currentNotes: [
      { title: 'New', body: 'Hovering a workspace in the sidebar shows an archive button, so you can archive it without opening it.\nA new chat takes a short title from its first message instead of staying "New chat".' },
      { title: 'Improved', body: 'A file\'s diff opens in its own tab, so the chat stays where you left it.' },
      { title: 'Fixed', body: 'Fixed Create PR showing in a workspace with no changes.\nFixed Rowan starting a new turn right after you pressed Stop.' }
    ]
  },
  ui: { ...teamFixtures.UpdateReady.ui, modal: { name: 'whatsNew' } }
}

/** KERNEL-251: Codex is on the PATH and one custom command is saved, as SettingsBigTerminal.png and WorkspaceTerminalPresets.png draw them. */
const codex: TerminalPreset = { id: 'codex', name: 'Codex', command: 'codex', builtin: true, skipsPermissions: false }
const bigTerminal: Partial<Fixture> = {
  settings: { ...DEFAULT_SETTINGS('/Users/you'), terminal: { ...DEFAULT_SETTINGS('/Users/you').terminal, custom: [{ id: 'custom-dev-server-logs', name: 'Dev server logs', command: 'tail -f logs/dev.log' }] } },
  terminalClis: [codex]
}


/** Rowan's chat in its own workspace while its setup runs, or once it failed with `code`, the first message in the queue (KERNEL-405). */
function leadSetup(f: Fixture, lines: Omit<ScriptLine, 'kind'>[], code?: number): Partial<Fixture> {
  const queue = [{ id: 'q-lead', chatId: ids.leadChat, parts: [{ type: 'text' as const, text: 'Add PDF export to invoices. Spec first.' }], ts: at(10, 40) }]
  return {
    ...clientA({ scripts: { ...kernelFiles.scripts, setup: 'pnpm install --frozen-lockfile' } }),
    workspaces: withWorkspace(f, ids.lead, { status: code === undefined ? 'setup' : 'failed', name: 'add-pdf-export-to-invoices', branch: 'rowan/add-pdf-export-to-invoices' }),
    threads: [{ id: 't-lead', roomId: ids.roomA, title: 'Add PDF export to invoices', createdAt: at(10, 40) }],
    chats: f.chats.map((c) => (c.id === ids.leadChat ? { ...c, title: 'New tab' } : c)),
    items: {},
    queue: { [ids.leadChat]: queue },
    push: [
      ...f.push,
      { type: 'chat.queue', chatId: ids.leadChat, queue, why: 'setup' },
      ...lines.map((l): PushEvent => ({ type: 'script.output', workspaceId: ids.lead, kind: 'setup', lines: [l] })),
      ...(code === undefined ? [] : [{ type: 'script.exit' as const, workspaceId: ids.lead, kind: 'setup' as const, code }])
    ],
    ui: { route: { name: 'workspace', workspaceId: ids.lead }, workspace: { right: 'files', leadRight: 'files', bottom: 'setup', checkpoints: false, toolsOpen: false }, tabs: { [ids.lead]: { tab: ids.leadChat, lastChat: ids.leadChat, files: [], diffs: [] } } }
  }
}

export const platformFixtures: Record<string, Fixture> = {
  WhatsNew: whatsNew,
  WhatsNewCurrent: whatsNewCurrent,
  // The update card in the light theme (KERNEL-164). UpdateReady shows it in dark; no PNG draws it.
  UpdateReadyLight: light(teamFixtures.UpdateReady),
  HomeLight: light(teamFixtures.Home),
  WorkspaceLight: light(workspaceFixtures.Workspace),
  // The VS Code file icons and git colors in the light theme (KERNEL-399).
  WorkspaceFilesTreeLight: light(workspaceFixtures.WorkspaceFilesTree),
  // Open at login is off by default since KERNEL-57; the canvas draws it on.
  Settings: settingsPage('general', { settings: { ...DEFAULT_SETTINGS('/Users/you'), general: { ...DEFAULT_SETTINGS('/Users/you').general, openTo: 'home', openAtLogin: true } } }),
  SettingsAppearance: settingsPage('appearance'),
  SettingsNotifications: settingsPage('notifications'),
  SettingsAccount: settingsPage('account', { usage: accountUsage }),
  // KERNEL-524: Work key runs the agents, and the Claude Max login behind it keeps the numbers it had when the key took over.
  SettingsAccountApiKey: settingsPage('account', { usage: accountUsage, account: { signedIn: true, name: 'Work key' }, accounts: [{ ...claudeAccounts[0], active: false }, keyAccount('claude', true), ...codexAccounts] }),
  SettingsShortcuts: settingsPage('shortcuts'),
  // KERNEL-406: Frontend and Backend run on Codex. The rest stay on Claude.
  SettingsModels: settingsPage('models', { settings: withRoles({ engineers: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }), models: { codex: codexModels } }),
  // KERNEL-406: both providers' accounts and status, with Claude's own login active and a second Claude account added.
  SettingsProviders: providersPage('claude'),
  SettingsProvidersCodex: providersPage('codex'),
  SettingsProvidersCodexSignedOut: providersPage('codex', { accounts: [workClaude, { ...ownCodex, signedIn: false }, personalCodex], providerStatus: { codex: { provider: 'codex', source: 'bundled', version: '0.153.4', signedIn: false, configFile: '/Users/you/.codex/config.toml' } } }),
  // KERNEL-524: an API key account beside the login, on each tab, then with the key in use and the sheet that adds one.
  SettingsProvidersApiKey: providersPage('claude', { accounts: [workClaude, keyAccount('claude'), ownCodex] }),
  SettingsProvidersApiKeyActive: providersPage('claude', {
    accounts: [{ ...workClaude, active: false }, keyAccount('claude', true), ownCodex],
    providerStatus: { ...providerStatus, claude: { provider: 'claude', source: 'bundled', version: '2.1.292', signedIn: true, loginMethod: 'API key', configFile: '/Users/you/.claude/settings.json' } }
  }),
  SettingsProvidersCodexApiKey: providersPage('codex', { accounts: [workClaude, ownCodex, keyAccount('codex')] }),
  SettingsAddAccountApiKey: providersPage('claude', { accounts: [workClaude, keyAccount('claude'), ownCodex] }),
  // KERNEL-561: the one-button sheet on each tab, and its signing-in state. Claude's `code` step arrives from the start and the sheet shows a link for it (KERNEL-615), Codex has no such step.
  SettingsAddAccount: addAccountPage('claude'),
  SettingsAddAccountBrowser: addAccountPage('claude', 'code'),
  SettingsAddAccountCodex: addAccountPage('codex'),
  SettingsAddAccountCodexBrowser: addAccountPage('codex', 'browser'),
  // KERNEL-561: Personal being renamed, and a Claude account from before the full login that asks to sign in again with the usage its last turn read.
  SettingsProvidersRename: providersPage('claude'),
  SettingsProvidersLegacy: providersPage('claude', {
    accounts: [workClaude, { ...personalClaude, email: undefined, plan: undefined, usageFromTurns: true, legacyToken: true }, keyAccount('claude'), ownCodex],
    usage: providerUsage(todayAt(14, 10))
  }),
  // KERNEL-619: Claude Code found two claude.ai connectors on Personal's login that need a sign-in. Work's login has none.
  SettingsProvidersMcp: providersPage('claude', {
    mcpAccounts: mcpAcrossAccounts,
    accounts: [{ ...workClaude, mcpSignIns: [] }, { ...personalClaude, mcpSignIns: [{ server: 'claude.ai Google Drive', connector: true }, { server: 'claude.ai Gmail', connector: true }] }, keyAccount('claude'), ownCodex]
  }),
  // KERNEL-627: Sign in to all on the same line while it runs, then what failed.
  SettingsProvidersMcpSigningIn: providersPage('claude', {
    mcpAccounts: mcpAcrossAccounts,
    accounts: [{ ...workClaude, mcpSignIns: [] }, { ...personalClaude, mcpSignIns: personalMcpSignIns.slice(1) }, keyAccount('claude'), ownCodex],
    push: [{ type: 'account.mcpSignInAll', run: signInAllRun }]
  }),
  SettingsProvidersMcpSignInFailed: providersPage('claude', {
    mcpAccounts: mcpAcrossAccounts,
    accounts: [{ ...workClaude, mcpSignIns: [] }, { ...personalClaude, mcpSignIns: personalMcpSignIns.slice(2) }, keyAccount('claude'), ownCodex],
    push: [{ type: 'account.mcpSignInAll', run: signInAllFailed }]
  }),
  // KERNEL-661: the notice after adding Personal, with Set up opening the checklist.
  SettingsMcpNeededNotice: scene(() => ({
    ...clientA(),
    accounts: [{ ...workClaude, mcpSignIns: [] }, { ...personalClaude, mcpSignIns: personalMcpSignIns }, keyAccount('claude'), ownCodex],
    providerStatus,
    usage: providerUsage(),
    ui: { route: { name: 'settings', page: 'providers', tab: 'claude' }, toasts: [{ id: 'mcp-needed', title: '6 MCP servers need you', action: { label: 'Set up', modal: setUpModal } }] }
  })),
  // KERNEL-619: Personal's Keychain item waits on a macOS prompt. It reads as waiting, not signed out, keeps no usage lines, and can't be switched to or signed out.
  SettingsProvidersKeychain: providersPage('claude', {
    accounts: [{ ...workClaude, mcpSignIns: [] }, { ...personalClaude, keychainWait: true }, keyAccount('claude'), ownCodex],
    usage: providerUsage().filter((l) => l.accountId !== 'personal')
  }),
  // KERNEL-619: both logins are seats in one Claude Team organization, so Personal says it shares limits with Work.
  SettingsProvidersSameOrg: providersPage('claude', {
    accounts: [{ ...workClaude, plan: 'Claude Team', mcpSignIns: [], sameOrg: ['personal'] }, { ...personalClaude, plan: 'Claude Team', mcpSignIns: [], sameOrg: ['cli'] }, keyAccount('claude'), ownCodex],
    providerStatus: { ...providerStatus, claude: { ...providerStatus.claude!, plan: 'Claude Team' } }
  }),
  // KERNEL-619: Personal's login is already in Kernel, so Add account says so and keeps its Sign in button.
  SettingsAddAccountDuplicate: providersPage('claude', { push: [{ type: 'account.add', add: { provider: 'claude', step: 'failed', error: 'That account is already in Kernel.' } }] }),
  // KERNEL-561: the menu lists every account of both providers with its plan and usage, and Cmd+K switches to any that isn't in use.
  AccountMenu: { ...teamFixtures.Home, accounts: richAccounts, usage: providerUsage(), ui: { route: { name: 'home' }, menu: 'account' } },
  // KERNEL-619: the plan pill reads Usage and opens Claude Code and Codex together, each from the account in use. Work's Fable window is at 90%. Codex lists one other account.
  UsagePopover: usagePopover({ accounts: [workClaude, personalClaude, keyAccount('claude'), ownCodex, personalCodex] }),
  // KERNEL-619: a key is in use on Claude Code, so it says Billed per token and Switch lists both subscriptions.
  UsagePopoverApiKey: usagePopover({ accounts: [{ ...workClaude, active: false }, personalClaude, keyAccount('claude', true), ownCodex, personalCodex] }),
  // KERNEL-619: Codex isn't signed in, so its section is one line with Sign in.
  UsagePopoverSignedOut: usagePopover({ accounts: [workClaude, personalClaude, keyAccount('claude'), { ...ownCodex, signedIn: false }, personalCodex] }),
  SearchSwitchAccount: { ...teamFixtures.CommandPalette, workspaces: teamFixtures.CommandPalette.workspaces.map((w) => (w.id === ids.schema ? { ...w, status: 'archived' as const } : w)), accounts: richAccounts, usage: providerUsage() },
  // KERNEL-455: Auto is the pick, and the fixture's availability has it working on Claude Code and not on Codex.
  SettingsPermissions: settingsPage('permissions', { settings: { ...autoMode(), permissions: { ...autoMode().permissions, neverAllow: ['git push origin main', 'curl * | sh'] } } }),
  SettingsBigTerminal: settingsPage('bigterm', bigTerminal),
  SettingsAbout: settingsPage('about', { preflight: [] }),
  // KERNEL-397: usage data is opt-in. This build can send, and the user hasn't said yes, so every event is kept on the Mac.
  SettingsPrivacy: settingsPage('privacy', { telemetry: { canSend: true, recent: [
    { event: { name: 'team.resolved', leadFrom: 'builtin', reviewerFrom: 'file', agents: '1-5', helpers: '1-5', warnings: '1-5' }, at: at(10, 42), sent: false },
    { event: { name: 'agent.warning', kind: 'cant-open-pr' }, at: at(10, 42), sent: false },
    { event: { name: 'room.created', source: 'folder' }, at: at(10, 41), sent: false },
    { event: { name: 'app.started' }, at: at(10, 40), sent: false }
  ] } }),
  // KERNEL-397: the one question about usage data, over Home, in a build that can send.
  TelemetryAsk: scene(() => ({ telemetry: { canSend: true }, ui: { route: { name: 'home' }, modal: { name: 'telemetryAsk' } } })),
  SettingsGit: settingsPage('git', { branches: ['origin/main', 'origin/dev', 'main'] }),
  // KERNEL-371: Archive on merge is off in the personal file over settings.toml, and Delete branch on archive follows the app.
  // KERNEL-401: the optional checks come from settings.toml.
  SettingsRoomGit: roomPage('git', {
    ...clientA({
      workspace: { ...kernelFiles.workspace, archiveOnMerge: false },
      pr: { ...kernelFiles.pr, optionalChecks: ['Vercel*', 'codecov/patch'] },
      sources: { ...kernelFiles.sources, 'workspace.archiveOnMerge': 'override', 'pr.optionalChecks': 'shared' }
    }),
    branches: ['origin/main', 'origin/dev', 'main'],
    ...pushCheck('ok')
  }, 'settingsFiles'),
  // KERNEL-460: gh can push, but git has no login of its own, so the fix is gh auth setup-git.
  SettingsRoomGitPushFailed: roomPage('git', {
    ...clientA({ workspace: { ...kernelFiles.workspace, archiveOnMerge: false }, sources: { ...kernelFiles.sources, 'workspace.archiveOnMerge': 'override' } }),
    branches: ['origin/main', 'origin/dev', 'main'],
    ...pushCheck('failed')
  }),
  // KERNEL-460: git ls-remote couldn't resolve github.com, so the permission wasn't asked.
  SettingsRoomGitUnreachable: roomPage('git', {
    ...clientA({ workspace: { ...kernelFiles.workspace, archiveOnMerge: false }, sources: { ...kernelFiles.sources, 'workspace.archiveOnMerge': 'override' } }),
    branches: ['origin/main', 'origin/dev', 'main'],
    ...pushCheck('unreachable')
  }),
  // KERNEL-249: run is overridden here, and frontend and backend are personal scripts, as the canvas draws them.
  // KERNEL-250: the two preview URLs come from settings.toml. The list is one value, so its source shows on the first row.
  SettingsRoomScripts: roomPage('scripts', clientA({
    runScripts: [
      { name: 'run', command: 'pnpm dev --port $KERNEL_PORT' },
      { name: 'frontend', command: 'pnpm --filter web dev --port $KERNEL_PORT' },
      { name: 'backend', command: 'pnpm --filter api dev --port $((KERNEL_PORT + 1))' }
    ],
    preview: { urls: [{ name: 'Web app', url: 'http://localhost:$KERNEL_PORT' }, { name: 'API docs', url: 'http://localhost:$((KERNEL_PORT + 1))/docs' }] },
    sources: { ...kernelFiles.sources, 'runScripts.run': 'override', 'runScripts.frontend': 'local', 'runScripts.backend': 'local', 'preview.urls': 'shared' }
  })),
  // KERNEL-254: names only, since a value only ever comes from env.reveal. Client A's list is its personal file, and one of the two files isn't there.
  SettingsEnvironment: settingsPage('env', { env: { app: ['GH_TOKEN', 'NPM_TOKEN', 'NODE_OPTIONS'] } }),
  SettingsRoomEnvironment: roomPage('environment', envRoomA),
  SettingsEnvironmentAdd: scene(() => ({ ...envRoomA, ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'environment' }, modal: { name: 'envVar', roomId: ids.roomA } } })),
  SettingsRoomInstructions: roomPage('instructions', clientA()),
  SettingsRoomPermissions: scene((f) => ({ ...roomPermissions(f), ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'permissions' } } })),
  // KERNEL-455: the room's mode menu is open, over Use app default.
  SettingsRoomPermissionsMode: scene((f) => ({ ...roomPermissions(f), ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'permissions' }, menu: 'roomMode' } })),
  SettingsPRs: settingsPage('prs', { settings: prSettings }),
  SettingsScripts: settingsPage('scripts'),
  // KERNEL-252: the list and the ignored files in Client A's checkout, so the preview shows the 11 the canvas lists.
  SettingsFiles: scene((f) => ({
    ...clientA({ files: { copy: ['.env*', 'certs/*.pem', '.npmrc'], symlinkNodeModules: false } }),
    rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, path: '/Users/you/Projects/client-a' } : r)),
    localFiles: { [ids.roomA]: [...['.env', '.env.development', '.env.local', '.env.production', '.env.test', '.npmrc', 'certs/ca.pem', 'certs/dev.pem', 'certs/localhost.pem', 'certs/staging.pem', 'certs/wildcard.pem', '.DS_Store', 'certs/README.txt', 'dist/index.js'].map((path, i) => ({ path, size: 96 + i * 31 }))] },
    ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'files' } }
  })),
  // KERNEL-449: two of those files look like production, so the warning sits above the list, by file and variable name.
  SettingsFilesProduction: scene((f) => ({
    ...clientA({ files: { copy: ['.env*', 'certs/*.pem', '.npmrc'], symlinkNodeModules: false } }),
    rooms: f.rooms.map((r) => (r.id === ids.roomA ? { ...r, path: '/Users/you/Projects/client-a' } : r)),
    localFiles: { [ids.roomA]: [...['.env', '.env.development', '.env.local', '.env.production', '.env.test', '.npmrc', 'certs/ca.pem', 'certs/dev.pem', 'certs/localhost.pem', 'certs/staging.pem', 'certs/wildcard.pem', '.DS_Store', 'certs/README.txt', 'dist/index.js'].map((path, i) => ({ path, size: 96 + i * 31 }))] },
    production: { [ids.roomA]: [{ path: '.env', name: 'DATABASE_URL', why: 'remote-database' }, { path: '.env.production', name: 'STRIPE_SECRET_KEY', why: 'live-key' }] },
    ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'files' } }
  })),
  SettingsHooks: settingsPage('hooks', { hooks: { port: 7420, listening: true, installed: true, events: hookEvents.filter((e) => e.name !== 'SessionStart') } }),
  // KERNEL-493: Agents working at once is 4, so the Open workspaces row's first option reads "Same as agents working at once (4)".
  SettingsTeam: scene((f) => ({ ...clientA(), settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, agentLimit: 4 } }, agents: { ...f.agents, [ids.roomA]: sixAgents }, ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' } } })),
  // KERNEL-639: the room's agents grouped by where they come from, scrolled to In this repo. Yours has a personal agent, and From plugins two with View, one with a long description cleaned to two lines.
  SettingsTeamOrigins: scene((f) => ({ ...clientA(), settings: { ...DEFAULT_SETTINGS('/Users/you'), models: { ...DEFAULT_SETTINGS('/Users/you').models, agentLimit: 4 } }, agents: { ...f.agents, [ids.roomA]: [...sixAgents.filter((a) => ['rowan', 'kai', 'noor', 'ivy', 'theo'].includes(a.id)), ...extraAgents] }, ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'agents' } } })),
  // KERNEL-641: Settings, Agents with no room open: Yours has a personal agent and From plugins two. No PNG, built from the Settings kit and AgentProfile.png's fields.
  SettingsAgents: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.roomA]: [...sixAgents, ...extraAgents] }, ui: { route: { name: 'settings', page: 'agents' } } })),
  // KERNEL-641: a personal agent's editor, opened from Settings, Agents: Back says Agents, and there is no status, workspace or recent work.
  SettingsAgentEdit: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.roomA]: [...sixAgents, ...extraAgents] }, ui: { route: { name: 'settings', page: 'agents', agentId: 'ops' } } })),
  // KERNEL-641: a plugin's agent read only: the fields are disabled, the line names the plugin, and there is no Save changes or Retire.
  SettingsAgentPlugin: scene((f) => ({ ...clientA(), agents: { ...f.agents, [ids.roomA]: [...sixAgents, ...extraAgents] }, ui: { route: { name: 'settings', page: 'agents', agentId: 'vercel:deployment-expert' } } })),
  // KERNEL-557: Client A's `[review]` as the canvas draws it (KERNEL-594: and its always-review paths). The code review runs as Kernel, so the room has no agent that reviews. Security runs as Theo, and the UX review as Lumi, which is optional.
  SettingsRoomReviews: scene((f) => ({
    ...clientA({
      review: {
        rounds: 2,
        kinds: {
          code: { enabled: true, paths: [], required: true, model: 'claude-opus-5-5', provider: 'claude' },
          security: { enabled: true, paths: ['src/api/**', 'src/auth/**', 'db/migrations/**'], required: true, agent: 'theo', model: 'claude-opus-5-5', provider: 'claude' },
          ux: { enabled: true, paths: ['src/renderer/**/*.tsx', '**/*.css'], required: false, agent: 'lumi', model: 'claude-sonnet-5-5', provider: 'claude' }
        }
      },
      // KERNEL-594: the shared `[merge] always_review`, as the canvas's box lists it.
      merge: { alwaysReview: ['src/billing/**', 'db/migrations/**'] }
    }),
    agents: { ...f.agents, [ids.roomA]: sixAgents.map((a) => ({ ...a, reviewer: false })) },
    ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA, section: 'reviews' } }
  })),
  SettingsSkills: roomPage('skills', { ...clientA(), skills: ['setup', 'plan', 'feature', 'verify', 'image'].map(skill), mcp: mcpServers, mcpAccounts: mcpAcrossAccounts }),
  // KERNEL-661: twenty-seven servers as switches in a room, each with one word of status and the link to the global page.
  SettingsSkillsMany: roomPage('skills', { ...clientA(), skills: ['setup', 'plan'].map(skill), mcp: mcpAcrossServers, mcpAccounts: manyServers() }),
  // KERNEL-661: Settings, MCP servers opens on the active account, Work, with every server ready and folded into one line per group.
  SettingsMcpServersReady: mcpPage({}, {}),
  // KERNEL-661: the notice or Providers opens the page on Personal: sign-ins, a failure, connectors not set up and one ignored.
  SettingsMcpServers: mcpPage({}),
  // KERNEL-661: Codex accounts that read the same show as one Codex tab, with a sign-in and two servers that are off on purpose.
  SettingsMcpServersCodex: mcpPage({ mcpAccounts: sharedCodex(), accounts: [workClaude, personalClaude, ownCodex, personalCodex] }, { tab: 'codex', account: 'cli' }),
  // KERNEL-661: twenty-seven servers on Personal at 1440x900.
  SettingsMcpServersMany: mcpPage({ mcpAccounts: manyServers() }),
  // KERNEL-661: Set up this account over Settings, MCP servers, with everything that needs Personal ticked.
  SettingsMcpSetUp: mcpPage({ ui: { route: { name: 'settings', page: 'mcp', account: 'personal' }, modal: setUpModal } }),
  // KERNEL-661: signing in to Vercel, the second of five, with the claude.ai step waiting for the connectors.
  SettingsMcpSetUpRunning: mcpPage({ ui: { route: { name: 'settings', page: 'mcp', account: 'personal' }, modal: setUpModal }, push: [{ type: 'account.mcpSignInAll', run: { ...setUpRun, connect: setUpConnect } }, { type: 'account.mcpConnect', connect: setUpConnect }] }),
  // KERNEL-661: it ended with Vercel failed, the connectors left for claude.ai and one server ignored.
  SettingsMcpSetUpDone: mcpPage({ ui: { route: { name: 'settings', page: 'mcp', account: 'personal' }, modal: setUpModal }, push: [{ type: 'account.mcpSignInAll', run: { ...setUpRun, current: undefined, done: ['Linear'], failed: [{ server: 'Vercel', error: 'The sign-in was not finished in the browser.' }], finished: true, connect: setUpConnect } }] }),
  SettingsIntegrations: settingsPage('integrations', { integrations: integrationRows }),
  SettingsRoom: scene(settingsRoom),
  // KERNEL-253: the room has its GitHub avatar and the Icon row's menu is open. The sidebar row for Client A shows it too.
  SettingsRoomIcon: scene((f) => {
    const room = settingsRoom(f)
    return {
      ...room,
      rooms: room.rooms!.map((r) => (r.id === ids.roomA ? { ...r, icon: { kind: 'github' as const, file: `${ids.roomA}-1.png`, at: at(9, 0) } } : r)),
      roomIcons: { [ids.roomA]: invaderIcon },
      ui: { route: { name: 'settings', page: 'room', roomId: ids.roomA }, menu: 'roomIcon' }
    }
  }),
  // KERNEL-472: Client B's repo is on GitHub and Linear isn't connected, so detection says GitHub Issues, and the menu marks it.
  SettingsRoomTracker: trackerRoom(ids.roomB, ['rowan', 'noor', 'theo'], { path: '/Users/you/Projects/client-b', repo: 'cjjutba/client-b' }, true),
  // KERNEL-472: Portfolio is a folder with no GitHub remote and no Linear, so there is nothing to detect and the tracker is None.
  SettingsRoomTrackerNone: trackerRoom(ids.roomPortfolio, ['rowan', 'kai'], { path: '/Users/you/Projects/portfolio', repo: undefined, kind: 'folder' }),
  DevUi: gallery('components'),
  DevUiDisplay: gallery('display'),
  DevUiOverlays: gallery('overlays'),
  DevUiDialogs: gallery('dialogs'),
  Welcome: scene(() => ({ ...empty, ui: { route: { name: 'onboarding', step: 'welcome' } } })),
  // KERNEL-217: boot failed. The Loading layout with the error and Try again. No PNG.
  LoadingError: scene(() => ({ ...empty, ui: { route: { name: 'onboarding', step: 'loading' }, startError: 'Could not read the Kernel database. Quit Kernel and open it again.' } })),
  LoadingApp: scene((f) => ({ ...sixRunning(f), ui: { route: { name: 'onboarding', step: 'loading' } } })),
  CheckHooks: scene((f) => ({
    ...sixRunning(f),
    hooks: { port: 7420, listening: true, installed: true, events: hookEvents },
    ui: { route: { name: 'home' }, modal: { name: 'checkHooks' } }
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
  // KERNEL-448: what Kernel read from the login shell, as the KERNEL-437 PNGs draw it.
  SetupGhIdentity: setup(passing({ ...ghOk, detail: 'Signed in as cjjutba, from the keyring', note: '`GH_TOKEN` is set in your shell. Kernel leaves it out, because gh would use it instead of this login.' })),
  SetupGhToken: setup(passing({ ...ghOk, detail: 'Signed in as cjjutba-bot, from `GH_TOKEN` in your shell', note: 'Kernel passes it on because gh has no stored login.' })),
  SetupShellTimeout: setup([{ id: 'shell', ok: false, blocking: false, title: 'Reading your shell timed out', detail: 'Kernel reads PATH and proxy settings from your login shell and gave up after 10 seconds. Tools from nvm, or a proxy set in `.zshrc`, may be missing until it can.', note: 'Look in `.zshrc` for a slow command, or one that waits for an answer, like an update prompt.', fix: { action: 'recheck' } }, ...allOk]),
  SetupBedrock: setup(passing({ id: 'auth', ok: true, blocking: true, title: 'Using Bedrock from your shell', detail: 'Agents bill your AWS account. No Claude sign-in needed.', note: '`CLAUDE_CODE_USE_BEDROCK` is set in your shell.', meta: 'us-east-1' })),
  // KERNEL-457: the step after the checks. The Lead runs on Claude Code in the first and on Codex in the second, where the fixture's availability answer turns Auto off (src/main/fixtures.ts).
  SetupPermissions: scene(() => ({ ...empty, ui: permissionStep })),
  SetupPermissionsNoAuto: scene(() => ({ ...empty, settings: withRoles({ lead: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }), ui: permissionStep })),
  // KERNEL-28: failure banners. Each one is the state main would push: usage, account, network, retry, setup, hooks.
  WorkspaceSessionLimit: scene(() => ({ usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }], ui: open })),
  // KERNEL-406: Kai on Claude hit its 5-hour limit while Codex runs other roles, and a second Claude account has room.
  WorkspaceProviderLimit: scene(() => ({
    settings: withRoles({ qa: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }),
    accounts: claudeAccounts,
    usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }, { type: 'five_hour', status: 'allowed', utilization: 0.12, resetsAt: secs(next(15, 40)), accountId: 'work' }],
    ui: open
  })),
  // KERNEL-524: the account on offer is an API key, so the banner says it is billed per token. Kai's room runs on Codex too, as in the one above.
  WorkspaceProviderLimitApiKey: scene(() => ({
    settings: withRoles({ qa: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }),
    accounts: [claudeAccounts[0], keyAccount('claude')],
    usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }],
    ui: open
  })),
  // KERNEL-619: the only other account is signed out, so the banner says so and offers its sign-in beside Notify me. Kai's room runs on Codex too, as in the ones above.
  WorkspaceProviderLimitSignedOut: scene(() => ({
    settings: withRoles({ qa: { provider: 'codex', model: 'gpt-6-astra', effort: 'medium' } }),
    accounts: [workClaude, { ...personalClaude, signedIn: false }],
    usage: [{ type: 'five_hour', status: 'rejected', utilization: 1, resetsAt: secs(next(15, 40)) }],
    ui: open
  })),
  // KERNEL-569: Work is at 90% of its 5-hour window and Personal has room, so the banner offers the move before the limit. Switching at a limit is off.
  WorkspaceProviderNearLimit: scene(() => ({
    accounts: [workClaude, personalClaude],
    usage: [window5('claude', 'cli', 90, next(15, 40)), window5('claude', 'personal', 8, next(17, 10))],
    ui: open
  })),
  // KERNEL-569: the chat after a switch to Personal, plain and after Work hit its 5-hour limit. The footer says Personal's plan.
  WorkspaceAccountNote: scene(() => ({
    account: personalAccount,
    accounts: [{ ...workClaude, active: false }, { ...personalClaude, active: true }],
    items: { [ids.tableChat]: afterSwitch('Now on Personal') },
    ui: open
  })),
  WorkspaceAccountNoteLimit: scene(() => ({
    account: personalAccount,
    accounts: [{ ...workClaude, active: false }, { ...personalClaude, active: true }],
    items: { [ids.tableChat]: afterSwitch('Now on Personal (Work hit its 5-hour limit)') },
    ui: open
  })),
  // KERNEL-619: after a switch to Personal, whose plan lacks Opus 5.5, which Theo and Noor use. The banner offers the way back and the place to pick another model.
  WorkspaceSwitchWarning: scene(() => ({
    account: personalAccount,
    accounts: [{ ...workClaude, active: false }, { ...personalClaude, active: true, missingModels: [{ model: 'claude-opus-5-5', label: 'Opus 5.5', agents: ['Theo', 'Noor'] }] }],
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
  WorkspaceSignedOut: scene(() => ({ account: { signedIn: false, name: 'Sam Rivera', login: 'samrivera', plan: 'Claude Max' }, ui: open })),
  // KERNEL-218: the dialog the banner's Review opens, over the held workspace.
  TrustScripts: scene(() => ({ ...workspaceFixtures.WorkspaceTrustHeld, ui: { ...open, modal: { name: 'confirm', kind: 'trust', roomId: ids.roomA } } })),
  WorkspaceSetupFailed: scene((f) => ({
    ...clientA({ scripts: { ...kernelFiles.scripts, setup: 'pnpm install --frozen-lockfile' } }),
    workspaces: withWorkspace(f, ids.table, { status: 'failed' }),
    items: {},
    push: [
      ...f.push,
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line: '$ pnpm install --frozen-lockfile', stream: 'stdout' }] },
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date', stream: 'stderr' }] },
      { type: 'script.output', workspaceId: ids.table, kind: 'setup', lines: [{ line: 'Setup failed with exit code 1', stream: 'stderr' }] },
      setupData(ids.table, SETUP_RAW.frozen),
      { type: 'script.exit', workspaceId: ids.table, kind: 'setup', code: 1 }
    ],
    ui: { ...open, workspace: { right: 'files', bottom: 'setup', checkpoints: false, toolsOpen: false } }
  })),
  // A chat with Rowan sets up like a teammate's before its first message goes out (KERNEL-405): the skeleton, and the message in the queue.
  WorkspaceLeadSetup: scene((f) => leadSetup(f, [
    { line: '$ pnpm install --frozen-lockfile', stream: 'stdout' },
    { line: 'Progress: resolved 812, reused 806, downloaded 6, added 0', stream: 'stdout' }
  ])),
  // Its setup failed: the banner and Run again, as for a teammate, and the first message still waits.
  WorkspaceLeadSetupFailed: scene((f) => leadSetup(f, [
    { line: '$ pnpm install --frozen-lockfile', stream: 'stdout' },
    { line: 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date', stream: 'stderr' },
    { line: 'Setup failed with exit code 1', stream: 'stderr' }
  ], 1)),
  // A worktree deleted outside Kernel (KERNEL-291): the banner says so and offers Archive, and the composer waits.
  WorkspaceFolderMissing: scene((f) => ({ workspaces: withWorkspace(f, ids.table, { folderGone: true }), ui: open })),
  WorkspaceHooksDown: scene(() => ({ hooks: { port: 7420, listening: false, installed: true, events: hookEvents }, ui: open })),
  // KERNEL-401: a GitHub rate limit holds PR reads off until 3:41 PM, over a PR that passed its checks.
  WorkspaceGitHubPaused: scene(() => ({ ...workspaceFixtures.WorkspacePRReady, github: { pausedUntil: next(15, 41) } })),
  ConfirmArchive: scene((f) => ({
    gitStatus: { [ids.table]: { branch: 'feat/t-14-invoice-table', ahead: 2, behind: 0, dirty: { files: 0, added: 0, removed: 0 } } },
    push: f.push,
    ui: { ...open, modal: { name: 'confirm', kind: 'archive', workspaceId: ids.table } }
  })),
  ConfirmDiscard: scene(() => ({ ui: { ...open, modal: { name: 'confirm', kind: 'discard', workspaceId: ids.table } } })),
  // KERNEL-455: the first switch into Bypass permissions, with Only in worktrees on.
  ConfirmBypass: scene(() => ({ ui: { ...open, modal: { name: 'confirm', kind: 'bypass' } } }))
}
