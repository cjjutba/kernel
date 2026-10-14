import './agents.css'
import { useEffect, useState } from 'react'
import type { AgentDef, AppSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, Icon, SegmentedControl } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { patchSettings, useSettings } from '../useSettings'
import { RowMenu } from './RowMenu'
import { cleanDescription, pluginOf } from './agentRows'

const matches = (a: AgentDef, q: string) => !q || `${a.name} ${a.role} ${cleanDescription(a.description)}`.toLowerCase().includes(q)

/** Settings > Agents (AgentsPage.dc.html, KERNEL-641, KERNEL-680): the agents that join every room, with no room needed. A change on disk reaches this list as a push. */
export function Agents() {
  const s = useSettings()
  const list = useStore((st) => st.globalAgents)
  const roomId = useStore((st) => st.rooms.find((r) => !r.hidden && !r.archived)?.id)
  const [query, setQuery] = useState('')
  const [closed, setClosed] = useState<string[]>([])
  useEffect(() => {
    void call('agents.listGlobal', {}).then(actions.agents.setGlobal)
      .catch((e) => actions.ui.toast({ title: 'Could not read the agents', sub: cleanError(e) }))
  }, [])
  const q = query.trim().toLowerCase()
  const edit = (a: AgentDef) => go({ name: 'settings', page: 'agents', agentId: a.id })
  // With a room the draft is made through it. With none, the agent is personal: it lands in ~/.claude/agents and joins every room added later.
  const hire = () => actions.ui.openModal({ name: 'newAgent', roomId, step: 'describe' })
  const openFile = (a: AgentDef) => call('system.openInEditor', { path: a.file }).catch((e) => actions.ui.toast({ title: 'Could not open the file', sub: cleanError(e) }))
  const copyPath = (a: AgentDef) => navigator.clipboard.writeText(a.file).catch(() => actions.ui.toast({ title: 'Could not copy', sub: 'Select the path and copy it by hand.' }))

  const personal = (list ?? []).filter((a) => a.origin !== 'plugin')
  const plugins = [...new Set((list ?? []).filter((a) => a.origin === 'plugin').map(pluginOf))]
  const groups = [
    { key: 'personal', title: 'Yours', plugin: false, agents: personal },
    ...plugins.map((p) => ({ key: `plugin:${p}`, title: p, plugin: true, agents: (list ?? []).filter((a) => a.origin === 'plugin' && pluginOf(a) === p) }))
  ].map((g) => ({ ...g, shown: g.agents.filter((a) => matches(a, q)) })).filter((g) => (q ? g.shown.length : g.key === 'personal' || g.shown.length))

  const row = (a: AgentDef, verb: 'Edit' | 'View') => {
    const role = a.role.trim() && a.role.trim().toLowerCase() !== a.name.trim().toLowerCase() ? a.role.trim() : ''
    const desc = cleanDescription(a.description)
    return (
      <div key={a.id} className="set-row set-hoverable ag-agent">
        <button type="button" className="ag-open" aria-label={`Open ${a.name}${role ? `, ${role}` : ''}. ${desc}`} onClick={() => edit(a)}>
          <span className="ag-avatar" aria-hidden="true">{a.name.charAt(0).toUpperCase()}</span>
          <span className="ag-lines">
            <span className="ag-title"><b>{a.name}</b>{role && <span>{role}</span>}</span>
            <span className="ag-desc">{desc}</span>
          </span>
        </button>
        <span className="set-acts">
          <Button aria-label={`${verb} ${a.name}`} onClick={() => edit(a)}>{verb}</Button>
          {a.file && <RowMenu label={`More for ${a.name}`} items={[{ id: 'open', label: 'Open file', icon: 'doc', onSelect: () => void openFile(a) }, { id: 'copy', label: 'Copy path', icon: 'copy', onSelect: () => void copyPath(a) }]} />}
        </span>
      </div>
    )
  }

  return (
    <Page title="Agents" action={<Button variant="primary" icon="plus" onClick={hire}>New agent</Button>}>
      {list && (
        <>
          <div className="ag-filter wide">
            <Icon name="search" size={14} />
            <input type="text" aria-label="Filter agents" placeholder="Filter agents" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {groups.map((g) => {
            const open = !closed.includes(g.key) || !!q
            return (
              <section key={g.key} className="ag-group" aria-label={g.title}>
                <button type="button" className="ag-group-head" aria-expanded={open} onClick={() => setClosed(open ? [...closed, g.key] : closed.filter((k) => k !== g.key))}>
                  <h2>{g.title}<span className="set-count">{g.shown.length}</span></h2>
                  {g.plugin && <span className="set-badge">Plugin</span>}
                  <Icon name="right" size={12} />
                </button>
                {open && <div className="set-card">{g.shown.length ? g.shown.map((a) => row(a, g.plugin ? 'View' : 'Edit')) : <Row label="No personal agents" desc="Files in ~/.claude/agents join every room." />}</div>}
              </section>
            )
          })}
          {q && groups.length === 0 && <p className="ag-empty">No agents match “{query}”</p>}
        </>
      )}
      {s && <Section title="New rooms">
        <Row setting="team.defaultTemplate" label="New rooms start with"><SegmentedControl label="New rooms start with" value={s.team.defaultTemplate} onChange={(v) => void patchSettings({ team: { defaultTemplate: v as AppSettings['team']['defaultTemplate'] } })} options={[{ value: 'starter', label: 'Starter team' }, { value: 'pair', label: 'Pair' }]} /></Row>
      </Section>}
    </Page>
  )
}
