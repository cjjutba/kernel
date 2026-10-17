import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ReleaseEntry } from '@/components/changelog/ReleaseEntry'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { Container } from '@/components/ui/Container'
import { changelog, latestRelease, publishedRelease, releaseHref } from '@/content/changelog'
import { pageMetadata } from '@/lib/site'

// One release on its own page, linked from its title on the changelog. A release file shows here only once GitHub
// has published its release, like on the changelog (KERNEL-412).

type Props = { params: Promise<{ version: string }> }

export function generateStaticParams() {
  return changelog.releases.map((r) => ({ version: r.version }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const release = await publishedRelease((await params).version)
  if (!release) return {}
  const { version, title, intro } = release
  const base = pageMetadata({
    title: title === `Kernel ${version}` ? `${title} · Changelog` : `${title} · Kernel ${version}`,
    description: intro ?? `New features, improvements and fixes in Kernel ${version}.`,
    path: releaseHref(version)
  })
  return { ...base, alternates: { ...base.alternates, types: { 'application/rss+xml': '/changelog/rss.xml' } } }
}

export default async function ReleasePage({ params }: Props) {
  const release = await publishedRelease((await params).version)
  if (!release) notFound()
  const latest = (await latestRelease()).version === release.version
  return (
    <>
      <SiteNav current="/changelog" />
      <main id="content">
        <Container size="changelog" className="pt-32 pb-24 max-nav:pt-20 max-nav:pb-16">
          <ReleaseEntry release={release} latest={latest} standalone />
        </Container>
      </main>
      <SiteFooter />
    </>
  )
}
