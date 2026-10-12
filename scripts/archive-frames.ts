// Frame capture for archiving the chat or workspace on screen (KERNEL-578, KERNEL-596), against the real main process.
// Runs on plain Node with built-in type stripping, so only erasable TypeScript here.
//
//   node scripts/archive-frames.ts after       this checkout's code
//   node scripts/archive-frames.ts before      the code this branch was cut from (origin/main at that time), built in a temporary git worktree that is removed afterwards
//   node scripts/archive-frames.ts table       the before and after results of the last runs, as a markdown table
//
//   --only chat-row,last-tab   run some paths (ids are in `paths` below)
//   --where screen,chat,history   run some placements: the item on screen, another chat open, History open
//   --no-build   reuse the last build in the folder being tested
//   --rebuild-world   build the room again instead of reusing the one saved for this code
//
// Nothing is simulated. It launches the built app headless (KERNEL_HEADLESS=1) with its own application-data folder, its own HOME and a
// temp git repo with a bare origin, so it never touches the data or ~/.claude of a Kernel you run. The room, its chats with Rowan, its
// workspaces and their worktrees are made through the app's own IPC, and every archive is the app's own: main stops sessions and removes
// worktrees, pushes each archived workspace, and answers when it is done. The one thing set by hand is which chat a workspace belongs to
// (and a title for the row), because only Rowan's create_workspace tool sets that and it needs a Claude session. That is one UPDATE on
// the app's database before the window loads. No Claude session ever starts: preflight passes on CLAUDE_CODE_USE_BEDROCK and no prompt is sent.
//
// The room is built once per code version and saved, then restored before each run, so every run archives the same untouched world.
//
// A requestAnimationFrame loop and a MutationObserver in the page read which screen the main area shows, from just before the click until
// the destination has held for 20 frames. A frame is fine when it shows the screen the item was on, or the destination, in that order.
// Anything else (History, the workspace stripped of its tabs, another chat) is outside. capturePage runs alongside and saves what the window
// painted. Images taken while an outside frame was on screen are named BAD_*.
//
// Frames are saved to shots/archive-frames/<before|after>/<path>-<where>/ and the verdicts to results.json and summary.txt beside them.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WIDTH = 1440
const HEIGHT = 900
/** Frames the destination must hold before the run counts as settled. */
const SETTLE = 30
const FRAME_MS = 16
/** The folder every run lives in. The database holds absolute paths, so the world is always restored to the same place. */
const BASE = join(realpathSync(tmpdir()), 'kernel-596-frames')

// ---------- What a frame shows

export type Sig =
  | { kind: 'workspace'; title: string; tabs: number }
  | { kind: 'new-chat'; room: string }
  | { kind: 'history' }
  | { kind: 'other'; text: string }
  | { kind: 'none' }

export type Want = { kind: 'workspace'; title: string; tabs: boolean } | { kind: 'new-chat' } | { kind: 'history' }
export type Expect = { old: Want; dest?: Want }
export type Seen = 'old' | 'dest' | 'other'
export type Sample = { n: number; at: number; src: 'frame' | 'commit'; sig: Sig; labels: string[]; seen: Seen }

const same = (s: Sig, w: Want) => s.kind === w.kind && (s.kind !== 'workspace' || w.kind !== 'workspace' || (s.title === w.title && (!w.tabs || s.tabs > 0)))

/** Page side as well: `sampler` receives this function's source, so it can use nothing but its arguments. */
export function classify(sig: Sig, want: Expect): Seen {
  const is = (w: Want | undefined) => !!w && sig.kind === w.kind && (sig.kind !== 'workspace' || w.kind !== 'workspace' || (sig.title === w.title && (!w.tabs || sig.tabs > 0)))
  return is(want.old) ? 'old' : is(want.dest) ? 'dest' : 'other'
}

/** The words for a screen, as a person would say it. */
export const say = (s: Sig) => s.kind === 'workspace' ? `"${s.title}"${s.tabs ? '' : ' with no tabs'}` : s.kind === 'new-chat' ? 'New chat with Rowan' : s.kind === 'history' ? 'History' : s.kind === 'none' ? 'a blank screen' : `${s.text}`

/** Runs in the page. Reads the screen in the main area (the live one, not the copy an archive leaves under it while it fades, and not the footer) on every animation frame and on every DOM change, so a screen that is committed and gone between two frames still shows. Page side, so it uses nothing from this file. */
export function sampler(want: Expect, judge: (sig: Sig, want: Expect) => Seen) {
  const log: Sample[] = []
  let n = 0
  let streak = 0
  let live = true
  let last = ''
  const toasts = new Set<string>()
  const stamp = document.createElement('div')
  stamp.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:4px;font:11px/1.4 ui-monospace,monospace;color:#fff'
  document.body.appendChild(stamp)
  const read = (): Sig => {
    const main = document.querySelector('.app > .main')
    const layers = main ? [...main.children].filter((e) => !e.hasAttribute('data-archive-ghost') && !e.classList.contains('ft')) : []
    const el = layers[layers.length - 1]
    if (!el) return { kind: 'none' }
    const text = (node: Element | null | undefined) => (node?.textContent || '').trim()
    const title = el.querySelector('.ws-title')
    if (title) return { kind: 'workspace', title: text(title), tabs: el.querySelectorAll('.ws-tabs [role="tab"]').length }
    const h1 = text(el.querySelector('h1'))
    if (h1 === 'New chat' && (el.matches('.ws-panel') || el.querySelector('.ws-panel'))) return { kind: 'new-chat', room: text(el.querySelector('.crumb')) }
    if (h1 === 'History') return { kind: 'history' }
    return { kind: 'other', text: h1 || el.className || el.tagName }
  }
  const labels = () => [...document.querySelectorAll('[aria-current="page"]')].map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
  const push = (src: Sample['src']) => {
    const sig = read()
    const key = JSON.stringify(sig)
    if (src === 'commit' && key === last) return
    last = key
    const seen = judge(sig, want)
    if (src === 'frame') { n++; streak = seen === 'dest' || (!want.dest && seen === 'old') ? streak + 1 : 0 }
    log.push({ n, at: performance.timeOrigin + performance.now(), src, sig, labels: labels(), seen })
    if (src === 'frame') {
      for (const t of document.querySelectorAll('.app-toasts > *')) toasts.add((t.textContent || '').trim())
      stamp.textContent = seen === 'other' ? `#${n} OUTSIDE ${JSON.stringify(sig)}` : `#${n} ${seen}`
      stamp.style.background = seen === 'other' ? 'rgba(170,0,0,.92)' : 'rgba(0,0,0,.75)'
    }
  }
  const observer = new MutationObserver(() => { if (live) push('commit') })
  const target = document.querySelector('.app') ?? document.body
  observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true })
  const tick = () => {
    if (!live) return
    push('frame')
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  ;(window as any).__frames = { status: () => ({ n, streak }), stop: () => { live = false; observer.disconnect(); stamp.remove(); return { log, toasts: [...toasts] } } }
}

