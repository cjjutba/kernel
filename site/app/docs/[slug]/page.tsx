import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { DocsShell } from '@/components/docs/DocsShell'
import { DOC_SLUGS, getDoc } from '@/lib/docs'
import { pageMetadata } from '@/lib/site'

type Props = { params: Promise<{ slug: string }> }

export const dynamicParams = false

export function generateStaticParams() {
  return DOC_SLUGS.filter((s) => s !== 'introduction').map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = getDoc((await params).slug)
  if (!doc) return {}
  return pageMetadata({ title: `${doc.title} · Kernel docs`, description: doc.description, path: doc.href })
}

export default async function DocRoute({ params }: Props) {
  const { slug } = await params
  // The introduction lives at /docs.
  if (slug === 'introduction') redirect('/docs')
  const doc = getDoc(slug)
  if (!doc) notFound()
  return <DocsShell page={doc} />
}
