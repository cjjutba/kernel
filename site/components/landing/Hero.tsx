import Link from 'next/link'
import floor from '@/public/images/floor.png'
import { Button } from '@/components/ui/Button'
import { ArrowIcon, DownloadIcon, GitHubIcon } from '@/components/ui/icons'
import { Shot } from '@/components/ui/Shot'
import { DOWNLOAD_URL, REPO_URL } from '@/lib/links'

/** `version` is the newest release's label, such as "0.1". */
export function Hero({ version }: { version: string }) {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative pt-32 text-center">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-245 bg-dots-hero" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-150 left-1/2 h-140 w-full max-w-300 -translate-x-1/2 glow-hero"
      />
      <div className="relative px-6">
        <Link
          href="/changelog"
          className="inline-flex h-8 items-center gap-2 rounded-pill border border-line-strong bg-surface-2/85 pr-3 pl-1 text-small text-ink-2 hover:border-edge-hover hover:text-white"
        >
          <span className="inline-flex h-6 items-center rounded-pill bg-ink px-2 text-tag font-semibold text-canvas">New</span>
          Kernel {version} is here
          <ArrowIcon className="text-muted" />
        </Link>
        <h1 id="hero-title" className="mt-8 text-display">
          Your coding agents,
          <br />
          working as a team.
        </h1>
        <p className="mx-auto mt-6 max-w-150 text-hero-lead text-balance text-muted">
          Brief a lead, approve the plan, and watch agents build in parallel, each in its own workspace, on an office
          floor you can actually see.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Button href={DOWNLOAD_URL} size="lg" icon={<DownloadIcon />}>
            Download for macOS
          </Button>
          <Button href={REPO_URL} variant="secondary" size="lg" external icon={<GitHubIcon />}>
            View on GitHub
          </Button>
        </div>
        <p className="mt-4 text-small text-faint">Free · For Macs with Apple silicon</p>
      </div>
      <div className="relative mt-16 px-6">
        <Shot
          src={floor}
          alt="The Kernel floor: the lead's plan waits for review while the team works at their desks"
          sizes="(max-width: 1328px) calc(100vw - 48px), 1280px"
          preload
          className="mx-auto max-w-320"
        />
      </div>
    </section>
  )
}