export type Outside = { first: number; last: number; frames: number; ms: number; what: string }

/** The frames reduced to a verdict: how many sat outside, where, and the order of screens they went through. */
export function summarize(log: Sample[]): { frames: number; outside: number; sequence: string[]; runs: Outside[] } {
  const sequence: string[] = []
  for (const s of log) {
    const word = s.seen === 'other' ? say(s.sig) : s.seen
    if (sequence[sequence.length - 1] !== word) sequence.push(word)
  }
  const runs: Outside[] = []
  let run: Sample[] = []
  const flush = () => {
    if (!run.length) return
    const first = run[0]
    const last = run[run.length - 1]
    runs.push({ first: first.n, last: last.n, frames: run.filter((s) => s.src === 'frame').length, ms: Math.round(last.at - first.at + FRAME_MS), what: say(first.sig) })
    run = []
  }
  for (const s of log) { if (s.seen === 'other') run.push(s); else flush() }
  flush()
  return { frames: log.filter((s) => s.src === 'frame').length, outside: log.filter((s) => s.seen === 'other').length, sequence, runs }
}

/** Passes when every frame and every commit was the old screen or the destination, in that order, and the destination held. Without a destination the old screen never changes. */
export const passes = (s: ReturnType<typeof summarize>, settled: boolean, moves: boolean) => settled && s.outside === 0 && s.sequence.join('>') === (moves ? 'old>dest' : 'old')

/** An image is BAD when a frame outside was on screen while capturePage took it. */
export const caught = (shot: { from: number; to: number }, log: Sample[]) => log.some((s) => s.seen === 'other' && s.at >= shot.from - 20 && s.at <= shot.to + 20)

// ---------- Making the room, with the app's own IPC

type Ctx = { app: ElectronApplication; page: Page; dir: string; live: string }
type Item = { id: string; title: string }
type World = { roomId: string; chats: Record<string, { threadId: string; workspaceId: string; chatId: string }>; workspaces: Record<string, { id: string; path: string }>; repo: string }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const call = (page: Page, channel: string, req?: unknown) => page.evaluate(([c, r]) => (window as any).kernel.invoke(c, r), [channel, req] as const)

function sh(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Kai', GIT_AUTHOR_EMAIL: 'kai@example.com', GIT_COMMITTER_NAME: 'Kai', GIT_COMMITTER_EMAIL: 'kai@example.com' } })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd ?? '.'}:\n${r.stderr || r.stdout}`)
  return r.stdout
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)) })
  })
}

/** A repo with one commit and a bare origin, so Rowan's chats get worktrees and a room with no GitHub merges on the Mac. */
function makeRepo(live: string) {
  const repo = join(live, 'shop')
  const origin = join(live, 'origin.git')
  mkdirSync(repo, { recursive: true })
  sh('git', ['init', '-b', 'main'], repo)
  writeFileSync(join(repo, 'README.md'), '# Shop\n')
  sh('git', ['add', '.'], repo)
  sh('git', ['commit', '-m', 'Start the shop'], repo)
  sh('git', ['clone', '--bare', repo, origin])
  sh('git', ['remote', 'add', 'origin', origin], repo)
  sh('git', ['fetch', 'origin'], repo)
  sh('git', ['branch', '-u', 'origin/main', 'main'], repo)
  return repo
}

/** A folder with a launcher that moves Electron's application data before the app starts, which nothing in the environment can do. */
function makeAppDir(dir: string, live: string) {
  const app = join(live, 'app')
  mkdirSync(app, { recursive: true })
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'launcher.cjs' }))
  writeFileSync(join(app, 'launcher.cjs'), "const { app } = require('electron')\napp.setPath('appData', process.env.KERNEL_APP_DATA)\nimport('./out/main/index.js')\n")
  for (const d of ['out', 'docs', 'build', 'site', 'node_modules']) if (existsSync(join(dir, d))) symlinkSync(join(dir, d), join(app, d))
  return app
}

