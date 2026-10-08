import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared } },
  preload: { plugins: [externalizeDepsPlugin()], resolve: { alias: shared } },
  // Fonts stay files, never data: URIs, so the CSP can keep font-src to 'self' (D-054).
  renderer: { plugins: [react()], resolve: { alias: shared }, build: { assetsInlineLimit: 0 } }
})
