import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteNav } from '@/components/layout/SiteNav'

export default function Home() {
  return (
    <>
      <SiteNav />
      <main id="content" />
      <SiteFooter />
    </>
  )
}
