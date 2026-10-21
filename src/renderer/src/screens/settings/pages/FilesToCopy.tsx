import './projects.css'
import './envScripts.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileToCopy, ProductionHint, Project, ProjectSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { FileLabel } from '../../../components/FileIcon'
import { failToast, useRetryKey } from '../../../retry'
import { actions } from '../../../store'
import { Button, LoadingRow, Toggle, useBusy } from '../../../ui'
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

/** What the Matches line says about the checkout: how many files match now, or why none do. */
function matchesLine(files: FileToCopy[] | null, failed: boolean, project: Project) {
  if (failed) return 'Could not read the checkout'
  if (files === null) return `Looking in ${home(project.path)}`
  return files.length ? `Matches ${files.length} ${files.length === 1 ? 'file' : 'files'} in the checkout` : 'Matches nothing in the checkout'
}

/**
 * The Files to copy, Never copied and Dependencies sections of a project's Environment page: what a new worktree gets from the checkout, each file that
 * matches and, on a file that looks like production, the variable that gave it away and a choice to leave it out or keep copying it (KERNEL-449, KERNEL-914).
 */
export function FilesToCopy({ projectId, project, rs }: { projectId: string; project: Project; rs: ProjectSettings | null }) {
  const preview = usePreview(projectId)
  const { files, failed } = preview
  const production = useProduction(projectId)
  const [busy, run] = useBusy<string>()
  const reload = useCallback(async () => { await Promise.all([preview.reload(), production.reload()]) }, [preview.reload, production.reload]) // eslint-disable-line react-hooks/exhaustive-deps
  const retry = `files.preview:${projectId}`
  useRetryKey(retry, reload)
  useEffect(() => { if (failed) failToast('Could not read the files to copy', 'Check that the folder is still there.', retry) }, [failed, retry])
  const copy = rs?.files.copy ?? []
  const exclude = rs?.files.exclude ?? []
  /** Saves go to the personal file. The preview reads the saved list, so it reloads once the save has landed. */
  const save = async (patch: { copy?: string[] | null; exclude?: string[] }) => { const saved = await patchProjectSettings(projectId, { files: patch }); void reload(); return saved }
  const hintOf = (path: string) => production.hints.find((h) => h.path === path)
  const leaveOut = (h: ProductionHint) => run(`skip:${h.path}`, () => save({ exclude: [...new Set([...exclude, h.path])] }))
  const keep = (h: ProductionHint) => run(`keep:${h.path}`, async () => {
    try { await call('files.keepCopying', { projectId, hints: [h] }) } catch (e) { actions.ui.toast({ title: 'Could not save the choice', sub: cleanError(e) }) }
    await production.reload()
  })
  return (
    <>
      <Section title="Files to copy" action={<span className="rm-aside">{matchesLine(files, failed, project)}</span>} footnote={<><code>*</code> and <code>**</code> don’t match dot files. A pattern only reaches inside an ignored folder when it names that folder, like <code>certs/*.pem</code>.</>}>
        <Row id="copy-files" setting="files.copy" label="Patterns" desc="Copied into each new worktree before setup runs." {...projectValue(rs, 'files.copy', () => void save({ copy: null }))}
          full={<TagList label="Files to copy" value={copy} addLabel="Add pattern" placeholder="certs/*.pem" onChange={(next) => save({ copy: next })} />} />
        {files === null && !failed && <LoadingRow what="files" inline />}
        {!!files?.length && (
          <ul className="rm-matches" tabIndex={0} aria-label="Files that will be copied">
            {files.map((f) => {
              const hint = hintOf(f.path)
              return (
                <li key={f.path} className="rm-match">
                  <span className="rm-match-name"><FileLabel path={f.path} /></span>
                  {hint && (
                    <span className="rm-match-hint">
                      <span><code>{hint.name}</code>{WHY[hint.why]}</span>
                      <Button size="xs" aria-label={`Leave ${f.path} out`} busy={busy === `skip:${f.path}`} busyLabel="Saving" disabled={busy !== null} onClick={() => void leaveOut(hint)}>Leave out</Button>
                      <Button size="xs" variant="ghost" aria-label={`Keep copying ${f.path}`} busy={busy === `keep:${f.path}`} busyLabel="Saving" disabled={busy !== null} onClick={() => void keep(hint)}>Keep copying</Button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {files?.length === 0 && <p className="rm-matches-empty">{copy.length ? 'Nothing in the checkout matches the list. Patterns only match files git ignores.' : 'The list is empty.'}</p>}
      </Section>
      <Section title="Never copied">
        <Row id="never-copied" setting="files.exclude" label="Patterns" desc="Kept out even when a pattern above matches." full={<TagList label="Files never copied" value={exclude} addLabel="Add pattern" onChange={(next) => save({ exclude: next })} />} />
      </Section>
      <Section title="Dependencies">
        <Row id="symlink-node-modules" setting="files.symlinkNodeModules" label="Symlink node_modules" desc="Faster setup. Native modules can break when Electron versions differ." {...projectValue(rs, 'files.symlinkNodeModules', () => void patchProjectSettings(projectId, { files: { symlinkNodeModules: null } }))}>
          <Toggle label="Symlink node_modules" checked={!!rs?.files.symlinkNodeModules} onChange={(v) => void patchProjectSettings(projectId, { files: { symlinkNodeModules: v } })} />
        </Row>
      </Section>
    </>
  )
}
