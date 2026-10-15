import { useEffect, useState } from 'react'
import type { ProjectSettings, Skill } from '@shared/types'
import { call } from '../../../api'
import { Button, Skeleton, Toggle, useBusy } from '../../../ui'
import { appliesTo, Row, Section } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { ProjectMcp } from './ProjectMcp'

/**
 * The Skills and MCP servers sections of a project's Agents page (KERNEL-914): a switch for each skill and MCP server. What is off is kept per project in
 * its .kernel settings, so the same skill can be on in one project and off in another. Sign-ins live in Settings, MCP servers (KERNEL-661).
 */
export function TeamSkills({ projectId, rs }: { projectId: string; rs: ProjectSettings | null }) {
  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, run] = useBusy<'retry'>()
  const off = rs?.disabled
  const load = (id: string) => call('skills.list', { projectId: id }).then((l) => { setSkills(l); setFailed(false) }).catch(() => setFailed(true))
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
      <Section title="Skills" count={skills?.length || undefined} footnote={appliesTo('disabled.skills')}>
        {!skills && failed && (
          <Row label="Could not list skills" desc="Try again in a moment.">
            <Button busy={busy === 'retry'} busyLabel="Trying again" onClick={() => void run('retry', () => load(projectId))}>Try again</Button>
          </Row>
        )}
        {!skills && !failed && [60, 45, 52].map((w, i) => <Row key={i} label={<Skeleton width={90} />} desc={<Skeleton width={`${w}%`} height={10} />} />)}
        {skills?.length === 0 && <p className="set-empty">No skills found in this repo or your user folders. Add one in <code>.claude/skills</code> and it shows up here.</p>}
        {skills?.map((k) => (
          <Row key={k.name} label={<span className="mono">/{k.name}</span>} desc={k.description || undefined}>
            <Toggle label={`/${k.name}`} checked={isOn('skills', k.name)} onChange={(v) => flip('skills', k.name, v)} />
          </Row>
        ))}
      </Section>
      <ProjectMcp isOn={(name) => isOn('mcp', name)} flip={(name, on) => flip('mcp', name, on)} />
    </>
  )
}
