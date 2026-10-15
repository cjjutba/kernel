import { PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { call, cleanError } from '../../../api'
import { MODE_INFO, pickMode, unavailable, useModeAvailability } from '../../../permissionModes'
import { actions, useStore } from '../../../store'
import { Select } from '../../../ui'
import { Row, Section, SettingsLink, TagList } from '../kit'
import { useMenuOpen } from './projectMenu'

const USE_DEFAULT = ''

/**
 * The Permissions section of a project's Agents page (KERNEL-914): the project's mode, with "Default (the app's mode)" first, and the commands and
 * tools approvals saved with Always allow in this project, as tags you can remove. Never allow and protected branches stay on the app's page.
 */
export function TeamPermissions({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects.find((r) => r.id === projectId))
  const menu = useMenuOpen('projectMode')
  const appMode = useStore((s) => s.settings?.permissions.mode)
  const availability = useModeAvailability()
  if (!project) return null
  const current = project.permissionMode
  const save = async (patch: { allow: string[] } | { allowTools: string[] }) => {
    try { actions.projects.upsert(await call('projects.update', { projectId, patch })); return true } catch (e) { actions.ui.toast({ title: 'Could not save the rule', sub: cleanError(e) }); return undefined }
  }
  const modes = PERMISSION_MODES.map((mode) => ({ value: mode, label: MODE_INFO[mode].label, disabled: unavailable(mode, availability).dim && mode !== current }))
  return (
    <Section title="Permissions" footnote={<>Never allow and protected branches apply in every project, from <SettingsLink to={{ page: 'permissions' }}>Settings, Permissions</SettingsLink>.</>}>
      <Row id="mode" label="Mode" labelId="rp-mode" desc="Chats in this project start in this mode." {...(current ? { changed: true, onReset: () => void pickMode(undefined, projectId) } : { inherited: { to: { page: 'permissions' as const }, label: 'Settings, Permissions' } })}>
        <Select label="Mode" labelledBy="rp-mode" align="right" value={current ?? appMode ?? USE_DEFAULT} onChange={(v) => void pickMode(v as PermissionMode, projectId)} options={modes} {...menu} />
      </Row>
      <Row id="commands" label="Commands always allowed" desc="Saved when you choose Always allow in this project." full={<TagList label="Commands always allowed" value={project.allow ?? []} addLabel="Add command" onChange={(allow) => save({ allow })} />} />
      <Row id="tools" label="Tools always allowed" desc="MCP tools and web fetches, saved the same way." full={<TagList label="Tools always allowed" value={project.allowTools ?? []} addLabel="Add tool" onChange={(allowTools) => save({ allowTools })} />} />
    </Section>
  )
}
