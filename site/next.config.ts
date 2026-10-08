import type { NextConfig } from 'next'

const config: NextConfig = {
  // The e2e server builds into its own folder so it never clobbers a dev or production build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // site/ has its own lockfile. Without this Next picks the Electron app's lockfile as the workspace root.
  outputFileTracingRoot: import.meta.dirname,
  turbopack: { root: import.meta.dirname },
  poweredByHeader: false,
  images: { formats: ['image/avif', 'image/webp'] }
}

export default config
