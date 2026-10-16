// The landing page demo: the real renderer built for a plain browser, with the story (demo/story.ts) and the fixture
// handlers from the main process running in the page. `pnpm demo:build` writes it to site/public/demo, which the site serves at /demo/.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = (p: string) => resolve(__dirname, p)
const empty = here('shims/empty.ts')
// Real stand-ins for the Node modules the fixture handlers call. Everything else Node is `empty`: importing it works, calling it throws.
const shims: Record<string, string> = {
  fs: here('shims/fs.ts'),
  path: here('shims/path.ts'),
  events: here('shims/events.ts'),
  crypto: here('shims/crypto.ts'),
  util: here('shims/util.ts'),
  module: here('shims/module.ts')
}
const nodeOnly = ['fs', 'child_process', 'os', 'net', 'electron', 'electron-updater', 'better-sqlite3']

export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [
    react(),
    {
      name: 'node-stand-ins',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'node:fs' || id === 'fs') return shims.fs
        const bare = id.replace(/^node:/, '').split('/')[0]!
        if (id.startsWith('node:') || nodeOnly.includes(bare)) return shims[bare] ?? empty
        // The Agent SDK arrives through services/claudeSettings.ts and runs Node code when it loads. The demo never starts a session.
        if (id.startsWith('@anthropic-ai/claude-agent-sdk') || id.startsWith('@openai/codex')) return empty
        return null
      }
    }
  ],
  resolve: { alias: { '@shared': here('../src/shared') } },
  define: { __KERNEL_TELEMETRY__: JSON.stringify({ key: '', host: '' }), 'process.env': '{}', 'process.platform': '"darwin"', 'process.versions': '{}' },
  build: {
    outDir: here('../site/public/demo'),
    emptyOutDir: true,
    minify: 'esbuild',
    // About 1,250 file icons are tiny SVGs. Inlined, the demo is a few dozen files instead of over a thousand requests.
    assetsInlineLimit: (file) => file.endsWith('.svg'),
    chunkSizeWarningLimit: 5000,
    // Named imports of a Node stand-in that doesn't define them become undefined instead of failing the build.
    rollupOptions: { shimMissingExports: true }
  }
})
