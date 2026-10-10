// Builds the grouped chats proposal pages from the canvas templates and renders them to PNGs next to this file.
//
//   node design/proposals/grouped-chats/build.mjs            build every page into ./build, then render every PNG
//   node design/proposals/grouped-chats/build.mjs --no-render
//   node design/proposals/grouped-chats/build.mjs GroupedTabs GroupedPalette
//
// This is a proposal, not the spec. It reads design/canvas/source/templates (the sidebar, rooms, footer, helmet and the Workspace,
// CommandPalette and Confirm pages) and writes only into this folder, so design/screens and design/canvas/project stay as they are.
// The pages are built, then rendered by design/canvas/source/render.mjs (--from, --out).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const here = import.meta.dirname
const root = join(here, '..', '..', '..')
const T = join(root, 'design', 'canvas', 'source', 'templates')
const BUILD = join(here, 'build')
mkdirSync(BUILD, { recursive: true })
const rd = (n) => readFileSync(join(T, n), 'utf8')
const sub = (s, from, to) => { if (!s.includes(from)) throw new Error('Template changed, missing: ' + from.slice(0, 80)); return s.split(from).join(to) }

// ---------------------------------------------------------------- partials, the way design/canvas/source/build.py uses them
const helmet = rd('_helmet.html').replace('.cmp input::placeholder{color:#8a8f98}', 'input::placeholder,textarea::placeholder{color:#8a8f98}')
const footT = rd('_footer.html')
const sideT = rd('_sidebar.html')
const roomsT = rd('_rooms.html')

// The room list scrolls in the app (sidebar.css), so it gets its own clipped box instead of pushing the footer off the window.
const sideScroll = sub(sideT, '%%ROOMS%%\n\n<div style="flex: 1"></div>', '<div style="flex: 1; min-height: 0; overflow: hidden">%%ROOMS%%</div>')

