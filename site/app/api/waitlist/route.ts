import { overLimit, sendConfirm, Signup, waitlistConfig, WaitlistError } from '@/lib/waitlist'

// POST /api/waitlist: { email, platforms, company } from the waitlist form. Sends the confirm email and adds nothing yet.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export async function POST(req: Request) {
  // Only this site's own pages post here.
  const origin = req.headers.get('origin')
  if (origin && new URL(origin).host !== new URL(req.url).host) return json({ error: 'Not allowed.' }, 403)

  const parsed = Signup.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0]
    return json({ error: field === 'platforms' ? 'Pick at least one platform.' : 'Enter a valid email address.' }, 400)
  }
  const signup = parsed.data
  // A filled hidden field is a bot. It gets the same answer as a person, so it learns nothing.
  if (signup.company) return json({ ok: true })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
  if (overLimit(`ip:${ip}`, 8, 10 * 60_000) || overLimit(`email:${signup.email}`, 3, 60 * 60_000)) {
    return json({ error: 'Too many tries. Wait a few minutes, then try again.' }, 429)
  }

  try {
    const origin = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin
    const { link, sent } = await sendConfirm(signup, origin)
    if (!sent) {
      // Development without RESEND_API_KEY: nothing is sent, so the link comes back to open by hand.
      console.info(`waitlist (dry run): confirm link for ${signup.email}: ${link}`)
      return json({ ok: true, dryRun: waitlistConfig().dryRun, link })
    }
    return json({ ok: true })
  } catch (e) {
    if (e instanceof WaitlistError) return json({ error: e.message }, e.status)
    console.error('waitlist: signup failed', e)
    return json({ error: 'Something went wrong. Try again in a minute.' }, 500)
  }
}
