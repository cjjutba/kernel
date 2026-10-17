import { publishedChangelog, releaseHref } from '@/content/changelog'
import { pullUrl } from '@/lib/links'
import type { Release } from '@/lib/schema'
import { SITE_URL } from '@/lib/site'

// /changelog/rss.xml: every published release as an RSS item, newest first, linking to its own page.
// It follows the changelog: a release shows here once GitHub has published it (KERNEL-412).
export const revalidate = 3600

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function body(release: Release): string {
  const parts: string[] = []
  if (release.intro) parts.push(`<p>${escape(release.intro)}</p>`)
  for (const section of release.sections) {
    parts.push(`<h3>${escape(section.title)}</h3><ul>`)
    for (const item of section.items) {
      const lead = item.lead ? `<b>${escape(item.lead)}</b> ` : ''
      const pr = item.pr ? ` <a href="${pullUrl(item.pr)}">#${item.pr}</a>` : ''
      parts.push(`<li>${lead}${escape(item.text)}${pr}</li>`)
    }
    parts.push('</ul>')
  }
  return parts.join('')
}

export async function GET() {
  const { releases } = await publishedChangelog()
  const items = releases.map((release) => {
    const url = `${SITE_URL}${releaseHref(release.version)}`
    return [
      '<item>',
      `<title>${escape(release.title === `Kernel ${release.version}` ? release.title : `Kernel ${release.version}: ${release.title}`)}</title>`,
      `<link>${url}</link>`,
      `<guid isPermaLink="false">kernel-${release.version}</guid>`,
      `<pubDate>${new Date(`${release.date}T00:00:00Z`).toUTCString()}</pubDate>`,
      `<description><![CDATA[${body(release)}]]></description>`,
      '</item>'
    ].join('')
  })
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>',
    '<title>Kernel changelog</title>',
    `<link>${SITE_URL}/changelog</link>`,
    `<atom:link href="${SITE_URL}/changelog/rss.xml" rel="self" type="application/rss+xml" />`,
    '<description>New features, improvements and fixes in every Kernel release.</description>',
    '<language>en</language>',
    ...items,
    '</channel></rss>'
  ].join('\n')
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
}
