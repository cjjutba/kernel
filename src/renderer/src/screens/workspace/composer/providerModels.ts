import { useEffect, useState } from 'react'
import { EFFORT_LABELS, EFFORTS, MODELS, PROVIDERS, type Effort, type Provider, type ProviderModel } from '@shared/types'
import { call } from '../../../api'
import { useStore } from '../../../store'

// Each provider's models for the pickers (KERNEL-406). Claude's are Kernel's own list, so they show at once. Codex's come
// from its model/list, read once per launch in main and once per window here.

const CLAUDE: ProviderModel[] = MODELS.map((m) => ({ provider: 'claude', id: m.id, label: m.label, efforts: EFFORTS.map((e) => e.id), defaultEffort: 'high' }))
const cache = new Map<Provider, Promise<ProviderModel[]>>()

/** A provider's models. Codex's arrive after a read, and the list is empty until then, or when Codex can't be read. */
export function useProviderModels(provider: Provider): ProviderModel[] {
  const [models, setModels] = useState<ProviderModel[]>(provider === 'claude' ? CLAUDE : [])
  useEffect(() => {
    if (provider === 'claude') { setModels(CLAUDE); return }
    let live = true
    if (!cache.has(provider)) cache.set(provider, call('models.list', { provider }).catch((e) => { cache.delete(provider); throw e }))
    void cache.get(provider)!.then((m) => { if (live) setModels(m) }, () => undefined)
    return () => { live = false }
  }, [provider])
  return models
}

// Whether Codex is signed in, read once per window like the model list. Settings, Providers feeds every status it reads
// into `noteCodexStatus`, so a sign-in or sign-out shows the next time a picker mounts. A failed read isn't kept.
let codexSignedIn: Promise<boolean> | null = null

export const noteCodexStatus = (signedIn: boolean) => { codexSignedIn = Promise.resolve(signedIn) }

function useCodexSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    let live = true
    if (!codexSignedIn) {
      const read: Promise<boolean> = call('providers.status', { provider: 'codex' }).then((s) => s.signedIn, () => { if (codexSignedIn === read) codexSignedIn = null; return false })
      codexSignedIn = read
    }
    void codexSignedIn.then((v) => { if (live) setSignedIn(v) })
    return () => { live = false }
  }, [])
  return signedIn
}

/**
 * Codex is in use: it is signed in, a role runs on it, or this chat does. Only then do the pickers group models by provider,
 * so a setup without Codex sees the picker it always had (KERNEL-406, KERNEL-649).
 */
export function useCodexInUse(chatProvider?: Provider): boolean {
  const signedIn = useCodexSignedIn()
  const configured = useStore((s) => chatProvider === 'codex' || Object.values(s.settings?.models.roles ?? {}).some((r) => r.provider === 'codex'))
  return signedIn || configured
}

export const providerLabel = (p: Provider) => PROVIDERS.find((x) => x.id === p)?.label ?? p

/** A model's name: Claude's from MODELS, Codex's from its list, else the id as written. */
export const modelLabelOf = (id: string, models: ProviderModel[] = []) => models.find((m) => m.id === id)?.label ?? MODELS.find((m) => m.id === id)?.label ?? id

/** The efforts a model takes: its own list, else Claude's four. */
export const effortsOf = (model: string, models: ProviderModel[]): Effort[] => models.find((m) => m.id === model)?.efforts ?? EFFORTS.map((e) => e.id)

/** An effort the model takes: `effort` when it can, else the model's default, else the closest one below. */
export function fitEffort(effort: Effort, model: string, models: ProviderModel[]): Effort {
  const list = effortsOf(model, models)
  if (list.includes(effort)) return effort
  const m = models.find((x) => x.id === model)
  if (m && list.includes(m.defaultEffort)) return m.defaultEffort
  const order = Object.keys(EFFORT_LABELS) as Effort[]
  return [...list].reverse().find((e) => order.indexOf(e) <= order.indexOf(effort)) ?? list[0] ?? effort
}
