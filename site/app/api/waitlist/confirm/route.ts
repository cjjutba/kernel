import { addToWaitlist, readToken, waitlistConfig, WaitlistError } from '@/lib/waitlist'

// POST /api/waitlist/confirm, from the button on /waitlist/confirm. Adds the signup to the waitlist segment, then sends
// the browser back to the page with the outcome. A GET does nothing, so mail scanners that open links confirm no one.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const back = (req: Request, state: string) => Response.redirect(new URL(`/waitlist/confirm?state=${state}`, req.url), 303)

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null)
  const token = String(form?.get('token') ?? '')
  const secret = waitlistConfig().secret
  if (!secret) return back(req, 'error')
  const read = readToken(token, secret)
  if (!read.ok) return back(req, read.reason)
  try {
    await addToWaitlist(read.claim)
    return back(req, 'done')
  } catch (e) {
    if (!(e instanceof WaitlistError)) console.error('waitlist: confirm failed', e)
    return back(req, 'error')
  }
}
