import type { Fixture } from './types'
import { ids } from './base'
import { teamFixtures } from './team'
import { workspaceFixtures } from './workspace'

// Long versions of the screens the scroll check drives (KERNEL-923, scripts/scrollCheck.ts). Each is an existing fixture with more rows,
// so a view scrolls well past a screenful and holds items to anchor on.

/** Open PRs cloned `times` over, each its own workspace, so the Pull requests list is several screens tall. */
const manyOpenPrs = (f: Fixture, times: number): Fixture => {
  const open = f.workspaces.filter((w) => w.prNumber && w.status !== 'archived' && w.prState !== 'merged')
  const more = Array.from({ length: times }, (_, k) => open.map((w) => ({ ...w, id: `${w.id}-x${k}`, name: `${w.name}-x${k}`, branch: `${w.branch}-x${k}`, prNumber: (w.prNumber ?? 0) + 1000 * (k + 1) }))).flat()
  const prs = { ...f.prs }
  for (const w of more) {
    const src = open.find((o) => w.id.startsWith(`${o.id}-x`))
    if (src && f.prs?.[src.id]) prs[w.id] = { ...f.prs[src.id], workspaceId: w.id, number: w.prNumber! }
  }
  return { ...f, workspaces: [...f.workspaces, ...more], prs }
}

/** The archived workspaces of History cloned `times` over, so the list is several screens tall. */
const manyHistory = (f: Fixture, times: number): Fixture => {
  const old = f.workspaces.filter((w) => w.status === 'archived')
  const more = Array.from({ length: times }, (_, k) => old.map((w, i) => ({ ...w, id: `${w.id}-x${k}`, name: `${w.name}-x${k}`, branch: `${w.branch}-x${k}`, archivedAt: (w.archivedAt ?? 0) - (k + 1) * 3_600_000 * 20 - i }))).flat()
  return { ...f, workspaces: [...f.workspaces, ...more] }
}

/** The project list cloned, each with the first project's team. */
const manyProjects = (f: Fixture, times: number): Fixture => {
  const more = Array.from({ length: times }, (_, k) => f.projects.filter((p) => !p.archived).map((p) => ({ ...p, id: `${p.id}-x${k}`, name: `${p.name} ${k + 2}` }))).flat()
  const agents = { ...f.agents }
  for (const p of more) agents[p.id] = f.agents[p.id.replace(/-x\d+$/, '')] ?? []
  return { ...f, projects: [...f.projects, ...more], agents }
}

/** A long source file, with long lines too so it scrolls across as well as down. */
const longFile = Array.from({ length: 220 }, (_, i) => `  const row${i} = renderInvoiceRow(invoices[${i}], { sort, columns: ['date', 'client', 'amount', 'status', 'owner', 'due', 'notes'], format: 'long', extra: '${'x'.repeat(i % 7 === 0 ? 160 : 20)}' })`).join('\n') + '\n'

/** A long diff of one file: one hunk of 200 changed lines, a few of them long. */
const longDiff = (path: string) => [
  `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,200 +1,200 @@',
  ...Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? `-  const old${i} = legacyRow(${i})\n+  const row${i} = renderInvoiceRow(invoices[${i}], { sort, columns: ['date', 'client', 'amount', 'status'], extra: '${'y'.repeat(i % 5 === 0 ? 140 : 10)}' })` : `   const keep${i} = ${i}`))
].join('\n').replace(/\\n/g, '\n')

/** The Run script's output, many lines, so its log scrolls. */
const runLines = Array.from({ length: 400 }, (_, i) => `GET /api/requests/${i} 200 in ${40 + (i % 50)}ms`)

/** The open issue (KERNEL-200) with a long description and 30 comments, so its detail scrolls. */
const longIssue = (f: Fixture): Fixture => {
  const long = Array.from({ length: 24 }, (_, i) => `## Step ${i + 1}\n\nThe billing team listed this in the planning thread: the export keeps the invoice number in the file name, the totals match the table and the empty state reads the same in every locale. Check ${i + 1} of 24.`).join('\n\n')
  const comments = Array.from({ length: 30 }, (_, i) => ({ id: `c-${i}`, author: 'Maya', body: `Comment ${i + 1}: the same question came up in review, and the answer is in the thread above.`, createdAt: new Date(Date.now() - (30 - i) * 3_600_000).toISOString() }))
  return { ...f, linear: { ...f.linear!, issues: (f.linear!.issues ?? []).map((i) => (i.id === 'KERNEL-200' ? { ...i, description: long, comments: comments as typeof i.comments } : i)) } }
}

/** Inbox on its plan approval, with a plan of 80 steps so the reading pane scrolls. */
const longPlan = (f: Fixture): Fixture => {
  const detail = Array.from({ length: 80 }, (_, i) => `${i + 1}. Step ${i + 1}: read the module, change it, add a test and run the suite before moving on to the next one.`).join('\n')
  const plan = f.approvals.find((a) => a.kind === 'plan' && a.projectId === ids.projectA)!
  return { ...f, approvals: [{ ...plan, detail }], notifications: [] }
}

export const scrollCheckFixtures: Record<string, Fixture> = {
  ScrollCheckInbox: teamFixtures.InboxMany,
  ScrollCheckPrs: manyOpenPrs(teamFixtures.PullRequests, 6),
  ScrollCheckPrsMerged: teamFixtures.PullRequestsMergedCapped,
  ScrollCheckHistory: manyHistory(teamFixtures.History, 8),
  ScrollCheckHistoryProject: manyHistory(teamFixtures.HistoryProject, 8),
  ScrollCheckProjects: manyProjects(teamFixtures.Projects, 6),
  ScrollCheckFile: { ...workspaceFixtures.WorkspaceFile, fileText: { [ids.table]: { 'src/app/invoices/table.tsx': longFile } } },
  ScrollCheckDiff: { ...workspaceFixtures.WorkspaceDiffTab, diffs: { [ids.table]: longDiff('src/app/invoices/page.tsx') } },
  ScrollCheckLog: (() => {
    const f = workspaceFixtures.PanelToolbarChecks
    const more = runLines.map((line) => ({ type: 'script.output' as const, workspaceId: ids.table, kind: 'run' as const, lines: [{ line, stream: 'stdout' as const }] }))
    return { ...f, push: [...f.push, ...more] }
  })(),
  ScrollCheckIssueDetail: longIssue(teamFixtures.IssuesMany),
  ScrollCheckLeadChat: workspaceFixtures.ChatRailLead,
  ScrollCheckInboxPane: longPlan(teamFixtures.Inbox),
  ScrollCheckChat: workspaceFixtures.ChatNewMessages,
  ScrollCheckFiles: workspaceFixtures.PanelToolbarFiles,
  ScrollCheckChanges: (() => {
    const f = workspaceFixtures.PanelToolbarChanges
    const more = Array.from({ length: 70 }, (_, i) => ({ path: `src/generated/module-${String(i).padStart(2, '0')}.ts`, status: 'M' as const, added: 3 + i, removed: i % 4 }))
    return { ...f, changes: { ...f.changes, [ids.table]: [...(f.changes[ids.table] ?? []), ...more] }, ui: { ...f.ui, workspace: { ...f.ui!.workspace!, changesView: 'list' as const } } }
  })()
}
