import './agents.css'
import { useRef, useState } from 'react'
import { EFFORT_LABELS, type AppSettings, type CompactWindow, type Effort, type Provider, type ProviderModel, type Role, type RoleChoice, type RoleModel } from '@shared/types'
import { roleOf, takesTasks } from '@shared/team'
import { roleSide } from '@shared/rolePick'
import { AgentAvatar, Icon, LinkButton, Popover, ProviderMark, Select, Toggle } from '../../../ui'
import { ModelPicker } from '../../workspace/composer/ModelPicker'
import { agentModelLabel, COMPACT_LABELS, effortsOf, fitEffort, modelLabelOf, providerLabel, useProviderModels } from '../../workspace/composer/providerModels'
import { appliesTo, Page, Row, Section, SettingsLink } from '../kit'
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

/** The provider by its short name, as a sentence says it. */
const short = (p: Provider) => (p === 'codex' ? 'Codex' : 'Claude')

/** Role, Model, Effort and Agents (Pen 15.7). The columns are fixed, so the picker chips line up down the card. */
const ROLE_GRID = 'minmax(0, 1fr) 220px 150px 110px'

/** What a role does, under its name. A role on Codex says so. */
const roleNote = (key: Role, prefer: Provider) => (key === 'lead' ? 'Plans and hands off' : prefer === 'codex' ? 'Runs on Codex' : undefined)

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

/** A role's agents column: how many follow the row, or the one who does by name, as a quiet button that opens the list of them and the ones that set their own model. */
function RoleAgents({ title, lead, follow, own }: { title: string; lead: boolean; follow: WhoLine[]; own: WhoLine[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const close = () => {
    const at = document.activeElement
    setOpen(false)
    if (!at || at === document.body || wrap.current?.contains(at)) button.current?.focus()
  }
  const count = !follow.length ? 'No agents' : follow.length === 1 && !own.length && !lead ? follow[0].name : `${follow.length} ${follow.length === 1 ? 'agent' : 'agents'}`
  const line = (l: WhoLine) => (
    <li key={l.key} className="ag-who-line">
      <AgentAvatar name={l.name} size={18} />
      {l.open
        ? <LinkButton variant="action" className="ag-who-name" onClick={() => go({ name: 'settings', page: 'project', projectId: l.open!.projectId, section: 'agents', agentId: l.open!.agentId })}>{l.name}</LinkButton>
        : <span className="ag-who-name">{l.name}</span>}
      <span className="ag-who-right ellipsis">{l.right}</span>
    </li>
  )
  return (
    <span ref={wrap} className="ag-role-sub">
      {follow.length || own.length
        ? <button ref={button} type="button" className="ag-count" aria-haspopup="dialog" aria-expanded={open} aria-label={`${count}, on ${title}`} onClick={() => (open ? close() : setOpen(true))}>{count}</button>
        : <span className="ag-count" data-none="">{count}</span>}
      <Popover open={open} onClose={close} align="right" label={`Agents on ${title}`} anchorRef={wrap} className="ag-who">
        {follow.length > 0 && <><p className="ag-who-head">Uses this row</p><ul className="ag-who-list">{follow.map(line)}</ul></>}
        {own.length > 0 && <><p className="ag-who-head">Sets its own model</p><ul className="ag-who-list">{own.map(line)}</ul></>}
      </Popover>
    </span>
  )
}

/**
 * A role's model: the shared model and effort picker opens under a chip with the model's name (KERNEL-988, KERNEL-995). Both providers stay open in it, so picking a model of the other
 * provider moves the role there. `label` is what the chip says, `only` holds the picker to one provider (the fallback). Escape and a pick return focus to the chip.
 */
function ModelChip({ title, current, compact, models, label, only, onPick, onEffort, onCompact }: {
  title: string; current: RoleModel; compact?: CompactWindow; models: ProviderModel[]; label?: string; only?: Provider
  onPick: (model: string, provider: Provider) => void; onEffort: (e: Effort) => void; onCompact?: (w: CompactWindow) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const name = modelLabelOf(current.model, models)
  const claude = current.provider !== 'codex'
  const detail = claude && compact ? `${EFFORT_LABELS[current.effort]} · ${COMPACT_LABELS[compact]}` : EFFORT_LABELS[current.effort]
  // An outside click has already moved focus where the person pointed, so only take it back from the picker or from nowhere.
  const close = () => {
    const at = document.activeElement
    setOpen(false)
    if (!at || at === document.body || wrap.current?.contains(at)) button.current?.focus()
  }
  return (
    <span ref={wrap} className="select">
      <button ref={button} type="button" className="select-trigger ag-chip" aria-haspopup="dialog" aria-expanded={open} aria-label={`${title} model, ${name}, ${detail}`} onClick={() => (open ? close() : setOpen(true))}>
        <ProviderMark provider={current.provider} size={14} />
        <span className="ag-chip-name">{label ?? name}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && <ModelPicker variant="settings" placement="down" only={only} anchorRef={wrap} provider={current.provider} model={current.model} effort={current.effort} fallback={current.effort} compact={claude ? compact : undefined}
        onModel={(m, _e, p) => { onPick(m, p); close() }} onEffort={onEffort} onCompact={onCompact} onClose={close} />}
    </span>
  )
}

/** Saves a model pick for one side of a role. Picking the other provider's model moves the role onto it, with that side's own effort. */
function useRoleSave(roleKey: Role, choice: RoleChoice, listOf: (p: Provider) => ProviderModel[]) {
  const save = (provider: Provider, model: string, effort: Effort) => void patchSettings({ models: { roles: { [roleKey]: { [provider]: { model, effort } } } } })
  const pick = (provider: Provider) => (model: string, picked: Provider) => (picked === provider
    ? save(provider, model, fitEffort(roleSide(choice, provider).effort, model, listOf(provider)))
    : void patchSettings({ models: { roles: { [roleKey]: { prefer: picked, [picked]: { model, effort: fitEffort(roleSide(choice, picked).effort, model, listOf(picked)) } } } } }))
  return { save, pick }
}

/**
 * One role's row (KERNEL-406, KERNEL-680, KERNEL-995, Pen 15.7): its name, the model it runs on, how hard it thinks and the agents that follow it. The model is the preferred provider's side of the role.
 * Claude's compact window lives in the picker, since Codex manages its own context.
 */
function RoleLine({ title, roleKey, choice, compact }: { title: string; roleKey: Role; choice: RoleChoice; compact: CompactWindow }) {
  const claude = useProviderModels('claude')
  const codex = useProviderModels('codex')
  const listOf = (p: Provider) => (p === 'codex' ? codex : claude)
  const who = useRoleAgents(roleKey, [...claude, ...codex])
  const { save, pick } = useRoleSave(roleKey, choice, listOf)
  const provider = choice.prefer
  const current = roleSide(choice, provider)
  const note = roleNote(roleKey, provider)
  const efforts = effortsOf(current.model, listOf(provider))
  const effort = fitEffort(current.effort, current.model, listOf(provider))
  return (
    <div className="set-table-row ag-role-row" role="row" aria-label={title} style={{ gridTemplateColumns: ROLE_GRID }}>
      <span role="cell" className="ag-role-name"><span className="set-label ellipsis">{title}</span>{note && <span className="set-desc ellipsis">{note}</span>}</span>
      <span role="cell" className="ag-side">
        <ModelChip title={`${title} ${providerLabel(provider)}`} current={{ ...current, effort }} compact={compact} models={listOf(provider)} onPick={pick(provider)}
          onEffort={(e) => save(provider, current.model, e)} onCompact={(w) => void patchSettings({ models: { compact: { [roleKey]: w } } })} />
      </span>
      <span role="cell" className="ag-side">
        <Select label={`${title} effort`} value={effort} options={efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))} onChange={(v) => save(provider, current.model, v as Effort)} />
      </span>
      <span role="cell"><RoleAgents title={title} lead={roleKey === 'lead'} follow={who.follow} own={who.own} /></span>
    </div>
  )
}

