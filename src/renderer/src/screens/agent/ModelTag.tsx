import { EFFORT_LABELS, type AgentDef } from '@shared/types'
import { ProviderMark } from '../../icons'
import { agentModelLabel, useProviderModels } from '../workspace/composer/providerModels'
import './agent.css'

/** The model an agent's file pins, as the composer's control names it: the provider's mark, the model and the effort. A file with no pin runs on its role's model. */
export function ModelTag({ agent }: { agent: Pick<AgentDef, 'name' | 'model' | 'effort' | 'provider'> }) {
  const provider = agent.provider === 'codex' ? 'codex' : 'claude'
  const models = useProviderModels(provider)
  return (
    <span className="rm-model" aria-label={`${agent.name} model and effort, ${agent.model ? agentModelLabel(agent.model, models) : 'Default'}${agent.effort ? `, ${EFFORT_LABELS[agent.effort]}` : ''}`}>
      <ProviderMark provider={provider} size={14} />
      <span className="rm-model-name">{agent.model ? agentModelLabel(agent.model, models) : 'Default'}</span>
      {agent.effort && <span className="rm-model-effort">{EFFORT_LABELS[agent.effort]}</span>}
    </span>
  )
}
