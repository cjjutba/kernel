import { notFound, permanentRedirect } from 'next/navigation'
import type { Metadata } from 'next'
import { ChangelogView } from '@/components/changelog/ChangelogView'
import { changelogPage, changelogPageCount, changelogPageHref } from '@/content/changelog'
import { pageMetadata } from '@/lib/site'

// Older pages of the changelog. Page 1 lives at /changelog, so /changelog/page/1 redirects there.

type Props = { params: Promise<{ page: string }> }

const parse = (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : NaN)

export function generateStaticParams() {
  return Array.from({ length: changelogPageCount() - 1 }, (_, i) => ({ page: String(i + 2) }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = parse((await params).page)
  return pageMetadata({
    title: `Changelog, page ${page} · Kernel`,
    description: 'Earlier Kernel releases: new features, improvements and fixes.',
    path: changelogPageHref(page)
  })
}

export default async function ChangelogOlderPage({ params }: Props) {
  const page = parse((await params).page)
  if (page === 1) permanentRedirect('/changelog')
  const data = await changelogPage(page)
  if (!data) notFound()
  return <ChangelogView data={data} />
}
