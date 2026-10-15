// The two providers Kernel's agents run on, floating beside the hero's headline: Claude's mark in Claude's orange and
// OpenAI's in white, the only colors OpenAI allows for it. The paths are the ones the app draws (src/renderer/src/icons.tsx).
// Decorative: the hero's text says what Kernel is, and these only show who it works with.

import { CLAUDE, OPENAI } from '@/components/brand/logos'

function Tile({ path, fill, className }: { path: string; fill: string; className: string }) {
  return (
    <div className={`provider-tile absolute flex size-22 items-center justify-center rounded-frame border border-edge ${className}`}>
      <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true" className={fill}>
        <path d={path} fill="currentColor" />
      </svg>
    </div>
  )
}

export function ProviderTiles() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-130 max-w-312 max-docs:hidden">
      <Tile path={CLAUDE} fill="text-claude" className="top-44 left-10 -rotate-8 float-a" />
      <Tile path={OPENAI} fill="text-ink" className="top-62 right-10 rotate-7 float-b" />
    </div>
  )
}
