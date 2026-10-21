import './projects.css'
import './envScripts.css'
import { useEffect, useState } from 'react'
import type { ProjectSettings, ScriptSuggestion } from '@shared/types'
import { call } from '../../../api'
import { Button, CodeLines, useBusy } from '../../../ui'
import { appliesTo, NoProject, ProjectPage, Row, SaveNote, Section, useBlurSave, useFieldText, useProjectPage, useSaveNote } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { PreviewUrls } from './PreviewUrls'
import { RunMode, RunScripts } from './RunScripts'

type ScriptKey = 'setup' | 'archive'
const SCRIPT_HELP: Record<ScriptKey, { title: string; heading: string; placeholder: string; aside: string; empty: string }> = {
  setup: { title: 'Setup script', heading: 'Setup', placeholder: 'pnpm install', aside: 'Runs in each new worktree', empty: 'Runs alongside the agent in each new worktree.' },
  archive: { title: 'Archive script', heading: 'Archive', placeholder: '# Nothing runs on archive', aside: 'Runs before the worktree is removed', empty: 'Runs before a worktree is removed.' }
}

/** What Kernel found for the project (`scripts.suggest`, KERNEL-682). Empty until the first answer, and on a failed read. */
function useSuggestions(projectId: string | undefined) {
  const [found, setFound] = useState<ScriptSuggestion[]>([])
  useEffect(() => {
    let live = true
    setFound([])
    if (!projectId) return undefined
    call('scripts.suggest', { projectId }).then((next) => { if (live) setFound(next) }, () => {})
    return () => { live = false }
  }, [projectId])
  return found
}

const fromLine = (s: ScriptSuggestion) => (s.source === 'detected' ? `Kernel found ${s.file}.` : `From ${s.file}.`)

/** The label of the button that takes a suggestion: its command when it is one short line, else "Use this script". */
const useLabel = (script: string) => (!script.includes('\n') && script.length <= 28 ? `Use ${script}` : 'Use this script')

/** One offered script in place of an empty editor: where it came from, the script in full, and Use, which saves only that script. Write my own opens the editor. */
function Suggestion({ projectId, kind, suggestion, script, onOwn }: { projectId: string; kind: ScriptKey; suggestion: ScriptSuggestion; script: string; onOwn: () => void }) {
  const [busy, run] = useBusy<'use'>()
  return (
    <div className="set-row rm-offer">
      <div className="rm-offer-body">
        <div className="set-text">
          <span className="set-label">{SCRIPT_HELP[kind].title}</span>
          <span className="set-desc">{fromLine(suggestion)}</span>
        </div>
        <pre className="rm-offer-code">{script}</pre>
        {suggestion.notes.map((n) => <span key={n} className="set-desc">{n}</span>)}
      </div>
      <span className="set-actions">
        <Button variant="ghost" onClick={onOwn}>Write my own</Button>
        <Button aria-label={`Use the suggested ${kind} script`} busy={busy === 'use'} busyLabel="Saving" onClick={() => void run('use', () => patchProjectSettings(projectId, { scripts: { [kind]: script } }))}>{useLabel(script)}</Button>
      </span>
    </div>
  )
}

/** Where a script's text comes from: settings.toml, or the personal file over it. Only the personal file is ever written, so Reset drops that edit. */
function ScriptSource({ projectId, kind, rs }: { projectId: string; kind: ScriptKey; rs: ProjectSettings | null }) {
  const [busy, run] = useBusy<'reset'>()
  const source = rs?.sources?.[`scripts.${kind}`]
  if (source !== 'shared' && source !== 'override') return null
  return (
    <span className="rm-badge-row">
      <span className="rm-badge">{source === 'shared' ? 'From settings.toml' : 'Overrides settings.toml'}</span>
      {source === 'override' && <Button variant="ghost" size="xs" aria-label={`Reset the ${kind} script`} busy={busy === 'reset'} busyLabel="Resetting" onClick={() => void run('reset', () => patchProjectSettings(projectId, { scripts: { [kind]: null } }))}>Reset</Button>}
    </span>
  )
}

/**
 * The whole of a workspace script in a line-numbered field. It saves when the field loses focus, on Cmd+Enter, or when the page goes
 * away with text still in it, and Escape puts the saved script back (KERNEL-721). An empty script takes the key away.
 */
