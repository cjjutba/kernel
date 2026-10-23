import { isRemote } from '../../remote/isRemote'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { modelLabelOf, useCodexInUse, useProviderModels } from './composer/providerModels'
import type { ChatPart, IssueTakenFinding, LeadWhere, NewChatPicks, WorkspaceMode, WorkspaceSource } from '@shared/types'
import { bypassConfirmed } from '../../bypassConfirm'
import { useModeAvailability } from '../../permissionModes'
import { providerOf } from '@shared/providers'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { leadOf, unusedFirstChat } from '../../lead'
import { leadNewKey } from '../../components/sidebar/slots'
import { Icon, useBusy } from '../../ui'
import { startChat } from '../new-workspace/start'
import { takenFindings } from '../new-workspace/taken'
import { issueTracker } from './issueKey'
import { OpenIssue } from './composer/Chip'
import { useProjectTracker } from '../issues/useProjectTracker'
import { focusComposerIn, onComposerCommand, onComposerFocusAsked, takeComposerFocus } from './composer/bus'
import { readBranches, useBaseBranch, useBranches } from './composer/BranchPicker'
import { useDraft } from './composer/draft'
import { shownWhere, useWorkspaceChoices, whereToSend } from './composer/workspaceChoices'
import { ComposerInput } from './composer/ComposerInput'
import { ComposerShell } from './composer/ComposerShell'
import { loadPicks, moveDraft, newChatDraftOf, onPicksChange, savePicks, type DraftPicks } from './composer/draftStore'
import { ComposerToolbar } from './composer/ComposerToolbar'
import { cyclePatch, cycleRun, leadPlaceholder, modePatch, nextMode, offLine, shownMode, type ComposerMode, type CycleRun } from './composer/modes'
import { useLeadBox } from './composer/modelPrefs'
import type { PlusPanel } from './composer/PlusMenu'
import { sendsOn, useSendWith } from './composer/sendKey'
import { ProjectPicker } from './composer/WherePickers'
import { useModelKeys } from './composer/useModelKeys'
import { stripRemote } from '../settings/remote'
import { SetupLine } from './SetupLine'
import { PartChip, TurnLine } from './Transcript'
import { pressed } from '../../hotkeys'

/**
 * The New chat page, the one way to start a chat (KERNEL-788): the title, which names the project and picks it, and a composer, in the
 * middle of the page. Sending calls `lead.start`, so the chat, its own worktree and its sidebar row begin with the first message
 * (KERNEL-405), on a new branch from the one the composer names. The box keeps the project's own draft, so typed text survives
 * leaving the page and never shows in another project. `focusIn` is the workspace whose focus requests it takes, for the shared Lead
 * workspace from before, else the project's New chat key.
 * A chat that starts from an issue first asks whether someone else is on it (KERNEL-500). `source` arrives as a chip in the box,
 * and `picks` is what the box had chosen when that warning sent the user back.
 */
