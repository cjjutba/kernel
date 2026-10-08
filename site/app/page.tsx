import { Details } from '@/components/landing/Details'
import { Faq } from '@/components/landing/Faq'
import { FinalCta } from '@/components/landing/FinalCta'
import { Hero } from '@/components/landing/Hero'
import { HowItWorks } from '@/components/landing/HowItWorks'
import { Privacy } from '@/components/landing/Privacy'
import { ProductTour } from '@/components/landing/ProductTour'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { latestRelease } from '@/content/changelog'
import type { Metadata } from 'next'
import { latestVersionLabel } from '@/lib/format'
import { DOWNLOAD_URL } from '@/lib/links'
import { pageMetadata, SITE_DESCRIPTION, SITE_URL } from '@/lib/site'

const title = 'Kernel · Your coding agents, working as a team'

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

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <SiteNav />
      <main id="content">
        <Hero version={latestVersionLabel(latestRelease.version)} />
        <HowItWorks />
        <ProductTour />
        <Details />
        <Privacy />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  )
}