async function launch(dir: string, live: string): Promise<Ctx> {
  const home = join(live, 'home')
  const data = join(live, 'appdata')
  mkdirSync(join(data, 'Kernel Dev'), { recursive: true })
  mkdirSync(home, { recursive: true })
  // The hook server's port is free, so it never answers hook calls meant for a Kernel you are running (the default is 7420).
  const settings = join(data, 'Kernel Dev', 'settings.json')
  if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ version: 2, hookPort: await freePort() }))
  const appDir = join(live, 'app')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN)$/.test(k)) env[k] = v
  Object.assign(env, {
    KERNEL_HEADLESS: '1', KERNEL_APP_DATA: data, HOME: home, KERNEL_LOG_DIR: join(live, 'logs'),
    // Preflight passes on this without a Claude sign-in, and no session is ever started. The mock keychain (an argument below) keeps Electron's
    // safe storage off the real keychain, which a faked HOME hides and which then asks for a password in a dialog nobody sees.
    CLAUDE_CODE_USE_BEDROCK: '1',
    GIT_AUTHOR_NAME: 'Kai', GIT_AUTHOR_EMAIL: 'kai@example.com', GIT_COMMITTER_NAME: 'Kai', GIT_COMMITTER_EMAIL: 'kai@example.com'
  })
  const executablePath: string = createRequire(import.meta.url)('electron')
  // Playwright sometimes never gets its devtools connection from a headless Electron. A second try on the same folder works, once the first is gone.
  let app: ElectronApplication | undefined
  for (let attempt = 1; !app; attempt++) {
    try { app = await electron.launch({ executablePath, args: [appDir, '--force-device-scale-factor=1', '--use-mock-keychain'], cwd: appDir, env, timeout: 60_000 }) }
    catch (e) {
      console.log(`  launch attempt ${attempt} failed: ${String(e instanceof Error ? e.message : e).split('\n')[0]}`)
      if (attempt >= 3) throw e
      await reap()
      await sleep(1000)
    }
  }
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h), { w: WIDTH, h: HEIGHT })
  await page.waitForFunction(() => !!(window as any).kernel)
  return { app, page, dir, live }
}

/**
 * Ends everything still running from this script's folder: the app's helper processes, and whatever it started (git, scripts). They can outlive
 * the app for a moment, hold the folder, and a launch on it is then turned away by the single-instance lock, so the next run waits for them.
 */
export async function reap() {
  for (let i = 0; i < 50; i++) {
    const pids = spawnSync('pgrep', ['-f', BASE], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid)
    if (!pids.length) return
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone already */ } }
    await sleep(200)
  }
}

/** Closes the app and makes sure it is gone, so the next launch on the same folder is not turned away by the single-instance lock. */
export async function shutdown(app: ElectronApplication | undefined) {
  if (!app) return
  const pid = app.process().pid
  await Promise.race([app.close().catch(() => undefined), sleep(8000)])
  for (let i = 0; i < 40 && pid; i++) {
    try { process.kill(pid, 0) } catch { break }
    if (i === 20) { try { process.kill(pid, 'SIGKILL') } catch { break } }
    await sleep(100)
  }
  await reap()
}

/** Through the first-run screens, which a saved room has done already. */
async function pastOnboarding(page: Page) {
  const start = page.getByRole('button', { name: 'Get started' })
  if (await start.isVisible({ timeout: 4000 }).catch(() => false)) {
    await start.click()
    const next = page.getByRole('button', { name: 'Continue' })
    await next.waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Continue' && !(b as HTMLButtonElement).disabled))
    await next.click()
  }
  await page.waitForSelector('.app > .main')
}

