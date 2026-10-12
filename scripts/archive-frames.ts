// Frame capture for archiving the chat on screen (KERNEL-578). Runs on plain Node with built-in type stripping, so only erasable TypeScript here.
//
//   node scripts/archive-frames.ts after       this checkout's code
//   node scripts/archive-frames.ts before      origin/main's code, built in a temporary git worktree that is removed afterwards
//
//   --only chat-row,last-tab,confirm,handed-off,workspace-row    run some paths
//   --hold 600       ms main spends stopping sessions and removing worktrees before the first archived push
//   --gap 150        ms between main's last push and its answer. Real main answers within a few ms, so 150 stretches the window the
//                    old code shows the stripped screen in. Try --gap 10 for something closer to life.
//   --no-build       reuse the last build in the folder being tested
//
// It launches the app headless (KERNEL_HEADLESS=1) on GroupedChatArchive, which has four chats with Rowan in one room, and archives the
// chat on screen through each path. Main is simulated: the fixture's `threads.archive` and `workspaces.archive` are replaced by handlers
// that wait `hold`, push the archived workspaces and the closed thread in the order main sends them, wait `gap`, and answer.
//
// A requestAnimationFrame loop in the page reads what the sidebar and the tab strip show on every frame, from just before the click until
// the destination has held for 20 frames. A frame is fine when it shows the old screen or the destination, and anything else (the emptied
// chat, History, a blank screen) is outside. capturePage runs alongside and saves what the window painted, with the frame's number and
// verdict stamped in the corner by the same loop. Images taken while an outside frame was on screen are named BAD_*.
//
// Frames are saved to shots/archive-frames/<before|after>/<path>/ and a summary to shots/archive-frames/<before|after>/summary.txt.
// A path's folder is replaced when that path runs again, and --only leaves the other paths' folders alone.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = 'GroupedChatArchive'
const WIDTH = 1440
const HEIGHT = 900
/** Frames the destination must hold before the run counts as settled. */
const SETTLE = 20
const FRAME_MS = 16

// ---------- What a frame shows

/** What a screen has to show to count as `old` or `dest`: the sidebar row marked current starts with `label`, and a workspace that has tabs keeps them. */
export type Want = { label: string; tabs: boolean }
export type Expect = { old: Want; dest: Want }
export type Seen = 'old' | 'dest' | 'other'
export type Sample = { n: number; at: number; labels: string[]; tabs: number; seen: Seen }

/** Page side as well: `sampler` receives this function's source, so it can use nothing but its arguments. */
export function classify(labels: string[], tabs: number, want: Expect): Seen {
  const is = (w: Want) => labels.some((l) => l.startsWith(w.label)) && (!w.tabs || tabs > 0)
  return is(want.old) ? 'old' : is(want.dest) ? 'dest' : 'other'
}

