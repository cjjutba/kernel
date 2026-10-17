import './agents.css'
import { useRef, useState } from 'react'
import { EFFORT_LABELS, type AppSettings, type CompactWindow, type Effort, type Provider, type ProviderModel, type Role, type RoleModel } from '@shared/types'
import { roleOf, takesTasks } from '@shared/team'
import { roleSide } from '@shared/rolePick'
import { LinkButton, Icon, Popover, ProviderMark, Select, Toggle } from '../../../ui'
import { ModelPicker } from '../../workspace/composer/ModelPicker'
import { agentModelLabel, COMPACT_LABELS, fitEffort, modelLabelOf, useProviderModels } from '../../workspace/composer/providerModels'
import { appliesTo, Page, Row, Section } from '../kit'
import { go, useStore } from '../../../store'
import { patchSettings } from '../useSettings'

const ROLES: { key: Role; title: string }[] = [
  { key: 'lead', title: 'Kernel' },
  { key: 'frontend', title: 'Frontend' },
  // `engineers` is every engineer but a frontend one. The key kept its name so saved settings still read (KERNEL-974).
  { key: 'engineers', title: 'Backend' },
  { key: 'qa', title: 'QA' },
  { key: 'reviewer', title: 'Reviewer' }
]

const LIMITS = [1, 2, 3, 4, 5, 6, 8]

const ROLE_GRID = 'minmax(150px, 1fr) minmax(0, 280px)'

interface WhoLine { key: string; name: string; right: string; open?: { projectId: string; agentId: string } }

/**
 * The agents of every project that read a role's row (KERNEL-974, KERNEL-995), by name across projects. Retired agents and helpers, which take no
 * tasks, are left out. `follow` take the row's model, `own` have a file that sets one and keep it.
 */
function useRoleAgents(roleKey: Role, models: ProviderModel[]): { follow: WhoLine[]; own: WhoLine[] } {
  const projects = useStore((st) => st.projects)
  const agents = useStore((st) => st.agents)
  const follow = new Map<string, WhoLine & { in: string[] }>()
  const own = new Map<string, WhoLine>()
  for (const p of projects) {
    for (const a of agents[p.id] ?? []) {
      if (a.retired || roleOf(a) !== roleKey || (roleKey !== 'lead' && roleKey !== 'reviewer' && !takesTasks(a))) continue
      const open = a.file ? { projectId: p.id, agentId: a.id } : undefined
      if (a.model) {
        const label = agentModelLabel(a.model, models)
        if (!own.has(`${a.name}|${label}`)) own.set(`${a.name}|${label}`, { key: `${a.name}|${label}`, name: a.name, right: label, open })
        else if (!own.get(`${a.name}|${label}`)!.open) own.get(`${a.name}|${label}`)!.open = open
      } else {
        const line = follow.get(a.name) ?? { key: a.name, name: a.name, right: '', in: [], open }
        line.in.push(p.name)
        if (!line.open) line.open = open
        follow.set(a.name, line)
      }
    }
  }
  return { follow: [...follow.values()].map((l) => ({ key: l.key, name: l.name, right: l.in.join(', '), open: l.open })), own: [...own.values()] }
}

