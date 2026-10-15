import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ChangelogView } from '@/components/changelog/ChangelogView'
import { changelogPage } from '@/content/changelog'
import { pageMetadata } from '@/lib/site'

const title = 'Changelog · Kernel'
const description = 'New features, improvements and fixes in every Kernel release.'

export const metadata: Metadata = pageMetadata({ title, description, path: '/changelog' })

export default async function ChangelogPage() {
  const data = await changelogPage(1)
  if (!data) notFound()
  return <ChangelogView data={data} />
}
