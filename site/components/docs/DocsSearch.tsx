'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SearchEntry } from '@/lib/docs'

// Docs search: ⌘K or a search button opens a dialog that reads /docs/search-index.json once, then matches as you type.
// Titles rank above headings, headings above the text. Up and Down move, Return opens, Esc closes.

const OPEN = 'kernel:docs-search'

type Result = { key: string; href: string; title: string; context: string; snippet: string; score: number }

function snippet(text: string, term: string) {
  const i = text.toLowerCase().indexOf(term)
  if (i < 0) return text.slice(0, 120)
  const start = Math.max(0, i - 50)
  return `${start ? '…' : ''}${text.slice(start, i + 90)}…`
}

function search(index: SearchEntry[], query: string): Result[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const results: Result[] = []
  for (const page of index) {
    const all = `${page.title} ${page.description} ${page.headings.map((h) => h.text).join(' ')} ${page.text}`.toLowerCase()
    if (!terms.every((t) => all.includes(t))) continue
    const title = page.title.toLowerCase()
    const text = page.text.toLowerCase()
    const phrase = terms.join(' ')
    // Title, then description, then how often the words come up in the page, capped so a long page doesn't win on length.
    let score = terms.reduce((n, t) => n + (title.includes(t) ? 10 : 0) + (page.description.toLowerCase().includes(t) ? 3 : 0) + Math.min(text.split(t).length - 1, 6), 0)
    if (terms.length > 1) score += Math.min(text.split(phrase).length - 1, 4) * 3
    if (title.startsWith(terms[0]!)) score += 5
    // The description when it matches, else the spot in the page's text where the first word shows up.
    const inDescription = terms.some((t) => page.description.toLowerCase().includes(t))
    results.push({ key: page.href, href: page.href, title: page.title, context: page.section, snippet: inDescription ? page.description : snippet(page.text, terms[0]!), score })
    for (const h of page.headings) {
      const text = h.text.toLowerCase()
      const hits = terms.filter((t) => text.includes(t)).length
      if (hits) results.push({ key: `${page.href}#${h.id}`, href: `${page.href}#${h.id}`, title: h.text, context: page.title, snippet: '', score: 4 + hits * 3 })
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 12)
}

/** A search button. Any number can sit on the page: they all open the one dialog. */
export function SearchButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN))}
      className="flex h-9 w-full items-center gap-2 rounded-lg border border-line-strong bg-surface-1 px-3 text-left text-ui text-faint transition-colors hover:border-edge-hover hover:text-muted"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" />
      </svg>
      <span className="flex-1">Search docs</span>
      <kbd className="font-mono text-badge text-faint">⌘K</kbd>
    </button>
  )
}

export function DocsSearch() {
  const router = useRouter()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [index, setIndex] = useState<SearchEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(() => (index ? search(index, query) : []), [index, query])

  const open = useCallback(() => {
    if (!dialog.current || dialog.current.open) return
    dialog.current.showModal()
    input.current?.select()
    if (!index && !failed) {
      fetch('/docs/search-index.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: SearchEntry[]) => setIndex(d))
        .catch(() => setFailed(true))
    }
  }, [index, failed])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (dialog.current?.open) dialog.current.close()
        else open()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN, open)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN, open)
    }
  }, [open])

  const go = (href: string) => {
    dialog.current?.close()
    setQuery('')
    router.push(href)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault()
      go(results[active].href)
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label="Search the docs"
      onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      className="docs-search m-auto mt-24 w-full max-w-150 rounded-frame border border-line-strong bg-surface-2 p-0 text-ink max-nav:mt-6 max-nav:max-w-none"
    >
      <div className="flex items-center gap-3 border-b border-line px-4">
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="shrink-0 text-faint">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
        <input
          ref={input}
          type="search"
          aria-label="Search the docs"
          aria-controls="docs-search-results"
          aria-activedescendant={results[active] ? `docs-result-${active}` : undefined}
          placeholder="Search the docs"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          className="h-14 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-faint"
        />
        <kbd className="font-mono text-badge text-faint">Esc</kbd>
      </div>
      <div className="max-h-105 overflow-y-auto p-2">
        {failed ? (
          <p className="px-3 py-8 text-center text-ui text-muted">Search couldn&apos;t load. Reload the page and try again.</p>
        ) : !query.trim() ? (
          <p className="px-3 py-8 text-center text-ui text-faint">Search titles, sections and text across the docs.</p>
        ) : !index ? (
          <p className="px-3 py-8 text-center text-ui text-faint">Loading</p>
        ) : results.length === 0 ? (
          <p className="px-3 py-8 text-center text-ui text-muted">Nothing matches &ldquo;{query}&rdquo;.</p>
        ) : (
          <ul id="docs-search-results" role="listbox" aria-label="Results">
            {results.map((r, i) => (
              <li key={r.key} id={`docs-result-${i}`} role="option" aria-selected={i === active}>
                <a
                  href={r.href}
                  onClick={(e) => {
                    e.preventDefault()
                    go(r.href)
                  }}
                  onMouseMove={() => setActive(i)}
                  className={`block rounded-md px-3 py-2.5 ${i === active ? 'bg-white/6' : ''}`}
                >
                  <span className="block text-small text-faint">{r.context}</span>
                  <span className="mt-0.5 block text-ui font-medium text-ink">{r.title}</span>
                  {r.snippet ? <span className="mt-0.5 block truncate text-small text-muted">{r.snippet}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </dialog>
  )
}
