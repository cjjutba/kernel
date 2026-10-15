import './projects.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileToCopy, ProductionHint, Project, ProjectSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { FileLabel } from '../../../components/FileIcon'
import { actions } from '../../../store'
import { Button, Icon, Toggle, useBusy } from '../../../ui'
import { Row, projectValue, Section, TagList } from '../kit'
import { patchProjectSettings } from '../useSettings'

const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/**
 * What a new worktree of the project gets, from `files.preview` (the same resolver the copy uses). It loads when the page opens,
 * and `reload` runs it again: Refresh calls it, and so does saving the list. `files` is null until the first answer.
 */
function usePreview(projectId: string) {
  const [files, setFiles] = useState<FileToCopy[] | null>(null)
  const [failed, setFailed] = useState(false)
  const latest = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++latest.current
    try {
      const next = await call('files.preview', { projectId })
      if (mine === latest.current) { setFiles(next); setFailed(false) }
    } catch {
      if (mine === latest.current) setFailed(true)
    }
  }, [projectId])
  useEffect(() => { setFiles(null); void reload() }, [reload])
  return { files, failed, reload }
}

/** The files to copy that look like production, from `files.production`. Empty until the first answer, and on a failed read. */
function useProduction(projectId: string) {
  const [hints, setHints] = useState<ProductionHint[]>([])
  const latest = useRef(0)
  const reload = useCallback(async () => {
    const mine = ++latest.current
    const next = await call('files.production', { projectId }).catch(() => [])
    if (mine === latest.current) setHints(next)
  }, [projectId])
  useEffect(() => { setHints([]); void reload() }, [reload])
  return { hints, reload }
}

const WHY: Record<ProductionHint['why'], string> = {
  'live-key': ' is a live key',
  'remote-database': ' points to a remote database',
  production: ' is set to production'
}

/**
 * SettingsFilesProduction.png: each file that looks like production and the variable that gave it away, never its value
 * (KERNEL-449). Don't copy these files adds them to the project's exclusions. Keep copying remembers them for the project.
 */
function ProductionBanner({ hints, onSkip, onKeep }: { hints: ProductionHint[]; onSkip: () => Promise<unknown>; onKeep: () => Promise<unknown> }) {
  const [busy, run] = useBusy<'skip' | 'keep'>()
  const title = `${hints.length} ${hints.length === 1 ? 'file looks' : 'files look'} like production`
  return (
    <div className="card set-banner" role="group" aria-label={title}>
      <Icon name="warning" size={16} />
      <div className="set-banner-body">
        <div className="set-banner-text">
          <span className="set-banner-title">{title}</span>
          <span className="set-banner-detail">Agents run commands in every worktree, so a migration or seed script there could reach a live database.</span>
        </div>
        <ul className="set-banner-files">
          {hints.map((h) => <li key={h.path}><span className="set-banner-file">{h.path}</span><span><code>{h.name}</code>{WHY[h.why]}</span></li>)}
        </ul>
        <div className="set-banner-acts">
          <Button busy={busy === 'skip'} busyLabel="Saving" disabled={busy !== null} onClick={() => void run('skip', onSkip)}>Don’t copy these files</Button>
          <Button variant="ghost" busy={busy === 'keep'} busyLabel="Saving" disabled={busy !== null} onClick={() => void run('keep', onKeep)}>Keep copying</Button>
        </div>
      </div>
    </div>
  )
}

/** What the Gitignored files row says about the checkout: how many files match now, or why none do. */
function previewDesc(project: Project, copy: string[], files: FileToCopy[] | null, failed: boolean) {
  if (failed) return 'Could not read the files. Check that the folder is still there, then refresh.'
  if (files === null) return `Looking in ${home(project.path)}`
  if (!files.length) return copy.length ? 'Nothing in the checkout matches the list. Patterns only match files git ignores.' : 'The list is empty.'
  return `${files.length} ${files.length === 1 ? 'file matches' : 'files match'} in ${home(project.path)} right now.`
}

/** The Files to copy section of a project's Environment page: what a new worktree gets from the checkout, with the production warning above it (KERNEL-914). */
export function FilesToCopy({ projectId, project, rs }: { projectId: string; project: Project; rs: ProjectSettings | null }) {
  const preview = usePreview(projectId)
  const { files, failed } = preview
  const production = useProduction(projectId)
  const reload = useCallback(async () => { await Promise.all([preview.reload(), production.reload()]) }, [preview.reload, production.reload]) // eslint-disable-line react-hooks/exhaustive-deps
  const copy = rs?.files.copy ?? []
  const exclude = rs?.files.exclude ?? []
  /** Saves go to the personal file. The preview reads the saved list, so it reloads once the save has landed. */
  const save = async (patch: { copy?: string[] | null; exclude?: string[] }) => { const saved = await patchProjectSettings(projectId, { files: patch }); void reload(); return saved }
  const skip = () => save({ exclude: [...new Set([...exclude, ...production.hints.map((h) => h.path)])] })
  const keep = async () => {
    try { await call('files.keepCopying', { projectId, hints: production.hints }) } catch (e) { actions.ui.toast({ title: 'Could not save the choice', sub: cleanError(e) }) }
    await production.reload()
  }
  return (
    <>
      {production.hints.length > 0 && <ProductionBanner hints={production.hints} onSkip={skip} onKeep={keep} />}
      <Section title="Files to copy" footnote={<><code>*</code> and <code>**</code> don’t match dot files. A pattern only reaches inside an ignored folder when it names that folder, like <code>certs/*.pem</code>.</>}>
        <Row id="copy-files" setting="files.copy" label="Gitignored files" desc={previewDesc(project, copy, files, failed)} {...projectValue(rs, 'files.copy', () => void save({ copy: null }))}
          full={
            <>
              <TagList label="Files to copy" value={copy} addLabel="Add pattern" placeholder="certs/*.pem" onChange={(next) => save({ copy: next })} />
              {!!files?.length && <ul className="set-preview rm-files" tabIndex={0} aria-label="Files that will be copied">{files.map((f) => <li key={f.path}><FileLabel path={f.path} /></li>)}</ul>}
            </>
          } />
        {exclude.length > 0 && (
          <Row id="never-copied" setting="files.exclude" label="Never copied" desc="Skipped even when a pattern above matches." full={<TagList label="Files never copied" value={exclude} addLabel="Add file" onChange={(next) => save({ exclude: next })} />} />
        )}
        <Row id="symlink-node-modules" setting="files.symlinkNodeModules" label="Symlink node_modules" desc="Faster setup. Workspaces share dependencies." {...projectValue(rs, 'files.symlinkNodeModules', () => void patchProjectSettings(projectId, { files: { symlinkNodeModules: null } }))}>
          <Toggle label="Symlink node_modules" checked={!!rs?.files.symlinkNodeModules} onChange={(v) => void patchProjectSettings(projectId, { files: { symlinkNodeModules: v } })} />
        </Row>
      </Section>
    </>
  )
}
