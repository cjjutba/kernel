import { useEffect } from 'react'
import type { AgentDef } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button } from '../../../ui'
import { Page, Row, Section } from '../kit'
import { agentLabel, agentSource, cleanDescription } from './agentRows'

/** Settings > Agents (KERNEL-641): the agents that join every room, with no room needed. A change on disk reaches this list as a push. */
export function Agents() {
  const list = useStore((s) => s.globalAgents)
  const roomId = useStore((s) => s.rooms.find((r) => !r.hidden && !r.archived)?.id)
  useEffect(() => {
    void call('agents.listGlobal', {}).then(actions.agents.setGlobal)
      .catch((e) => actions.ui.toast({ title: 'Could not read the agents', sub: cleanError(e) }))
  }, [])
  const personal = (list ?? []).filter((a) => a.origin !== 'plugin')
  const plugin = (list ?? []).filter((a) => a.origin === 'plugin')
  const edit = (a: AgentDef) => go({ name: 'settings', page: 'agents', agentId: a.id })
  // The draft and the file are made through a room, so New agent needs one to open from. The agent lands in ~/.claude/agents and joins them all.
  const hire = () => roomId && actions.ui.openModal({ name: 'newAgent', roomId, step: 'describe' })
  const row = (a: AgentDef, verb: string) => (
    <Row key={a.id} label={agentLabel(a)} source={agentSource(a)} desc={a.description ? <span className="set-clamp">{cleanDescription(a.description)}</span> : undefined}>
      <Button aria-label={`${verb} ${a.name}`} onClick={() => edit(a)}>{verb}</Button>
    </Row>
  )
  return (
    <Page
      title="Agents" intro="Agents that join every room: your own files in ~/.claude/agents, and the ones plugins bring. A room’s Agents page adds the ones in its repo."
      action={<Button variant="primary" disabled={!roomId} title={roomId ? undefined : 'Add a room first. New agent opens from a room.'} onClick={hire}>New agent</Button>}
    >
      {list && (
        <Section title="Yours">
          {personal.length
            ? personal.map((a) => row(a, 'Edit'))
            : <Row label="No personal agents" desc="Files in ~/.claude/agents join every room." />}
        </Section>
      )}
      {plugin.length > 0 && <Section title="From plugins">{plugin.map((a) => row(a, 'View'))}</Section>}
    </Page>
  )
}
