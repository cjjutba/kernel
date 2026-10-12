import { createConnection } from 'node:net'
import { exec, type ExecResult } from './exec'
import { ghAuth, ghCanPush } from './github'
import { bundledClaude } from './providers/binary'
import { rcFile, type ShellRead } from './shellPath'
import { githubRepoOf } from './worktrees'
import type { PreflightCheck, PushCheck, PushCheckRow, RoomSetupStep } from '@shared/types'

export const MIN_CLAUDE = '2.1.80'

/** Compare dotted versions. Returns -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}

export function parseClaudeVersion(out: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null
}

/** Something already listening on the port that is not Kernel's hook server. */
export function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

/** First port at or after `from` that nothing is listening on. */
export async function nextFreePort(from: number, busy: (port: number) => Promise<boolean> = portBusy): Promise<number> {
  for (let p = from; p < from + 50; p++) if (!(await busy(p))) return p
  throw new Error(`No free port from ${from} to ${from + 49}`)
}

/** Reads `lsof -Fpc` output (p<pid> then c<command>) into the process listening on a port. */
export function parseLsof(out: string): { pid: number; name: string } | null {
  const pid = /^p(\d+)/m.exec(out)?.[1]
  if (!pid) return null
  return { pid: Number(pid), name: /^c(.+)$/m.exec(out)?.[1] ?? 'unknown' }
}

async function portOwner(port: number, run: typeof exec = exec) {
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { timeoutMs: 5000 })
  return r.code === 0 ? parseLsof(r.stdout) : null
}

/** "max" becomes "Claude Max". An API key login has no plan, so it reads as undefined. */
export function planName(subscriptionType: unknown): string | undefined {
  return typeof subscriptionType === 'string' && subscriptionType ? `Claude ${subscriptionType[0].toUpperCase()}${subscriptionType.slice(1)}` : undefined
}

/** The `claude` binary sessions run: the unpacked copy in a packaged app, or the SDK's own platform package (sessions.ts). */
export function sessionClaude(): string | undefined { return bundledClaude() }

/** The official installer from Claude Code's docs (code.claude.com/docs/en/setup). It needs no Node. */
export const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'

/** merge-tree --write-tree, which conflictFiles relies on, arrived in git 2.38. */
export const MIN_GIT = '2.38'

/**
 * The checks behind the "Getting Kernel ready" screens, in canvas order with git before the GitHub CLI. Only Claude sign-in,
 * the hook port, a missing git and a broken bundled Claude block (KERNEL-213). Everything else is a warning.
 * `shell` is what `refreshPath` just read, and `env` the environment it left. `run`, `claude` and `env` are for tests: a
 * stubbed command runner, the session binary's path and the variables Bedrock and Vertex are read from. `gh: false` leaves
 * the GitHub CLI out when no room's PRs go to GitHub (KERNEL-477).
 */