function ScriptEditor({ projectId, kind, rs, offer, focus }: { projectId: string; kind: ScriptKey; rs: ProjectSettings | null; offer?: ScriptSuggestion; focus?: boolean }) {
  const saved = rs?.scripts[kind] ?? ''
  const [text, setText] = useFieldText(saved)
  const [own, setOwn] = useState(false)
  const note = useSaveNote()
  const { title, heading, placeholder, aside } = SCRIPT_HELP[kind]
  const fieldId = `script-${kind}-field`
  useEffect(() => { if (focus) document.getElementById(fieldId)?.focus() }, [focus, fieldId])
  useEffect(() => { if (own) document.getElementById(fieldId)?.focus() }, [own, fieldId])
  // A script of only spaces saves as none and the field empties, so it doesn't save again when the page goes away.
  const commit = (t: string) => {
    if (!t.trim()) setText('')
    void note.track(patchProjectSettings(projectId, { scripts: { [kind]: t.trim() ? t : null } }))
  }
  const save = useBlurSave({ text, setText, saved, commit })
  const dirty = text !== saved
  const empty = !saved.trim() && !!rs
  const offered = empty && !dirty && !own && offer
  const applies = appliesTo(kind === 'setup' ? 'scripts.setup' : 'scripts.archive', projectId)
  const footnote = [kind === 'setup' && 'Setup can write NAME=value lines to $KERNEL_ENV. Agents, run scripts and terminals in the workspace get them.', applies && `${applies}.`].filter(Boolean).join(' ')
  return (
    <Section
      id={`script-${kind}`} title={heading}
      note={<ScriptSource projectId={projectId} kind={kind} rs={rs} />}
      action={<span className="rm-aside">{aside}</span>}
      footnote={footnote || undefined}
    >
      {offered
        ? <Suggestion projectId={projectId} kind={kind} suggestion={offer} script={offer.patch.scripts![kind]!.trim()} onOwn={() => setOwn(true)} />
        : (
          <div className="rm-editor">
            <CodeLines
              id={fieldId} value={text} onChange={(t) => { note.reset(); setText(t) }} label={title} placeholder={placeholder} minLines={1} disabled={!rs}
              onBlur={save.onBlur} onKeyDown={save.onKeyDown} onSubmit={save.onBlur}
            />
          </div>
        )}
      {note.state.kind !== 'idle' && <div className="set-row"><SaveNote state={note.state} /></div>}
    </Section>
  )
}

/** Settings > a project > Scripts (KERNEL-914): setup and archive edited in place, run scripts as rows, run mode, ports and preview URLs. The section id stays `setup`, so every link to it keeps working. */
export function ProjectSetup({ projectId }: { projectId?: string }) {
  const { project, rs } = useProjectPage(projectId)
  const found = useSuggestions(projectId)
  // Add on an empty page opens the editors, with the cursor in the setup script.
  const [started, setStarted] = useState(false)
  if (!project || !projectId) return <NoProject />
  const offerFor = (kind: ScriptKey) => found.find((s) => s.patch.scripts?.[kind]?.trim())
  const blank = !!rs && !rs.scripts.setup?.trim() && !rs.scripts.archive?.trim() && rs.runScripts.length === 0 && !offerFor('setup') && !offerFor('archive')
  return (
    <ProjectPage project={project} rs={rs} title="Scripts" desc="What runs when a workspace is created, archived and started.">
      {blank && !started
        ? (
          <Section label="No scripts yet">
            <Row label="Setup script" desc={SCRIPT_HELP.setup.empty}><Button onClick={() => setStarted(true)}>Add</Button></Row>
            <RunScripts projectId={projectId} rs={rs} empty />
          </Section>
        )
        : (
          <>
            <ScriptEditor projectId={projectId} kind="setup" rs={rs} offer={offerFor('setup')} focus={started} />
            <ScriptEditor projectId={projectId} kind="archive" rs={rs} offer={offerFor('archive')} />
            <RunScripts projectId={projectId} rs={rs} />
          </>
        )}
      <RunMode projectId={projectId} rs={rs} />
      <PreviewUrls projectId={projectId} rs={rs} />
    </ProjectPage>
  )
}
