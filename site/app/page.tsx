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
import { latestVersionLabel } from '@/lib/format'

export default function Home() {
  return (
    <>
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