export function NewLeadChat({ projectId: routeProject, focusIn, source, picks }: { projectId: string; focusIn?: string; source?: WorkspaceSource; picks?: NewChatPicks }) {
  // The project picked under the box. It starts as the route's, and follows the route when that moves to another project.
  const [projectId, setProjectId] = useState(routeProject)
  useEffect(() => { setProjectId(routeProject) }, [routeProject])
  const lead = useStore((s) => leadOf(s.agents, projectId))
  const name = lead?.name ?? 'Kernel'
  const codexInUse = useCodexInUse()
  const codexModels = useProviderModels('codex')
  const draftKey = newChatDraftOf(projectId)
  // Model, effort and plan mode are the Lead's until picked here, and a pick stays with the project's draft (KERNEL-544).
  const { model, effort, plan, mode, fallback, pickModel, pickEffort, savePick } = useLeadBox(draftKey, lead, picks && { model: picks.model, effort: picks.effort, plan: picks.plan })
  const [menu, setMenu] = useState<'model' | 'mode' | 'project' | PlusPanel>(null)
  const plusPanel: PlusPanel = menu === 'plus' || menu === 'linkIssue' || menu === 'linkPr' || menu === 'linkWorkspaces' || menu === 'workspace' || menu === 'branch' ? menu : null
  // The projects the title's menu offers: the active ones, and a hidden project only while it is the one on show.
  const allProjects = useStore((s) => s.projects)
  const projects = allProjects.filter((r) => !r.archived && (!r.hidden || r.id === projectId))
  // The rest of the box's picks live with the project's draft, so leaving the page and coming back keeps them (DESIGN.md, Remembered choices).
  const boxPicks = useSyncExternalStore(onPicksChange, () => loadPicks(draftKey))
  // The issue warning's way back brings what the box had picked (KERNEL-500).
  useLayoutEffect(() => {
    if (picks) savePicks(draftKey, { place: picks.mode === appPlace ? undefined : picks.mode, previous: picks.previous, ...(picks.baseRef ? { baseRef: picks.baseRef } : {}) })
  }, [])
  // Where the chat works starts from Settings' workspace type, and a pick stays with the project the same way. The chat gets the folder it
  // names (the checkout, a new worktree or a previous one), since Kernel may edit files in it (workspace-picker).
  const appPlace: WorkspaceMode = useStore((s) => s.settings?.workspace.mode) ?? 'worktree'
  const choices = useWorkspaceChoices(projectId)
  const where = shownWhere(boxPicks, appPlace, choices)
  const place: WorkspaceMode = where.kind === 'current' ? 'current' : 'worktree'
  const previous = where.kind === 'previous' ? where.workspaceId : undefined
  // A pick of Previous worktree sits over the Worktree or Current checkout pick, which stays for when it is dropped.
  const pickWhere = (w: LeadWhere) => savePicks(draftKey, w.kind === 'previous' ? { previous: w.workspaceId } : { place: w.kind === appPlace ? undefined : w.kind, previous: undefined })
  // The branch picked, empty for the default. It stays with the project's draft until a chat starts, which goes back to the default, so no
  // chat starts from an old branch by accident. Local keeps it for when Worktree is picked again.
  const picked = boxPicks?.baseRef ?? ''
  const base = useBaseBranch(projectId, picked)
  // The project's branches are read as the page opens, so the branch menu opens on them. A picked branch the repo no longer has goes back to the default.
  useEffect(() => { if (projectId) void readBranches(projectId) }, [projectId])
  const branches = useBranches(projectId)
  useEffect(() => {
    if (picked && branches && 'ok' in branches && !branches.ok.some((b) => b.name === picked)) savePicks(draftKey, { baseRef: undefined })
  }, [picked, branches, draftKey])
  // Fixtures put text in the box for a shot.
  const forced = useStore((s) => s.ui.workspace.composer)
  const d = useDraft(forced, draftKey)
  const [sending, run] = useBusy()
  const busy = sending !== null
  // What Send sent, from the press until the chat opens: drawn as the chat will draw it, so nothing waits on the engine to show it. A failed start brings the page back.
  const [sent, setSent] = useState<{ parts: ChatPart[]; at: number } | null>(null)
  // An empty box stands in for the composer meanwhile, as the chat's own will be. The real one keeps the draft until the send succeeds.
  const blank = useDraft()
  const filePick = useRef<HTMLInputElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const fits = useFits(topRef, titleRef)
  const provider = providerOf(model)
  const availability = useModeAvailability()
  const projectMode = useStore((s) => s.projects.find((r) => r.id === projectId)?.permissionMode)
  const appMode = useStore((s) => s.settings?.permissions.mode)
  const shown = shownMode(plan, undefined, mode ?? projectMode ?? appMode ?? 'default')
  const cycle = useRef<CycleRun | null>(null)
  // ^⌘1 to 9 and ⌘⇧/ work here as in a chat, with the picker closed. The open picker takes them itself.
  useModelKeys({ provider, model, effort, fallback, onModel: pickModel, onEffort: pickEffort, enabled: !busy })

  // The sidebar's Lead row, ⌘⇧L, + and ⌘T ask for the caret in the workspace's composer. This box is it while no chat is open.
  const focusAsked = () => { if (takeComposerFocus({ id: '', workspaceId: focusIn ?? leadNewKey(routeProject) })) d.focus() }
  // The route's project names the request. The page stays mounted when the route moves to another project, so a request made for that project is taken here.
  useEffect(() => { focusAsked() }, [routeProject])
  useEffect(() => onComposerFocusAsked(focusAsked))

  // ⌘L puts the caret back in the box, as in a chat's composer. ⌘⇧L is the Lead chat (App.tsx).
  useEffect(() => {
    const onKeyL = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || getState().ui.modal) return
      if (pressed(e, 'focusComposer')) { e.preventDefault(); d.focus() }
    }
    window.addEventListener('keydown', onKeyL)
    return () => window.removeEventListener('keydown', onKeyL)
  })

  // A source arrives as a chip in the box, once: a chip already there, from the draft or an earlier visit, is the same one.
  const sourceKey = source ? JSON.stringify(source) : ''
  useEffect(() => {
    if (source?.kind !== 'issue' || d.parts.some((p) => p.type === 'issue' && p.name === source.id)) return
    d.insert({ type: 'issue', name: source.id, title: source.title, url: source.url, source: issueTracker(source) })
    d.focus()
  }, [sourceKey])

  // Kernel fetches the project's remote now, so the fetch a send needs is done or under way by then. Nothing waits on it.
  useEffect(() => { if (projectId) void call('lead.prefetch', { projectId }).catch(() => undefined) }, [projectId])

  // The issue in the box starts its check at once and keeps the answer, so a send finds it answered (KERNEL-543). Another issue or project drops it.
  const chip = d.parts.find((p): p is Extract<ChatPart, { type: 'issue' }> => p.type === 'issue')
  const issueKey = chip ? `${projectId}:${chip.name}` : ''
  const taken = useRef<{ key: string; found: Promise<IssueTakenFinding[]> } | null>(null)
  useEffect(() => {
    if (!chip) { taken.current = null; return }
    if (taken.current?.key !== issueKey) taken.current = { key: issueKey, found: takenFindings((req) => call('issues.taken', req), projectId, chip.name) }
  }, [issueKey])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [checking, setChecking] = useState(false)

  /**
   * Whether the issue check held the chat back: it opens the warning, which sends the chat on or brings the page back. Anything the
   * check can't answer, or the user leaving the page meanwhile, leaves nothing held (KERNEL-500).
   */
  const someoneIsOn = async (issue: Extract<ChatPart, { type: 'issue' }>, parts: ChatPart[]) => {
    setChecking(true)
    let found
    // The check started when the chip arrived, and a send waits only for what is left of it.
    const asked = taken.current?.key === `${projectId}:${issue.name}` ? taken.current.found : takenFindings((req) => call('issues.taken', req), projectId, issue.name)
    try { found = await asked }
    finally { setChecking(false) }
    if (!alive.current) return true
    if (!found.length) return false
    if (getState().ui.modal) return true
    const held: WorkspaceSource = { kind: 'issue', id: issue.name, title: issue.title, ...(issue.url ? { url: issue.url } : {}), tracker: issue.source }
    actions.ui.openModal({ name: 'confirm', kind: 'issueTaken', issue: issue.name, findings: found, held: { projectId, source: held, parts, picks: { mode: place, ...(previous ? { previous } : {}), model, effort, plan, baseRef: picked } } })
    return true
  }

  /** Sends what is typed. A picked branch goes as the base, and as a line for the Lead. A failed start keeps the text. */
  const start = () => {
    const typed = d.message()
    // Every error here is a toast, and the draft stays in the box (Pen 3.8).
    if (!usable) {
      actions.ui.toast(projectId
        ? { title: 'This project is archived or gone', sub: 'There is nowhere to start the chat. Pick another project.', action: { label: 'Pick project', pickProject: true } }
        : { title: 'Pick a project first', sub: 'Kernel and its team work inside one repo at a time.', action: { label: 'Pick project', pickProject: true } })
      return
    }
    if (!typed.length) {
      actions.ui.toast({ title: 'Nothing to send', sub: `Type a message for ${name} first.` })
      d.focus()
      return
    }
    const parts = typed
    void run('send', async () => {
      const issue = typed.find((p): p is Extract<ChatPart, { type: 'issue' }> => p.type === 'issue')
      if (issue && (await someoneIsOn(issue, parts))) return
      const at = Date.now()
      setSent({ parts: typed, at })
      const failed = await startChat({ projectId, parts, model, effort, plan, mode, baseRef: picked && where.kind === 'worktree' ? picked : '', where: whereToSend(place, previous, appPlace), at })
      if (failed) { setSent(null); actions.ui.toast({ title: 'Could not send', sub: failed }); refocus.current = true }
    })
  }
  // A toast's Pick project opens the title's menu, or Add a project when there is none.
  useEffect(() => onComposerCommand((c) => {
    if (c !== 'project') return
    if (projects.length) setMenu('project')
    else actions.ui.openModal({ name: 'newProject' })
  }))
  // The box is disabled while the send runs, so the caret goes back once it is enabled again.
  const refocus = useRef(false)
  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; d.focus() } }, [busy])

  /** As in a chat: Plan sets `plan` and leaves the picked mode, every other mode sets `mode` and clears plan. Bypass permissions asks once first. */
  const setMode = (next: ComposerMode, patch: (m: ComposerMode) => DraftPicks = modePatch) => {
    if (next === shown.picked) return
    if (next === 'bypassPermissions' && !bypassConfirmed()) { cycle.current = null; setMenu(null); return actions.ui.openModal({ name: 'confirm', kind: 'bypass', draftKey }) }
    savePick(patch(next))
  }
  const pickMode = (next: ComposerMode) => { cycle.current = null; setMode(next) }
  const cycleMode = () => {
    const { before } = (cycle.current = cycleRun(cycle.current, draftKey, mode))
    setMode(nextMode(shown.picked, (m) => !offLine(m, provider, availability)), (m) => cyclePatch(before, m))
  }

  const sendWith = useSendWith()
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (sendsOn(e, sendWith)) { e.preventDefault(); start(); return }
    if (pressed(e, 'planMode')) { e.preventDefault(); cycleMode(); return }
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) cycle.current = null
    if (pressed(e, 'attach')) { e.preventDefault(); filePick.current?.click() }
    if (pressed(e, 'linkIssue')) { e.preventDefault(); setMenu('linkIssue') }
  }

  /** Another project: the typed text moves to that project's box, and its status, Up next, model and branch follow. */
  const pickProject = (id: string) => {
    if (id === projectId) return
    moveDraft(draftKey, newChatDraftOf(id))
    setProjectId(id)
    // The route follows, so the breadcrumb and the sidebar selection name the project the chat will start in. It replaces the entry, so Back still leaves the page.
    const at = getState().ui.route
    if (at.name === 'leadNew') actions.ui.go({ ...at, projectId: id }, { history: 'replace' })
    d.focus()
  }

  const hasDraft = !d.empty
  const project = allProjects.find((r) => r.id === projectId)
  const { read: trackerRead } = useProjectTracker(projectId)
  // A project that was archived or removed under the page, or none at all: the title asks without one, and nothing sends until one is picked.
  const usable = !!project && !project.archived
  // Setup shows as one line under the box (KERNEL-1089) and never holds a send.
  const setupSteps = useStore((s) => s.projectSetup[projectId])
  // A project added while this page was open makes its first chat when setup finishes, and the page gives way to it, so the first Send stays in that chat.
  const sawSetup = useRef(false)
  if (setupSteps) sawSetup.current = true
  const firstWs = useStore((s) => unusedFirstChat(projectId, s)?.workspaceId)
  useEffect(() => {
    const first = firstWs ? unusedFirstChat(projectId) : undefined
    if (!first || !sawSetup.current || sent || !d.empty || getState().ui.route.name !== 'leadNew') return
    actions.ui.openTab(first.workspaceId, first.chatId)
    focusComposerIn(first.workspaceId)
    actions.ui.go({ name: 'workspace', workspaceId: first.workspaceId }, { history: 'replace' })
  }, [firstWs])
  const projectPicker = (variant: 'title' | 'button') => (
    <ProjectPicker variant={variant} projects={projects} project={usable ? project : undefined} open={menu === 'project'} disabled={busy} onToggle={() => setMenu(menu === 'project' ? null : 'project')} onClose={() => setMenu((m) => (m === 'project' ? null : m))} onPick={pickProject} onNewProject={() => actions.ui.openModal({ name: 'newProject' })} />
  )
  const issueCtx = useMemo(() => ({ project, tracker: trackerRead.kind === 'ready' ? trackerRead.tracker : undefined }), [project, trackerRead])
  return (
    <OpenIssue.Provider value={issueCtx}>
    <div className="lead-new">
      {sent && (
        <div className="ws-scroll">
          <div className="thread">
            <div className="msg msg-user">
              <div className="bubble">{sent.parts.map((p, i) => (p.type === 'text' ? <span key={i}>{p.text} </span> : <PartChip key={i} part={p} />))}</div>
              <div className="msg-acts-space" aria-hidden />
            </div>
            <TurnLine since={sent.at} />
          </div>
        </div>
      )}
      <div ref={topRef} className="lead-top" style={sent ? GONE : undefined}>
        <div ref={titleRef} className="lead-title" style={{ visibility: fits ? undefined : 'hidden' }} aria-hidden={fits ? undefined : true}>
          {usable
            ? <>
              <h2 className="lead-ask">What's next for {projectPicker('title')}?</h2>
            </>
            : projects.length
              ? <>
                <h2 className="lead-ask">What should we build today?</h2>
                <div className="lead-sub">{projectPicker('button')}</div>
              </>
              : <>
                <h2 className="lead-ask">What are we building?</h2>
                <p className="lead-note">Add a project first. Kernel and its team work inside one repo at a time.</p>
              </>}
        </div>
      </div>
      <ComposerShell
        above={<>{!projects.length && <FirstProjectPills />}</>}
        input={<>
          {sent && <ComposerInput d={blank} aria-label={`Message ${name}`} disabled placeholder="Add a follow up" />}
          <div style={sent ? GONE : { display: 'contents' }}><ComposerInput d={d} aria-label={`Message ${name}`} disabled={busy} placeholder={leadPlaceholder(name)} onKeyDown={onKey} /></div>
        </>}
        box={{ 'data-plan': plan ? 'true' : undefined, 'data-drop': d.over || undefined }}
        foot={<ComposerToolbar disabled={busy}
          model={{ label: modelLabelOf(model, codexModels), provider: providerOf(model), open: menu === 'model', onOpen: (o) => setMenu(o ? 'model' : null), picker: { provider: providerOf(model), grouped: codexInUse, model, effort, fallback, onClose: () => setMenu(null), onModel: (m, x) => { setMenu(null); pickModel(m, x) }, onEffort: pickEffort } }}
          mode={{ provider: providerOf(model), availability, shown, open: menu === 'mode', onOpen: (o) => setMenu(o ? 'mode' : null), onPick: (m) => { setMenu(null); pickMode(m); d.focus() }, onCycle: cycleMode }}
          plus={{ panel: plusPanel, onPanel: setMenu, projectId, disabled: busy || !usable, where: { pick: where, taken: choices.taken, previous: choices.previous, picked, branch: stripRemote(base.target, base.remote), onPick: pickWhere, onBranch: (ref) => savePicks(draftKey, { baseRef: ref || undefined }) }, onAttach: () => filePick.current?.click(), onInsert: (parts) => { for (const p of parts) d.insert(p); d.focus() } }}
          send={{ label: 'Send', ready: hasDraft, busy: busy || d.pending > 0, busyLabel: d.pending > 0 ? 'Attaching' : checking ? 'Checking' : 'Sending', onSend: start }} />}
        below={project && setupSteps ? <SetupLine project={project} steps={setupSteps} /> : undefined}
        hidden={<input ref={filePick} type="file" hidden tabIndex={-1} aria-hidden="true" multiple onChange={(e) => { d.attach([...(e.target.files ?? [])]); e.target.value = '' }} />}
      />
      <div className="lead-up" style={sent ? GONE : undefined} />
    </div>
    </OpenIssue.Provider>
  )
}

