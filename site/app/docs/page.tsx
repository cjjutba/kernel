import type { Metadata } from 'next'
import { DocsShell } from '@/components/docs/DocsShell'
import { getDoc } from '@/lib/docs'
import { pageMetadata } from '@/lib/site'

const page = getDoc('introduction')!

export const metadata: Metadata = pageMetadata({ title: 'Docs · Kernel', description: page.description, path: '/docs' })

export default function DocsHome() {
  return <DocsShell page={page} />
}