/** Runs in the page, once per animation frame: reads the frame, stamps it in the corner, and keeps the log. Page side, so it uses nothing from this file. */
export function sampler(want: Expect, judge: (labels: string[], tabs: number, want: Expect) => Seen) {
  const log: Sample[] = []
  let n = 0
  let streak = 0
  let live = true
  const stamp = document.createElement('div')
  stamp.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:4px;font:11px/1.4 ui-monospace,monospace;color:#fff'
  document.body.appendChild(stamp)
  const tick = () => {
    if (!live) return
    n++
    const labels = [...document.querySelectorAll('[aria-current="page"]')].map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
    const tabs = document.querySelectorAll('.ws-tabs [role="tab"]').length
    const seen = judge(labels, tabs, want)
    streak = seen === 'dest' ? streak + 1 : 0
    log.push({ n, at: performance.timeOrigin + performance.now(), labels, tabs, seen })
    stamp.textContent = seen === 'other' ? `#${n} OUTSIDE current: ${labels.join(' | ') || 'none'}, ${tabs} tabs` : `#${n} ${seen}`
    stamp.style.background = seen === 'other' ? 'rgba(170,0,0,.92)' : 'rgba(0,0,0,.75)'
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  ;(window as any).__frames = { status: () => ({ n, streak }), stop: () => { live = false; stamp.remove(); return log } }
}

export type Outside = { first: number; last: number; frames: number; ms: number; what: string }

/** The frames reduced to a verdict: how many sat outside, where, and the order of screens they went through. */
export function summarize(log: Sample[]): { frames: number; outside: number; sequence: Seen[]; runs: Outside[] } {
  const sequence: Seen[] = []
  for (const s of log) if (sequence[sequence.length - 1] !== s.seen) sequence.push(s.seen)
  const runs: Outside[] = []
  let run: Sample[] = []
  const flush = () => {
    if (!run.length) return
    const first = run[0]
    const last = run[run.length - 1]
    runs.push({ first: first.n, last: last.n, frames: run.length, ms: Math.round(last.at - first.at + FRAME_MS), what: `current: ${first.labels.join(' | ') || 'none'}, ${first.tabs} tabs` })
    run = []
  }
  for (const s of log) { if (s.seen === 'other') run.push(s); else flush() }
  flush()
  return { frames: log.length, outside: log.filter((s) => s.seen === 'other').length, sequence, runs }
}

/** Passes when every frame was the old screen or the destination, in that order, and the destination held. */
export const passes = (s: ReturnType<typeof summarize>, settled: boolean) => settled && s.outside === 0 && s.sequence.join('>') === 'old>dest'

/** An image is BAD when a frame outside was on screen while capturePage took it. The stamp in its corner says which frame it caught. */
export const caught = (shot: { from: number; to: number }, log: Sample[]) => log.some((s) => s.seen === 'other' && s.at >= shot.from - 20 && s.at <= shot.to + 20)

// ---------- What is in the fixture

export type World = {
  /** The room's chat rows with Rowan as the sidebar lists them, top to bottom. */
  titles: string[]
  threads: { id: string; title: string; roomId: string; stops: boolean; tabs: number }[]
  workspaces: { id: string; name: string; title?: string; roomId: string; lead?: boolean; threadId?: string; status: string; prNumber?: number; confirm: boolean }[]
  /** The fixture's own workspace and thread records, which the simulated main pushes back archived. */
  records: { workspaces: { id: string; threadId?: string; lead?: boolean; status: string }[]; threads: { id: string }[] }
}

async function inventory(page: Page): Promise<World> {
  return page.evaluate(async () => {
    const kernel = (window as any).kernel
    const titles = [...document.querySelectorAll('.chat-row')].map((r) => r.querySelector('button[aria-label^="Archive "]')?.getAttribute('aria-label')?.slice('Archive '.length) ?? '')
    const all = await kernel.invoke('workspaces.list', {})
    const threads = await kernel.invoke('threads.list', {})
    const rows = await Promise.all(threads.map(async (t: any) => {
      const preview = await kernel.invoke('threads.archivePreview', { threadId: t.id }).catch(() => null)
      const stops = !preview || preview.workspaces.some((w: any) => w.running || w.pr || w.dirty > 0 || w.unpushed > 0 || w.unknown)
      const own = all.find((w: any) => w.lead && w.threadId === t.id && w.status !== 'archived')
      const chats = own ? await kernel.invoke('chats.list', { workspaceId: own.id }).catch(() => []) : []
      return { id: t.id, title: t.title, roomId: t.roomId, stops, tabs: chats.filter((c: any) => c.kind === 'chat' && !c.closed && c.threadId === t.id).length }
    }))
    const workspaces = await Promise.all(all.filter((w: any) => w.status !== 'archived').map(async (w: any) => {
      const git = w.lead || w.mode !== 'worktree' ? null : await kernel.invoke('workspaces.gitStatus', { workspaceId: w.id }).catch(() => undefined)
      const confirm = git === null ? false : !git || git.ahead > 0 || git.dirty.files > 0
      return { id: w.id, name: w.name, title: w.title, roomId: w.roomId, lead: w.lead, threadId: w.threadId, status: w.status, prNumber: w.prNumber, confirm }
    }))
    return { titles, threads: rows, workspaces, records: { workspaces: all, threads } }
  })
}

// ---------- The five paths

type Plan = { expect: Expect; note: string; prepare: () => Promise<void>; trigger: () => Promise<void> }
type PathDef = { id: string; name: string; plan: (page: Page, w: World) => Promise<Plan> }

const quote = (s: string) => s.replace(/"/g, '\\"')
const chatRow = (page: Page, title: string) => page.locator(`.chat-row:has(button[aria-label="Archive ${quote(title)}"])`)
const workspaceRow = (page: Page, name: string) => page.locator(`.ws-row:has(button[aria-label="Archive ${quote(name)}"])`)
const dialog = (page: Page) => page.getByRole('alertdialog')

/** Waits for the sidebar to mark a row current whose name starts with `label`. */
const showing = (page: Page, label: string) =>
  page.waitForFunction((l) => [...document.querySelectorAll('[aria-current="page"]')].some((el) => (el.getAttribute('aria-label') || el.textContent || '').trim().startsWith(l)), label)

/** The chat row above `title`, else the one below, as Kernel opens it after the archive (KERNEL-338). */
const landing = (w: World, title: string) => {
  const at = w.titles.indexOf(title)
  const dest = at < 0 ? undefined : w.titles[at - 1] ?? w.titles[at + 1]
  if (!dest) throw new Error(`"${title}" has no chat above or below it in the sidebar (rows: ${w.titles.join(', ')}).`)
  return dest
}

/** What the sidebar calls a workspace: its task title where it shows one (KERNEL-587), else its name. Read off the Archive buttons, so this runs on code from either side of that change. */
async function rowName(page: Page, ws: World['workspaces'][number]) {
  for (const name of [ws.title?.trim(), ws.name]) if (name && (await page.locator(`button[aria-label="Archive ${quote(name)}"]`).count()) > 0) return name
  throw new Error(`The sidebar has no row for workspace "${ws.title || ws.name}".`)
}

const open = async (page: Page, title: string) => {
  await chatRow(page, title).locator('button.nav-item').click()
  await showing(page, title)
}
/** A chat reads its tabs from main the first time it opens, and an empty tab strip for a frame or two is not what this measures. So the destination is opened once first. */
const warm = (page: Page, dest: string) => open(page, dest)
const archiveButton = (page: Page, name: string) => page.locator(`button[aria-label="Archive ${quote(name)}"]`)

export const paths: PathDef[] = [
  {
    id: 'chat-row', name: "chat row's Archive",
    async plan(page, w) {
      const clean = w.threads.filter((t) => !t.stops && w.titles.includes(t.title))
      const t = clean.find((c) => w.titles.indexOf(c.title) > 0) ?? clean[0]
      if (!t) throw new Error('No chat in this fixture archives without a confirm.')
      const dest = landing(w, t.title)
      return {
        note: `"${t.title}" -> "${dest}"`, expect: { old: { label: t.title, tabs: true }, dest: { label: dest, tabs: true } },
        prepare: async () => { await warm(page, dest); await open(page, t.title); await chatRow(page, t.title).hover() },
        trigger: () => chatRow(page, t.title).locator(`button[aria-label="Archive ${quote(t.title)}"]`).click()
      }
    }
  },
  {
    id: 'last-tab', name: "closing the chat's last tab",
    async plan(page, w) {
      const t = w.threads.find((c) => !c.stops && c.tabs === 1 && w.titles.includes(c.title))
      if (!t) throw new Error('No chat with a single tab that archives without a confirm.')
      const dest = landing(w, t.title)
      return {
        note: `"${t.title}" -> "${dest}"`, expect: { old: { label: t.title, tabs: true }, dest: { label: dest, tabs: true } },
        prepare: async () => { await warm(page, dest); await open(page, t.title) },
        trigger: async () => {
          const tab = page.locator('.ws-tabs .tab-group:has([role="tab"][aria-selected="true"])')
          await tab.hover()
          await tab.locator('button[aria-label^="Close "]').click()
        }
      }
    }
  },
  {
    id: 'confirm', name: 'Archive chat confirm (ConfirmArchiveChat)',
    async plan(page, w) {
      const t = w.threads.find((c) => c.stops && w.titles.includes(c.title))
      if (!t) throw new Error('No chat in this fixture needs the confirm.')
      const dest = landing(w, t.title)
      return {
        note: `"${t.title}" -> "${dest}"`, expect: { old: { label: t.title, tabs: true }, dest: { label: dest, tabs: true } },
        prepare: async () => {
          await warm(page, dest)
          await open(page, t.title)
          await chatRow(page, t.title).hover()
          await archiveButton(page, t.title).click()
          await dialog(page).waitFor()
        },
        trigger: () => dialog(page).getByRole('button', { name: 'Archive', exact: true }).click()
      }
    }
  },
  {
    id: 'handed-off', name: 'chat archived while one of its workspaces is on screen',
    async plan(page, w) {
      const chats = w.threads.filter((c) => c.stops && w.titles.includes(c.title))
      const pick = chats.map((c) => ({ chat: c, ws: w.workspaces.filter((x) => !x.lead && x.threadId === c.id).sort((a, b) => Number(!!b.prNumber) - Number(!!a.prNumber))[0] })).find((x) => x.ws)
      if (!pick) throw new Error('No chat that needs the confirm has a workspace it handed off.')
      const { chat, ws } = pick
      const dest = landing(w, chat.title)
      const name = await rowName(page, ws)
      return {
        note: `workspace "${name}"${ws.prNumber ? ` (PR #${ws.prNumber})` : ''} of "${chat.title}" -> "${dest}"`,
        expect: { old: { label: name, tabs: true }, dest: { label: dest, tabs: true } },
        prepare: async () => {
          await warm(page, dest)
          await workspaceRow(page, name).locator('button.nav-item').click()
          await showing(page, name)
          await chatRow(page, chat.title).hover()
          await archiveButton(page, chat.title).click()
          await dialog(page).waitFor()
        },
        trigger: () => dialog(page).getByRole('button', { name: 'Archive', exact: true }).click()
      }
    }
  },
  {
    id: 'workspace-row', name: "plain workspace row's Archive",
    async plan(page, w) {
      const rooms = new Set(w.threads.map((t) => t.roomId))
      const live = w.workspaces.filter((x) => !x.lead && rooms.has(x.roomId))
      const ws = live.find((x) => !x.confirm && !x.threadId) ?? live.find((x) => !x.confirm) ?? live[0]
      if (!ws) throw new Error('No plain workspace row in this fixture.')
      const name = await rowName(page, ws)
      return {
        note: `workspace "${name}" -> History${ws.confirm ? ' (through its confirm)' : ''}`,
        expect: { old: { label: name, tabs: true }, dest: { label: 'History', tabs: false } },
        prepare: async () => {
          await workspaceRow(page, name).locator('button.nav-item').click()
          await showing(page, name)
          await workspaceRow(page, name).hover()
          if (ws.confirm) { await archiveButton(page, name).click(); await dialog(page).waitFor() }
        },
        trigger: () => ws.confirm
          ? dialog(page).getByRole('button', { name: /^(Push and archive|Archive)$/ }).click()
          : workspaceRow(page, name).locator(`button[aria-label="Archive ${quote(name)}"]`).click()
      }
    }
  }
]

// ---------- Main, simulated

type Sim = World['records'] & { hold: number; gap: number; between: number }

/** Replaces the fixture's archive handlers (they throw, or answer at once) with ones that take as long as main does. Their timestamps are read back through `globalThis.__archiveSim`. */
export async function simulateMain(app: ElectronApplication, sim: Sim) {
  await app.evaluate(({ ipcMain, BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.isOffscreen()) ?? BrowserWindow.getAllWindows()[0]
    const send = (event: unknown) => win.webContents.send('kernel:event', event)
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const times = { called: 0, pushed: 0, answered: 0 }
    ;(globalThis as any).__archiveSim = times
    const archived = (id: string) => ({ ...s.workspaces.find((w) => w.id === id), status: 'archived', archivedAt: Date.now() })
    const answer = async () => { times.pushed = Date.now(); await sleep(s.gap); times.answered = Date.now(); return { ok: true } }
    ipcMain.removeHandler('threads.archive')
    ipcMain.handle('threads.archive', async (_event, req: { threadId: string }) => {
      times.called = Date.now()
      await sleep(s.hold)
      const mine = s.workspaces.filter((w) => w.threadId === req.threadId && w.status !== 'archived')
      // The workspaces the chat handed off go first, one by one, then its own, then the chat is closed.
      for (const w of mine.filter((x) => !x.lead)) { send({ type: 'workspace', workspace: archived(w.id) }); await sleep(s.between) }
      for (const w of mine.filter((x) => x.lead)) send({ type: 'workspace', workspace: archived(w.id) })
      const thread = s.threads.find((t) => t.id === req.threadId)
      if (thread) send({ type: 'thread', thread: { ...thread, closedAt: Date.now() } })
      return answer()
    })
    ipcMain.removeHandler('workspaces.archive')
    ipcMain.handle('workspaces.archive', async (_event, req: { workspaceId: string }) => {
      times.called = Date.now()
      await sleep(s.hold)
      send({ type: 'workspace', workspace: archived(req.workspaceId) })
      return answer()
    })
  }, sim)
}

// ---------- Capturing

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

// ---------- One run

type Result = { def: PathDef; verdict: 'PASS' | 'FAIL' | 'ERROR'; note: string; lines: string[]; dir?: string; images?: number }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function launch(dir: string) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'ELECTRON_RENDERER_URL') env[k] = v
  env.KERNEL_FIXTURES = FIXTURE
  env.KERNEL_HEADLESS = '1'
  const data = mkdtempSync(join(tmpdir(), 'kernel-frames-'))
  env.KERNEL_FIXTURE_DATA = data
  const executablePath: string = createRequire(import.meta.url)('electron')
  const app = await electron.launch({ executablePath, args: ['.', '--force-device-scale-factor=1'], cwd: dir, env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10_000)
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h), { w: WIDTH, h: HEIGHT })
  await page.waitForSelector('html[data-fixture="ready"]', { state: 'attached', timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.waitForSelector('[data-lazy="pending"]', { state: 'detached', timeout: 15_000 })
  await page.waitForTimeout(500)
  return { app, page, close: async () => { await app.close().catch(() => undefined); rmSync(data, { recursive: true, force: true }) } }
}

async function run(def: PathDef, o: { dir: string; out: string; hold: number; gap: number }): Promise<Result> {
  const { app, page, close } = await launch(o.dir)
  try {
    const world = await inventory(page)
    if (world.titles.length < 3) throw new Error(`The sidebar lists ${world.titles.length} chats with Rowan, and this needs at least 3.`)
    const plan = await def.plan(page, world)
    await simulateMain(app, { ...world.records, hold: o.hold, gap: o.gap, between: 40 })
    await plan.prepare()
    // A workspace that was handed off may have no chat tabs of its own (GroupedChatArchive's invoice-pdf-button has none), so what the old screen must keep is read off it now.
    const tabsBefore = await page.locator('.ws-tabs [role="tab"]').count()
    const expect: Expect = { ...plan.expect, old: { ...plan.expect.old, tabs: plan.expect.old.tabs && tabsBefore > 0 } }
    await page.evaluate(`(${sampler.toString()})(${JSON.stringify(expect)}, ${classify.toString()})`)
    const stop = capturing(app)
    const t0 = Date.now()
    let settled = false
    let shots: Shot[] = []
    try {
      await plan.trigger()
      const deadline = Date.now() + o.hold + o.gap + 6000
      while (Date.now() < deadline) {
        await sleep(50)
        const status = await page.evaluate<{ streak: number }>('window.__frames.status()')
        const times = await app.evaluate(() => (globalThis as any).__archiveSim as { answered: number })
        if (times.answered && status.streak >= SETTLE) { settled = true; break }
      }
    } finally {
      shots = await stop()
    }
    const log = await page.evaluate<Sample[]>('window.__frames.stop()')
    const summary = summarize(log)

    const dir = join(o.out, def.id)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    let empty = 0
    shots.forEach((s, i) => {
      if (!s.jpeg) { empty++; return }
      const at = s.to - t0
      const name = `${caught(s, log) ? 'BAD_' : ''}${String(i).padStart(4, '0')}_${at < 0 ? '-' : '+'}${String(Math.abs(at)).padStart(5, '0')}ms.jpg`
      writeFileSync(join(dir, name), Buffer.from(s.jpeg, 'base64'))
    })
    writeFileSync(join(dir, 'frames.json'), JSON.stringify({ note: plan.note, settled, summary, frames: log }, null, 1))

    const lines = [`${summary.frames} frames, ${summary.outside} outside the old screen and the destination, screens in order: ${summary.sequence.join(' > ') || 'none'}`]
    for (const r of summary.runs) lines.push(`  frames ${r.first} to ${r.last} (${r.frames} frames, about ${r.ms} ms) showed ${r.what}`)
    if (plan.expect.old.tabs && !expect.old.tabs) lines.push('  The old screen has no tabs before the click, so none was required of it. Its row in the sidebar and the move off it are what is checked.')
    if (!summary.frames) lines.push('  No animation frames ran, so the window was not painting. Nothing here proves anything.')
    else if (!settled) lines.push(`  The destination never held for ${SETTLE} frames. The last frame showed: ${(log[log.length - 1].labels.join(' | ') || 'no current row')}`)
    lines.push(`  ${shots.length - empty} capturePage images in ${dir}`)
    if (empty) lines.push(`  ${empty} of ${shots.length} capturePage images came back empty, so the window may not be painting.`)
    const ok = summary.frames > 0 && passes(summary, settled)
    return { def, verdict: ok ? 'PASS' : 'FAIL', note: plan.note, lines, dir, images: shots.length - empty }
  } catch (e) {
    return { def, verdict: 'ERROR', note: '', lines: [e instanceof Error ? e.message.split('\n').slice(0, 4).join('\n    ') : String(e)] }
  } finally {
    await close()
  }
}

// ---------- The code under test

function git(args: string[], cwd = root) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

/** origin/main in a temporary worktree next to nothing of yours, sharing this checkout's node_modules. Removed by `done`. */
export function mainsCode(): { dir: string; done: () => void } {
  const dir = join(tmpdir(), 'kernel-578-before')
  const done = () => {
    try { unlinkSync(join(dir, 'node_modules')) } catch { /* not linked yet */ }
    git(['worktree', 'remove', '--force', dir])
    rmSync(dir, { recursive: true, force: true })
    git(['worktree', 'prune'])
  }
  done()
  const fetched = git(['fetch', 'origin', 'main'])
  if (fetched.status !== 0) console.warn(`Could not fetch origin/main, so this uses the copy you have:\n${fetched.stderr}`)
  const added = git(['worktree', 'add', '--detach', dir, 'origin/main'])
  if (added.status !== 0) throw new Error(`Could not make a worktree of origin/main:\n${added.stderr}`)
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
  return { dir, done }
}

/** Runs electron-vite itself and not through pnpm, which would check a symlinked node_modules before running anything. */
function build(dir: string) {
  const r = spawnSync(join(root, 'node_modules', '.bin', 'electron-vite'), ['build'], { cwd: dir, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`The build failed in ${dir}.`)
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--')
  const label = args[0]
  if (label !== 'before' && label !== 'after') throw new Error('Say which code to test: node scripts/archive-frames.ts before|after')
  const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
  const hold = Number(value('hold') ?? 600)
  const gap = Number(value('gap') ?? 150)
  const only = value('only')?.split(',')
  const list = only ? paths.filter((p) => only.includes(p.id)) : paths
  if (!list.length) throw new Error(`No such path. Known: ${paths.map((p) => p.id).join(', ')}`)

  const before = label === 'before' ? mainsCode() : undefined
  const dir = before?.dir ?? root
  const out = join(root, 'shots', 'archive-frames', label)
  try {
    if (!args.includes('--no-build')) build(dir)
    const head = git(['rev-parse', '--short', 'HEAD'], dir).stdout.trim()
    mkdirSync(out, { recursive: true })
    const results: Result[] = []
    for (const def of list) {
      console.log(`running ${def.name} ...`)
      results.push(await run(def, { dir, out, hold, gap }))
    }
    const report = [
      `Archive frames, ${label} (${label === 'before' ? `origin/main at ${head}` : `this checkout at ${head}`}), main simulated with hold ${hold} ms and gap ${gap} ms`,
      '',
      ...results.flatMap((r) => [`${r.verdict.padEnd(5)} ${r.def.name}${r.note ? `: ${r.note}` : ''}`, ...r.lines.map((l) => `      ${l}`)]),
      '',
      `Frames: ${out}`,
      'Each folder holds frames.json (every animation frame) and the capturePage images, stamped with the frame they caught. BAD_ images were taken while a frame outside the old screen and the destination was on screen.'
    ].join('\n')
    // A run of some paths leaves the other paths' frames and the full summary alone.
    writeFileSync(join(out, only ? `summary-${list.map((p) => p.id).join('+')}.txt` : 'summary.txt'), `${report}\n`)
    console.log(`\n${report}`)
    if (results.some((r) => r.verdict !== 'PASS')) process.exitCode = 1
  } finally {
    before?.done()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
}