export async function runPreflight(o: { hookPort: number; hookServerUp: boolean; run?: typeof exec; claude?: string | null; nextPort?: (from: number) => Promise<number>; codex?: { bin?: string }; shell?: ShellRead; env?: NodeJS.ProcessEnv; gh?: boolean }): Promise<PreflightCheck[]> {
  const run = o.run ?? exec
  const checks: PreflightCheck[] = []
  // First, since it explains anything below that's missing.
  if (o.shell?.timedOut) checks.push(shellCheck(o.shell))
  const bin = o.claude === undefined ? sessionClaude() : o.claude
  // A first run of a freshly installed binary can be slow while macOS scans it, hence the long timeout.
  const v = bin ? await run(bin, ['--version'], { timeoutMs: 60000 }) : null
  const version = v?.code === 0 ? parseClaudeVersion(v.stdout) : null
  if (!v || v.code === 127) checks.push({ id: 'claude', ok: false, blocking: true, title: 'Claude Code is missing from Kernel', detail: 'Kernel could not find its own copy of Claude Code. Reinstall Kernel, then check again.' })
  else if (!version) checks.push({ id: 'claude', ok: false, blocking: true, title: 'Claude Code did not start', detail: 'Kernel\'s own copy of Claude Code did not start. Run it in Terminal to see why, then check again.', fix: { command: `"${bin}" --version` } })
  else if (compareVersions(version, MIN_CLAUDE) < 0) checks.push({ id: 'claude', ok: false, blocking: false, title: 'Claude Code is too old', detail: `Found v${version}. Agent teams need v2.1.32 and Channels need v${MIN_CLAUDE} or later. Update Kernel to get a newer one.`, meta: `v${version}` })
  else {
    // Agents use Kernel's copy. The one on PATH is only for the fixes below, like signing in from Terminal.
    const onPath = (await run('claude', ['--version'], { timeoutMs: 15000 })).code === 0
    checks.push(onPath
      ? { id: 'claude', ok: true, blocking: false, title: 'Claude Code', detail: 'Found on your PATH', meta: `v${version}` }
      : { id: 'claude', ok: false, blocking: false, title: 'Claude Code not found', detail: 'Kernel runs agents with its own copy. Install Claude Code to sign in from Terminal.', meta: `v${version}`, fix: { command: CLAUDE_INSTALL } })
  }

  // Signing in is checked with the same binary, so a broken one shows one failure, not two.
  const cloud = cloudCheck(o.env ?? process.env)
  if (bin && version && cloud) checks.push(cloud)
  else if (bin && version) {
    const a = await run(bin, ['auth', 'status'], { timeoutMs: 15000 })
    let status: { loggedIn?: boolean; subscriptionType?: unknown } = {}
    try { status = JSON.parse(a.stdout) } catch { /* not signed in, or an older CLI */ }
    checks.push(status.loggedIn
      ? { id: 'auth', ok: true, blocking: true, title: 'Signed in', detail: planName(status.subscriptionType) ?? 'Claude account' }
      : { id: 'auth', ok: false, blocking: true, title: 'Not signed in to Claude', detail: 'Agents run on your own Claude plan. Sign in, then check again.', fix: { command: 'claude auth login' } })
  }

  // Only while a role in Settings, Models and effort runs on Codex, so a Claude-only setup sees the checks it always did.
  if (o.codex) checks.push(await codexCheck(o.codex.bin, run))
  checks.push(await gitCheck(run))
  if (o.gh ?? true) checks.push(await ghCheck(run, o.shell))

  if (o.hookServerUp) checks.push({ id: 'hooks', ok: true, blocking: true, title: 'Hook server', detail: 'Listening for events', meta: `localhost:${o.hookPort}` })
  else {
    const owner = await portOwner(o.hookPort, run)
    const next = await (o.nextPort ?? nextFreePort)(o.hookPort + 1).catch(() => o.hookPort + 1)
    const who = owner ? `Another process (${owner.name}, pid ${owner.pid})` : 'Another process'
    checks.push({ id: 'hooks', ok: false, blocking: true, title: `Port ${o.hookPort} is taken`, detail: `${who} is using it. Kernel can listen on ${next} and update your hooks.`, fix: { action: 'use-next-port' } })
  }
  return checks
}

/** A warning, since Kernel still has the launch PATH and the usual install folders. The note is where to look (KERNEL-448). */
function shellCheck(shell: ShellRead): PreflightCheck {
  const rc = rcFile(shell.shell)
  const s = Math.max(1, Math.round(shell.timeoutMs / 1000))
  return {
    id: 'shell', ok: false, blocking: false, title: 'Reading your shell timed out',
    detail: `Kernel reads PATH and proxy settings from your login shell and gave up after ${s} second${s === 1 ? '' : 's'}. Tools from nvm, or a proxy set in \`${rc}\`, may be missing until it can.`,
    note: `Look in \`${rc}\` for a slow command, or one that waits for an answer, like an update prompt.`,
    fix: { action: 'recheck' }
  }
}

/** Claude Code's own test for a switch like CLAUDE_CODE_USE_BEDROCK. */
const switchedOn = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? '')

/**
 * Claude Code on Bedrock or Vertex bills the cloud account and skips the Claude sign-in, so this row takes Signed in's
 * place. Only the Mac's environment can switch it on (KERNEL-247), and the shell read is how a Finder launch gets it.
 */
function cloudCheck(env: NodeJS.ProcessEnv): PreflightCheck | null {
  if (switchedOn(env.CLAUDE_CODE_USE_BEDROCK)) return { id: 'auth', ok: true, blocking: true, title: 'Using Bedrock from your shell', detail: 'Agents bill your AWS account. No Claude sign-in needed.', note: '`CLAUDE_CODE_USE_BEDROCK` is set in your shell.', ...(env.AWS_REGION ? { meta: env.AWS_REGION } : {}) }
  if (switchedOn(env.CLAUDE_CODE_USE_VERTEX)) return { id: 'auth', ok: true, blocking: true, title: 'Using Vertex AI from your shell', detail: 'Agents bill your Google Cloud account. No Claude sign-in needed.', note: '`CLAUDE_CODE_USE_VERTEX` is set in your shell.', ...(env.CLOUD_ML_REGION ? { meta: env.CLOUD_ML_REGION } : {}) }
  return null
}

