import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared } },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared } },
  // Fonts stay files, never data: URIs, so the CSP can keep font-src to 'self' (D-054). The two floor SVGs are the exception: they
  // are only drawn by the lazy Floor chunk (hidden, D-104), so they live in that chunk as data: URIs, not as two 34 KB files nothing fetches.
  renderer: {
    plugins: [react()],
    resolve: { alias: shared },
    build: { minify: 'esbuild', assetsInlineLimit: (file) => /\/floor\/floor(-light)?\.svg$/.test(file) }
  }
})
