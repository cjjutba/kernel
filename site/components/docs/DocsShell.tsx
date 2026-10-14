import Link from 'next/link'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { ArrowIcon, GitHubIcon } from '@/components/ui/icons'
import { docsNav, neighbors, type DocPage } from '@/lib/docs'
import { DocsSearch, SearchButton } from './DocsSearch'

// A docs page: the sections on the left, the page in the middle and "On this page" on the right. On narrower screens
// "On this page" goes, then the sidebar folds into a menu above the page.

function Sidebar({ current }: { current: string }) {
  return (
    <nav aria-label="Docs" className="flex flex-col gap-7">
      {docsNav().map((section) => (
        <div key={section.title}>
          <p className="px-3 text-small font-medium text-ink">{section.title}</p>
          <ul className="mt-2 flex flex-col">
            {section.pages.map((p) => {
              const on = p.slug === current
              return (
                <li key={p.slug}>
                  <Link
                    href={p.href}
                    aria-current={on ? 'page' : undefined}
                    className={`block rounded-md px-3 py-1.5 text-ui transition-colors ${on ? 'bg-white/6 text-ink' : 'text-muted hover:text-ink'}`}
                  >
                    {p.title}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export function DocsShell({ page }: { page: DocPage }) {
  const { prev, next } = neighbors(page.slug)
  return (
    <>
      <SiteNav current="/docs" />
      <div className="mx-auto grid max-w-336 grid-docs gap-x-12 px-6">
        <div className="docs-rail pt-10 pb-16 max-docs:hidden">
          <SearchButton />
          <div className="mt-8">
            <Sidebar current={page.slug} />
          </div>
        </div>

        <main id="content" className="min-w-0 pt-10 pb-24 max-docs:pt-6">
          <div className="docs:hidden">
            <SearchButton />
            <details className="group mt-3 rounded-lg border border-line bg-surface-1">
              <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-ui font-medium text-ink-2">
                {page.section}: {page.title}
                <span aria-hidden="true" className="faq-plus" />
              </summary>
              <div className="border-t border-line px-1 py-4">
                <Sidebar current={page.slug} />
              </div>
            </details>
          </div>

          <article aria-labelledby="doc-title" className="max-w-180 max-docs:mt-8">
            <p className="text-small font-medium text-muted">{page.section}</p>
            <h1 id="doc-title" className="mt-3 text-h2 text-balance">
              {page.title}
            </h1>
            <p className="mt-4 text-lead text-muted">{page.description}</p>
            <div className="doc-prose mt-10" dangerouslySetInnerHTML={{ __html: page.html }} />

            <div className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6 text-small text-faint">
              <a href={page.editUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-2 transition-colors hover:text-ink">
                <GitHubIcon size={14} />
                Edit this page on GitHub
              </a>
            </div>
            <nav aria-label="Previous and next" className="mt-6 grid grid-cols-2 gap-3 max-nav:grid-cols-1">
              {prev ? (
                <Link href={prev.href} className="group rounded-lg border border-line p-4 transition-colors hover:border-edge">
                  <span className="text-small text-faint">Previous</span>
                  <span className="mt-1 block text-ui font-medium text-ink-2 group-hover:text-ink">{prev.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link href={next.href} className="group rounded-lg border border-line p-4 text-right transition-colors hover:border-edge">
                  <span className="text-small text-faint">Next</span>
                  <span className="mt-1 inline-flex w-full items-center justify-end gap-1.5 text-ui font-medium text-ink-2 group-hover:text-ink">
                    {next.title}
                    <ArrowIcon />
                  </span>
                </Link>
              ) : null}
            </nav>
          </article>
        </main>

        <div className="docs-rail pt-10 pb-16 max-toc:hidden">
          {page.headings.length ? (
            <nav aria-label="On this page">
              <p className="text-small font-medium text-ink">On this page</p>
              <ul className="mt-3 flex flex-col gap-2 border-l border-line">
                {page.headings.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`} className={`-ml-px block border-l border-transparent text-small text-muted transition-colors hover:border-rule hover:text-ink ${h.depth === 3 ? 'pl-6' : 'pl-3'}`}>
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>
      </div>
      <DocsSearch />
      <SiteFooter />
    </>
  )
}