const GONE = { display: 'none' } as const

/** With no project yet, the three ways to add one sit above the box (KERNEL-943). Each opens its own dialog. */
function FirstProjectPills() {
  if (isRemote()) return <p className="muted">Add a project in Kernel on your Mac to start here.</p>
  return (
    <nav className="lead-pills" aria-label="Add a project">
      <button type="button" className="lead-pill" onClick={() => actions.ui.openModal({ name: 'connectRepo' })}><Icon name="branch" size={14} />Connect a repo</button>
      <button type="button" className="lead-pill" onClick={() => actions.ui.openModal({ name: 'openFolder' })}><Icon name="folder" size={14} />Open a folder</button>
      <button type="button" className="lead-pill" onClick={() => actions.ui.openModal({ name: 'newProject', prefill: { source: 'scratch', name: '', from: '' } })}><Icon name="burst" size={14} />Start from scratch</button>
    </nav>
  )
}

/** Whether the title block fits the space between the header and Up next. It hides, rather than clips, when the box has grown into its project. */
function useFits(topRef: React.RefObject<HTMLElement | null>, titleRef: React.RefObject<HTMLElement | null>): boolean {
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const top = topRef.current
    const title = titleRef.current
    if (!top || !title) return
    const measure = () => setFits(top.clientHeight >= title.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(top)
    ro.observe(title)
    return () => ro.disconnect()
  }, [])
  return fits
}
