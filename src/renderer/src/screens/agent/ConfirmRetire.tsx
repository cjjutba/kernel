import { useState } from 'react'
import { cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { ConfirmDialog, Icon, useBusy } from '../../ui'
import { AgentFile } from './AgentFile'
import { retireAgent } from './retireAgent'
import './agent.css'

/**
 * ConfirmRetire.png. The file moves to .claude/retired-agents (D-003) and open workspaces go to the Lead, or a reviewer's
 * reviews to whoever reviews next, Kernel's Theo when nobody else does (KERNEL-397).
 */
export function ConfirmRetire({ projectId, agentId }: { projectId: string; agentId: string }) {
  const agents = useStore((s) => s.agents[projectId])
  const open = useStore((s) => s.workspaces.filter((w) => w.projectId === projectId && w.agentId === agentId && w.status !== 'archived' && !w.lead).length)
  const reviews = useStore((s) => s.workspaces.filter((w) => w.projectId === projectId && w.agentId === agentId && w.status !== 'archived' && !!w.reviewOf).length)
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const agent = agents?.find((a) => a.id === agentId)
  const lead = agents?.find((a) => a.lead && a.id !== agentId)
  if (!agent) return null

  const retire = () => run('retire', async () => {
    setError(null)
    try {
      await retireAgent(projectId, agentId)
    } catch (e) { setError(cleanError(e)) }
  })
  const leadName = lead?.name ?? 'Kernel'
  const others = agent.reviewer ? open - reviews : open
  const chats = (n: number) => `${n} open ${n === 1 ? 'chat' : 'chats'}`
  const moves = [
    agent.reviewer && reviews ? `${chats(reviews)} ${reviews === 1 ? 'is a review that goes' : 'are reviews that go'} to the next reviewer` : '',
    others ? `${chats(others)} ${others === 1 ? 'moves' : 'move'} to ${leadName}` : ''
  ].filter(Boolean)

  return (
    <ConfirmDialog
      title={`Retire ${agent.name}?`} danger busy={!!busy} busyPattern="ripple" busyLabel="Retiring" confirmLabel={`Retire ${agent.name}`} onConfirm={() => void retire()} onCancel={actions.ui.closeModal}
      body={`${agent.name} finishes the current turn, then leaves the team. The file moves to .claude/retired-agents, so you can bring ${agent.name} back.`}
    >
      <div className="rt-box">
        <div className="rt-row"><AgentFile file={agent.file} /><span className="rt-where">Moves to .claude/retired-agents</span></div>
        {moves.length === 0
          ? <div className="rt-row rt-chat"><Icon name="chat" size={14} />No open chats</div>
          : moves.map((m) => <div key={m} className="rt-row rt-chat"><Icon name="chat" size={14} />{m}</div>)}
      </div>
      {error && <p role="alert" className="del">{error}</p>}
    </ConfirmDialog>
  )
}
