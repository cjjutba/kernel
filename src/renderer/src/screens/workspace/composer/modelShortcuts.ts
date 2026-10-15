import type { Provider, ProviderModel } from '@shared/types'

/** ^⌘1 to 9 reach this many models. ⌘1 to 9 alone switch chats, so the keys carry Control too. */
export const SHORTCUT_MAX = 9

/** The models ^⌘1, ^⌘2 and so on pick, in the order the picker lists them: a provider's current models, never its legacy ones. */
export const shortcutModels = (models: ProviderModel[]): ProviderModel[] => models.filter((m) => !m.legacy).slice(0, SHORTCUT_MAX)

/** The number a model's ^⌘ hint shows, or undefined when no key picks it: another provider's model, or a legacy one. */
export function shortcutNumber(model: { id: string; provider: Provider }, provider: Provider, models: ProviderModel[]): number | undefined {
  if (model.provider !== provider) return undefined
  const i = shortcutModels(models).findIndex((m) => m.id === model.id)
  return i < 0 ? undefined : i + 1
}

/** The model a key picks in a chat on `provider`: the key's number counts that provider's current models. */
export function shortcutModel(key: string, models: ProviderModel[]): ProviderModel | undefined {
  return /^[1-9]$/.test(key) ? shortcutModels(models)[Number(key) - 1] : undefined
}

/**
 * ⌘⇧/ cycles the effort. With Shift held the slash key reports '?', and another layout puts '/' elsewhere, so the physical key counts too.
 * Both boxes listen on the window (useModelKeys) and the open picker on itself, and all three ask here.
 */
export const isCycleEffortKey = (e: { key: string; code?: string; metaKey: boolean; shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean =>
  e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.code === 'Slash' || e.key === '/' || e.key === '?')
