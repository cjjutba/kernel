import { searchIndex } from '@/lib/docs'

// What docs search reads, built with the site. components/docs/DocsSearch.tsx fetches it when search first opens.
export const dynamic = 'force-static'

export function GET() {
  return Response.json(searchIndex())
}