/** Edits fields of workspace records on the app's own database. The app reads it on every call, and the window reloads after. */
async function patch(ctx: Ctx, edits: { id: string; set: Record<string, unknown> }[]) {
  await ctx.app.evaluate((_electron, { appDir, file, edits }) => {
    const Database = (process as any).mainModule.require('node:module').createRequire(appDir + '/')('better-sqlite3')
    const db = new Database(file)
    try {
      for (const e of edits) for (const [key, value] of Object.entries(e.set)) db.prepare("update workspaces set data = json_set(data, '$.' || ?, json(?)) where id = ?").run(key, JSON.stringify(value), e.id)
    } finally { db.close() }
  }, { appDir: join(ctx.live, 'app'), file: join(ctx.live, 'appdata', 'Kernel Dev', 'kernel.db'), edits })
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`)
    await sleep(150)
  }
}

const listWs = (page: Page) => call(page, 'workspaces.list', {}) as Promise<any[]>
const ready = (page: Page, id: string) => until(`workspace ${id} to be ready`, async () => (await listWs(page)).find((w) => w.id === id && w.status === 'ready' && !w.worktreePending))

export const CHATS = ['Draft the changelog', 'Seed realistic demo data', 'Client portal login', 'Invoice table and empty states', 'Export invoices as PDF']
/** Workspaces of the room: the title the sidebar shows, and the chat it was started by when it has one. */
export const WORKSPACES: { key: string; title: string; chat?: string }[] = [
  { key: 'redirect', title: 'fix-login-redirect' }, { key: 'nav', title: 'fix-nav-overflow' },
  { key: 'billing', title: 'billing-page' }, { key: 'csv', title: 'export-csv' }, { key: 'folder', title: 'seed-script' },
  { key: 'reviewed', title: 'org-invites' }, { key: 'review', title: 'review-org-invites' },
  { key: 'renderer', title: 'invoice-pdf-renderer', chat: 'Client portal login' }, { key: 'button', title: 'invoice-pdf-button', chat: 'Client portal login' }
]

/**
 * A workspace made through the app starts a Claude turn for its first chat, which has no credentials here and never ends by itself. Kernel keeps
 * a workspace with a turn running (it goes when the turn ends), and a Kernel that quits mid-turn starts it again. So the turns are stopped, and
 * the room is saved with none running.
 */
async function quiet(page: Page) {
  for (let calm = 0; calm < 4;) {
    const live = (await call(page, 'chats.live')) as { running: string[] }
    if (!live.running.length) { calm++; await sleep(250); continue }
    calm = 0
    for (const chatId of live.running) await call(page, 'chats.interrupt', { chatId }).catch(() => undefined)
    await sleep(400)
  }
}

/** Makes the room: chats with Rowan, workspaces, a dirty tree, a merged branch and a branch ready to merge, all through the app. Returns what the paths need. */
async function buildWorld(ctx: Ctx): Promise<World> {
  const { page } = ctx
  await pastOnboarding(page)
  const repo = join(ctx.live, 'shop')
  const added: any = await call(page, 'rooms.add', { path: repo, name: 'Shop' })
  // A room with no GitHub merges its branches on the Mac (KERNEL-478), which is the only merge a temp repo can have for real.
  const room: any = await call(page, 'rooms.update', { roomId: added.id, patch: { host: 'local' } })
  await until('the room team', async () => ((await call(page, 'agents.list', { roomId: room.id })) as any[]).some((a) => a.lead))
  // Teammates for the workspaces: the Lead's own workspaces are never archived on merge, so a workspace made without one would stay.
  for (const id of ['kai', 'theo']) await call(page, 'agents.addStarter', { roomId: room.id, id })
  sh('git', ['add', '-A'], repo)
  sh('git', ['commit', '-m', 'Add the team'], repo)
  sh('git', ['push', 'origin', 'main'], repo)
  const chats: World['chats'] = {}
  for (const title of CHATS) {
    const c: any = await call(page, 'lead.start', { roomId: room.id, prompt: '' })
    const ws = await ready(page, c.workspaceId)
    await call(page, 'threads.rename', { threadId: ws.threadId, title })
    chats[title] = { threadId: ws.threadId, workspaceId: ws.id, chatId: c.id }
    await sleep(120)
  }
  const workspaces: World['workspaces'] = {}
  const make = async (key: string) => {
    const made: any = await call(page, 'workspaces.create', { roomId: room.id, prompt: '', agentId: 'kai' })
    const ws = await ready(page, made.id)
    workspaces[key] = { id: ws.id, path: ws.path }
  }
  const commit = (key: string, file: string) => {
    const dirPath = workspaces[key].path
    writeFileSync(join(dirPath, file), `${key}\n`)
    sh('git', ['add', '.'], dirPath)
    sh('git', ['commit', '-m', `Add ${file}`], dirPath)
  }
  // The merged branch goes first: a real local merge on the Mac, kept in the room until someone archives it. Branches cut after it start from the new main.
  await call(page, 'settings.set', { patch: { workspace: { archiveOnMerge: false } } })
  await make('csv')
  commit('csv', 'export.ts')
  await call(page, 'pr.refresh', { workspaceId: workspaces.csv.id })
  await call(page, 'pr.merge', { workspaceId: workspaces.csv.id })
  await until('export-csv to merge', async () => (await listWs(page)).find((w) => w.id === workspaces.csv.id && w.prState === 'merged'))
  await call(page, 'settings.set', { patch: { workspace: { archiveOnMerge: true } } })
  // Main goes to the origin too, so the branches cut next start from it and are not behind it.
  sh('git', ['push', 'origin', 'main'], repo)
  for (const w of WORKSPACES) if (w.key !== 'csv') await make(w.key)
  await patch(ctx, WORKSPACES.map((w) => ({
    id: workspaces[w.key].id,
    set: { title: w.title, ...(w.chat ? { threadId: chats[w.chat].threadId, leadChatId: chats[w.chat].chatId } : {}), ...(w.key === 'review' ? { reviewOf: workspaces.reviewed.id, agentId: 'theo' } : {}) }
  })))
  // Real git in the real worktrees: uncommitted files for the confirms, and commits to merge.
  for (const key of ['nav', 'button']) writeFileSync(join(workspaces[key].path, `${key}-notes.md`), 'half done\n')
  // Pushed to the bare origin, so the commits are on the remote and Archive on merge finds nothing to keep the branch for.
  for (const [key, file] of [['billing', 'billing.ts'], ['reviewed', 'invites.ts']] as const) { commit(key, file); sh('git', ['push', 'origin', 'HEAD'], workspaces[key].path) }
  // A chat with Rowan that has done work: a commit on the remote, so the PR header has a state to show on its own workspace.
  const worked = (await listWs(page)).find((w) => w.id === chats['Export invoices as PDF'].workspaceId)
  workspaces.worked = { id: worked.id, path: worked.path }
  commit('worked', 'invoices.pdf.ts')
  sh('git', ['push', 'origin', 'HEAD'], worked.path)
  await page.reload()
  await pastOnboarding(page)
  for (const key of ['billing', 'reviewed', 'worked']) await call(page, 'pr.refresh', { workspaceId: workspaces[key].id })
  await quiet(page)
  // Folders deleted outside Kernel, which the window notices when the workspace opens.
  const gone = (await listWs(page)).find((w) => w.id === chats['Draft the changelog'].workspaceId)
  for (const path of [workspaces.folder.path, gone.path]) rmSync(path, { recursive: true, force: true })
  return { roomId: room.id, chats, workspaces, repo }
}

// ---------- The paths

type Where = 'screen' | 'chat' | 'history'
type Plan = {
  note: string
  /** Gets the window to where the click is, and says what the main area should show before it and after it. With another screen open nothing moves, so there is no destination. */
  prepare: () => Promise<Expect>
  trigger: () => Promise<void>
  /** Main has finished archiving. */
  done: () => Promise<boolean>
  /** Kernel made this archive on its own, so it says so in a toast. An archive by hand says nothing. */
  toast?: boolean
}
type PathDef = { id: string; name: string; where: Where[]; plan: (ctx: Ctx, w: World, where: Where) => Plan }

const OTHER_CHAT = 'Seed realistic demo data'
const quote = (s: string) => s.replace(/"/g, '\\"')
const chatRow = (page: Page, title: string) => page.locator(`.chat-row:has(button[aria-label="Archive ${quote(title)}"])`)
const workspaceRow = (page: Page, name: string) => page.locator(`.ws-row:has(button[aria-label="Archive ${quote(name)}"])`)
const dialog = (page: Page) => page.getByRole('alertdialog')
const rowArchive = (page: Page, name: string) => page.locator(`button[aria-label="Archive ${quote(name)}"]`)
const roomRow = (page: Page) => page.locator('.room-row .nav-item').first()

/** Waits for the sidebar to mark a row current whose name starts with `label`. */
const showing = (page: Page, label: string) =>
  page.waitForFunction((l) => [...document.querySelectorAll('[aria-current="page"]')].some((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().startsWith(l)), label)

/** The room open in the sidebar, so its rows can be clicked. */
async function expand(page: Page) {
  if ((await page.locator('.chat-row').count()) === 0) await roomRow(page).click()
  await page.locator('.chat-row').first().waitFor()
}
const openChat = async (page: Page, title: string) => { await expand(page); await chatRow(page, title).locator('button.nav-item').click(); await showing(page, title); await settleTabs(page) }
const openWorkspace = async (page: Page, name: string) => { await expand(page); await workspaceRow(page, name).locator('button.nav-item').click(); await showing(page, name) }
const openHistory = async (page: Page) => { await page.getByRole('button', { name: 'History', exact: true }).first().click(); await page.getByRole('heading', { name: 'History' }).waitFor() }

/** A chat reads its tabs from main the first time it opens, and the frames of an empty tab strip are not what this measures. */
const settleTabs = (page: Page) => page.waitForFunction(() => !!document.querySelector('.ws-tabs [role="tab"]'), undefined, { timeout: 4000 }).catch(() => undefined)

/** What the main area shows, read once before the sampler starts, so the expectation names what the screen really draws. */
async function screenNow(page: Page): Promise<Sig> {
  return page.evaluate(() => {
    const main = document.querySelector('.app > .main')
    const el = main ? [...main.children].filter((e) => !e.hasAttribute('data-archive-ghost') && !e.classList.contains('ft')).pop() : undefined
    const text = (n: Element | null | undefined) => (n?.textContent || '').trim()
    const title = el?.querySelector('.ws-title')
    if (title) return { kind: 'workspace', title: text(title), tabs: el!.querySelectorAll('.ws-tabs [role="tab"]').length }
    const h1 = text(el?.querySelector('h1'))
    return h1 === 'History' ? { kind: 'history' } : { kind: 'other', text: h1 }
  }) as Promise<Sig>
}

const wantOf = async (page: Page): Promise<Want> => {
  const s = await screenNow(page)
  if (s.kind !== 'workspace') throw new Error(`The window is not on a workspace: ${say(s)}`)
  return { kind: 'workspace', title: s.title, tabs: s.tabs > 0 }
}

const NEW_CHAT: Want = { kind: 'new-chat' }

/** Puts the window where the placement says: on the item (`onItem`), on another chat, or on History. Then reads what it shows. */
async function place(page: Page, where: Where, onItem: () => Promise<void>): Promise<Expect> {
  if (where === 'screen') { await onItem(); return { old: await wantOf(page), dest: NEW_CHAT } }
  if (where === 'history') { await openHistory(page); return { old: { kind: 'history' } } }
  await openChat(page, OTHER_CHAT)
  return { old: await wantOf(page) }
}

const archived = (page: Page, ...ids: string[]) => async () => { const all = await listWs(page); return ids.every((id) => all.find((w) => w.id === id)?.status === 'archived') }
const confirmButton = (page: Page) => dialog(page).getByRole('button', { name: /^(Push and archive|Archive|Close chat)$/ })

export const paths: PathDef[] = [
  {
    id: 'chat-row', name: "chat row's Archive", where: ['screen', 'chat', 'history'],
    plan(ctx, w, where) {
      const { page } = ctx
      const title = 'Invoice table and empty states'
      return {
        note: `"${title}"`, done: archived(page, w.chats[title].workspaceId),
        prepare: async () => { await expand(page); const e = await place(page, where, () => openChat(page, title)); await chatRow(page, title).hover(); return e },
        trigger: () => rowArchive(page, title).click()
      }
    }
  },
  {
    id: 'chat-with-work', name: 'chat with committed work, so its PR header is on screen (ConfirmArchiveChat)', where: ['screen'],
    plan(ctx, w) {
      const { page } = ctx
      const title = 'Export invoices as PDF'
      return {
        note: `"${title}", with a commit on the remote`, done: archived(page, w.chats[title].workspaceId),
        // A commit that is ahead of its base is something to lose, so the chat asks first.
        prepare: async () => {
          await expand(page)
          const e = await place(page, 'screen', () => openChat(page, title))
          await chatRow(page, title).hover()
          await rowArchive(page, title).click()
          await dialog(page).waitFor()
          return e
        },
        trigger: () => confirmButton(page).click()
      }
    }
  },
  {
    id: 'last-tab', name: "closing the chat's last tab", where: ['screen'],
    plan(ctx, w) {
      const { page } = ctx
      const title = 'Seed realistic demo data'
      return {
        note: `"${title}"`, done: archived(page, w.chats[title].workspaceId),
        prepare: async () => { await openChat(page, title); return { old: await wantOf(page), dest: NEW_CHAT } },
        trigger: async () => {
          const tab = page.locator('.ws-tabs .tab-group:has([role="tab"][aria-selected="true"])')
          await tab.hover()
          await tab.locator('button[aria-label^="Close "]').click()
        }
      }
    }
  },
  {
    id: 'confirm-chat', name: 'Archive chat confirm (ConfirmArchiveChat)', where: ['screen', 'chat', 'history'],
    plan(ctx, w, where) {
      const { page } = ctx
      const title = 'Client portal login'
      const c = w.chats[title]
      return {
        note: `"${title}", whose workspace invoice-pdf-button has uncommitted files`, done: archived(page, c.workspaceId, w.workspaces.renderer.id, w.workspaces.button.id),
        prepare: async () => {
          await expand(page)
          const e = await place(page, where, () => openChat(page, title))
          await chatRow(page, title).hover()
          await rowArchive(page, title).click()
          await dialog(page).waitFor()
          return e
        },
        trigger: () => confirmButton(page).click()
      }
    }
  },
  {
    id: 'handed-off', name: 'chat archived while one of its workspaces is on screen', where: ['screen'],
    plan(ctx, w) {
      const { page } = ctx
      const title = 'Client portal login'
      const c = w.chats[title]
      return {
        note: `workspace "invoice-pdf-renderer" of "${title}"`, done: archived(page, c.workspaceId, w.workspaces.renderer.id, w.workspaces.button.id),
        prepare: async () => {
          await openWorkspace(page, 'invoice-pdf-renderer')
          const e: Expect = { old: await wantOf(page), dest: NEW_CHAT }
          await chatRow(page, title).hover()
          await rowArchive(page, title).click()
          await dialog(page).waitFor()
          return e
        },
        trigger: () => confirmButton(page).click()
      }
    }
  },
  {
    id: 'workspace-row', name: "workspace row's Archive", where: ['screen', 'chat', 'history'],
    plan(ctx, w, where) {
      const { page } = ctx
      const name = 'fix-login-redirect'
      return {
        note: `workspace "${name}"`, done: archived(page, w.workspaces.redirect.id),
        prepare: async () => { await expand(page); const e = await place(page, where, () => openWorkspace(page, name)); await workspaceRow(page, name).hover(); return e },
        trigger: () => rowArchive(page, name).click()
      }
    }
  },
  {
    id: 'confirm-workspace', name: 'Archive workspace confirm (ConfirmArchive)', where: ['screen', 'chat', 'history'],
    plan(ctx, w, where) {
      const { page } = ctx
      const name = 'fix-nav-overflow'
      return {
        note: `workspace "${name}", which has an uncommitted file`, done: archived(page, w.workspaces.nav.id),
        prepare: async () => {
          await expand(page)
          const e = await place(page, where, () => openWorkspace(page, name))
          await workspaceRow(page, name).hover()
          await rowArchive(page, name).click()
          await dialog(page).waitFor()
          return e
        },
        trigger: () => confirmButton(page).click()
      }
    }
  },
  {
    id: 'pr-header', name: "PR header's Archive, then ConfirmArchive", where: ['screen'],
    plan(ctx, w) {
      const { page } = ctx
      const name = 'export-csv'
      return {
        note: `workspace "${name}", merged`, done: archived(page, w.workspaces.csv.id),
        prepare: async () => {
          await openWorkspace(page, name)
          const e: Expect = { old: await wantOf(page), dest: NEW_CHAT }
          await page.locator('.pr-tone').getByRole('button', { name: 'Archive', exact: true }).click()
          await dialog(page).waitFor()
          return e
        },
        trigger: () => confirmButton(page).click()
      }
    }
  },
  {
    id: 'kernel-merge', name: 'Kernel archiving a workspace after its PR merged', where: ['screen', 'chat', 'history'],
    plan(ctx, w, where) {
      const { page } = ctx
      const name = 'billing-page'
      const id = w.workspaces.billing.id
      return {
        note: `workspace "${name}", merged on the Mac while Archive on merge is on`, done: archived(page, id), toast: true,
        prepare: () => place(page, where, () => openWorkspace(page, name)),
        trigger: async () => {
          if (where === 'screen') await page.locator('.pr-tone').getByRole('button', { name: /^Merge/ }).first().click()
          else await call(page, 'pr.merge', { workspaceId: id })
        }
      }
    }
  },
  {
    id: 'review', name: 'a review archived once the work it reviewed merged', where: ['screen', 'history'],
    plan(ctx, w, where) {
      const { page } = ctx
      const name = 'review-org-invites'
      return {
        note: `review "${name}" of org-invites, which merges on the Mac`, done: archived(page, w.workspaces.review.id), toast: true,
        prepare: () => place(page, where, () => openWorkspace(page, name)),
        trigger: () => call(page, 'pr.merge', { workspaceId: w.workspaces.reviewed.id }).then(() => undefined)
      }
    }
  },
  {
    id: 'banner-workspace', name: "banner's Archive on a workspace whose folder is gone", where: ['screen'],
    plan(ctx, w) {
      const { page } = ctx
      const name = 'seed-script'
      return {
        note: `workspace "${name}"`, done: archived(page, w.workspaces.folder.id),
        prepare: async () => { await openWorkspace(page, name); await page.getByText("This workspace's folder is gone").waitFor(); return { old: await wantOf(page), dest: NEW_CHAT } },
        trigger: () => page.getByRole('button', { name: 'Archive', exact: true }).click()
      }
    }
  },
  {
    id: 'banner-chat', name: "banner's Archive on a chat whose folder is gone", where: ['screen'],
    plan(ctx, w) {
      const { page } = ctx
      const title = 'Draft the changelog'
      return {
        note: `"${title}"`, done: archived(page, w.chats[title].workspaceId),
        prepare: async () => { await openChat(page, title); await page.getByText("This workspace's folder is gone").waitFor(); return { old: await wantOf(page), dest: NEW_CHAT } },
        trigger: () => page.getByRole('button', { name: 'Archive', exact: true }).click()
      }
    }
  }
]

// ---------- One run

type Result = { id: string; name: string; where: Where; verdict: 'PASS' | 'FAIL' | 'ERROR'; note: string; lines: string[]; sequence: string[]; toasts: string[]; settled?: boolean; dir?: string }
type Shot = { from: number; to: number; jpeg: string }

/** Two loops of capturePage back to back, each returning a JPEG. `stop` waits for the ones in flight. */
export function capturing(app: ElectronApplication): () => Promise<Shot[]> {
  const shots: Shot[] = []
  let on = true
  const loop = async () => {
    while (on) {
      const from = Date.now()
      const jpeg = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.isOffscreen()) ?? BrowserWindow.getAllWindows()[0]
        const image = await win.webContents.capturePage()
        return image.isEmpty() ? '' : image.toJPEG(70).toString('base64')
      })
      shots.push({ from, to: Date.now(), jpeg })
    }
  }
  const loops = [loop(), loop()]
  return async () => { on = false; await Promise.all(loops); return shots }
}

function restore(live: string, saved: string) {
  rmSync(live, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  cpSync(saved, live, { recursive: true, verbatimSymlinks: true })
}

const WHERE_WORDS: Record<Where, string> = { screen: 'on screen', chat: 'another chat open', history: 'History open' }

async function run(def: PathDef, where: Where, o: { dir: string; live: string; saved: string; out: string; world: World }): Promise<Result> {
  const base = { id: def.id, name: def.name, where }
  let ctx: Ctx | undefined
  try {
    await reap()
    restore(o.live, o.saved)
    ctx = await launch(o.dir, o.live)
    const { app, page } = ctx
    await pastOnboarding(page)
    await quiet(page)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const plan = def.plan(ctx, o.world, where)
    const expect = await plan.prepare()
    await page.waitForTimeout(600)
    await page.evaluate(`(${sampler.toString()})(${JSON.stringify(expect)}, ${classify.toString()})`)
    const stop = capturing(app)
    const t0 = Date.now()
    let settled = false
    let shots: Shot[] = []
    try {
      await plan.trigger()
      let doneAt = 0
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        await sleep(50)
        if (!doneAt && (await plan.done())) doneAt = Date.now()
        const status = await page.evaluate<{ streak: number }>('window.__frames.status()')
        if (doneAt && Date.now() - doneAt > 700 && status.streak >= SETTLE) { settled = true; break }
        // Past a couple of seconds after main is done, a screen that still has not held is not going to.
        if (doneAt && Date.now() - doneAt > 3000) break
      }
    } finally {
      shots = await stop()
    }
    const { log, toasts } = await page.evaluate<{ log: Sample[]; toasts: string[] }>('window.__frames.stop()')
    const summary = summarize(log)
    const dir = join(o.out, `${def.id}-${where}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    let empty = 0
    shots.forEach((s, i) => {
      if (!s.jpeg) { empty++; return }
      const at = s.to - t0
      writeFileSync(join(dir, `${caught(s, log) ? 'BAD_' : ''}${String(i).padStart(4, '0')}_${at < 0 ? '-' : '+'}${String(Math.abs(at)).padStart(5, '0')}ms.jpg`), Buffer.from(s.jpeg, 'base64'))
    })
    writeFileSync(join(dir, 'frames.json'), JSON.stringify({ note: plan.note, settled, expect, toasts, summary, frames: log }, null, 1))

    const moves = !!expect.dest
    // Toasts stack in one box, so the text of one may follow the text of another.
    const told = toasts.filter((t) => t.includes('Archived '))
    // The toast says what happened to the screen you were on, so it comes only when that screen moved.
    const wantsToast = !!plan.toast && moves
    const toastOk = wantsToast ? told.length > 0 : told.length === 0
    const lines = [`${summary.frames} frames and ${log.length - summary.frames} DOM changes, ${summary.outside} outside, screens in order: ${summary.sequence.join(' > ') || 'none'}`]
    for (const r of summary.runs) lines.push(`  frames ${r.first} to ${r.last} (${r.frames} frames, about ${r.ms} ms) showed ${r.what}`)
    if (!summary.frames) lines.push('  No animation frames ran, so the window was not painting. Nothing here proves anything.')
    else if (!settled) lines.push(`  It never settled. The last screen was ${say(log[log.length - 1].sig)}.`)
    lines.push(wantsToast ? (told.length ? `  Kernel said: ${told[0]}` : '  Kernel said nothing, and an archive of its own should have a toast.') : told.length ? `  A toast appeared that should not have: ${told[0]}` : plan.toast ? '  No toast, since the screen did not move.' : '  No toast, as for an archive by hand.')
    if (empty) lines.push(`  ${empty} of ${shots.length} capturePage images came back empty.`)
    const ok = summary.frames > 0 && passes(summary, settled, moves) && toastOk
    return { ...base, verdict: ok ? 'PASS' : 'FAIL', note: plan.note, lines, sequence: summary.sequence, toasts, settled, dir }
  } catch (e) {
    return { ...base, verdict: 'ERROR', note: '', lines: [e instanceof Error ? e.message.split('\n').slice(0, 5).join('\n    ') : String(e)], sequence: [], toasts: [] }
  } finally {
    await shutdown(ctx?.app)
  }
}

