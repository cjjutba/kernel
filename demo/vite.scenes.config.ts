// The scenes the landing page's feature clips are recorded from (demo/clips.ts). The same renderer and stand-ins as the
// demo, built to out/scenes and never shipped: the clips are.
import { resolve } from 'node:path'
import { mergeConfig } from 'vite'
import base from './vite.config'

export default mergeConfig(base, {
  root: resolve(__dirname, 'scenes'),
  build: { outDir: resolve(__dirname, '../out/scenes'), emptyOutDir: true }
})
