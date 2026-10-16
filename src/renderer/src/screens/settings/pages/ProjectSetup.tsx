import './projects.css'
import { useEffect, useState } from 'react'
import type { ProjectSettings, ScriptSuggestion } from '@shared/types'
import { call } from '../../../api'
import { useStore } from '../../../store'
import { Button, CodeLines, Toggle, useBusy } from '../../../ui'
import { appliesTo, NoProject, ProjectPage, projectValue, Row, SaveNote, Section, useBlurSave, useProjectPage, useSaveNote } from '../kit'
import { patchProjectSettings } from '../useSettings'
import { PreviewUrls } from './PreviewUrls'
import { RunMode, RunScripts } from './RunScripts'

type ScriptKey = 'setup' | 'archive'
const SCRIPT_HELP: Record<ScriptKey, { title: string; placeholder: string; desc: string }> = {
  setup: { title: 'Setup script', placeholder: 'pnpm install', desc: 'Runs when a workspace is created.' },
  archive: { title: 'Archive script', placeholder: 'docker compose down', desc: 'Runs before a workspace is archived.' }
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

const fromLine = (s: ScriptSuggestion) => (s.source === 'detected' ? `Detected from ${s.file}` : `From ${s.file}`)

/** One offered script under an empty field: where it came from, the script in full, and Use, which saves only that script. */
function SuggestionLine({ projectId, kind, suggestion, script }: { projectId: string; kind: ScriptKey; suggestion: ScriptSuggestion; script: string }) {
  const [busy, run] = useBusy<'use'>()
  return (
    <div className="rm-suggest">
      <div className="rm-suggest-head">
        <span className="set-desc">{fromLine(suggestion)}</span>
        <Button aria-label={`Use the suggested ${kind} script`} busy={busy === 'use'} busyLabel="Saving" onClick={() => void run('use', () => patchProjectSettings(projectId, { scripts: { [kind]: script } }))}>Use</Button>
      </div>
      <pre className="rm-suggest-script">{script}</pre>
      {suggestion.notes.map((n) => <span key={n} className="set-desc">{n}</span>)}
    </div>
  )
}

/** Where a script's text comes from: settings.toml, or the personal file over it. Only the personal file is ever written, so Reset drops that edit. */
function ScriptSource({ projectId, kind, rs }: { projectId: string; kind: ScriptKey; rs: ProjectSettings | null }) {
  const [busy, run] = useBusy<'reset'>()
  const source = rs?.sources?.[`scripts.${kind}`]
  if (source !== 'shared' && source !== 'override') return null
  return (
    <span className="rm-source">
      <span className="set-desc">{source === 'shared' ? 'From .kernel/settings.toml' : 'Overrides .kernel/settings.toml'}</span>
      {source === 'override' && <Button variant="ghost" aria-label={`Reset the ${kind} script`} busy={busy === 'reset'} busyLabel="Resetting" onClick={() => void run('reset', () => patchProjectSettings(projectId, { scripts: { [kind]: null } }))}>Reset</Button>}
    </span>
  )
}

/**
 * The whole of a workspace script in a line-numbered field. It saves when the field loses focus, on Cmd+Enter, or when the page goes
 * away with text still in it, and Escape puts the saved script back (KERNEL-721). An empty script takes the key away.
 */
function ScriptEditor({ projectId, kind, rs, offer }: { projectId: string; kind: ScriptKey; rs: ProjectSettings | null; offer?: ScriptSuggestion }) {
  const saved = rs?.scripts[kind] ?? ''
  const [text, setText] = useState(saved)
  const note = useSaveNote()
  const { title, placeholder, desc } = SCRIPT_HELP[kind]
  useEffect(() => { setText(saved) }, [saved])
  const save = useBlurSave({ text, setText, saved, commit: (t) => void note.track(patchProjectSettings(projectId, { scripts: { [kind]: t.trim() ? t : null } })) })
  const dirty = text !== saved
  const empty = !saved.trim() && !!rs
  return (
    <Section id={`script-${kind}`} title={title} plain footnote={appliesTo(kind === 'setup' ? 'scripts.setup' : 'scripts.archive', projectId)}>
      <p className="rm-script-desc set-desc">{desc}</p>
      <CodeLines
        value={text} onChange={(t) => { note.reset(); setText(t) }} label={title} placeholder={placeholder} minLines={1} disabled={!rs}
        onBlur={save.onBlur} onKeyDown={save.onKeyDown} onSubmit={save.onBlur}
      />
      <div className="rm-script-foot">
        <ScriptSource projectId={projectId} kind={kind} rs={rs} />
        {note.state.kind !== 'idle' && <span className="rm-script-acts"><SaveNote state={note.state} /></span>}
      </div>
      {kind === 'setup' && <p className="set-help">Setup can write NAME=value lines to <code>$KERNEL_ENV</code>. Agents, run scripts and terminals in the workspace get them.</p>}
      {empty && !dirty && offer && <SuggestionLine projectId={projectId} kind={kind} suggestion={offer} script={offer.patch.scripts![kind]!.trim()} />}
    </Section>
  )
}

/** Settings > a project > Scripts (KERNEL-914): setup and archive edited in place, run scripts as rows, run mode, ports and preview URLs. The section id stays `setup`, so every link to it keeps working. */
export function ProjectSetup({ projectId }: { projectId?: string }) {
  const { project, rs } = useProjectPage(projectId)
  const found = useSuggestions(projectId)
  const appWait = useStore((x) => x.settings?.workspace.leadWaitForSetup)
  if (!project || !projectId) return <NoProject />
  const offerFor = (kind: ScriptKey) => found.find((s) => s.patch.scripts?.[kind]?.trim())
  const wait = rs?.workspace.leadWaitForSetup
  return (
    <ProjectPage project={project} rs={rs} title="Scripts" subtitle="Commands that run when workspaces are set up, run or archived.">
      <ScriptEditor projectId={projectId} kind="setup" rs={rs} offer={offerFor('setup')} />
      <Section label="Setup">
        <Row id="wait-for-setup" setting="workspace.leadWaitForSetup" label="Wait for setup before the first message" {...projectValue(rs, 'workspace.leadWaitForSetup', () => void patchProjectSettings(projectId, { workspace: { leadWaitForSetup: null } }), { to: { page: 'git' }, label: 'Settings, Git' })}>
          <Toggle label="Wait for setup before the first message" checked={wait ?? appWait ?? false} onChange={(v) => void patchProjectSettings(projectId, { workspace: { leadWaitForSetup: v } })} />
        </Row>
      </Section>
      <ScriptEditor projectId={projectId} kind="archive" rs={rs} offer={offerFor('archive')} />
      <RunScripts projectId={projectId} rs={rs} />
      <RunMode projectId={projectId} rs={rs} />
      <PreviewUrls projectId={projectId} rs={rs} />
    </ProjectPage>
  )
}
