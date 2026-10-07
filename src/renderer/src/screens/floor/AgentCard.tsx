import type { AgentDef, AgentStatus } from '@shared/types'
import { Icon } from '../../ui'
import { go, useStore } from '../../store'
import { ART, LOOKS, WORD, cap, modelLabel } from '../../floor/layout'

/** The selected agent: name, role and model, status with its workspace, what they are doing now, and a way into the workspace. `status` is what the floor shows. */
export function AgentCard({ agent, roomId, agents, status }: { agent: AgentDef; roomId: string; agents: AgentDef[]; status: AgentStatus }) {
  const saying = useStore((s) => s.saying[agent.id])
  const ws = useStore((s) => s.workspaces.find((w) => w.roomId === roomId && w.agentId === agent.id && w.status !== 'archived'))
  const shirt = (agent.look ?? LOOKS[Math.max(0, agents.indexOf(agent)) % LOOKS.length]).shirt
  const model = modelLabel(agent.model)
  const now = saying ?? (status === 'idle' ? 'No active task' : cap(WORD[status]))
  return (
    <section className="agent-card" aria-label={`${agent.name}, selected`}>
      <div className="row" style={{ gap: 10 }}>
        <span aria-hidden="true" className="agent-dot" style={{ background: shirt, color: ART.onShirt }}>{agent.name[0]}</span>
        <span className="col grow"><span className="agent-name">{agent.name}</span><span className="muted" style={{ fontSize: 12 }}>{agent.role}{model ? ` · ${model}` : ''}</span></span>
      </div>
      <span className="agent-status" data-loud={status === 'needs' || status === 'blocked' ? 'true' : undefined}>
        {cap(WORD[status])}
        {ws && <><span className="faint">·</span><span className="mono muted">{ws.mode === 'current' ? `${ws.branch} checkout` : ws.name}</span></>}
      </span>
      <span className="ink2">{now}</span>
      {ws && <button type="button" className="btn agent-open" onClick={() => go({ name: 'workspace', workspaceId: ws.id })}>Open workspace<Icon name="right" size={12} stroke={1.6} /></button>}
    </section>
  )
}
