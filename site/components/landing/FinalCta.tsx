import { Button } from '@/components/ui/Button'
import { CtaBlock } from './CtaBlock'

export function FinalCta() {
  return (
    <section aria-labelledby="final-title" className="relative mt-40 overflow-hidden border-t border-line-faint py-32 text-center">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-dots-final" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-glow-final left-1/2 h-glow-final w-full max-w-glow-final -translate-x-1/2 glow-final"
      />
      <div className="relative z-raise px-6">
        <h2 id="final-title" className="text-display-sm">
          Put your agents to work.
        </h2>
        <CtaBlock
          lead="Install it, open a repo, and brief your lead. The team takes it from there."
          secondary={
            <Button href="/changelog" variant="secondary" size="lg">
              Release notes
            </Button>
          }
        />
      </div>
    </section>
  )
}
