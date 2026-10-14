'use client'

import { useId, useState, type FormEvent } from 'react'
import { CheckIcon } from '@/components/ui/icons'

// The waitlist form: platforms, an email and Join. It posts to /api/waitlist, which sends the confirm email. The
// platform list matches lib/waitlist.ts, which can't be imported here because it's server only.

const PLATFORMS = [
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
  { id: 'intel-mac', label: 'Intel Mac' }
] as const

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string; link?: string } | { kind: 'error'; message: string }

export function WaitlistForm() {
  const id = useId()
  const [email, setEmail] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [company, setCompany] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  const toggle = (p: string) => setPicked((all) => (all.includes(p) ? all.filter((x) => x !== p) : [...all, p]))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (state.kind === 'sending') return
    if (!picked.length) return setState({ kind: 'error', message: 'Pick at least one platform.' })
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
      <div role="status" className="rounded-lg border border-line-strong bg-surface-2 p-6">
        <p className="flex items-center gap-2 text-item text-ink">
          <CheckIcon size={15} className="shrink-0" />
          Check your inbox
        </p>
        <p className="mt-2 text-body text-muted">
          We sent a link to <span className="text-ink-2">{state.email}</span>. Open it and confirm to join the list.
        </p>
        {state.link ? (
          <p className="mt-4 rounded-md border border-dashed border-edge p-3 text-small text-muted">
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
    <form onSubmit={submit} noValidate className="relative" aria-describedby={state.kind === 'error' ? `${id}-error` : undefined}>
      <fieldset>
        <legend className="text-small font-medium text-ink-2">Which platform?</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {PLATFORMS.map((p) => {
            const on = picked.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(p.id)}
                className={`inline-flex h-9 items-center gap-2 rounded-md border px-3.5 text-ui font-medium transition-colors ${
                  on ? 'border-ink bg-ink text-canvas' : 'border-line-strong bg-surface-2 text-ink-2 hover:border-edge-hover hover:text-ink'
                }`}
              >
                {on ? <CheckIcon size={12} /> : null}
                {p.label}
              </button>
            )
          })}
        </div>
      </fieldset>
      <div className="mt-5 flex gap-2 max-nav:flex-col">
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
          className="h-11 min-w-0 flex-1 rounded-lg border border-line-strong bg-canvas px-4 text-body text-ink outline-none transition-colors placeholder:text-faint focus:border-rule"
        />
        <button
          type="submit"
          disabled={sending}
          aria-busy={sending}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-ink px-5 text-body font-medium text-canvas transition-colors hover:bg-white disabled:opacity-70"
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
      <p id={`${id}-error`} role={state.kind === 'error' ? 'alert' : undefined} className="mt-3 min-h-5 text-small text-del">
        {state.kind === 'error' ? state.message : ''}
      </p>
    </form>
  )
}
