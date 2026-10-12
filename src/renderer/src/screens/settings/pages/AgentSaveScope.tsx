import { useState } from 'react'
import type { AgentDef, AgentScope } from '@shared/types'
import { Button, Modal } from '../../../ui'
import { formOf, slash, type AgentForm } from '../../agent/AgentEditor'
import { shortFile } from '../../team/model'

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five']

/** The file lines a save changes, as the dialog draws them: the old value, then the new one. Instructions are too long to show, so they are named. */
export function changedLines(agent: AgentDef, form: AgentForm): { old?: string; now?: string }[] {
  const was = formOf(agent)
  const text = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : v ?? '')
  const lines: { old?: string; now?: string }[] = []
  for (const key of ['description', 'model', 'effort', 'tools', 'skills'] as const) {
    const a = key === 'skills' ? was.skills.map(slash) : was[key]
    const b = key === 'skills' ? form.skills.map(slash) : key === 'description' ? form.description.trim() : form[key]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    lines.push({ ...(text(a) ? { old: `${key}: ${text(a)}` } : {}), ...(text(b) ? { now: `${key}: ${text(b)}` } : {}) })
  }
  if (was.prompt !== form.prompt) lines.push({ now: 'instructions: changed' })
  return lines
}

/**
 * AgentProfileScope.png: who gets a saved change to an agent in the repo's .claude/agents. It starts on Just for me, because For the
 * team opens a pull request on a repo others share, and the confirm button names the result (KERNEL-440). `onSave` returns when the
 * save is over, so the dialog shows it busy meanwhile.
 */
export function AgentSaveScope({ agent, form, busy, error, onCancel, onSave }: {
  agent: AgentDef; form: AgentForm; busy: boolean; error: string | null; onCancel: () => void; onSave: (scope: AgentScope) => void
}) {
  const [scope, setScope] = useState<AgentScope>('me')
  const lines = changedLines(agent, form)
  const file = shortFile(agent.file)
  const count = lines.reduce((n, l) => n + (l.old ? 1 : 0) + (l.now ? 1 : 0), 0)
  return (
    <Modal
      title={`Save changes to ${agent.name}`} onClose={onCancel} width={520} top={150}
      footer={<><span className="grow">{error && <span role="alert" className="del">{error}</span>}</span><Button variant="ghost" size="lg" disabled={busy} onClick={onCancel}>Cancel</Button><Button variant="primary" size="lg" busy={busy} busyLabel="Saving" onClick={() => onSave(scope)}>{scope === 'me' ? 'Save for me' : 'Open pull request'}</Button></>}
    >
      <div className="ae-scope">
        <p>{WORDS[Math.min(count, 5)] ?? count} {count === 1 ? 'line' : 'lines'} of {agent.name}’s file {count === 1 ? 'changes' : 'change'}.</p>
        <div className="ae-diff" aria-label={`Changes to ${file}`}>
          <span>{file}</span>
          {lines.flatMap((l, i) => [
            l.old && <span key={`${i}o`} className="del">- {l.old}</span>,
            l.now && <span key={`${i}n`} className="add">+ {l.now}</span>
          ])}
        </div>
        <fieldset className="ae-pick">
          <legend>Who gets this change?</legend>
          <label className="ae-opt">
            <input type="radio" name="scope" checked={scope === 'me'} onChange={() => setScope('me')} />
            <span>Just for me<small>Kernel keeps the change on this Mac. The repo’s {agent.id}.md stays as it is.</small></span>
          </label>
          <label className="ae-opt">
            <input type="radio" name="scope" checked={scope === 'team'} onChange={() => setScope('team')} />
            <span>For the team<small>Kernel opens a pull request that changes {file}. Everyone gets it once it merges.</small></span>
          </label>
        </fieldset>
      </div>
    </Modal>
  )
}
