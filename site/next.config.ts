import type { NextConfig } from 'next'

const config: NextConfig = {
  // The e2e server builds into its own folder so it never clobbers a dev or production build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  images: { formats: ['image/avif', 'image/webp'] }
}

export default config