/** A role's second line: the provider, then who follows the row as a quiet link that opens the list of agents on it and the ones that set their own model. */
function RoleAgents({ title, provider, follow, own }: { title: string; provider: Provider; follow: WhoLine[]; own: WhoLine[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const close = () => {
    const at = document.activeElement
    setOpen(false)
    if (!at || at === document.body || wrap.current?.contains(at)) button.current?.focus()
  }
  const count = follow.length ? `${follow.length} ${follow.length === 1 ? 'agent' : 'agents'}` : 'No agents use this row'
  const line = (l: WhoLine) => (
    <li key={l.key} className="ag-who-line">
      {l.open
        ? <LinkButton variant="action" className="ag-who-name" onClick={() => go({ name: 'settings', page: 'project', projectId: l.open!.projectId, section: 'agents', agentId: l.open!.agentId })}>{l.name}</LinkButton>
        : <span className="ag-who-name">{l.name}</span>}
      <span className="ag-who-right ellipsis">{l.right}</span>
    </li>
  )
  return (
    <span ref={wrap} className="set-desc ag-role-sub">
      <span>{provider === 'codex' ? 'Codex' : 'Claude Code'}</span>
      <span aria-hidden="true">·</span>
      {follow.length || own.length
        ? <button ref={button} type="button" className="ag-count" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>{count}</button>
        : <span>{count}</span>}
      <Popover open={open} onClose={close} label={`Agents on ${title}`} anchorRef={wrap} className="ag-who">
        {follow.length > 0 && <><p className="ag-who-head">Uses this row</p><ul className="ag-who-list">{follow.map(line)}</ul></>}
        {own.length > 0 && <><p className="ag-who-head">Sets its own model</p><ul className="ag-who-list">{own.map(line)}</ul></>}
      </Popover>
    </span>
  )
}

/** A role's chip: like the composer's model chip, with the model, then the effort and, on Claude, the compact window. Opens the model picker under it (KERNEL-988, KERNEL-995). Escape and a pick return focus to the chip. */
function ModelChip({ title, current, compact, models, onPick, onEffort, onCompact }: { title: string; current: RoleModel; compact: CompactWindow; models: ProviderModel[]; onPick: (model: string) => void; onEffort: (e: Effort) => void; onCompact: (w: CompactWindow) => void }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const label = modelLabelOf(current.model, models)
  const claude = current.provider !== 'codex'
  const detail = claude ? `${EFFORT_LABELS[current.effort]} · ${COMPACT_LABELS[compact]}` : EFFORT_LABELS[current.effort]
  // An outside click has already moved focus where the person pointed, so only take it back from the picker or from nowhere.
  const close = () => {
    const at = document.activeElement
    setOpen(false)
    if (!at || at === document.body || wrap.current?.contains(at)) button.current?.focus()
  }
  return (
    <span ref={wrap} className="select">
      <button ref={button} type="button" className="select-trigger ag-chip" aria-haspopup="dialog" aria-expanded={open} aria-label={`${title} model, ${label}, ${detail}`} onClick={() => (open ? close() : setOpen(true))}>
        <ProviderMark provider={current.provider} size={14} />
        <span className="ag-chip-name">{label}</span>
        <span className="ag-chip-detail ellipsis">{detail}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && <ModelPicker variant="settings" placement="down" anchorRef={wrap} provider={current.provider} model={current.model} effort={current.effort} fallback={current.effort} compact={claude ? compact : undefined}
        onModel={(m) => { onPick(m); close() }} onEffort={onEffort} onCompact={onCompact} onClose={close} />}
    </span>
  )
}

/**
 * One role's row (KERNEL-406, KERNEL-680, KERNEL-995): the model picker is grouped by provider, so picking a model also picks the provider, and the
 * effort moves to one the model takes. Codex manages its own context, so a Codex role has no compact window.
 */
function RoleLine({ title, roleKey, current, compact }: { title: string; roleKey: Role; current: RoleModel; compact: CompactWindow }) {
  const claude = useProviderModels('claude')
  const codex = useProviderModels('codex')
  const listOf = (p: Provider) => (p === 'codex' ? codex : claude)
  const who = useRoleAgents(roleKey, [...claude, ...codex])
  const save = (next: RoleModel) => void patchSettings({ models: { roles: { [roleKey]: { prefer: next.provider, [next.provider]: { model: next.model, effort: next.effort } } } } })
  const pick = (model: string) => {
    const provider: Provider = codex.some((m) => m.id === model) ? 'codex' : claude.some((m) => m.id === model) ? 'claude' : current.provider
    save({ provider, model, effort: fitEffort(current.effort, model, listOf(provider)) })
  }
  return (
    <div className="set-table-row ag-role-row" role="row" aria-label={title} style={{ gridTemplateColumns: ROLE_GRID }}>
      <span role="cell" className="ag-role-name"><span className="set-label ellipsis">{title}</span><RoleAgents title={title} provider={current.provider} follow={who.follow} own={who.own} /></span>
      <span role="cell"><ModelChip title={title} current={current} compact={compact} models={listOf(current.provider)} onPick={pick}
        onEffort={(effort) => save({ ...current, effort })} onCompact={(w) => void patchSettings({ models: { compact: { [roleKey]: w } } })} /></span>
    </div>
  )
}

function Roles({ s }: { s: AppSettings }) {
  return (
    <div className="set-card ag-roles" role="table" aria-label="Roles">
      <div className="set-table-head" role="row" style={{ gridTemplateColumns: ROLE_GRID }}>{['Role', 'Model'].map((c) => <span key={c} role="columnheader">{c}</span>)}</div>
      {ROLES.map((r) => <RoleLine key={r.key} title={r.title} roleKey={r.key} current={roleSide(s.models.roles[r.key])} compact={s.models.compact[r.key]} />)}
    </div>
  )
}

/** Settings > Models and effort (AgentsPage.dc.html, KERNEL-680). The agent limit is enforced by the engine with a queue. */
export function Models({ s }: { s: AppSettings }) {
  const m = s.models
  const limits = [...new Set([...LIMITS, m.agentLimit])].filter((n) => n > 0).sort((a, b) => a - b)
  return (
    <Page title="Models and effort">
      <Section title="Roles" plain label="Roles" footnote={appliesTo('models.roles')}>
        <Roles s={s} />
      </Section>
      <Section title="Planning">
        <Row id="lead-plan-mode" setting="models.leadPlanMode" label="Kernel starts in plan mode"><Toggle label="Kernel starts in plan mode" checked={m.leadPlanMode} onChange={(v) => void patchSettings({ models: { leadPlanMode: v } })} /></Row>
        <Row id="workspace-plan-mode" setting="models.workspacePlanMode" label="New workspaces start in plan mode" desc="Kernel’s hand-offs skip it, since Kernel already planned."><Toggle label="New workspaces start in plan mode" checked={m.workspacePlanMode} onChange={(v) => void patchSettings({ models: { workspacePlanMode: v } })} /></Row>
      </Section>
      <Section title="Teamwork">
        <Row id="agent-limit" label="Agents working at once" desc="More agents use more of your limits. Chats with Kernel don’t count.">
          <Select label="Agents working at once" value={String(m.agentLimit)} options={[...limits.map((n) => ({ value: String(n), label: String(n) })), { value: '0', label: 'No limit' }]} onChange={(v) => void patchSettings({ models: { agentLimit: Number(v) } })} />
        </Row>
        <Row id="lead-updates" label="Keep Kernel updated" desc="Tells Kernel about failed checks, reviews and questions."><Toggle label="Keep Kernel updated" checked={m.leadUpdates} onChange={(v) => void patchSettings({ models: { leadUpdates: v } })} /></Row>
        <Row id="agent-teams" setting="models.agentTeams" label={<>Agent teams <span className="set-badge">Experimental</span></>} desc="Kernel coordinates teammates through a shared task list."><Toggle label="Agent teams" checked={m.agentTeams} onChange={(v) => void patchSettings({ models: { agentTeams: v } })} /></Row>
        {m.agentTeams && (
          <>
            <Row child label="Send back tasks without test output" desc="A task marked done before any test ran goes back once."><Toggle label="Send back tasks without test output" checked={s.hooks.requireTestOutput} onChange={(v) => void patchSettings({ hooks: { requireTestOutput: v } })} /></Row>
            <Row child label="Keep idle teammates working" desc="An idle teammate picks up an open task."><Toggle label="Keep idle teammates working" checked={s.hooks.keepTeammatesWorking} onChange={(v) => void patchSettings({ hooks: { keepTeammatesWorking: v } })} /></Row>
          </>
        )}
      </Section>
    </Page>
  )
}
