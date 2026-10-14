// The waitlist's one email: confirm the address. Plain table markup with inline styles, since mail clients ignore
// stylesheets, and a text part for clients that show no HTML. Colors are email-only and live here, not in globals.css.

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function list(items: string[]) {
  if (items.length < 2) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
}

export function confirmEmail(link: string, platforms: string[]) {
  const which = list(platforms)
  const subject = 'Confirm your spot on the Kernel waitlist'
  const text = [
    `Thanks for your interest in Kernel on ${which}.`,
    '',
    'Confirm your email with this link, and we will write once when Kernel runs there:',
    link,
    '',
    "If you didn't ask for this, ignore this email. Without a confirmation you aren't added to the list, and you won't hear from us again.",
    '',
    'Kernel · https://github.com/cjjutba/kernel'
  ].join('\n')
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f6f6f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
            <tr>
              <td style="padding:32px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0b0c0d;">
                <p style="margin:0 0 24px;font-size:15px;font-weight:600;letter-spacing:-0.2px;">Kernel</p>
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.4px;">Confirm your spot on the waitlist</h1>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#52525b;">Thanks for your interest in Kernel on ${escape(which)}. Confirm your email, and we will write once when Kernel runs there.</p>
                <a href="${escape(link)}" style="display:inline-block;background:#0b0c0d;color:#ffffff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 20px;border-radius:8px;">Confirm my email</a>
                <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#71717a;">Or paste this link into your browser:<br /><a href="${escape(link)}" style="color:#52525b;word-break:break-all;">${escape(link)}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
                <p style="margin:0;padding-top:20px;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.6;color:#a1a1aa;">If you didn't ask for this, ignore this email. Without a confirmation you aren't added to the list, and you won't hear from us again.</p>
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