// ---------- The code under test

function git(args: string[], cwd = root) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

/** The code this branch started from (origin/main when it was cut), in a temporary worktree sharing this checkout's node_modules. Removed by `done`. */
export function mainsCode(): { dir: string; done: () => void } {
  const dir = join(tmpdir(), 'kernel-596-before')
  const done = () => {
    try { unlinkSync(join(dir, 'node_modules')) } catch { /* not linked yet */ }
    git(['worktree', 'remove', '--force', dir])
    rmSync(dir, { recursive: true, force: true })
    git(['worktree', 'prune'])
  }
  done()
  const fetched = git(['fetch', 'origin', 'main'])
  if (fetched.status !== 0) console.warn(`Could not fetch origin/main, so this uses the copy you have:\n${fetched.stderr}`)
  // The commit this branch was cut from, which is origin/main without what landed since. That can bring packages this checkout's node_modules does not have.
  const base = git(['merge-base', 'HEAD', 'origin/main']).stdout.trim() || 'origin/main'
  const added = git(['worktree', 'add', '--detach', dir, base])
  if (added.status !== 0) throw new Error(`Could not make a worktree of origin/main:\n${added.stderr}`)
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
  return { dir, done }
}

/** Runs electron-vite itself and not through pnpm, which would check a symlinked node_modules before running anything. */
function build(dir: string) {
  const r = spawnSync(join(root, 'node_modules', '.bin', 'electron-vite'), ['build'], { cwd: dir, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`The build failed in ${dir}.`)
}

// ---------- Before and after, side by side

const results = (label: string) => join(root, 'shots', 'archive-frames', label, 'results.json')
const readResults = (label: string): Result[] => (existsSync(results(label)) ? JSON.parse(readFileSync(results(label), 'utf8')).results : [])

/** The markdown table for a PR: one row per path and placement, what each side showed and whether it passed. */
export function table(): string {
  const before = readResults('before')
  const after = readResults('after')
  const keys = [...new Set([...before, ...after].map((r) => `${r.id}|${r.where}`))]
  const order = (k: string) => paths.findIndex((p) => p.id === k.split('|')[0]) * 10 + ['screen', 'chat', 'history'].indexOf(k.split('|')[1])
  const cell = (r?: Result) => (r ? `${r.verdict === 'PASS' ? 'pass' : r.verdict === 'FAIL' ? 'FAIL' : 'ERROR'}: ${r.sequence.length ? r.sequence.map((s) => s.replace(/^old$/, 'item').replace(/^dest$/, 'New chat with Rowan')).join(' > ') : r.lines[0]}` : 'not run')
  const rows = keys.sort((a, b) => order(a) - order(b)).map((k) => {
    const [id, where] = k.split('|') as [string, Where]
    const def = paths.find((p) => p.id === id)
    const find = (list: Result[]) => list.find((r) => r.id === id && r.where === where)
    return `| ${def?.name ?? id} | ${WHERE_WORDS[where]} | ${cell(find(before))} | ${cell(find(after))} |`
  })
  return ['| Path | Window | origin/main | This branch |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--')
  const label = args[0]
  if (label === 'table') { console.log(table()); return }
  if (label !== 'before' && label !== 'after') throw new Error('Say which code to test: node scripts/archive-frames.ts before|after|table')
  const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
  const only = value('only')?.split(',')
  const wheres = value('where')?.split(',') as Where[] | undefined
  const list = only ? paths.filter((p) => only.includes(p.id)) : paths
  if (!list.length) throw new Error(`No such path. Known: ${paths.map((p) => p.id).join(', ')}`)

  const before = label === 'before' ? mainsCode() : undefined
  const dir = before?.dir ?? root
  const out = join(root, 'shots', 'archive-frames', label)
  const live = join(BASE, 'live')
  const saved = join(BASE, `saved-${label}`)
  try {
    if (!args.includes('--no-build')) build(dir)
    const head = git(['rev-parse', '--short', 'HEAD'], dir).stdout.trim()
    mkdirSync(out, { recursive: true })
    const stamp = join(saved, 'world.json')
    let world: World
    if (!args.includes('--rebuild-world') && existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).head === head) {
      world = JSON.parse(readFileSync(stamp, 'utf8')).world
    } else {
      console.log('making the room ...')
      rmSync(live, { recursive: true, force: true })
      mkdirSync(live, { recursive: true })
      makeRepo(live)
      makeAppDir(dir, live)
      const ctx = await launch(dir, live)
      try { world = await buildWorld(ctx) } finally { await shutdown(ctx.app) }
      rmSync(saved, { recursive: true, force: true })
      cpSync(live, saved, { recursive: true, verbatimSymlinks: true })
      writeFileSync(stamp, JSON.stringify({ head, world }))
    }
    const done: Result[] = []
    for (const def of list) {
      for (const where of def.where) {
        if (wheres && !wheres.includes(where)) continue
        console.log(`running ${def.name}, ${WHERE_WORDS[where]} ...`)
        const r = await run(def, where, { dir, live, saved, out, world })
        console.log(`  ${r.verdict}${r.lines[0] ? `: ${r.lines[0]}` : ''}`)
        done.push(r)
      }
    }
    // A run of some paths leaves the other paths' results where they were.
    const kept = readResults(label).filter((r) => !done.some((d) => d.id === r.id && d.where === r.where))
    writeFileSync(results(label), JSON.stringify({ code: label === 'before' ? `the branch's base, origin/main at ${head}` : `this checkout at ${head}`, results: [...kept, ...done] }, null, 1))
    const report = [
      `Archive frames, ${label} (${label === 'before' ? `the branch's base, origin/main at ${head}` : `this checkout at ${head}`}), real main process`,
      '',
      ...done.flatMap((r) => [`${r.verdict.padEnd(5)} ${r.name}, ${WHERE_WORDS[r.where]}${r.note ? `: ${r.note}` : ''}`, ...r.lines.map((l) => `      ${l}`)]),
      '',
      `Frames: ${out}`,
      'Each folder holds frames.json (every animation frame and DOM change) and the capturePage images, stamped with the frame they caught. BAD_ images were taken while a frame outside the old screen and the destination was on screen.'
    ].join('\n')
    writeFileSync(join(out, only || wheres ? `summary-${done.map((r) => `${r.id}-${r.where}`).join('+').slice(0, 120)}.txt` : 'summary.txt'), `${report}\n`)
    console.log(`\n${report}`)
    if (done.some((r) => r.verdict !== 'PASS')) process.exitCode = 1
  } finally {
    before?.done()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
}

export { buildWorld, launch, makeAppDir, makeRepo, BASE, root, call, listWs, sleep }