function Roles({ s }: { s: AppSettings }) {
  return (
    <div className="set-card ag-roles" role="table" aria-label="Roles">
      <div className="set-table-head" role="row" style={{ gridTemplateColumns: ROLE_GRID }}>{['Role', 'Model', 'Effort', 'Agents'].map((c) => <span key={c} role="columnheader">{c}</span>)}</div>
      {ROLES.map((r) => <RoleLine key={r.key} title={r.title} roleKey={r.key} choice={s.models.roles[r.key]} compact={s.models.compact[r.key]} />)}
    </div>
  )
}

/**
 * What runs when a role's provider is at its limit (KERNEL-1056, Pen 15.33): the role's other side, one row per role. Settings, Accounts decides whether new work moves there.
 * The chip names the provider and the model, and its picker is held to that provider.
 */
function FallbackLine({ title, roleKey, choice }: { title: string; roleKey: Role; choice: RoleChoice }) {
  const claude = useProviderModels('claude')
  const codex = useProviderModels('codex')
  const listOf = (p: Provider) => (p === 'codex' ? codex : claude)
  const { save, pick } = useRoleSave(roleKey, choice, listOf)
  const other: Provider = choice.prefer === 'codex' ? 'claude' : 'codex'
  const current = roleSide(choice, other)
  const name = modelLabelOf(current.model, listOf(other))
  return (
    <Row id={`fallback-${roleKey}`} label={`${title}, when ${short(choice.prefer)} is at its limit`} desc={`Start new chats on ${short(other)} instead of waiting.`}>
      <ModelChip title={`${title} ${providerLabel(other)} fallback`} current={current} models={listOf(other)} label={`${short(other)}, ${name}`} only={other} onPick={pick(other)} onEffort={(e) => save(other, current.model, e)} />
    </Row>
  )
}

/** Settings > Models and effort (AgentsPage.dc.html, KERNEL-680). The agent limit is enforced by the engine with a queue. */
export function Models({ s }: { s: AppSettings }) {
  const m = s.models
  const limits = [...new Set([...LIMITS, m.agentLimit])].filter((n) => n > 0).sort((a, b) => a - b)
  return (
    <Page title="Models and effort" desc="Which model each role runs on, and how hard it thinks.">
      <Section title="Roles" plain label="Roles" action={<span className="set-section-note">Applies to every project</span>} footnote={appliesTo('models.roles')}>
        <Roles s={s} />
      </Section>
      <Section id="at-a-limit" title="At a limit" footnote={<>Used when Settings, Accounts has “start new work on the other provider” on. <SettingsLink to={{ page: 'accounts' }}>Open Accounts</SettingsLink></>}>
        {ROLES.map((r) => <FallbackLine key={r.key} title={r.title} roleKey={r.key} choice={m.roles[r.key]} />)}
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
