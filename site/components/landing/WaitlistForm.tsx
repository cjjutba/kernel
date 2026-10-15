'use client'

import { useId, useState, type FormEvent } from 'react'
import { CheckIcon } from '@/components/ui/icons'

// The waitlist form: an email, a platform and Join, on one row. It posts to /api/waitlist, which sends the confirm
// email. The platform ids match lib/waitlist.ts, which can't be imported here because it's server only.

const PLATFORMS = [
  { id: 'any', label: 'Any platform' },
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
  { id: 'intel-mac', label: 'Intel Mac' }
] as const

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string; link?: string } | { kind: 'error'; message: string }

const ALL = ['windows', 'linux', 'intel-mac']

export function WaitlistForm() {
  const id = useId()
  const [email, setEmail] = useState('')
  const [platform, setPlatform] = useState('any')
  const [company, setCompany] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })
  const picked = platform === 'any' ? ALL : [platform]

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (state.kind === 'sending') return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setState({ kind: 'error', message: 'Enter a valid email address.' })
    setState({ kind: 'sending' })
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, platforms: picked, company })
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; link?: string }
      if (!res.ok) return setState({ kind: 'error', message: data.error ?? 'Something went wrong. Try again in a minute.' })
      setState({ kind: 'sent', email: email.trim(), link: data.link })
    } catch {
      setState({ kind: 'error', message: "Couldn't reach the server. Check your connection and try again." })
    }
  }

  if (state.kind === 'sent') {
    return (
      <div role="status" className="mx-auto flex max-w-140 flex-col items-center rounded-track border border-line-strong bg-surface-2 px-6 py-7 text-center">
        <span className="flex size-9 items-center justify-center rounded-pill border border-edge bg-surface-3 text-ink">
          <CheckIcon size={15} />
        </span>
        <p className="mt-4 text-item text-ink">Check your inbox</p>
        <p className="mt-1.5 text-body text-muted">
          We sent a link to <span className="text-ink-2">{state.email}</span>. Confirm it to join the list.
        </p>
        {state.link ? (
          <p className="mt-4 text-small text-muted">
            Development: no email was sent.{' '}
            <a href={state.link} className="text-ink underline decoration-rule underline-offset-3 hover:text-white">
              Open the confirm link
            </a>
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setEmail('')
            setState({ kind: 'idle' })
          }}
          className="mt-5 text-ui font-medium text-muted transition-colors hover:text-ink"
        >
          Use another email
        </button>
      </div>
    )
  }

  const sending = state.kind === 'sending'
  return (
    <form onSubmit={submit} noValidate className="relative mx-auto max-w-140" aria-describedby={state.kind === 'error' ? `${id}-error` : undefined}>
      <div className="flex items-center gap-1 rounded-track border border-line-strong bg-canvas p-1.5 transition-colors focus-within:border-rule max-nav:flex-wrap">
        <label htmlFor={`${id}-email`} className="sr-only">
          Email address
        </label>
        <input
          id={`${id}-email`}
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-10 min-w-0 flex-1 bg-transparent px-3 text-body text-ink outline-none placeholder:text-faint max-nav:basis-full"
        />
        <span aria-hidden="true" className="h-5 w-px bg-line-strong max-nav:hidden" />
        <label htmlFor={`${id}-platform`} className="sr-only">
          Platform
        </label>
        <span className="relative flex shrink-0 items-center max-nav:flex-1">
          <select
            id={`${id}-platform`}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            className="h-10 w-full cursor-pointer appearance-none rounded-chip bg-transparent pr-8 pl-3 text-ui text-ink-2 outline-none transition-colors hover:bg-white/4 hover:text-ink focus-visible:bg-white/6"
          >
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute right-2.5 text-muted">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </span>
        <button
          type="submit"
          disabled={sending}
          aria-busy={sending}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-chip bg-ink px-4 text-ui font-medium text-canvas transition-colors hover:bg-white disabled:opacity-70"
        >
          {sending ? <span aria-hidden="true" className="spinner" /> : null}
          {sending ? 'Joining' : 'Join the waitlist'}
        </button>
      </div>
      {/* People never see this field. Bots fill it in, and the server quietly drops their signup. */}
      <div aria-hidden="true" className="absolute -left-2500 size-px overflow-hidden">
        <label>
          Company
          <input tabIndex={-1} autoComplete="off" value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
      </div>
      <p id={`${id}-error`} role={state.kind === 'error' ? 'alert' : undefined} className="mt-2.5 min-h-5 text-center text-small text-del">
        {state.kind === 'error' ? state.message : ''}
      </p>
    </form>
  )
}
