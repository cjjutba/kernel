import { useState } from 'react'
import { cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { ConfirmDialog, useBusy } from '../../ui'
import { retireAgent } from './retireAgent'
import { shortFile } from './model'
import './agent.css'

/**
 * ConfirmRetire.png. The file moves to .claude/retired-agents (D-003) and open workspaces go to the Lead, or a reviewer's
 * reviews to whoever reviews next, Kernel's Theo when nobody else does (KERNEL-397).
 */
export function ConfirmRetire({ roomId, agentId }: { roomId: string; agentId: string }) {
  const agents = useStore((s) => s.agents[roomId])
  const open = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.agentId === agentId && w.status !== 'archived' && !w.lead).length)
  const reviews = useStore((s) => s.workspaces.filter((w) => w.roomId === roomId && w.agentId === agentId && w.status !== 'archived' && !!w.reviewOf).length)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const agent = agents?.find((a) => a.id === agentId)
  const lead = agents?.find((a) => a.lead && a.id !== agentId)
  if (!agent) return null

  const retire = () => run('retire', async () => {
    setError(null)
    try {
      await retireAgent(roomId, agentId)
    } catch (e) { setError(cleanError(e)) }
  })
  const leadName = lead?.name ?? 'the Lead'
  const others = agent.reviewer ? open - reviews : open
  const handoff = open === 0 ? 'No open workspaces' : [
    agent.reviewer && reviews ? `${reviews} open ${reviews === 1 ? 'review goes' : 'reviews go'} to the next reviewer` : '',
    others ? `${others} open ${others === 1 ? 'workspace goes' : 'workspaces go'} to ${leadName}` : ''
  ].filter(Boolean).join(', ')

  return (
    <ConfirmDialog
      title={`Retire ${agent.name}?`} busy={!!busy} busyLabel="Retiring" confirmLabel={`Retire ${agent.name}`} onConfirm={() => void retire()} onCancel={actions.ui.closeModal}
      body={`${agent.name} finishes the current turn, then leaves the team and the workspace picker. The file moves to .claude/retired-agents so you can bring ${agent.name} back.`}
    >
      <div className="tm-box mono"><span>{shortFile(agent.file)}</span><span>{handoff}</span></div>
      {error && <p role="alert" className="confirm-error">{error}</p>}
    </ConfirmDialog>
  )
}
