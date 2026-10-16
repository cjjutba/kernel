import { describe, expect, it } from 'vitest'
import type { AgentDef, AppSettings, ProviderModel } from '@shared/types'
import { defaultEffortOf, nextEffort } from '../src/renderer/src/screens/workspace/composer/modelPrefs'
import { SHORTCUT_MAX, isCycleEffortKey, shortcutModel, shortcutModels, shortcutNumber } from '../src/renderer/src/screens/workspace/composer/modelShortcuts'

const m = (provider: ProviderModel['provider'], id: string, legacy = false): ProviderModel => ({ provider, id, label: id, legacy, efforts: ['medium'], defaultEffort: 'medium' })
const claude = [m('claude', 'fable'), m('claude', 'opus'), m('claude', 'sonnet'), m('claude', 'haiku'), m('claude', 'old-opus', true)]
const codex = [m('codex', 'gpt-a'), m('codex', 'gpt-b'), m('codex', 'gpt-old', true), m('codex', 'gpt-c')]

describe('model shortcuts', () => {
  it('count a provider\'s current models in order and skip legacy ones', () => {
    expect(shortcutModels(claude).map((x) => x.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(shortcutModels(codex).map((x) => x.id)).toEqual(['gpt-a', 'gpt-b', 'gpt-c'])
  })

  it('pick the Nth model for Claude and for Codex', () => {
    expect(shortcutModel('2', claude)?.id).toBe('opus')
    expect(shortcutModel('3', codex)?.id).toBe('gpt-c')
  })

  it('pick nothing past the last current model, or for a key that is not 1 to 9', () => {
    expect(shortcutModel('5', claude)).toBeUndefined()
    expect(shortcutModel('4', codex)).toBeUndefined()
    expect(shortcutModel('0', claude)).toBeUndefined()
    expect(shortcutModel('a', claude)).toBeUndefined()
  })

  it('stop at nine models', () => {
    const many = Array.from({ length: 12 }, (_, i) => m('codex', `g${i}`))
    expect(shortcutModels(many)).toHaveLength(SHORTCUT_MAX)
    expect(shortcutModel('9', many)?.id).toBe('g8')
  })

  it('give a row a hint only when its key works', () => {
    expect(shortcutNumber(claude[1], 'claude', claude)).toBe(2)
    // Legacy, and the other provider's models: no key picks them.
    expect(shortcutNumber(claude[4], 'claude', claude)).toBeUndefined()
    expect(shortcutNumber(codex[0], 'claude', claude)).toBeUndefined()
    expect(shortcutNumber(claude[0], 'codex', codex)).toBeUndefined()
    // Codex's hints skip its legacy model: gpt-c is third.
    expect(shortcutNumber(codex[3], 'codex', codex)).toBe(3)
    expect(shortcutNumber(codex[2], 'codex', codex)).toBeUndefined()
  })

  it('agree: every hint is the key that picks that row', () => {
    for (const [provider, list] of [['claude', claude], ['codex', codex]] as const) {
      for (const row of list) {
        const n = shortcutNumber(row, provider, list)
        if (n) expect(shortcutModel(String(n), list)?.id).toBe(row.id)
      }
    }
  })
})

describe('cycle effort', () => {
  const key = (o: Partial<Parameters<typeof isCycleEffortKey>[0]>) => ({ key: '?', code: 'Slash', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, ...o })

  it('answers Cmd+Shift+/ however the layout names the key', () => {
    expect(isCycleEffortKey(key({}))).toBe(true)
    expect(isCycleEffortKey(key({ key: '/' }))).toBe(true)
    expect(isCycleEffortKey(key({ key: '-', code: 'Slash' }))).toBe(true)
  })

  it('leaves other chords alone', () => {
    expect(isCycleEffortKey(key({ shiftKey: false }))).toBe(false)
    expect(isCycleEffortKey(key({ metaKey: false }))).toBe(false)
    expect(isCycleEffortKey(key({ ctrlKey: true }))).toBe(false)
    expect(isCycleEffortKey(key({ altKey: true }))).toBe(false)
    expect(isCycleEffortKey(key({ key: 'a', code: 'KeyA' }))).toBe(false)
  })

  it("steps through a model's levels and wraps to the first", () => {
    expect(nextEffort('low')).toBe('medium')
    expect(nextEffort('xhigh')).toBe('low')
    expect(nextEffort('xhigh', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max')
    expect(nextEffort('max', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('low')
  })
})

describe('the effort a model with none remembered falls back to (KERNEL-974)', () => {
  const row = (effort: string) => ({ provider: 'claude', model: 'claude-sonnet-5-5', effort })
  const models = { roles: { lead: row('max'), frontend: row('low'), engineers: row('high'), qa: row('medium'), reviewer: row('xhigh') } } as unknown as AppSettings['models']
  const agent = (o: Partial<AgentDef>) => ({ id: 'a', name: 'A', role: '', description: '', prompt: '', file: '', ...o }) as AgentDef

  it("reads the row of the agent's own role, so a frontend agent gets Frontend's and a backend one Backend's", () => {
    expect(defaultEffortOf(agent({ role: 'Frontend engineer' }), models)).toBe('low')
    expect(defaultEffortOf(agent({ role: 'Backend engineer' }), models)).toBe('high')
    expect(defaultEffortOf(agent({ role: 'QA' }), models)).toBe('medium')
    expect(defaultEffortOf(agent({ lead: true }), models)).toBe('max')
  })

  it("keeps the agent file's own effort, and reads Backend's for a chat with no agent", () => {
    expect(defaultEffortOf(agent({ role: 'Frontend engineer', effort: 'xhigh' }), models)).toBe('xhigh')
    expect(defaultEffortOf(undefined, models)).toBe('high')
    expect(defaultEffortOf(undefined, undefined)).toBe('high')
  })
})