/** Codex runs only the roles set to it, so a missing or signed-out Codex is a warning, never a block (KERNEL-406). */
async function codexCheck(bin: string | undefined, run: typeof exec): Promise<PreflightCheck> {
  const v = bin ? await run(bin, ['--version'], { timeoutMs: 60000 }) : null
  const version = v?.code === 0 ? parseClaudeVersion(v.stdout) : null
  if (!version) return { id: 'codex', ok: false, blocking: false, title: 'Codex did not start', detail: 'A role in Settings, Models and effort runs on Codex, and Kernel could not start it. Check Settings, Providers.' }
  const signedIn = (await run(bin!, ['login', 'status'], { timeoutMs: 15000 })).code === 0
  return signedIn
    ? { id: 'codex', ok: true, blocking: false, title: 'Codex', detail: 'Signed in with ChatGPT', meta: `v${version}` }
    : { id: 'codex', ok: false, blocking: false, title: 'Not signed in to Codex', detail: 'A role runs on Codex. Sign in with your ChatGPT plan in Settings, Providers.', meta: `v${version}`, fix: { command: 'codex login' } }
}

/** Every worktree, commit and merge goes through git, so a missing one blocks. An old one only loses conflict lists. */
async function gitCheck(run: typeof exec): Promise<PreflightCheck> {
  const r = await run('git', ['--version'], { timeoutMs: 15000 })
  // "git version 2.39.5 (Apple Git-154)". Without the command line tools, /usr/bin/git exits 1 and macOS offers to install them.
  const version = r.code === 0 ? /git version (\d+\.\d+(?:\.\d+)?)/.exec(r.stdout)?.[1] : undefined
  if (!version) return { id: 'git', ok: false, blocking: true, title: 'Git not found', detail: 'Kernel keeps each agent\'s work in its own git worktree. Install the command line tools, then check again.', fix: { command: 'xcode-select --install' } }
  if (compareVersions(version, MIN_GIT) < 0) return { id: 'git', ok: false, blocking: false, title: 'Git is too old', detail: `Found v${version}. Kernel needs v${MIN_GIT} or later to list a pull request's conflicting files.`, meta: `git ${version}`, fix: { command: 'brew install git' } }
  return { id: 'git', ok: true, blocking: false, title: 'Git', detail: 'Found on your PATH', meta: `git ${version}` }
}

/** "the keyring", "`GH_TOKEN` in your shell" or "gh's config file", from gh's `tokenSource`. */
function ghSource(source: string | undefined): string | undefined {
  if (source === 'keyring') return 'the keyring'
  if (source === 'GH_TOKEN' || source === 'GITHUB_TOKEN') return `\`${source}\` in your shell`
  if (source?.includes('/')) return 'gh\'s config file'
  return undefined
}

/** gh only matters for pull requests, so every failure here is a warning. */
async function ghCheck(run: typeof exec, shell?: ShellRead): Promise<PreflightCheck> {
  const auth = await ghAuth(run)
  if (auth.state === 'missing') return { id: 'gh', ok: false, blocking: false, title: 'GitHub CLI not found', detail: 'Pull requests need gh. Everything else works without it.', fix: { command: 'brew install gh' } }
  if (auth.state === 'signed-out') return { id: 'gh', ok: false, blocking: false, title: 'GitHub CLI is not signed in', detail: 'Kernel uses gh to open and merge pull requests. Everything else works without it.', fix: { command: 'gh auth login' } }
  const gh = await run('gh', ['--version'], { timeoutMs: 10000 })
  const meta = /gh version (\d+\.\d+(?:\.\d+)?)/.exec(gh.stdout)?.[1]
  if (auth.state === 'offline') return { id: 'gh', ok: false, blocking: false, title: 'Can\'t reach GitHub', detail: 'gh is signed in, but GitHub didn\'t answer. Pull requests need it, so check again once you\'re online.', fix: { command: 'gh auth status' }, meta: meta && `gh ${meta}` }
  // ConnectRepo reads the login back out of "Signed in as <login>".
  const from = ghSource(auth.source)
  const detail = auth.login ? `Signed in as ${auth.login}${from ? `, from ${from}` : ''}` : 'Signed in'
  // A token gh uses is one Kernel passed on (shellPath.ts). One Kernel left out is still worth saying, since the terminal's gh uses it.
  const left = shell?.ghToken && !shell.ghToken.passed ? shell.ghToken.name : undefined
  const note = auth.source === 'GH_TOKEN' || auth.source === 'GITHUB_TOKEN'
    ? 'Kernel passes it on because gh has no stored login.'
    : left ? `\`${left}\` is set in your shell. Kernel leaves it out, because gh would use it instead of this login.` : undefined
  return { id: 'gh', ok: true, blocking: false, title: 'GitHub CLI', detail, ...(note ? { note } : {}), meta: meta && `gh ${meta}` }
}

