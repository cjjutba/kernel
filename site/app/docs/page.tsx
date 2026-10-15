import Link from 'next/link'
import type { Metadata } from 'next'
import { DocsLayout } from '@/components/docs/DocsShell'
import { SearchButton } from '@/components/docs/DocsSearch'
import { ArrowIcon } from '@/components/ui/icons'
import { docsNav } from '@/lib/docs'
import { ISSUES_URL } from '@/lib/links'
import { pageMetadata } from '@/lib/site'

// The docs home: search, the four pages to start with, and every other section with its pages.

const description = 'How to brief Kernel, run Claude Code and Codex agents side by side, and merge what they build.'

export const metadata: Metadata = pageMetadata({ title: 'Docs · Kernel', description, path: '/docs' })

export default function DocsHome() {
  const [start, ...sections] = docsNav()
  return (
    <DocsLayout current="home" label="Overview">
      <div className="max-w-220 max-docs:mt-8">
        <h1 className="text-h2 text-balance">Kernel docs</h1>
        <p className="mt-3 max-w-140 text-lead text-muted">{description}</p>
        <div className="mt-8 max-w-140">
          <SearchButton size="lg" />
        </div>

        <section aria-labelledby="start-title" className="mt-16">
          <h2 id="start-title" className="text-item text-ink">
            {start!.title}
          </h2>
          <ol className="mt-4 grid grid-cols-2 gap-3 max-nav:grid-cols-1">
            {start!.pages.map((p, i) => (
              <li key={p.slug}>
                <Link href={p.href} className="group flex h-full flex-col rounded-lg border border-line bg-surface-1 p-5 transition-colors hover:border-edge hover:bg-surface-2">
                  <span className="font-mono text-tag text-faint">0{i + 1}</span>
                  <span className="mt-3 inline-flex items-center gap-1.5 text-item text-ink">
                    {p.title}
                    <ArrowIcon className="text-faint transition-colors group-hover:text-ink" />
                  </span>
                  <span className="mt-1.5 text-body text-muted">{p.description}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="browse-title" className="mt-16">
          <h2 id="browse-title" className="text-item text-ink">
            Browse the docs
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-3 max-nav:grid-cols-1">
            {sections.map((s) => (
              <div key={s.title} className="rounded-lg border border-line p-5">
                <h3 className="flex items-baseline gap-2 text-ui font-medium text-ink">
                  {s.title}
                  <span className="font-mono text-tag text-faint">{s.pages.length}</span>
                </h3>
                <ul className="mt-3 flex flex-col gap-1">
                  {s.pages.map((p) => (
                    <li key={p.slug}>
                      <Link href={p.href} className="group -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-ui text-muted transition-colors hover:bg-white/3 hover:text-ink">
                        {p.title}
                        <ArrowIcon className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <p className="mt-16 border-t border-line-faint pt-6 text-small text-faint">
          Something missing?{' '}
          <a href={ISSUES_URL} target="_blank" rel="noopener" className="text-muted underline decoration-rule underline-offset-3 hover:text-ink">
            Ask on GitHub
          </a>
          . For an AI tool, every page is listed in{' '}
          <a href="/llms.txt" className="text-muted underline decoration-rule underline-offset-3 hover:text-ink">
            llms.txt
          </a>
          .
        </p>
      </div>
    </DocsLayout>
  )
}
