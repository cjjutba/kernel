import { useState } from 'react'
import { call } from '../../api'
import { actions, getState, useStore } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { shortFile } from './model'
import './team.css'

/** ConfirmRetire.png. The file moves to .claude/retired-agents (D-003) and open workspaces go to the Lead. */
export function ConfirmRetire({ roomId, agentId }: { roomId: string; agentId: string }) {
  const agents = useStore((s) => s.agents[roomId])
  const open = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.agentId === agentId && w.status !== 'archived' && w.name !== 'lead').length)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const agent = agents?.find((a) => a.id === agentId)
  const lead = agents?.find((a) => a.lead && a.id !== agentId)
  if (!agent) return null

  const retire = () => run('retire', async () => {
    setError(null)
    try {
      await call('agents.retire', { roomId, agentId, handoffTo: lead?.id })
      actions.agents.set(roomId, (getState().agents[roomId] ?? []).filter((a) => a.id !== agentId))
      const route = getState().ui.route
      if (route.name === 'agent' && route.agentId === agentId) actions.ui.go({ name: 'team', roomId })
      else actions.ui.closeModal()
      actions.ui.toast({ title: `${agent.name} retired`, sub: 'The file is in .claude/retired-agents' })
    } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
  })
  const handoff = open === 0 ? 'No open workspaces' : `${open} open ${open === 1 ? 'workspace goes' : 'workspaces go'} to ${lead?.name ?? 'the Lead'}`

  return (
    <ConfirmDialog
      title={`Retire ${agent.name}?`} busy={!!busy} busyLabel="Retiring" confirmLabel={`Retire ${agent.name}`} onConfirm={() => void retire()} onCancel={actions.ui.closeModal}
      body={`${agent.name} finishes the current turn, then leaves the team and the workspace picker. The file moves to .claude/retired-agents so you can bring ${agent.name} back.`}
    >
      <div className="tm-box mono"><span>{shortFile(agent.file)}</span><span>{handoff}</span></div>
      {error && <p role="alert" style={{ color: 'var(--del)' }}>{error}</p>}
    </ConfirmDialog>
  )
}