function sidebar(rooms) {
  let s = sideScroll.replace('%%ROOMS%%', rooms)
  s = s.replace('%%INBOXBADGE%%', '<span style="font-size: 12px; color: #8a8f98">3</span>')
  for (const k of ['ROOMSMENU', 'ROOMMENU', 'ACCTMENU']) s = s.replace('%%' + k + '%%', '')
  s = s.replace('%%ROOMSSHOW%%', '').replace('%%ROOMSHOW%%', '')
  for (const k of ['search', 'home', 'inbox', 'issues', 'history', 'lead', 'ws']) {
    s = s.replace('%%' + k + 'C%%', '').replace('%%' + k + 'S%%', '#8a8f98').replace('%%' + k + '%%', 'color: #d0d6e0;')
  }
  if (s.includes('%%')) throw new Error('Unfilled sidebar token: ' + s.slice(s.indexOf('%%') - 40, s.indexOf('%%') + 40))
  return s
}
function sidebarSearch(rooms) { return sidebar(rooms).replace(/(<a href="CommandPalette\.dc\.html") class="row"( style=")[^"]*"/, '$1 aria-current="page" class="row"$2display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 8px; border-radius: 6px; text-decoration: none; background: #1c1d21; color: #f7f8f8;"') }

// ---------------------------------------------------------------- sidebar rows, cut from the rows the room template already draws
const rl = roomsT.split('\n')
const iFirst = rl.findIndex((l) => l.startsWith('<a href="WorkspaceLead.dc.html"%%leadC%%'))
const iB = rl.findIndex((l) => l.includes('>Client B</span>')) - 1
const roomHead = rl.slice(0, iFirst)
const roomTail = rl.slice(iB)
const line = (needle) => { const l = rl.find((x) => x.includes(needle)); if (!l) throw new Error('Rooms template changed, missing: ' + needle); return l }
const svgOf = (l) => l.match(/<svg[\s\S]*?<\/svg>/)[0]
const SPIN = line('aria-label="Invoice table and empty states, Working"').match(/<span aria-hidden="true" style="width: 16px; height: 16px; flex-shrink: 0;[\s\S]*?<\/span><\/span>/)[0]
const STAT = line('>invoice-table<').match(/<span style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 11px">[\s\S]*?<\/span><\/span>/)[0]
const PRNUM = line('aria-label="org-invites, pull request open"').match(/<span style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 11px; color: #8a8f98">[\s\S]*?<\/span>/)[0]
const ICON = {
  chat: (on) => svgOf(line('aria-label="Client portal login"')).replace('stroke="#8a8f98"', `stroke="${on ? '#d0d6e0' : '#8a8f98'}"`),
  plan: () => svgOf(rl[iFirst]),
  ask: () => svgOf(line('aria-label="invoice-schema, Needs you"')),
  spin: () => SPIN,
  branch: (on) => svgOf(line('>invoice-table<')).replace('stroke="%%wsS%%"', `stroke="${on ? '#d0d6e0' : '#8a8f98'}"`),
  pr: () => svgOf(line('aria-label="org-invites, pull request open"'))
}
const GLYPH_WORD = { chat: '', plan: ', Plan to review', ask: ', Needs you', spin: ', Working' }

function row({ label, aria, icon, right = '', pad, on, title }) {
  const style = `display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 8px 0 ${pad}px; border-radius: 6px; text-decoration: none; ${on ? 'background: #1c1d21; color: #f7f8f8;' : 'color: #d0d6e0;'}`
  return `<a href="Workspace.dc.html"${on ? ' aria-current="page"' : ''} class="row" aria-label="${aria}"${title ? ` title="${label}"` : ''} style="${style}">${icon}<span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${label}</span>${right}</a>`
}
const chatRow = (c, on) => row({ label: c.title, aria: c.title + GLYPH_WORD[c.glyph || 'chat'], icon: ICON[c.glyph || 'chat'](on), pad: 20, on, title: true })
const num = (n, d) => STAT.replace('+412', '+' + n).replace('-38', d ? '-' + d : '').replace('</span> <span style="color: #eb5757"></span>', '</span>')
function wsRow(w, pad, on) {
  const right = w.pr ? PRNUM.replace('#41', w.pr) : w.stat ? num(w.stat[0], w.stat[1]) : ''
  return row({ label: w.name, aria: w.name + (w.pr ? ', pull request open' : ''), icon: ICON[w.icon](on), right, pad, on })
}

const W = {
  renderer: { name: 'invoice-pdf-renderer', icon: 'branch', stat: [188, 0] },
  button: { name: 'invoice-pdf-button', icon: 'pr', pr: '#43' },
  tests: { name: 'invoice-pdf-tests', icon: 'branch', stat: [138, 9] },
  table: { name: 'invoice-table', icon: 'branch', stat: [412, 38] },
  schema: { name: 'invoice-schema', icon: 'branch', stat: [54, 6] },
  org: { name: 'org-invites', icon: 'pr', pr: '#41' }
}

// chats: [{ id, title, glyph, ws: ['renderer', ...] }], unowned: ['org'], on: the id of the current row
function rooms({ chats, unowned = ['org'], on }) {
  const items = [], ids = []
  for (const c of chats) {
    items.push(chatRow(c, on === c.id)); ids.push(c.id)
    for (const k of c.ws || []) { items.push(wsRow(W[k], 32, on === k)); ids.push(k) }
  }
  for (const k of unowned) { items.push(wsRow(W[k], 20, on === k)); ids.push(k) }
  return { html: [...roomHead, ...items, ...roomTail].join('\n'), ids }
}
// The first row under the Client A header sits 290 + 31px from the top, the same 30px row and 1px gap the template draws.
const rowTop = (r, id) => 290 + 31 * (r.ids.indexOf(id) + 1)

// ---------------------------------------------------------------- the sample room: eight Lead tabs, grouped into four chats
const TABS = {
  a1: 'Export invoices as PDF', a2: "How is Kai's PR going?", a3: 'One PDF per client',
  b1: 'Invoice table and empty states', b2: 'Empty state copy',
  c1: 'Client portal login', c2: 'Fix the login redirect',
  d1: 'Seed realistic demo data',
  q1: "What's the status of T-15? Who is blocked?", q2: 'Which tests cover the PDF fonts?'
}
const tab = (id, extra = {}) => ({ id, kind: 'chat', title: TABS[id], ...extra })
const OWN = { a: ['renderer', 'button', 'tests'], b: ['table', 'schema'] }

// today: every tab is a row, and a chat's workspaces nest under the tab that handed them off
const currentRows = (ids, o = {}) => rooms({
  chats: ids.map((id) => ({ id, title: o.titles?.[id] ?? TABS[id], glyph: o.glyph?.[id], ws: id === 'a1' ? OWN.a : id === 'b1' ? OWN.b : [] })),
  unowned: o.unowned ?? ['org'], on: o.on
})
// proposed: one row per chat, with the workspaces of every tab in it
const CHATS = {
  a: { id: 'a', title: TABS.a1, ws: OWN.a }, b: { id: 'b', title: TABS.b1, glyph: 'spin', ws: OWN.b },
  c: { id: 'c', title: TABS.c1 }, d: { id: 'd', title: TABS.d1 }
}
const groupedRows = (o = {}) => rooms({
  chats: (o.chats ?? ['a', 'b', 'c', 'd']).map((k) => ({ ...CHATS[k], ...(o.glyph?.[k] ? { glyph: o.glyph[k] } : {}), ...(o.title?.[k] ? { title: o.title[k] } : {}) })),
  unowned: o.unowned ?? ['org'], on: o.on
})

// ---------------------------------------------------------------- transcripts
const U = (t, chips = []) => ({ kind: 'user', parts: [{ t }].concat(chips.map((c) => ({ chip: c }))) })
const STEPS = ['T-15a PDF renderer with embedded fonts · Noor', 'T-15b Download PDF in the row actions · Kai', 'T-15c Snapshot tests for three invoice types · Ivy', 'T-15d Review each PR as it lands · Theo']
const PLAN_TAB = [
  U('Add PDF export to invoices. Spec first.'),
  { kind: 'thinking', text: 'Renderer, button, tests and review can run in parallel.' },
  { kind: 'tool', text: 'Read the invoices module', cmd: 'cat src/app/invoices/page.tsx' },
  { kind: 'tool', text: 'Write the plan', cmd: 'cat > plans/t-15-invoice-pdf.md' },
  { kind: 'ai', text: 'I split PDF export into four tasks that can run in parallel.' },
  { kind: 'card', title: 'Plan for T-15', sub: 'Approved by you at 10:12', steps: STEPS },
  { kind: 'ai', text: 'Handed off. Noor has the renderer, Kai has the button and Ivy has the tests. Theo reviews each PR as it lands.' }
]
const ASK1 = [
  U("What's the status of T-15? Who is blocked?"),
  { kind: 'tool', text: "List this chat's workspaces", cmd: 'kernel workspaces' },
  { kind: 'ai', text: "Nobody is blocked. Noor is still on the renderer, Kai's PR is open and Ivy waits on the renderer for the fixtures." },
  { kind: 'meta', text: '6s · 10:49' }
]
const ASK2 = [
  U('Which tests cover the PDF fonts?'),
  { kind: 'thinking', text: 'Ivy owns the snapshot tests. I should check what they assert.' },
  { kind: 'tool', text: 'Search the tests', cmd: 'rg -n "font" tests' },
  { kind: 'ai', text: "Ivy's snapshot tests in invoice-pdf.spec.ts check the embedded fonts for all three invoice types. Noor's renderer has no unit test of its own yet." },
  { kind: 'meta', text: '8s · 10:52' }
]
const SHARED = [
  U("How is Kai's PR going?"),
  { kind: 'tool', text: "List this chat's workspaces", cmd: 'kernel workspaces' },
  { kind: 'tool', text: 'Read the approved plan', cmd: 'cat plans/t-15-invoice-pdf.md' },
  { kind: 'ai', text: "Kai's PR is open as #43 on invoice-pdf-button. Checks pass and Theo is reviewing it. Here is where your other workspaces in this chat stand." },
  { kind: 'card', title: 'Your workspaces in this chat', code: ['invoice-pdf-renderer  Noor  working', 'invoice-pdf-button    Kai   PR #43 open', 'invoice-pdf-tests     Ivy   waiting on the renderer'] },
  { kind: 'card', title: 'From the plan you approved in the first tab', steps: STEPS.slice(0, 3) },
  { kind: 'meta', text: '11s · 10:56' }
]
const TABLE_TAB = [
  U('Build the invoice table with sorting, plus the empty, loading and error states.'),
  { kind: 'thinking', text: 'The table and the schema change are independent. Kai and Noor can start together.' },
  { kind: 'tool', text: 'Write the plan', cmd: 'cat > plans/t-14-invoice-table.md' },
  { kind: 'ai', text: 'Kai has the table and its states. Noor has the schema change the table needs. I will tell you when either opens a PR.' },
  { kind: 'tool', text: 'Check on Kai and Noor', cmd: 'kernel workspaces' }
]
const NEW_CHAT = [
  U('Add CSV export next to the PDF one. Spec first.'),
  { kind: 'thinking', text: 'PDF export already lives in the row actions. CSV can sit in the same menu.' },
  { kind: 'tool', text: 'Read the invoices module', cmd: 'cat src/app/invoices/page.tsx' }
]
const CONTEXT_BANNER = (newWord, subTail) => ({ kind: 'context', title: 'Context is almost full', sub: `Compacting keeps a summary and frees space. ${subTail}`, actions: [{ id: 'newchat', label: newWord }, { id: 'compact', label: 'Compact now', primary: true }] })

// ---------------------------------------------------------------- pages
const toJs = (v) => JSON.stringify(v)

// Applies the canvas Workspace page to a screen of this proposal. `state` replaces the page's seed, `post` edits what renderVals returns.
function workspacePage({ rows, tabs, chats, tab: cur, name, badge, state = {}, post = '', grouped = false, extra = '' }) {
  let t = rd('Workspace.dc.html')
  t = sub(t, '<!--HELMET-->', helmet)
  t = sub(t, '<!--SIDEBAR-->', sidebar(rows.html))
  t = sub(t, '<!--FOOTER-->', footT.replace('%%ASKOPEN%%', '').replace('%%UPDATEPILL%%', '').replace('%%HOOKS%%', '<span></span>'))
  t = sub(t, '%%SCENARIO%%', 'lead')
  t = sub(t, 'width: 1440px; height: 900px; box-sizing: border-box; display: flex; overflow: hidden;', 'position: relative; width: 1440px; height: 900px; box-sizing: border-box; display: flex; overflow: hidden;')
  // The canvas row never shrinks its tabs, but the app does (workspace.css: .ws-tab has min-width 0 and an ellipsis), so eight tabs show a few letters each.
  t = sub(t, 'height: 40px; max-width: 220px; padding: 0 12px; border: 0; border-bottom: 2px solid {{ t.line }};', 'height: 40px; min-width: 0; max-width: 220px; padding: 0 12px; border: 0; border-bottom: 2px solid {{ t.line }};')
  t = sub(t, '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4a1.5', '<svg style="flex-shrink: 0" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4a1.5')
  t = sub(t, 'style="align-self: center; margin-left: -8px; width: 22px; height: 22px;', 'style="flex-shrink: 0; align-self: center; margin-left: -8px; width: 22px; height: 22px;')
  // The + button's menu hangs off the button, as in the app (ChatTabs.tsx), so it follows the tab row whatever the tab titles are.
  const menuAt = t.indexOf('<sc-if value="{{ newMenu }}"')
  const menuEnd = t.indexOf('</sc-if>', menuAt) + '</sc-if>'.length
  const menu = t.slice(menuAt, menuEnd).replace('left: {{ newMenuLeft }}; top: 38px;', 'left: 0; top: calc(100% + 4px);')
  t = t.slice(0, menuAt) + t.slice(menuEnd)
  const btnAt = t.indexOf('<button type="button" onClick="{{ toggleNewMenu }}"')
  const btnEnd = t.indexOf('</button>', btnAt) + '</button>'.length
  const btn = t.slice(btnAt, btnEnd).replace('margin-left: 4px; ', '')
  t = t.slice(0, btnAt) + `<span style="position: relative; flex-shrink: 0; align-self: center; margin-left: 4px; display: flex">${btn}${menu}</span>` + t.slice(btnEnd)
  if (grouped) {
    // Proposed copy, see NOTES.md: a tab joins the chat you are in.
    t = sub(t, '<span style="flex: 1">New chat</span><span style="font-size: 12px; color: #8a8f98">⌘T</span>', '<span style="flex: 1">New tab</span><span style="font-size: 12px; color: #8a8f98">⌘T</span>')
    t = sub(t, 'New chat with {{ ag.name }}', 'New tab with {{ ag.name }}')
    t = sub(t, "label: 'Fork into new chat'", "label: 'Fork into new tab'")
  }
  if (extra) t = sub(t, '</div>\n</x-dc>', extra + '</div>\n</x-dc>')
  const S = { agent: 'rowan', model: 'opus', effort: 'high', plan: false, wsName: name, badge, filesKey: 'rowan', tabs, tab: cur, chats, right: 'changes', ...state }
  const patch = `
var __S = ${toJs(S)};
var __seed = Component.prototype.seed;
Component.prototype.seed = function (sc) { var s = __seed.call(this, sc); Object.assign(s, __S); return s; };
var __rv = Component.prototype.renderVals;
Component.prototype.renderVals = function () { var v = __rv.call(this); ${post} return v; };
`
  const end = t.lastIndexOf('</script>')
  return t.slice(0, end) + patch + t.slice(end)
}

const NO_CHANGES = "v.hasChanges = false; v.noChanges = true; v.rtabs[1].count = '';"
const FILE_T14 = "v.changes = [{ st: 'A', stColor: '#4cb782', dir: 'plans/', name: 't-14-invoice-table.md', add: '+52', del: '' }]; v.rtabs[1].count = '1'; v.changesLabel = '1 file';"

const pages = {}

// ---- 1 to 3, how main behaves now (D-139, D-133)
const ALL8 = ['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'c2', 'd1']
const planChats = (ids) => Object.fromEntries(ids.map((id) => [id, id === 'a1' ? PLAN_TAB : []]))
const current8 = currentRows(ALL8, { on: 'a1', glyph: { b1: 'spin' } })
pages.GroupedCurrentTabs = () => workspacePage({
  rows: current8, tabs: ALL8.map((id) => tab(id)), tab: 'a1', chats: { a1: PLAN_TAB }, name: 'export-invoices-as-pdf', badge: 'feat/export-invoices-as-pdf'
})

const withAsk = [...ALL8, 'q1', 'q2']
pages.GroupedCurrentAskRowan = () => workspacePage({
  rows: currentRows(withAsk, { on: 'q2', glyph: { b1: 'spin' } }), tabs: withAsk.map((id) => tab(id)), tab: 'q2', chats: { q1: ASK1, q2: ASK2 },
  name: 'export-invoices-as-pdf', badge: 'feat/export-invoices-as-pdf'
})

const CTX_CUR = CONTEXT_BANNER('New chat', 'A new chat starts clean on this branch.')
pages.GroupedCurrentContextFull = () => workspacePage({
  rows: current8, tabs: ALL8.map((id) => tab(id)), tab: 'a1', chats: { a1: PLAN_TAB }, name: 'export-invoices-as-pdf', badge: 'feat/export-invoices-as-pdf',
  state: { banner: CTX_CUR, ctx: 92 }
})
const afterCur = [...ALL8, 'n1']
TABS.n1 = 'New chat'
pages.GroupedCurrentContextFullAfter = () => workspacePage({
  rows: currentRows(afterCur, { on: 'n1', glyph: { b1: 'spin' } }), tabs: afterCur.map((id) => tab(id, id === 'n1' ? { empty: true } : {})), tab: 'n1', chats: { n1: [] },
  name: 'export-invoices-as-pdf', badge: 'feat/export-invoices-as-pdf'
})

// ---- 4 to 14, the proposal
const GR = (o) => groupedRows({ glyph: { b: 'spin' }, ...o })
const A3 = ['a1', 'a2', 'a3']
const gp = (o) => ({ name: 'export-invoices-as-pdf', badge: 'feat/export-invoices-as-pdf', ...o })

TABS.n2 = 'Add CSV export'
pages.GroupedNewChat = () => workspacePage({
  ...gp({ name: 'add-csv-export', badge: 'feat/add-csv-export' }), grouped: true,
  rows: groupedRows({ chats: ['a', 'b', 'c', 'd', 'e'], glyph: { b: 'spin', e: 'spin' }, on: 'e' }),
  tabs: [tab('n2')], tab: 'n2', chats: { n2: NEW_CHAT }, state: { plan: true, running: true, secs: 9 }, post: NO_CHANGES
})
CHATS.e = { id: 'e', title: 'Add CSV export' }

pages.GroupedTabs = () => workspacePage({
  ...gp(), grouped: true, rows: GR({ on: 'a' }), tabs: A3.map((id) => tab(id)), tab: 'a1', chats: { a1: PLAN_TAB, a2: SHARED, a3: [] }
})

pages.GroupedSwitchChat = () => workspacePage({
  ...gp({ name: 'invoice-table-and-empty-states', badge: 'feat/invoice-table-and-empty-states' }), grouped: true, rows: GR({ on: 'b' }),
  tabs: [tab('b1'), tab('b2')], tab: 'b1', chats: { b1: TABLE_TAB, b2: [] }, state: { running: true, secs: 38 }, post: FILE_T14
})

pages.GroupedNewTabMenu = () => workspacePage({
  ...gp(), grouped: true, rows: GR({ on: 'a' }), tabs: A3.map((id) => tab(id)), tab: 'a1', chats: { a1: PLAN_TAB }, state: { newMenu: true }
})

pages.GroupedSharedWork = () => workspacePage({
  ...gp(), grouped: true, rows: GR({ on: 'a' }), tabs: A3.map((id) => tab(id)), tab: 'a2', chats: { a2: SHARED }
})

const CTX_NEW = CONTEXT_BANNER('New tab', 'A new tab starts clean in this chat.')
pages.GroupedContextFull = () => workspacePage({
  ...gp(), grouped: true, rows: GR({ on: 'a' }), tabs: A3.map((id) => tab(id)), tab: 'a1', chats: { a1: PLAN_TAB }, state: { banner: CTX_NEW, ctx: 92 }
})
TABS.n3 = 'New tab'
pages.GroupedContextFullAfter = () => workspacePage({
  ...gp(), grouped: true, rows: GR({ on: 'a' }), tabs: [...A3.map((id) => tab(id)), tab('n3', { empty: true })], tab: 'n3', chats: { n3: [] }
})

// A Team update card the way TeamUpdateCard.tsx and cards.css draw it, in the proposed tab the update was routed to.
const UPDATE_CARD = `<sc-if value="{{ m.isUpdate }}" hint-placeholder-val="{{ false }}"><div class="msg" style="align-self: flex-start; width: 82%; display: flex; flex-direction: column; gap: 4px"><section aria-label="Team update from Kernel" style="border-radius: 10px; border: 1px solid #26272b; background: #141517; overflow: hidden">
<header style="display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 14px; border-bottom: 1px solid #26272b; font-size: 12.5px"><h3 style="margin: 0; font-size: 12.5px; font-weight: 500; color: #d0d6e0">Team update</h3><span style="color: #8a8f98">from Kernel</span></header>
<div style="padding: 10px 14px 0; font-size: 12px; color: #8a8f98">From "Export invoices as PDF", a tab you closed</div>
<div style="display: flex; flex-direction: column; gap: 4px; padding: 10px 14px">
<div style="display: flex; align-items: center; gap: 6px; font-size: 13px"><span style="color: #f7f8f8; font-weight: 500">Kai</span><span style="color: #8a8f98">·</span><span style="flex: 1; min-width: 0; color: #d0d6e0">Download PDF in the row actions</span><span style="margin-left: 12px; color: #d0d6e0; font-size: 12.5px; text-decoration: underline; text-underline-offset: 2px">Open</span></div>
<p style="margin: 0; font-size: 13px; line-height: 1.5"><span style="color: #d0d6e0">PR #43 is ready to merge.</span></p>
</div></section></div></sc-if>
`
pages.GroupedUpdateRouted = () => {
  let t = workspacePage({
    ...gp(), grouped: true, rows: GR({ on: 'a' }), tabs: [tab('a2'), tab('a3')], tab: 'a2',
    chats: { a2: [U("How is Kai's PR going?"), { kind: 'ai', text: "Kai's PR is open as #43 on invoice-pdf-button. Checks are still running." }, { kind: 'update' }] }
  })
  t = sub(t, 'isUser: m.kind === \'user\',', 'isUpdate: m.kind === \'update\', isUser: m.kind === \'user\',')
  return sub(t, '<sc-if value="{{ m.isMeta }}"', UPDATE_CARD + '<sc-if value="{{ m.isMeta }}"')
}

pages.GroupedRowStatus = () => {
  const r = groupedRows({ glyph: { b: 'spin', c: 'ask' }, on: 'a' })
  r.html = sub(r.html, 'aria-label="Client portal login, Needs you" title="Client portal login" style="display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 8px 0 20px; border-radius: 6px; text-decoration: none; color: #d0d6e0;"', 'aria-label="Client portal login, Needs you" title="Client portal login" style="display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 8px 0 20px; border-radius: 6px; text-decoration: none; background: #141518; color: #d0d6e0;"')
  const top = rowTop(r, 'c')
  const hover = `<div role="tooltip" style="position: absolute; z-index: 60; left: 243px; top: ${top}px; width: 300px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; padding: 11px 14px 10px; border-radius: 10px; border: 1px solid #2a2b30; background: #18191b">
<div style="display: flex; align-items: center; gap: 10px; font-size: 12px; color: #8a8f98"><span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">Client A · Chat with Rowan</span><span style="flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px; border: 1px solid rgba(242, 197, 92, 0.3); background: #40330f; color: #f2c55c; font-size: 11.5px; font-weight: 500">Needs you</span></div>
<div style="font-size: 13px; font-weight: 500; color: #f7f8f8">Client portal login</div>
<div style="font-size: 12px; color: #b7bcc4">Fix the login redirect asks whether to keep Google sign in.</div>
<div style="display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 11.5px; color: #8a8f98"><span style="flex: 1">2 tabs · 1 needs you</span><span>4m</span></div>
</div>`
  return workspacePage({
    ...gp(), grouped: true, rows: r, tabs: A3.map((id) => tab(id)), tab: 'a1', chats: { a1: PLAN_TAB }, extra: hover
  })
}

TABS.q1b = TABS.q1
pages.GroupedAskRowan = () => workspacePage({
  ...gp(), grouped: true, rows: GR({ on: 'a' }), tabs: [...A3, 'q1', 'q2'].map((id) => tab(id)), tab: 'q2', chats: { q1: ASK1, q2: ASK2 }
})

// ---- the confirm and the palette reuse their canvas pages
function confirmPage({ rows, under, title, body, facts, confirm, extraPost = '' }) {
  let t = rd('Confirm.dc.html')
  t = sub(t, '<!--HELMET-->', helmet)
  t = sub(t, '<!--SIDEBAR-->', sidebar(rows.html))
  t = sub(t, '<!--FOOTER-->', footT.replace('%%ASKOPEN%%', '').replace('%%UPDATEPILL%%', '').replace('%%HOOKS%%', '<span></span>'))
  t = sub(t, '%%KIND%%', 'archive')
  const patch = `
var __rv = Component.prototype.renderVals;
Component.prototype.renderVals = function () { var v = __rv.call(this); v.under = ${toJs(under)}; v.title = ${toJs(title)}; v.body = ${toJs(body)}; v.facts = ${toJs(facts)}; v.hasFacts = true; v.hasOption = false; v.hasAlt = false; v.confirmLabel = ${toJs(confirm)}; ${extraPost} return v; };
`
  const end = t.lastIndexOf('</script>')
  return t.slice(0, end) + patch + t.slice(end)
}
pages.GroupedCloseLastTab = () => confirmPage({
  rows: GR({ on: 'b' }), under: 'invoice-table-and-empty-states', title: 'Close this chat?',
  body: 'Rowan is still working in this chat. Closing its last tab stops that turn and closes the chat. The 2 workspaces it started stay in the sidebar.',
  facts: ['Invoice table and empty states', '1 tab · Rowan is working'], confirm: 'Close chat'
})
pages.GroupedCloseLastTabAfter = () => workspacePage({
  ...gp(), grouped: true, rows: groupedRows({ chats: ['a', 'c', 'd'], unowned: ['table', 'schema', 'org'], on: 'a' }),
  tabs: A3.map((id) => tab(id)), tab: 'a1', chats: { a1: PLAN_TAB }
})

pages.GroupedPalette = () => {
  let t = rd('CommandPalette.dc.html')
  t = sub(t, '<!--HELMET-->', helmet)
  t = sub(t, '<!--SIDEBAR-->', sidebarSearch(GR({ on: 'a' }).html))
  t = sub(t, '<!--FOOTER-->', footT.replace('%%ASKOPEN%%', '').replace('%%UPDATEPILL%%', '').replace('%%HOOKS%%', '<span></span>'))
  t = sub(t, '<h1 style="margin: 0; font-size: 13px; font-weight: 500">invoice-table</h1>', '<h1 style="margin: 0; font-size: 13px; font-weight: 500">export-invoices-as-pdf</h1>')
  t = sub(t, 'max-height: 540px;', 'max-height: 560px;')
  const it = (glyph, label, keys = []) => ({ glyph, label, href: 'Workspace.dc.html', keys })
  const G = [
    { title: 'Suggested', items: [it('+', 'New chat in Client A', ['⌘', 'N']), it('+', 'New tab', ['⌘', 'T']), it('>', 'Big terminal tab', ['⌘', '⇧', 'T'])] },
    { title: 'Chats in Client A', items: [it('◇', TABS.a1, ['3 tabs']), it('◇', TABS.b1, ['2 tabs']), it('◇', TABS.c1, ['2 tabs']), it('◇', TABS.d1, ['1 tab'])] },
    { title: 'Go to', items: [it('◇', 'Inbox', ['G', 'I']), it('◇', 'History')] },
    { title: 'Rooms', items: [it('A', 'Client A'), it('B', 'Client B')] }
  ]
  let first = true
  const groups = G.map((g) => ({ title: g.title, items: g.items.map((i) => { const hi = first; first = false; return { ...i, bg: hi ? '#1f2024' : 'transparent' } }) }))
  const patch = `
var __rv = Component.prototype.renderVals;
Component.prototype.renderVals = function () { var v = __rv.call(this); v.groups = ${toJs(groups)}; v.empty = false; return v; };
`
  const end = t.lastIndexOf('</script>')
  return t.slice(0, end) + patch + t.slice(end)
}

// ---- the overview sheet: current next to proposed, then thumbnails of the rest
const PAIRS = [
  ['GroupedCurrentTabs', 'GroupedTabs', '1 and 5', 'Eight tabs, four chats',
    'Eight tabs are eight sidebar rows and the tab titles shrink to a few letters.', 'The same eight tabs are four chat rows, and the tab row shows only this chat’s three.'],
  ['GroupedCurrentAskRowan', 'GroupedAskRowan', '2 and 13', 'Two Ask Rowan questions',
    'Two questions add two tabs and two more rows to a list that already runs past the window.', 'The same two questions open two tabs in the chat you are in. The sidebar does not change.'],
  ['GroupedCurrentContextFullAfter', 'GroupedContextFullAfter', '3 and 9', 'The context-full banner, after the click',
    'New chat adds a tab and a row, and pushes the last room off the bottom.', 'New tab adds a tab to this chat. The sidebar stays as it was.']
]
const THUMBS = [
  ['GroupedNewChat', '4', 'New chat adds one chat row with one tab.'], ['GroupedSwitchChat', '6', 'Another chat swaps the tab row.'],
  ['GroupedNewTabMenu', '7', '+ adds a tab to this chat.'], ['GroupedSharedWork', '8', 'A second tab sees the chat’s workspaces and plan.'],
  ['GroupedUpdateRouted', '10', 'Team updates follow the work to an open tab.'], ['GroupedRowStatus', '11', 'A chat row shows its strongest tab status.'],
  ['GroupedCloseLastTab', '12', 'Closing the last tab closes the chat.'], ['GroupedPalette', '14', 'The palette lists chats and adds ⌘T.']
]
pages.GroupedOverview = () => {
  const img = (n, w) => `<img src="../${n}.png" alt="${n}" width="${w}" style="display: block; border-radius: 10px; border: 1px solid #26272b">`
  const pair = ([cur, pro, nums, title, capCur, capPro]) => `
<section style="display: flex; flex-direction: column; gap: 14px">
<div style="display: flex; align-items: baseline; gap: 12px"><span style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 12px; color: #8a8f98">${nums}</span><h2 style="margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.2px">${title}</h2></div>
<div style="display: flex; gap: 24px">
<figure style="margin: 0; display: flex; flex-direction: column; gap: 10px"><figcaption style="font-size: 12px; font-weight: 500; color: #8a8f98">Current, ${cur}</figcaption>${img(cur, 660)}<p style="margin: 0; width: 660px; color: #b7bcc4">${capCur}</p></figure>
<figure style="margin: 0; display: flex; flex-direction: column; gap: 10px"><figcaption style="font-size: 12px; font-weight: 500; color: #f7f8f8">Proposed, ${pro}</figcaption>${img(pro, 660)}<p style="margin: 0; width: 660px; color: #d0d6e0">${capPro}</p></figure>
</div></section>`
  const thumb = ([n, no, cap]) => `<figure style="margin: 0; width: 318px; display: flex; flex-direction: column; gap: 8px">${img(n, 318)}<figcaption style="color: #d0d6e0"><span style="font-family: 'Geist Mono', ui-monospace, monospace; font-size: 12px; color: #8a8f98; margin-right: 8px">${no}</span>${cap}</figcaption></figure>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kernel · Grouped chats proposal</title><script src="./support.js"></script></head>
<body>
<x-dc>
${helmet}
<div style="width: 1440px; box-sizing: border-box; padding: 48px 48px 56px; display: flex; flex-direction: column; gap: 44px; background: #08090a; color: #f7f8f8; font-family: 'Inter', -apple-system, 'SF Pro Text', system-ui, sans-serif; font-feature-settings: 'cv01', 'ss03'; font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased">
<header style="display: flex; flex-direction: column; gap: 8px; max-width: 920px">
<span style="font-size: 12px; font-weight: 500; color: #8a8f98">Proposal, not the spec</span>
<h1 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.3px">Tabs grouped inside one sidebar chat</h1>
<p style="margin: 0; color: #b7bcc4; font-size: 14px; line-height: 1.6">Today every Lead tab is also a sidebar row (D-139). Proposed: a chat is a sidebar row, one per topic, and only ⌘N starts one. A tab is a conversation inside a chat, and + and ⌘T add one to the chat you are in.</p>
</header>
${PAIRS.map(pair).join('')}
<section style="display: flex; flex-direction: column; gap: 16px">
<h2 style="margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.2px">The rest of the proposal</h2>
<div style="display: flex; flex-wrap: wrap; gap: 28px 24px">${THUMBS.map(thumb).join('')}</div>
</section>
</div>
</x-dc>
</body></html>
`
}

// ---------------------------------------------------------------- build and render
const args = process.argv.slice(2)
const noRender = args.includes('--no-render')
const want = args.filter((a) => !a.startsWith('--'))
const names = want.length ? want : Object.keys(pages)
for (const n of names) {
  if (!pages[n]) throw new Error('No page called ' + n)
  const html = pages[n]()
  if (html.includes('%%') || html.includes('<!--SIDEBAR-->')) throw new Error(n + ' has an unfilled template token')
  writeFileSync(join(BUILD, n + '.dc.html'), html)
  console.log('built', n)
}
if (!noRender) {
  execFileSync('node', [join(root, 'design', 'canvas', 'source', 'render.mjs'), '--from', BUILD, '--out', here, ...names], { stdio: 'inherit' })
}
