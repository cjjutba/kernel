import { Hero } from '@/components/landing/Hero'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'
import { latestVersionLabel } from '@/lib/format'

export default function Home() {
  return (
    <>
      <SiteNav />
      <main id="content">
        <Hero version={latestVersionLabel('0.1.0')} />
      </main>
      <SiteFooter />
    </>
  )
}
