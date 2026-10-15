import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { SITE_URL } from './site'
import { confirmEmail } from './waitlistEmail'

// The Windows, Linux and Intel Mac waitlist, on Resend. Double opt-in with no database: a signup gets an email with a
// signed link, the link opens a confirm page, and only its button adds the contact to the waitlist segment. Mail scanners
// that open every link in an email never confirm anyone, since opening the page changes nothing.
//
// The announcement is the Resend template "Kernel waitlist announcement" (alias kernel-waitlist-announcement), sent as a
// broadcast to the segment with the topic. Its footer holds Resend's {{{RESEND_UNSUBSCRIBE_URL}}}, which docs/privacy promises.
//
// Environment, server side only:
//   RESEND_API_KEY              required in production. Without it, development runs dry: nothing is sent, and the confirm
//                               link comes back in the response and the server log so the flow can be tried locally.
//   RESEND_WAITLIST_SEGMENT_ID  the "Kernel waitlist" segment. Defaults to the one made for it.
//   RESEND_WAITLIST_TOPIC_ID    the "Kernel platform news" topic, opt-out by default, which a confirmed signup opts into.
//                               A broadcast sent with it carries Resend's unsubscribe link ({{{RESEND_UNSUBSCRIBE_URL}}}),
//                               and unsubscribing there opts the contact out. Defaults to the one made for it.
//   WAITLIST_FROM               the sender. Defaults to Kernel <kernel@cjjutba.dev>, a verified domain.
//   WAITLIST_SECRET             signs confirm links. Defaults to a hash of the API key, so rotating the key expires old links.

export const PLATFORMS = ['windows', 'linux', 'intel-mac'] as const
export type Platform = (typeof PLATFORMS)[number]
export const PLATFORM_LABELS: Record<Platform, string> = { windows: 'Windows', linux: 'Linux', 'intel-mac': 'Intel Mac' }

const DEFAULT_SEGMENT = 'd6015dc3-85e0-40ca-929c-acc55d952af5'
const DEFAULT_TOPIC = '1016ca5e-a534-4476-a602-e1ab41077f7a'
const DEFAULT_FROM = 'Kernel <kernel@cjjutba.dev>'
const LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000
const API = 'https://api.resend.com'

export const Signup = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  platforms: z.array(z.enum(PLATFORMS)).min(1).max(PLATFORMS.length),
  /** A field people never see. Anything in it is a bot. */
  company: z.string().optional()
})
export type Signup = z.infer<typeof Signup>

export class WaitlistError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export function waitlistConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim() || undefined
  const production = process.env.NODE_ENV === 'production'
  const secret = process.env.WAITLIST_SECRET?.trim() || (apiKey ? createHash('sha256').update(`kernel-waitlist:${apiKey}`).digest('hex') : production ? undefined : 'kernel-waitlist-dev')
  return {
    apiKey,
    secret,
    segmentId: process.env.RESEND_WAITLIST_SEGMENT_ID?.trim() || DEFAULT_SEGMENT,
    topicId: process.env.RESEND_WAITLIST_TOPIC_ID?.trim() || DEFAULT_TOPIC,
    from: process.env.WAITLIST_FROM?.trim() || DEFAULT_FROM,
    /** Development without a key: nothing leaves the machine. */
    dryRun: !apiKey && !production
  }
}

// ---------- Confirm links

type Claim = { email: string; platforms: Platform[]; expires: number }
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url')

function sign(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

export function makeToken(signup: Pick<Signup, 'email' | 'platforms'>, secret: string, now = Date.now()): string {
  const body = b64(JSON.stringify({ e: signup.email, p: signup.platforms, x: now + LINK_TTL_MS }))
  return `${body}.${sign(body, secret)}`
}

/** The signup a link carries, or why it can't be used. */
export function readToken(token: string, secret: string, now = Date.now()): { ok: true; claim: Claim } | { ok: false; reason: 'invalid' | 'expired' } {
  const [body, mac] = token.split('.')
  if (!body || !mac) return { ok: false, reason: 'invalid' }
  const want = Buffer.from(sign(body, secret))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'invalid' }
  try {
    const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { e?: unknown; p?: unknown; x?: unknown }
    const parsed = Signup.pick({ email: true, platforms: true }).safeParse({ email: raw.e, platforms: raw.p })
    if (!parsed.success || typeof raw.x !== 'number') return { ok: false, reason: 'invalid' }
    if (raw.x < now) return { ok: false, reason: 'expired' }
    return { ok: true, claim: { ...parsed.data, expires: raw.x } }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

export const confirmUrl = (token: string, origin = SITE_URL) => `${origin}/waitlist/confirm?token=${encodeURIComponent(token)}`

// ---------- A little protection for a public form

const recent = new Map<string, number[]>()

/** True when `key` was seen `max` times in the last `windowMs`. Per server instance, so a cap rather than a guarantee. */
export function overLimit(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const kept = (recent.get(key) ?? []).filter((t) => now - t < windowMs)
  if (kept.length >= max) {
    recent.set(key, kept)
    return true
  }
  kept.push(now)
  recent.set(key, kept)
  if (recent.size > 5000) recent.delete(recent.keys().next().value!)
  return false
}

// ---------- Resend

async function resend(apiKey: string, path: string, init: { method: string; body?: unknown }) {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store'
  })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { ok: res.ok, status: res.status, data }
}

