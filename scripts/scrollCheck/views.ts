// The views the scroll check drives (KERNEL-923). One entry per kept spot. Erasable TypeScript only: this runs on plain Node.
import type { ElectronApplication, Page } from 'playwright-core'

export interface Ctx { app: ElectronApplication; page: Page }
interface Anchor { id: string | null; offset: number; top: number; range: number; end: boolean }

export interface View {
  /** Prefix-matched by `pnpm scroll-check <name>`. */
  name: string
  /** The fixture the view opens on. */
  fixture: string
  /** The scroller's CSS selector. */
  scroller: string
  item?: string
  /** No rows to anchor to (code, diff, logs): the scroll position itself is compared. */
  raw?: boolean
  /** The window, when a view needs a shorter one to overflow. */
  size?: [number, number]
  /** An xterm log: scrolled with the wheel, and read by the lines on screen. `endText` is what the last line says at the end. */
  wheel?: boolean
  endText?: string
  axis?: 'y' | 'x'
  /** Gets to the view from the fixture's first screen. */
  open?: (c: Ctx) => Promise<void>
  /** Where to leave it, in pixels. A view left at its end sets `end` instead. */
  at?: number
  end?: boolean
  away: (c: Ctx) => Promise<void>
  back: (c: Ctx) => Promise<void>
  /** An item removed above the anchor and one added above it, while away. */
  change?: { remove: (c: Ctx, at: Anchor, rows: string[]) => Promise<void>; add: (c: Ctx, at: Anchor) => Promise<void>; removesAnchor?: boolean }
  /** New content while away, for a view left at its end. */
  grow?: (c: Ctx) => Promise<void>
  /** A purposeful move that must beat the saved spot. Returns a failure message, or nothing when it holds. */
  target?: (c: Ctx) => Promise<string | void>
}

export const push = (c: Ctx, event: object) =>
  c.app.evaluate(({ BrowserWindow }, e) => BrowserWindow.getAllWindows()[0]?.webContents.send('kernel:event', e), event)

/** Reads a channel the way the renderer does, so a test can clone a real row. */
export const read = <T>(c: Ctx, channel: string, req: object = {}): Promise<T> =>
  c.page.evaluate(([ch, r]) => (window as unknown as { kernel: { invoke: (a: string, b: object) => Promise<unknown> } }).kernel.invoke(ch as string, r as object), [channel, req] as const) as Promise<T>

/** The ids of the items on screen's scroller, in order. */
export const ids = (c: Ctx, scroller: string, item = '[data-keep-id]') =>
  c.page.evaluate(([s, i]) => [...document.querySelectorAll(`${s} ${i}`)].map((n) => n.getAttribute('data-keep-id') ?? ''), [scroller, item] as const)

const nav = (c: Ctx, name: string) => c.page.locator('.nav-item', { hasText: new RegExp(`^\\s*${name}`) }).first().click()
/** Leave a screen for the one next to it, and come back with the app's own Back (⌘[). */
export const viaInbox = { away: (c: Ctx) => nav(c, 'Inbox'), back: (c: Ctx) => c.page.keyboard.press('Meta+BracketLeft') }
export const viaWork = { away: (c: Ctx) => nav(c, 'Work'), back: (c: Ctx) => c.page.keyboard.press('Meta+BracketLeft') }

/** Leave a right panel tab for the Checks tab and come back by its name: the tab is the spot's key, the workspace stays open. */
const viaTab = (name: RegExp) => ({
  away: (c: Ctx) => c.page.getByRole('tab', { name: /^Checks/ }).click(),
  back: (c: Ctx) => c.page.getByRole('tab', { name }).click()
})

/** Back on the project's Scripts page: the nav folds a project's pages away when another page is open, so open the project first. */
const toScripts = async (c: Ctx) => {
  await nav(c, 'AClient A')
  await c.page.waitForTimeout(150)
  await nav(c, 'Scripts')
}

interface Ws { id: string; status: string; prNumber?: number; prState?: string; archivedAt?: number; name: string; branch: string }

/**
 * An item gone and one new above the anchor, for a list of workspaces: `leave` turns the first row above the anchor into one the list no longer
 * shows, `arrive` makes a new one that sorts above it. The rows are read from the page, so the fixture's own data is what changes.
 */
