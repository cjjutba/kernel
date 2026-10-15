import { DOC_SLUGS, getDoc } from '@/lib/docs'

// A docs page as Markdown, at /docs/<slug>.md through the rewrite in next.config.ts. For Copy page, View as Markdown,
// and the AI tools that read a page from its link.
export const dynamicParams = false

export function generateStaticParams() {
  return DOC_SLUGS.map((slug) => ({ slug }))
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const doc = getDoc((await params).slug)
  if (!doc) return new Response('Not found', { status: 404 })
  return new Response(doc.markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
}
