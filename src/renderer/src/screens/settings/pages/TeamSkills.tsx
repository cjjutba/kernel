import { useEffect, useState } from 'react'
import type { ProjectSettings, Skill } from '@shared/types'
import { call, cleanError } from '../../../api'
import { failToast, useRetryKey } from '../../../retry'
import { Button, LoadingRow, Skeleton, Toggle, useBusy } from '../../../ui'
import { appliesTo, Row, Section } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { ProjectMcp } from './ProjectMcp'
import './teamRows.css'

/**
 * The Skills and MCP servers sections of a project's Agents page (KERNEL-914): a switch for each skill and MCP server. What is off is kept per project in
 * its .kernel settings, so the same skill can be on in one project and off in another. Sign-ins live in Settings, MCP servers (KERNEL-661).
 */
export function TeamSkills({ projectId, rs }: { projectId: string; rs: ProjectSettings | null }) {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, run] = useBusy<'retry'>()
  const off = rs?.disabled
  const retryKey = `skills.list:${projectId}`
  const load = (id: string) => call('skills.list', { projectId: id }).then((l) => { setSkills(l); setFailed(false) }).catch((e) => {
    setFailed(true)
    failToast('Could not read this project’s skills', cleanError(e), retryKey)
  })
  useRetryKey(retryKey, () => load(projectId))
  useEffect(() => { setSkills(null); setFailed(false) }, [projectId])
  useEffect(() => {
    void load(projectId)
  }, [projectId, off?.skills.join('\n')])
  const flip = (kind: 'skills' | 'mcp', name: string, on: boolean) => {
    const list = off?.[kind] ?? []
    void patchProjectSettings(projectId, { disabled: { [kind]: on ? list.filter((n) => n !== name) : [...new Set([...list, name])] } })
  }
  const isOn = (kind: 'skills' | 'mcp', name: string) => !(off?.[kind] ?? []).includes(name)
  return (
    <>
      <Section title="Skills" footnote={appliesTo('disabled.skills')}>
        {!skills && failed && (
          <Row label="Skills" desc="From .claude/skills and plugins.">
            <Button busy={busy === 'retry'} busyLabel="Trying again" onClick={() => void run('retry', () => load(projectId))}>Try again</Button>
          </Row>
        )}
        {!skills && !failed && (
          <>
            {[160, 120, 190].map((w, i) => <Row key={i} className="rm-skeleton" lead={<Skeleton width={28} height={28} />} label={<Skeleton width={w} height={10} />} desc={<Skeleton width={90} height={8} />} />)}
            <LoadingRow what="skills" inline />
          </>
        )}
        {skills?.length === 0 && <p className="set-empty">No skills found in this repo or your user folders. Add one in <code>.claude/skills</code> and it shows up here.</p>}
        {skills?.map((k) => (
          <Row key={k.name} className="rm-skill" label={<span className="mono">/{k.name}</span>}>
            <Toggle label={`/${k.name}`} checked={isOn('skills', k.name)} onChange={(v) => flip('skills', k.name, v)} />
          </Row>
        ))}
      </Section>
      <ProjectMcp isOn={(name) => isOn('mcp', name)} flip={(name, on) => flip('mcp', name, on)} />
    </>
  )
}
