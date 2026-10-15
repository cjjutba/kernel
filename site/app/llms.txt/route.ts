import { docsNav, getDoc } from '@/lib/docs'
import { SITE_DESCRIPTION, SITE_URL } from '@/lib/site'

// /llms.txt: the docs as a list of Markdown links, for AI tools (llmstxt.org).
export const dynamic = 'force-static'

export function GET() {
  const lines = ['# Kernel', '', `> ${SITE_DESCRIPTION}`, '']
  for (const section of docsNav()) {
    lines.push(`## ${section.title}`, '')
    for (const p of section.pages) lines.push(`- [${p.title}](${SITE_URL}/docs/${p.slug}.md): ${getDoc(p.slug)!.description}`)
    lines.push('')
  }
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
