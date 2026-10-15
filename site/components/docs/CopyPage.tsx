'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CheckIcon, CopyIcon } from '@/components/ui/icons'

// Copy page, beside a docs page's title: copies the page as Markdown, and its menu opens the Markdown or hands the page
// to an AI chat, which reads it from its .md link. Arrow keys move through the menu, Esc closes it.

/** `mdUrl` is the page's Markdown on this site, `mdAbsolute` the same with the site's origin, for the AI chats to fetch. */
type Props = { markdown: string; mdUrl: string; mdAbsolute: string; title: string }

const prompt = (mdUrl: string, title: string) => `Read ${mdUrl}, the Kernel docs page "${title}", so I can ask questions about it.`

const AI = [
  { name: 'ChatGPT', url: (q: string) => `https://chatgpt.com/?hints=search&q=${encodeURIComponent(q)}` },
  { name: 'Claude', url: (q: string) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
  { name: 'Grok', url: (q: string) => `https://grok.com/?q=${encodeURIComponent(q)}` },
  { name: 'Perplexity', url: (q: string) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}` }
]

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 6 4 4 4-4" />
    </svg>
  )
}

function Out() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-faint">
      <path d="M6 3.5h6.5V10M12.5 3.5 4 12" />
    </svg>
  )
}

function Doc() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1.8H4.2a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.6ZM9 1.8v3.8h3.8M5.6 9.5l1.2 1.4 1.2-1.4M6.8 7v3.9M9.6 9h1.5" />
    </svg>
  )
}

function Chat() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.8 3.5h10.4v7H8.6L5.5 13v-2.5H2.8Z" />
    </svg>
  )
}

export function CopyPage({ markdown, mdUrl, mdAbsolute, title }: Props) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLElement | null)[]>([])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      window.open(mdUrl, '_blank', 'noopener')
    }
  }

  useEffect(() => {
    if (!open) return
    items.current[0]?.focus()
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items.current.filter(Boolean) as HTMLElement[]
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      wrap.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      list[(i + 1) % list.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      list[(i - 1 + list.length) % list.length]?.focus()
    }
  }

  const row = 'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left outline-none transition-colors hover:bg-white/6 focus-visible:bg-white/6'
  const q = prompt(mdAbsolute, title)

  return (
    <div ref={wrap} className="relative inline-flex shrink-0">
      <div className="inline-flex h-8 items-stretch overflow-hidden rounded-md border border-line-strong text-small font-medium text-ink-2">
        <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-2 px-3 transition-colors hover:bg-white/5 hover:text-ink">
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          {copied ? 'Copied' : 'Copy page'}
        </button>
        <button
          type="button"
          aria-label="More ways to use this page"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex w-8 items-center justify-center border-l border-line-strong transition-colors hover:bg-white/5 hover:text-ink"
        >
          <Chevron />
        </button>
      </div>
      {open ? (
        <div role="menu" aria-label="Use this page" onKeyDown={onMenuKey} className="absolute top-10 right-0 z-10 w-72 rounded-lg border border-line-strong bg-surface-2 p-1.5">
          <button
            ref={(el) => {
              items.current[0] = el
            }}
            role="menuitem"
            type="button"
            onClick={() => {
              void copy()
              setOpen(false)
            }}
            className={row}
          >
            <span className="mt-0.5 text-muted">
              <CopyIcon size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-ui text-ink">Copy page</span>
              <span className="block text-small text-muted">Copy as Markdown for an AI chat</span>
            </span>
          </button>
          <a
            ref={(el) => {
              items.current[1] = el
            }}
            role="menuitem"
            href={mdUrl}
            target="_blank"
            rel="noopener"
            onClick={() => setOpen(false)}
            className={row}
          >
            <span className="mt-0.5 text-muted">
              <Doc />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-ui text-ink">View as Markdown</span>
              <span className="block text-small text-muted">Open this page as plain text</span>
            </span>
            <Out />
          </a>
          <div className="my-1.5 border-t border-line" />
          {AI.map((ai, i) => (
            <a
              key={ai.name}
              ref={(el) => {
                items.current[i + 2] = el
              }}
              role="menuitem"
              href={ai.url(q)}
              target="_blank"
              rel="noopener"
              onClick={() => setOpen(false)}
              className={row}
            >
              <span className="mt-0.5 text-muted">
                <Chat />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-ui text-ink">Open in {ai.name}</span>
                <span className="block text-small text-muted">Ask questions about this page</span>
              </span>
              <Out />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  )
}
