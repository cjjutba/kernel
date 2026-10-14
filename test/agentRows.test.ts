import { describe, expect, it } from 'vitest'
import { agentGroup, agentLabel, agentSource, cleanDescription } from '../src/renderer/src/screens/settings/pages/agentRows'

describe('agent rows', () => {
  it('drops the role when it repeats the name', () => {
    expect(agentLabel({ name: 'Ai Architect', role: 'ai architect' })).toBe('Ai Architect')
    expect(agentLabel({ name: 'Kai', role: 'Frontend' })).toBe('Kai · Frontend')
  })
  it('names the real source of each agent', () => {
    expect(agentSource({ id: 'kai' })).toBe('.claude/agents/kai.md')
    expect(agentSource({ id: 'ops', origin: 'personal' })).toBe('~/.claude/agents/ops.md')
    expect(agentSource({ id: 'vercel:ai-architect', origin: 'plugin' })).toBe('From the vercel plugin')
    expect(agentSource({ id: 'kernel', builtIn: 'lead' })).toBe('Built into Kernel')
    expect(agentGroup({ builtIn: 'reviewer', origin: 'plugin' })).toBe('repo')
  })
  it('strips example and commentary blocks and collapses whitespace', () => {
    expect(cleanDescription('Design  AI.\n<example>\nuser: hi\n</example> <commentary>why</commentary>\nDone.')).toBe('Design AI. Done.')
  })
})
