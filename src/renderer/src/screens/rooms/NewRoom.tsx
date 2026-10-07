import { useId, useLayoutEffect, useState } from 'react'
import type { NewRoomPrefill, RoomKind } from '@shared/types'
import { call } from '../../api'
import { actions, go } from '../../store'
import { Button, Icon, Modal, Toggle, type IconName } from '../../ui'
import { patchDraft, resetDraft, STARTER_TEAM, tilde, useDraft } from './draft'
import './rooms.css'

const SOURCES: { id: RoomKind; icon: IconName; title: string; sub: string }[] = [
  { id: 'repo', icon: 'branch', title: 'GitHub repo', sub: 'Clone it and work on branches' },
  { id: 'folder', icon: 'folder', title: 'Local folder', sub: 'Use a project already on your Mac' },
  { id: 'scratch', icon: 'burst', title: 'From scratch', sub: 'Start from your starter kit' }
]

/** NewRoom.png: name it, pick where it comes from, pick the team, create. Connect a repo and Open a folder fill the source. */
export function NewRoom({ prefill }: { prefill?: NewRoomPrefill }) {
  useLayoutEffect(() => { if (prefill) resetDraft({ ...prefill, desc: prefill.desc ?? '', baseBranch: prefill.baseBranch ?? '', named: true }) }, [])
  const d = useDraft()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()

  const close = actions.ui.closeModal
  const ready = d.name.trim() !== '' && d.from.trim() !== ''
  const change = () => actions.ui.openModal({ name: d.source === 'repo' ? 'connectRepo' : 'openFolder' })
  const toggle = (member: string) => patchDraft({ team: d.team.includes(member) ? d.team.filter((m) => m !== member) : [...d.team, member] })

  const create = async () => {
    setBusy(true); setError(null)
    try {
      const room = await call('rooms.create', {
        source: d.source, name: d.name.trim(), desc: d.desc.trim() || undefined, from: d.from.trim(), baseBranch: d.baseBranch.trim() || undefined,
        team: d.team, autostart: d.autostart, cloneTo: d.source === 'folder' ? undefined : d.cloneTo, initGit: d.initGit
      })
      actions.rooms.upsert(room)
      go({ name: 'onboarding', step: 'room', roomId: room.id })
    } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); setBusy(false) }
  }

  const field = d.source === 'repo'
    ? { label: 'Repository', value: d.from || 'Choose a repository', action: 'Change' }
    : d.source === 'folder'
      ? { label: 'Folder', value: d.from ? tilde(d.from) : 'Choose a folder', action: 'Change' }
      : { label: 'Starter kit', value: d.from || 'starter-kit', action: '' }

  return (
    <Modal
      title="New room" onClose={close} bare width={640} top={92}
      footer={
        <>
          <Toggle checked={d.autostart} onChange={(v) => patchDraft({ autostart: v })} label="Brief Rowan right away" />
          <span className="grow" style={{ fontSize: 13, color: 'var(--ink-2)' }}>
            {error ? <span role="alert" className="del">{error}</span> : 'Brief Rowan right away'}
          </span>
          <Button variant="ghost" size="lg" onClick={close}>Cancel</Button>
          <Button variant="primary" size="lg" disabled={!ready || busy} onClick={() => void create()}>Create room</Button>
        </>
      }
    >
      <div className="nr-crumbs">
        <span className="nr-crumb">Rooms</span>
        <Icon name="right" size={12} />
        <span>New room</span>
        <span className="grow" />
        <button type="button" data-close className="icon-btn" aria-label="Close" onClick={close}><Icon name="close" /></button>
      </div>
      <div className="nr-body">
        <div className="col" style={{ gap: 6 }}>
          <label htmlFor={`${id}n`} className="sr-only">Room name</label>
          <input id={`${id}n`} className="nr-name" autoComplete="off" placeholder="Room name" value={d.name} onChange={(e) => patchDraft({ name: e.target.value, named: true })} />
          <label htmlFor={`${id}d`} className="sr-only">What this room builds</label>
          <input id={`${id}d`} className="nr-desc" autoComplete="off" placeholder="What should this room build?" value={d.desc} onChange={(e) => patchDraft({ desc: e.target.value })} />
        </div>

        <div className="col" style={{ gap: 8 }}>
          <p className="nr-label">Start from</p>
          <div role="radiogroup" aria-label="Start from" className="nr-sources">
            {SOURCES.map((s) => (
              <button
                key={s.id} type="button" role="radio" aria-checked={d.source === s.id} className="nr-source"
                onClick={() => patchDraft({ source: s.id, from: s.id === d.source ? d.from : '', baseBranch: '', initGit: false, cloneTo: undefined })}
              >
                <Icon name={s.icon} size={16} />
                <span className="col" style={{ gap: 2 }}><span className="nr-source-title">{s.title}</span><span className="nr-source-sub">{s.sub}</span></span>
                {d.source === s.id && <span className="nr-tick" aria-hidden="true"><Icon name="check" size={10} stroke={2} /></span>}
              </button>
            ))}
          </div>
        </div>

        <div className="nr-fields">
          <div className="col" style={{ gap: 6 }}>
            <span className="nr-label">{field.label}</span>
            <div className="nr-field">
              {d.source === 'scratch'
                ? <input aria-label="Starter kit repository" className="nr-field-input mono" placeholder="starter-kit" value={d.from} onChange={(e) => patchDraft({ from: e.target.value })} />
                : <span className="nr-field-value mono">{field.value}</span>}
              {field.action && <button type="button" className="nr-change" onClick={change}>{field.action}</button>}
            </div>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <label htmlFor={`${id}b`} className="nr-label">Base branch</label>
            <input id={`${id}b`} className="nr-field mono nr-branch" autoComplete="off" value={d.baseBranch} placeholder={d.source === 'folder' ? 'Current branch' : 'Detected after clone'} onChange={(e) => patchDraft({ baseBranch: e.target.value })} />
          </div>
        </div>

        <div className="col" style={{ gap: 8 }}>
          <p className="nr-label">Team <span style={{ fontWeight: 400 }}>from .claude/agents</span></p>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {STARTER_TEAM.map((m) => {
              const on = d.team.includes(m.id) || m.id === 'rowan'
              return (
                <button key={m.id} type="button" className="nr-member" aria-pressed={on} disabled={m.id === 'rowan'} onClick={() => toggle(m.id)}>
                  <span className="nr-av" aria-hidden="true">{m.name[0]}</span>{m.name}<span className="mono nr-role">{m.role}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}

