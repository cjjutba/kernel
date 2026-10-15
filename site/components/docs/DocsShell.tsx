import Link from 'next/link'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { ArrowIcon, GitHubIcon } from '@/components/ui/icons'
import { docsNav, neighbors, type DocPage } from '@/lib/docs'
import { SITE_URL } from '@/lib/site'
import { CodeCopy } from './CodeCopy'
import { CopyPage } from './CopyPage'
import { DocsSearch, SearchButton } from './DocsSearch'
import { Toc } from './Toc'

// The docs: the sections on the left, the page in the middle and "On this page" on the right. On narrower screens
// "On this page" goes, then the sidebar folds into a menu above the page. The docs home uses the same frame without
// "On this page".

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-faint">
      <path d="m6 4 4 4-4 4" />
    </svg>
  )
}

const item = (on: boolean) =>
  `block rounded-md px-3 py-1.5 text-ui transition-colors ${on ? 'bg-white/6 font-medium text-ink' : 'text-muted hover:bg-white/3 hover:text-ink'}`

/** `current` is the open page's slug, or "home" on the docs home. */
function Sidebar({ current }: { current: string }) {
  return (
    <nav aria-label="Docs" className="flex flex-col gap-7">
      <Link href="/docs" aria-current={current === 'home' ? 'page' : undefined} className={item(current === 'home')}>
        Overview
      </Link>
      {docsNav().map((section) => (
        <div key={section.title}>
          <p className="px-3 text-small font-medium text-ink">{section.title}</p>
          <ul className="mt-2 flex flex-col gap-px">
            {section.pages.map((p) => (
              <li key={p.slug}>
                <Link href={p.href} aria-current={p.slug === current ? 'page' : undefined} className={item(p.slug === current)}>
                  {p.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

/** The frame every docs page shares. `label` names the open page on the phone menu. */
export function DocsLayout({ current, label, toc, children }: { current: string; label: string; toc?: ReactNode; children: ReactNode }) {
  return (
    <>
      <SiteNav current="/docs" />
      <div className="mx-auto grid max-w-336 grid-docs px-6">
        {/* The column carries the hairline the whole way down; the sidebar inside it stays in view. */}
        <div className="border-r border-line-faint max-docs:hidden">
          {/* The rail scrolls on its own, and its scrollbar sits on the hairline. */}
          <div className="docs-rail pt-10 pr-5 pb-16">
            <SearchButton />
            <div className="mt-7">
              <Sidebar current={current} />
            </div>
          </div>
        </div>

        <main id="content" className="min-w-0 pt-10 pb-24 docs:px-12 max-docs:pt-6">
          <div className="docs:hidden">
            {/* The docs home has its own wide search field, so the menu's is left out there. */}
            {current === 'home' ? null : <SearchButton />}
            <details className={`group rounded-lg border border-line bg-surface-1 ${current === 'home' ? '' : 'mt-3'}`}>
              <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-ui font-medium text-ink-2">
                {label}
                <span aria-hidden="true" className="faq-plus" />
              </summary>
              <div className="border-t border-line px-1 py-4">
                <Sidebar current={current} />
              </div>
            </details>
          </div>
          {children}
        </main>

        {toc ? <div className="docs-rail pt-10 pb-16 max-toc:hidden">{toc}</div> : null}
      </div>
      <DocsSearch suggestions={docsNav()[0]!.pages.map((p) => ({ href: p.href, title: p.title, section: 'Get started' }))} />
      <SiteFooter />
    </>
  )
}

export function DocsShell({ page }: { page: DocPage }) {
  const { prev, next } = neighbors(page.slug)
  return (
    <DocsLayout current={page.slug} label={`${page.section}: ${page.title}`} toc={<Toc headings={page.headings} />}>
      <CodeCopy />
      <article aria-labelledby="doc-title" className="max-w-180 max-docs:mt-8">
        <div className="flex items-center justify-between gap-4">
          <p className="flex min-w-0 items-center gap-1.5 text-small text-muted">
            <Link href="/docs" className="transition-colors hover:text-ink">
              Docs
            </Link>
            <Chevron />
            {page.section}
            <Chevron />
            <span className="truncate text-ink-2">{page.title}</span>
          </p>
          <CopyPage markdown={page.markdown} mdUrl={page.mdHref} mdAbsolute={`${SITE_URL}${page.mdHref}`} title={page.title} />
        </div>
        <h1 id="doc-title" className="mt-5 text-h2 text-balance">
          {page.title}
        </h1>
        <p className="mt-3 text-lead text-muted">{page.description}</p>
        <div className="doc-prose mt-10 border-t border-line-faint pt-10" dangerouslySetInnerHTML={{ __html: page.html }} />

        <div className="mt-16 border-t border-line-faint pt-6 text-small text-faint">
          <a href={page.editUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-2 transition-colors hover:text-ink">
            <GitHubIcon size={14} />
            Edit this page on GitHub
          </a>
        </div>
        <nav aria-label="Previous and next" className="mt-6 grid grid-cols-2 gap-3 max-nav:grid-cols-1">
          {prev ? (
            <Link href={prev.href} className="group flex flex-col gap-1 rounded-lg border border-line p-4 transition-colors hover:border-edge hover:bg-white/2">
              <span className="text-small text-faint">Previous</span>
              <span className="inline-flex items-center gap-1.5 text-ui font-medium text-ink-2 group-hover:text-ink">
                <ArrowIcon className="rotate-180 text-muted" />
                {prev.title}
              </span>
            </Link>
          ) : (
            <span className="max-nav:hidden" />
          )}
          {next ? (
            <Link href={next.href} className="group flex flex-col items-end gap-1 rounded-lg border border-line p-4 text-right transition-colors hover:border-edge hover:bg-white/2">
              <span className="text-small text-faint">Next</span>
              <span className="inline-flex items-center gap-1.5 text-ui font-medium text-ink-2 group-hover:text-ink">
                {next.title}
                <ArrowIcon className="text-muted" />
              </span>
            </Link>
          ) : null}
        </nav>
      </article>
    </DocsLayout>
  )
}