const workspaceChange = (leave: (w: Ws) => object, arrive: (w: Ws) => object): NonNullable<View['change']> => ({
  remove: async (c, at, shown) => {
    const above = shown.slice(0, Math.max(0, shown.indexOf(at.id ?? '') - 1))
    const all = await read<Ws[]>(c, 'workspaces.list')
    const gone = all.find((w) => above.includes(w.id))
    console.log(`      leaving: ${gone?.id ?? 'none found'} (of ${above.length} rows above the anchor)`)
    if (gone) await push(c, { type: 'workspace', workspace: { ...gone, ...leave(gone) } })
  },
  add: async (c) => {
    const [first] = await read<Ws[]>(c, 'workspaces.list')
    await push(c, { type: 'workspace', workspace: { ...first, id: 'ws-added-above', name: 'added-above', branch: 'feat/added-above', ...arrive(first) } })
  }
})

export const views: View[] = [
  {
    name: 'inbox-list', fixture: 'ScrollCheckInbox', scroller: '.ib-list', at: 700, ...viaWork,
    change: {
      remove: async (c, at, rows) => {
        const gone = rows.slice(0, Math.max(0, rows.indexOf(at.id ?? '') - 2)).slice(0, 1)
        await push(c, { type: 'notification.removed', ids: gone })
      },
      add: async (c) => {
        const [first] = await read<{ id: string }[]>(c, 'notifications.list')
        await push(c, { type: 'notification', notification: { ...first, id: 'n-added-above', title: 'Added while away', createdAt: Date.now() + 60_000, read: false } })
      }
    },
    // j and k move the selection and the list follows it, not the saved spot.
    target: async (c) => {
      await c.page.locator('.ib-list').evaluate((e) => { e.scrollTop = 0 })
      await c.page.waitForTimeout(300)
      for (let i = 0; i < 3; i++) { await c.page.keyboard.press('j'); await c.page.waitForTimeout(150) }
      await c.page.waitForTimeout(600)
      return c.page.evaluate(() => {
        const list = document.querySelector('.ib-list') as HTMLElement
        const cur = list.querySelector('[aria-current="true"]') as HTMLElement | null
        if (!cur) return 'no row is selected after j'
        const a = cur.getBoundingClientRect(), b = list.getBoundingClientRect()
        if (list.scrollTop > 400) return `the list snapped back to ${Math.round(list.scrollTop)}px`
        return a.bottom > b.top && a.top < b.bottom ? undefined : 'the selected row is out of view'
      })
    }
  },
  { name: 'inbox-pane', fixture: 'ScrollCheckInboxPane', scroller: '.ib-pane', raw: true, at: 500, ...viaWork },
  { name: 'prs-open', fixture: 'ScrollCheckPrs', scroller: '.prs-scroll', at: 500, ...viaInbox, change: workspaceChange(() => ({ prState: 'merged', mergedAt: Date.now() }), () => ({ prNumber: 9999, prState: 'ready', status: 'ready', archivedAt: undefined })) },
  { name: 'prs-merged', fixture: 'ScrollCheckPrsMerged', scroller: '.prs-scroll', at: 500, ...viaInbox },
  { name: 'history', fixture: 'ScrollCheckHistory', scroller: '.hs-body', at: 500, ...viaInbox, change: workspaceChange(() => ({ status: 'ready', archivedAt: undefined }), () => ({ status: 'archived', archivedAt: Date.now() })) },
  { name: 'history-project', fixture: 'ScrollCheckHistoryProject', scroller: '.hs-body', at: 500, ...viaInbox },
  {
    name: 'projects', fixture: 'ScrollCheckProjects', scroller: '.rm-table', at: 200, ...viaInbox,
    change: {
      remove: async (c, at, rows) => {
        const above = rows.slice(0, Math.max(0, rows.indexOf(at.id ?? '') - 1))
        const all = await read<{ id: string }[]>(c, 'projects.list')
        const gone = all.find((p) => above.includes(p.id))
        if (gone) await push(c, { type: 'project', project: { ...gone, archived: true } })
      },
      add: async (c) => {
        const [first] = await read<{ id: string; name: string; createdAt: number }[]>(c, 'projects.list')
        await push(c, { type: 'project', project: { ...first, id: 'project-added-above', name: 'Added above', createdAt: Date.now() } })
      }
    }
  },
  { name: 'issues', fixture: 'IssuesMany', scroller: '.is-list', at: 600, ...viaInbox },
  { name: 'issue-detail', fixture: 'ScrollCheckIssueDetail', scroller: '.is-scroll', raw: true, at: 500, ...viaInbox },
  { name: 'lead-chat', fixture: 'ScrollCheckLeadChat', scroller: '.ws-scroll', item: '.thread > *', at: 500, ...viaInbox },
  // The sidebar stays mounted across screens, so hiding it (⌘B) and showing it again is what unmounts the list.
  { name: 'sidebar', fixture: 'ScrollCheckPrs', scroller: '.nav-list.sb-scroll', at: 200, away: (c) => c.page.keyboard.press('Meta+b'), back: (c) => c.page.keyboard.press('Meta+b') },
  { name: 'files-tree', fixture: 'ScrollCheckFiles', scroller: '.panel-scroll', at: 300, ...viaTab(/^All files/) },
  { name: 'changes-list', fixture: 'ScrollCheckChanges', scroller: '.panel-scroll', at: 300, ...viaTab(/^Changes/) },
  { name: 'code-view', fixture: 'ScrollCheckFile', scroller: '.code-view', raw: true, at: 900, ...viaInbox },
  { name: 'code-view-x', fixture: 'ScrollCheckFile', scroller: '.code-view', raw: true, axis: 'x', at: 400, ...viaInbox },
  { name: 'diff', fixture: 'ScrollCheckDiff', scroller: '.code-view', raw: true, at: 900, ...viaInbox },
  { name: 'log', fixture: 'ScrollCheckLog', scroller: '.term-script', wheel: true, at: 1500, ...viaInbox },
  {
    name: 'log-end', fixture: 'ScrollCheckLog', scroller: '.term-script', wheel: true, end: true, endText: '/requests/(399|400)', ...viaInbox,
    grow: async (c) => { await push(c, { type: 'script.output', workspaceId: 'ws-invoice-table', kind: 'run', lines: [{ line: 'GET /api/requests/400 200 in 12ms', stream: 'stdout' }] }) }
  },
  { name: 'chat', fixture: 'ScrollCheckChat', scroller: '.ws-scroll', item: '.thread > *', at: 500, ...viaInbox },
  {
    // Left at its end, a chat reopens at its new end when a reply arrived while away.
    name: 'chat-end', fixture: 'ScrollCheckChat', scroller: '.ws-scroll', item: '.thread > *', end: true, ...viaInbox,
    grow: async (c) => {
      for (const i of [1, 2, 3]) await push(c, { type: 'chat.item', chatId: 'chat-invoice-table', item: { kind: 'text', id: `grown-${i}`, ts: Date.now() + i, text: `A reply that arrived while the chat was closed, number ${i}.` } })
    }
  },
// Settings closes with Escape and opens again on ⌘, : the nav and the page both keep where they were.
  { name: 'settings-nav', fixture: 'SettingsAppearance', size: [1440, 520], scroller: '.set-list', at: 120, away: (c) => c.page.keyboard.press('Escape'), back: (c) => c.page.keyboard.press('Meta+Comma') },
  {
    name: 'settings-page', fixture: 'SettingsProjectScripts', scroller: '.set-scroll', at: 300, away: (c) => nav(c, 'Shortcuts'), back: toScripts,
    // A search result for a row lands on the row, whatever the saved spot says.
    target: async (c) => {
      await c.page.locator('.set-scroll').evaluate((e) => { e.scrollTop = 0 })
      await c.page.waitForTimeout(300)
      await c.page.fill('#set-q', 'archive script')
      await c.page.locator('.set-list button', { hasText: /^Archive script/ }).first().click()
      await c.page.waitForTimeout(1800)
      const r = await c.page.evaluate(() => {
        const s = document.querySelector('.set-scroll') as HTMLElement
        const row = s.querySelector('[data-row="script-archive"]') as HTMLElement | null
        if (!row) return 'the row is not on the page'
        const a = row.getBoundingClientRect(), b = s.getBoundingClientRect()
        return a.top >= b.top - 1 && a.bottom <= b.bottom + 1 ? '' : `the row is at ${Math.round(a.top - b.top)}px, outside the page (${Math.round(b.height)}px)`
      })
      return r || undefined
    }
  },
  { name: 'settings-page-closed', fixture: 'SettingsAppearance', size: [1440, 620], scroller: '.set-scroll', at: 100, away: (c) => c.page.keyboard.press('Escape'), back: async (c) => { await c.page.keyboard.press('Meta+Comma'); await c.page.waitForTimeout(150); await nav(c, 'Appearance') } }
]
