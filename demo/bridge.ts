// Plays the preload's part: installs window.kernel before the renderer boots. Calls go to the story first (demo/story.ts),
// then to the fixture handlers `KERNEL_FIXTURES=<Screen> pnpm dev` uses, so every read the UI makes has an answer.
import { fixturePush } from '../src/main/fixtures'
import { bus } from '../src/main/bus'
import { previewFixture } from './previewFixture'
import { f, fixtureAnswers, storyHandlers } from './story'
import type { PushEvent } from '@shared/ipc'

type Handler = (req: unknown) => Promise<unknown>
const ok = { ok: true } as const
const system: Record<string, Handler> = {
  ...(previewFixture(f) as unknown as Record<string, Handler>),
  'system.fixture': async () => ({ ui: f.ui, push: fixturePush(f) }),
  'system.pickFolder': async () => null,
  'system.pickImage': async () => null,
  'system.openInEditor': async () => ok,
  'system.openExternal': async (req) => {
    const url = (req as { url: string }).url
    if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener')
    return ok
  }
}
const story = storyHandlers as unknown as Record<string, Handler>

// Electron's IPC copies every value both ways. structuredClone does the same, so the UI never holds the fixture's own objects.
const copy = <T>(v: T): T => { try { return structuredClone(v) } catch { return v } }

const listeners = new Set<(e: PushEvent) => void>()
bus.on('push', (e) => { const c = copy(e as PushEvent); listeners.forEach((l) => l(c)) })

;(window as unknown as { kernel: unknown }).kernel = {
  async invoke(channel: string, req: unknown) {
    const fn = story[channel] ?? system[channel] ?? fixtureAnswers[channel]
    if (!fn) return null
    return copy(await fn(copy(req)))
  },
  on(listener: (e: PushEvent) => void) { listeners.add(listener); return () => listeners.delete(listener) },
  appearance: undefined
}
