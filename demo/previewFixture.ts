// previewHost.ts imports Electron, so the spike carries a copy of its previewFixture (src/main/previewHost.ts).
import type { Fixture } from '../fixtures'
import type { SharedAnchor } from '@shared/types'

const ok = { ok: true } as const
type Rect = { x: number; y: number; width: number; height: number }

export function previewFixture(f: Fixture) {
  return {
    'system.preview.open': async ({ sharedId, version }: { sharedId: string; version: number }) => {
      const d = f.sharedData?.[sharedId]?.[version]
      return { viewId: null, still: d?.still ?? d?.thumb ?? null }
    },
    'system.preview.place': async () => ok,
    'system.preview.still': async () => null,
    'system.preview.reload': async () => ok,
    'system.preview.focus': async () => ok,
    'system.preview.close': async () => ok,
    'system.preview.hit': async ({ x, y }: { x: number; y: number }) => {
      const inside = (f.sharedHits ?? []).filter((a) => a.element && x >= a.element.rect.x && x <= a.element.rect.x + a.element.rect.width && y >= a.element.rect.y && y <= a.element.rect.y + a.element.rect.height)
      const area = (a: SharedAnchor) => (a.element?.rect.width ?? 0) * (a.element?.rect.height ?? 0)
      return inside.sort((a, b) => area(a) - area(b))[0] ?? null
    },
    'system.preview.crop': async () => null,
    'system.preview.scroll': async () => null,
    'system.preview.locate': async ({ selectors }: { selectors: string[] }) => selectors.map((): Rect | null => null)
  }
}
