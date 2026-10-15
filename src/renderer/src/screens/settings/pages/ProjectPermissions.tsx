import { PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { call, cleanError } from '../../../api'
import { MODE_INFO, pickMode, unavailable, useModeAvailability } from '../../../permissionModes'
import { actions, useStore } from '../../../store'
import { Select } from '../../../ui'
import { NoProject, ProjectPage, Row, Section, SettingsLink, TagList, useProjectPage } from '../kit'
import { useMenuOpen } from './projectMenu'

const USE_DEFAULT = ''

/**
 * Settings > a project > Permissions (MorePage projectPerms, KERNEL-680): the project's mode, with "Default (the app's mode)" first, and the commands and
 * tools approvals saved with Always allow in this project, as tags you can remove. Never allow and protected branches stay on the app's page.
 */
export function ProjectPermissions({ projectId }: { projectId?: string }) {
  const { project, rs } = useProjectPage(projectId)
  const menu = useMenuOpen('projectMode')
  const appMode = useStore((s) => s.settings?.permissions.mode)
  const availability = useModeAvailability()
  if (!project || !projectId) return <NoProject />
  const current = project.permissionMode
  const save = async (patch: { allow: string[] } | { allowTools: string[] }) => {
    try { actions.projects.upsert(await call('projects.update', { projectId, patch })); return true } catch (e) { actions.ui.toast({ title: 'Could not save the rule', sub: cleanError(e) }); return undefined }
  }
  const modes = PERMISSION_MODES.map((mode) => ({ value: mode, label: MODE_INFO[mode].label, disabled: unavailable(mode, availability).dim && mode !== current }))
  return (
    <ProjectPage project={project} rs={rs} title="Permissions">
      <Section label="Mode">
        <Row id="mode" label="Mode" labelId="rp-mode" desc="Chats in this project start in this mode." {...(current ? { changed: true, onReset: () => void pickMode(undefined, projectId) } : { inherited: { to: { page: 'permissions' as const }, label: 'Settings, Permissions' } })}>
          <Select label="Mode" labelledBy="rp-mode" align="right" value={current ?? appMode ?? USE_DEFAULT} onChange={(v) => void pickMode(v as PermissionMode, projectId)} options={modes} {...menu} />
        </Row>
      </Section>
      <Section title="Always allowed" footnote={<>Never allow and protected branches apply in every project, from <SettingsLink to={{ page: 'permissions' }}>Settings, Permissions</SettingsLink>.</>}>
        <Row id="commands" label="Commands" desc="Saved when you choose Always allow in this project." full={<TagList label="Commands always allowed" value={project.allow ?? []} addLabel="Add command" onChange={(allow) => save({ allow })} />} />
        <Row id="tools" label="Tools" desc="MCP tools and web fetches, saved the same way." full={<TagList label="Tools always allowed" value={project.allowTools ?? []} addLabel="Add tool" onChange={(allowTools) => save({ allowTools })} />} />
      </Section>
    </ProjectPage>
  )
}
