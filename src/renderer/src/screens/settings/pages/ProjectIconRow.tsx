import type { KernelApi } from '@shared/ipc'
import type { Project } from '@shared/types'
import { call, cleanError } from '../../../api'
import { ProjectIcon } from '../../../components/ProjectIcon'
import { actions } from '../../../store'
import { Select, useBusy } from '../../../ui'
import { Row } from '../kit'
import { useMenuOpen } from './projectMenu'

type Kind = 'letter' | 'github' | 'image'

const LABEL: Record<Kind, string> = { letter: 'First letter', github: 'GitHub avatar', image: 'Image' }

/** Settings > a project > General > Icon (MorePage projectGeneral, KERNEL-680): the project's letter, its GitHub avatar or a picked image. Choose image opens the file dialog. */
export function ProjectIconRow({ project }: { project: Project }) {
  const menu = useMenuOpen('projectIcon')
  const [busy, run] = useBusy<Kind>()
  const kind: Kind = project.icon?.kind ?? 'letter'
  // The avatar comes from the project's GitHub owner, so a project with no GitHub repo can't ask for one. One that already has it keeps the entry.
  const github = !!project.repo || kind === 'github'

  const fail = (e: unknown) => actions.ui.toast({ title: 'Could not change the icon', sub: cleanError(e) })
  const save = (next: Kind, icon: KernelApi['projects.setIcon']['req']['icon']) => void run(next, async () => {
    try {
      actions.projects.upsert(await call('projects.setIcon', { projectId: project.id, icon }))
    } catch (e) {
      // The engine leaves the project as it was, so the letter or the old image stays.
      fail(e)
    }
  })
  const pick = (next: Kind) => { if (next !== kind) save(next, { kind: next } as KernelApi['projects.setIcon']['req']['icon']) }
  const chooseImage = async () => {
    // The file dialog opens before the busy state starts, so the control doesn't look busy while it is up. Cancelling returns null.
    let path: string | null
    try { path = await call('system.pickImage', undefined) } catch (e) { return fail(e) }
    if (path) save('image', { kind: 'image', path })
  }
  const options = [
    { value: 'letter', label: LABEL.letter },
    ...(github ? [{ value: 'github', label: LABEL.github }] : []),
    ...(kind === 'image' ? [{ value: 'image', label: LABEL.image }] : [])
  ]
  return (
    <Row id="icon" label="Icon" desc="Shown in the sidebar and on the project’s chats.">
      <ProjectIcon project={project} className="set-icon-tile" />
      <Select label="Project icon" value={kind} options={options} disabled={busy !== null} align="right" onChange={(v) => pick(v as Kind)} actions={[{ label: 'Choose an image', icon: 'image', onSelect: () => void chooseImage() }]} {...menu} />
    </Row>
  )
}
