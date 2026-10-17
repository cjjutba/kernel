import { Faq } from '@/components/landing/Faq'
import { Features } from '@/components/landing/Features'
import { FinalCta } from '@/components/landing/FinalCta'
import { Hero } from '@/components/landing/Hero'
import { Privacy } from '@/components/landing/Privacy'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { latestRelease } from '@/content/changelog'
import type { Metadata } from 'next'
import { latestVersionLabel } from '@/lib/format'
import { DOWNLOAD_URL } from '@/lib/links'
import { pageMetadata, SITE_DESCRIPTION, SITE_URL } from '@/lib/site'

const title = 'Kernel · Your AI coding agents, finally organized'

export const metadata: Metadata = pageMetadata({ title, description: SITE_DESCRIPTION, path: '/' })

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Kernel',
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  operatingSystem: 'macOS',
  applicationCategory: 'DeveloperApplication',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  downloadUrl: DOWNLOAD_URL
}

export default async function Home() {
  const latest = await latestRelease()
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <SiteNav />
      <main id="content">
        <Hero version={latestVersionLabel(latest.version)} />
        <Features />
        <Privacy />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  )
}
