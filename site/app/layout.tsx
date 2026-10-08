import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Geist_Mono, Inter } from 'next/font/google'
import { SITE_DESCRIPTION, SITE_URL, THEME_COLOR } from '@/lib/site'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })
const geistMono = Geist_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-geist-mono', display: 'swap' })

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Kernel',
  description: SITE_DESCRIPTION,
  openGraph: { type: 'website', siteName: 'Kernel' },
  twitter: { card: 'summary_large_image' }
}

export const viewport: Viewport = { themeColor: THEME_COLOR, colorScheme: 'dark' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable}`}>
      <body>
        <a
          href="#content"
          className="sr-only z-50 rounded-md bg-ink px-3 text-ui font-medium text-canvas focus-visible:not-sr-only focus-visible:fixed focus-visible:top-4 focus-visible:left-4 focus-visible:inline-flex focus-visible:h-8 focus-visible:items-center"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  )
}
