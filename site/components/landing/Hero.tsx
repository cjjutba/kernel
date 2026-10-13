import leadPlan from '@/public/images/lead-plan.png'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ArrowIcon, GitHubIcon } from '@/components/ui/icons'
import { OutlineChip } from '@/components/ui/OutlineChip'
import { Shot } from '@/components/ui/Shot'
import { REPO_URL } from '@/lib/links'
import { CtaBlock } from './CtaBlock'

/** `version` is the newest release's label, such as "0.1". */
export function Hero({ version }: { version: string }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative pt-32 text-center">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-dots-hero bg-dots-hero" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-glow-hero left-1/2 h-glow-hero w-full max-w-glow-hero -translate-x-1/2 glow-hero"
      />
      <div className="relative px-6">
        <OutlineChip
          href="/changelog"
          className="shimmer-pill inline-flex h-8 items-center gap-2 rounded-pill bg-surface-2-glass pr-3 pl-1 text-small text-ink-2 hover:text-white"
        >
          <Badge>New</Badge>
          Kernel {version} is here
          <ArrowIcon className="text-muted" />
        </OutlineChip>
        <h1 id="hero-title" className="mt-8 text-display">
          Your coding agents,
          <br />
          working as a team.
        </h1>
        <CtaBlock
          lead="Brief a lead, approve the plan, and watch agents build in parallel, each in its own workspace, until a pull request is ready for you to merge."
          secondary={
            <Button href={REPO_URL} variant="secondary" size="lg" external icon={<GitHubIcon />}>
              View on GitHub
            </Button>
          }
        />
      </div>
      <div className="relative mt-16 px-6">
        <Shot
          src={leadPlan}
          alt="Kernel: Rowan's plan for four tasks waits for review, with the room's team and workspaces in the sidebar"
          sizes="(max-width: 1328px) calc(100vw - 48px), 1280px"
          preload
          className="mx-auto max-w-hero-shot"
        />
      </div>
    </section>
  )
}
