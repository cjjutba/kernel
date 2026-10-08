import type { NextConfig } from 'next'

const config: NextConfig = {
  // The e2e server builds into its own folder so it never clobbers a dev or production build.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // site/ has its own lockfile. Without this Next picks the Electron app's lockfile as the workspace root.
  outputFileTracingRoot: import.meta.dirname,
  turbopack: { root: import.meta.dirname },
  poweredByHeader: false,
  // Stops `next dev` from writing an AGENTS.md into site/ when it detects a coding agent.
  agentRules: false,
  // Screenshots are mostly small UI text, which blurs at the default quality of 75.
  images: { formats: ['image/avif', 'image/webp'], qualities: [90] }
}

export default config