/** Sends the confirm email. In a dry run it only returns the link. */
export async function sendConfirm(signup: Pick<Signup, 'email' | 'platforms'>, origin?: string): Promise<{ link: string; sent: boolean }> {
  const cfg = waitlistConfig()
  if (!cfg.secret || (!cfg.apiKey && !cfg.dryRun)) throw new WaitlistError("The waitlist isn't open yet. Try again later.", 503)
  const link = confirmUrl(makeToken(signup, cfg.secret), origin)
  if (cfg.dryRun) return { link, sent: false }
  const email = confirmEmail(link, signup.platforms.map((p) => PLATFORM_LABELS[p]))
  const res = await resend(cfg.apiKey!, '/emails', { method: 'POST', body: { from: cfg.from, to: [signup.email], subject: email.subject, html: email.html, text: email.text } })
  if (!res.ok) {
    console.error('waitlist: Resend refused the confirm email', res.status, res.data?.message ?? res.data?.name)
    throw new WaitlistError("We couldn't send the email. Try again in a minute.", 502)
  }
  return { link, sent: true }
}

/** Opts a contact into the announcement topic. Resend's docs show both a bare array and a `topics` field, so it tries both. */
async function optIn(apiKey: string, who: string, topicId: string): Promise<boolean> {
  const topics = [{ id: topicId, subscription: 'opt_in' }]
  const bare = await resend(apiKey, `/contacts/${who}/topics`, { method: 'PATCH', body: topics })
  if (bare.ok) return true
  const wrapped = await resend(apiKey, `/contacts/${who}/topics`, { method: 'PATCH', body: { topics } })
  if (!wrapped.ok) console.error('waitlist: Resend refused the topic', bare.status, wrapped.status, wrapped.data?.message ?? bare.data?.message)
  return wrapped.ok
}

/** Adds a confirmed signup to the waitlist segment and the announcement topic, or updates the contact if it's there already. */
export async function addToWaitlist(claim: Pick<Claim, 'email' | 'platforms'>): Promise<{ stored: boolean }> {
  const cfg = waitlistConfig()
  if (cfg.dryRun) {
    console.info(`waitlist (dry run): would add ${claim.email} for ${claim.platforms.join(', ')}`)
    return { stored: false }
  }
  if (!cfg.apiKey) throw new WaitlistError("The waitlist isn't open yet. Try again later.", 503)
  const key = cfg.apiKey
  const who = encodeURIComponent(claim.email)
  const existing = await resend(key, `/contacts/${who}`, { method: 'GET' })
  if (existing.ok) {
    // Someone signing up again keeps the platforms they picked before.
    // Resend returns a property as { value, type }, and older contacts may have none.
    const stored = (existing.data?.properties as Record<string, unknown> | undefined)?.platforms
    const value = stored && typeof stored === 'object' && 'value' in stored ? (stored as { value: unknown }).value : stored
    const before = (typeof value === 'string' ? value : '').split(',').filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p))
    const platforms = [...new Set([...before, ...claim.platforms])].join(',')
    const patched = await resend(key, `/contacts/${who}`, { method: 'PATCH', body: { unsubscribed: false, properties: { platforms } } })
    const joined = await resend(key, `/contacts/${who}/segments/${cfg.segmentId}`, { method: 'POST' })
    const subscribed = await optIn(key, who, cfg.topicId)
    if (!patched.ok || (!joined.ok && joined.status !== 409) || !subscribed) {
      console.error('waitlist: Resend refused the update', patched.status, joined.status, joined.data?.message)
      throw new WaitlistError("We couldn't save that. Try the link again in a minute.", 502)
    }
    return { stored: true }
  }
  const created = await resend(key, '/contacts', {
    method: 'POST',
    body: {
      email: claim.email,
      unsubscribed: false,
      properties: { platforms: claim.platforms.join(',') },
      segments: [{ id: cfg.segmentId }],
      topics: [{ id: cfg.topicId, subscription: 'opt_in' }]
    }
  })
  if (!created.ok) {
    console.error('waitlist: Resend refused the contact', created.status, created.data?.message ?? created.data?.name)
    throw new WaitlistError("We couldn't save that. Try the link again in a minute.", 502)
  }
  return { stored: true }
}