// ---------- a room's push check (KERNEL-460)

/** How long each network step of the push check may take, in ms. */
export const PUSH_CHECK_MS = 20_000

/**
 * What git prints when the remote answered and refused a login, or git had none to give: no saved login over HTTPS with
 * prompts off, a wrong one, an SSH key the host doesn't accept, or GitHub's 403 for a login that can't write.
 */
const LOGIN_REFUSED = /terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Invalid username or (?:password|token)|Permission denied \(publickey|Permission to \S+ denied|returned error: 40[13]|Repository not found/i

/** The advice git adds under every failure to reach a remote, which says nothing about this one. */
const BOILERPLATE = /^(Please make sure you have the correct access rights|and the repository exists\.)$/

/** What git printed, for the box under a failed row: its first lines, where it names the problem. */
function gitSaid(r: ExecResult, what: string): string {
  if (r.timedOut) return `${what} didn't answer in ${PUSH_CHECK_MS / 1000} seconds.`
  const lines = (r.stderr.trim() || r.stdout.trim()).split('\n').map((l) => l.trim()).filter((l) => l && !BOILERPLATE.test(l))
  return lines.slice(0, 3).join('\n') || `${what} failed (${r.code}).`
}

/** How git logs in to a remote URL. `other` is a folder or a protocol with no login, like `file://`. */
function transportOf(url: string): 'https' | 'ssh' | 'other' {
  if (/^https?:\/\//i.test(url)) return 'https'
  return /^ssh:\/\/|^[^/\s]+@[^:/\s]+:/.test(url) ? 'ssh' : 'other'
}

/**
 * Whether git can push from `cwd` to `remote`, asked before an agent needs to (SettingsRoomGit*.png). Reach is
 * `git ls-remote`. Push is gh's permission on a GitHub repo and a dry-run push to a branch that doesn't exist, which logs in
 * as a real push does and sends nothing. Neither runs a hook. Null when the remote has no URL. `gh: false`, for a room
 * that merges locally, reads a GitHub remote as any other, so only git answers and gh is never asked (KERNEL-477). `run`
 * is for tests.
 */
export async function checkPush(cwd: string, remote: string, o: { run?: typeof exec; now?: () => number; gh?: boolean } = {}): Promise<PushCheck | null> {
  const run = o.run ?? exec
  const url = (await run('git', ['-C', cwd, 'remote', 'get-url', '--push', remote], { timeoutMs: 15000 })).stdout.trim()
  if (!url) return null
  const repo = (o.gh ?? true) ? githubRepoOf(url) : undefined
  const via = transportOf(url)
  const asked = `git ls-remote ${remote}`
  const done = (reach: PushCheckRow, push: PushCheckRow, login?: string): PushCheck => ({ remote, ...(repo ? { repo } : {}), ...(login ? { login } : {}), reach, push, at: (o.now ?? Date.now)() })

  const ls = await run('git', ['-C', cwd, 'ls-remote', remote, 'HEAD'], { timeoutMs: PUSH_CHECK_MS })
  // A host that refused the login was reached. Its fix is the login's, so the push row says so.
  const refused = ls.code !== 0 && !ls.timedOut && LOGIN_REFUSED.test(ls.stderr)
  if (ls.code !== 0 && !refused) {
    return done({ state: 'fail', detail: asked, output: gitSaid(ls, asked), note: 'Check your connection or VPN, then check again.' }, { state: 'unchecked', detail: 'Needs a reachable remote' })
  }
  const reach: PushCheckRow = { state: 'ok', detail: asked }

  // gh only knows GitHub. An offline gh still names its login, which is enough to say git isn't using it.
  const auth = repo ? await ghAuth(run) : undefined
  const login = auth?.state === 'ok' || auth?.state === 'offline' ? auth.login : undefined
  const canPush = repo && auth?.state === 'ok' ? await ghCanPush(repo, run) : undefined
  const cantWrite = (): PushCheckRow => ({ state: 'fail', detail: `${login ?? 'gh'} can only read ${repo}. Ask its owner for write access.` })

  // A checkout with no commit has nothing to push, so only gh can answer.
  const hasCommit = refused || (await run('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 15000 })).code === 0
  if (!hasCommit) {
    if (canPush === true) return done(reach, { state: 'ok', detail: `From gh, signed in as ${login}` }, login)
    if (canPush === false) return done(reach, cantWrite(), login)
    return done(reach, { state: 'unchecked', detail: 'Needs a first commit' }, login)
  }
  const dry = refused ? ls : await run('git', ['-C', cwd, 'push', '--dry-run', '--no-verify', '--recurse-submodules=no', remote, `HEAD:refs/heads/kernel-push-check-${Date.now()}`], { timeoutMs: PUSH_CHECK_MS })
  if (dry.code === 0) {
    const from = login && canPush === true ? `From gh, signed in as ${login}` : via === 'https' ? 'From git\'s saved login' : via === 'ssh' ? 'From your SSH key' : 'A dry-run push worked'
    return done(reach, { state: 'ok', detail: from }, login)
  }
  const said = gitSaid(dry, 'git push --dry-run')
  if (dry.timedOut || !LOGIN_REFUSED.test(dry.stderr)) return done(reach, { state: 'fail', detail: 'A dry-run push failed.', output: said }, login)
  if (canPush === false) return done(reach, cantWrite(), login)
  if (canPush === null) return done(reach, { state: 'fail', detail: `${login} can't see ${repo} on GitHub.`, output: said }, login)
  // gh's login works for git over HTTPS once gh is git's credential helper (KERNEL-437's fix).
  if (repo && via === 'https') {
    if (login) return done(reach, { state: 'fail', detail: `gh is signed in as ${login}, but git isn't using that login.`, fix: 'gh auth setup-git' }, login)
    if (auth?.state === 'missing') return done(reach, { state: 'fail', detail: 'git has no GitHub login, and gh isn\'t installed to give it one.', fix: 'brew install gh && gh auth login' })
    return done(reach, { state: 'fail', detail: 'git has no GitHub login, and gh isn\'t signed in.', fix: 'gh auth login' })
  }
  return done(reach, { state: 'fail', detail: via === 'ssh' ? 'The remote didn\'t accept your SSH key.' : 'The remote refused git\'s login.', output: said }, login)
}

/**
 * The Check push access step of room setup for a check's result (RoomSetup.png, RoomSetupWarnings.png). A failure is a
 * warning there, since a warning never blocks setup, while Settings, Room, Git shows the same result as a red x (KERNEL-437).
 * Every field is set, so a recheck that passes clears the last warning's.
 */
export function pushStepOf(c: PushCheck): Pick<RoomSetupStep, 'state' | 'title' | 'detail' | 'output' | 'fix'> {
  const to = c.repo ?? c.remote
  if (c.reach.state === 'fail') return { state: 'warn', title: `Git can't reach ${c.remote}`, detail: c.reach.note ?? '', output: c.reach.output, fix: { action: 'recheck' } }
  if (c.push.state === 'fail') {
    const d = c.push.detail
    // One sentence takes the consequence on its end, as the drawing has it. Two already say what to do.
    const detail = /\.\s/.test(d) ? d : d.replace(/\.?$/, ', so agents can\'t push yet.')
    return { state: 'warn', title: `Git can't push to ${to}`, detail, output: c.push.output, fix: { ...(c.push.fix ? { command: c.push.fix } : {}), action: 'recheck' } }
  }
  const detail = c.push.state === 'unchecked' ? c.push.detail : c.login && c.push.detail.startsWith('From gh') ? `${c.login} can push to ${to}` : `git can push to ${to}`
  return { state: 'ok', title: 'Check push access', detail, output: undefined, fix: undefined }
}
