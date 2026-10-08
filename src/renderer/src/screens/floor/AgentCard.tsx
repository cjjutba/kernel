import type { AgentDef, AgentStatus } from '@shared/types'
import { Icon } from '../../ui'
import { go, useStore } from '../../store'
import { openLead } from '../../lead'
import { ART, WORD, cap, lookFor, modelLabel } from '../../floor/layout'

/** The selected agent's popover: name, role and model, status with its workspace, what they are doing now, and a way into the workspace. `status` is what the floor shows. */
export function AgentCard({ agent, roomId, agents, status, note }: { agent: AgentDef; roomId: string; agents: AgentDef[]; status: AgentStatus; /** What they are doing, when the floor knows better than their last status line (a chat with the user, a new hire). */ note?: string }) {
  const saying = useStore((s) => s.saying[agent.id])
  const ws = useStore((s) => s.workspaces.find((w) => w.roomId === roomId && w.agentId === agent.id && w.status !== 'archived'))
  const shirt = lookFor(agent, Math.max(0, agents.indexOf(agent))).shirt
  const model = modelLabel(agent.model)
  const where = ws ? (ws.mode === 'current' ? `${ws.branch} checkout` : ws.name) : 'none'
  const now = note ?? saying ?? (status === 'idle' ? 'No active task' : cap(WORD[status]))
  return (
    <section className="agent-card" aria-label={`${agent.name}, selected`}>
      <div className="row" style={{ gap: 10 }}>
        <span aria-hidden="true" className="agent-dot" style={{ background: shirt, color: ART.onShirt }}>{agent.name[0]}</span>
        <span className="col grow"><span className="agent-name">{agent.name}</span><span className="muted" style={{ fontSize: 12 }}>{agent.role}{model ? ` · ${model}` : ''}</span></span>
      </div>
      <span className="agent-status" data-loud={status === 'needs' || status === 'blocked' ? 'true' : undefined}>
        <span>{cap(WORD[status])}</span>
        <span className="faint">·</span><span className="mono muted agent-ws" title={where}>{where}</span>
      </span>
      <span className="ink2">{now}</span>
      {/* Before the first brief the Lead has no workspace yet; opening its chat makes one. */}
      <button type="button" className="btn agent-open" onClick={() => (ws ? go({ name: 'workspace', workspaceId: ws.id }) : agent.lead ? void openLead(roomId) : go({ name: 'team', roomId }))}>{ws ? 'Open workspace' : agent.lead ? 'Open chat' : 'Open team'}<Icon name="right" size={12} stroke={1.6} /></button>
    </section>
  )
}
