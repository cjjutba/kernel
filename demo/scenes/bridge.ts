// window.kernel for a scene: the scene's own handlers first, then the fixture handlers. `?scene=<name>` picks the scene,
// and window.__scene.step(name) runs one of its steps, so the recorder can move the story on where no click would.
import { fixtureHandlers, fixturePush } from '../../src/main/fixtures'
import { bus } from '../../src/main/bus'
import { previewFixture } from '../previewFixture'
import { SCENES } from './scenes'
import type { PushEvent } from '@shared/ipc'

type Handler = (req: unknown) => Promise<unknown>
const ok = { ok: true } as const
const name = new URLSearchParams(location.search).get('scene') ?? 'team'
const make = SCENES[name]
if (!make) throw new Error(`No scene named ${name}`)
const scene = make()
const f = scene.fixture
const answers = (scene.answers ?? fixtureHandlers(f)) as unknown as Record<string, Handler>
const own = (scene.handlers ?? {}) as Record<string, Handler>
const system: Record<string, Handler> = {
  ...(previewFixture(f) as unknown as Record<string, Handler>),
  'system.fixture': async () => ({ ui: f.ui, push: fixturePush(f) }),
  'system.pickFolder': async () => null,
  'system.pickImage': async () => null,
  'system.openInEditor': async () => ok,
  'system.openExternal': async () => ok
}

const copy = <T>(v: T): T => { try { return structuredClone(v) } catch { return v } }
const listeners = new Set<(e: PushEvent) => void>()
bus.on('push', (e) => { const c = copy(e as PushEvent); listeners.forEach((l) => l(c)) })

;(window as unknown as { kernel: unknown }).kernel = {
  async invoke(channel: string, req: unknown) {
    const fn = own[channel] ?? system[channel] ?? answers[channel]
    if (!fn) return null
    return copy(await fn(copy(req)))
  },
  on(listener: (e: PushEvent) => void) { listeners.add(listener); return () => listeners.delete(listener) },
  appearance: undefined
}
;(window as unknown as { __scene: unknown }).__scene = {
  step: (key: string) => {
    const fn = scene.steps?.[key]
    if (!fn) throw new Error(`Scene ${name} has no step ${key}`)
    fn()
  }
}
