import { WORDMARK_CID } from './emailWordmark'

// The waitlist's one email: confirm the address. A single white column, the wordmark, a short heading, one button and
// a quiet footer. Table markup with inline styles, since mail clients ignore stylesheets, and a text part for clients
// that show no HTML. Colors are email-only and live here, not in globals.css. The page declares light only, so mail
// apps don't invert it.

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function list(items: string[]) {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif"
const INK = '#0b0c0d'
const BODY = '#3f3f46'
const MUTED = '#71717a'
const FAINT = '#a1a1aa'
const RULE = '#ececee'

/** `site` is the site's origin, for the footer's links. */
export function confirmEmail(link: string, platforms: string[], site: string) {
  const which = list(platforms)
  const subject = 'Confirm your email for Kernel'
  const preheader = `One click, and we will email you once when Kernel runs on ${which}.`
  const host = site.replace(/^https?:\/\//, '')
  const text = [
    'Confirm your email',
    '',
    `You asked to hear when Kernel runs on ${which}. Confirm this address, and we will email you once, when it does.`,
    '',
    link,
    '',
    'The link works for 3 days.',
    '',
    "If you didn't ask for this, ignore this email. You won't be added to the list.",
    '',
    `Kernel · ${site}`
  ].join('\n')
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escape(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#ffffff;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
      <tr>
        <td align="center" style="padding:48px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;font-family:${FONT};">
            <tr>
              <td style="padding:0 0 40px;">
                <img src="cid:${WORDMARK_CID}" width="62" height="30" alt="Kernel" style="display:block;border:0;outline:none;width:62px;height:30px;margin-left:-3px;" />
              </td>
            </tr>
            <tr>
              <td>
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.5px;color:${INK};">Confirm your email</h1>
                <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:${BODY};">You asked to hear when Kernel runs on ${escape(which)}. Confirm this address, and we will email you once, when it does.</p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:8px;background:${INK};">
                      <a href="${escape(link)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:500;line-height:1.4;color:#ffffff;text-decoration:none;border-radius:8px;">Confirm email</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:${MUTED};">The link works for 3 days.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 0 0;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:${FAINT};">Button not working? Paste this into your browser:</p>
                <p style="margin:4px 0 0;font-size:12px;line-height:1.6;word-break:break-all;"><a href="${escape(link)}" style="color:${MUTED};text-decoration:underline;">${escape(link)}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:40px 0 0;">
                <div style="border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</div>
                <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:${FAINT};">If you didn't ask for this, ignore this email. You won't be added to the list.</p>
                <p style="margin:8px 0 0;font-size:12px;line-height:1.6;color:${FAINT};"><a href="${escape(site)}" style="color:${FAINT};text-decoration:none;">${escape(host)}</a> · <a href="${escape(site)}/docs/privacy#waitlist" style="color:${FAINT};text-decoration:underline;">Privacy</a></p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
  return { subject, text, html }
}
