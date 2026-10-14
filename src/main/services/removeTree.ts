import { createRequire } from 'node:module'
import * as nodeFs from 'node:fs'

/**
 * Electron's `fs` reads a `.asar` file as a folder, so a recursive `rm` of a tree holding one, such as a worktree's
 * `node_modules/electron/dist/Electron.app/.../default_app.asar`, fails with ENOTEMPTY (KERNEL-810). `original-fs` is the
 * plain Node `fs`. It only exists under Electron, so it is loaded at run time and vitest on plain Node needs no alias.
 */
const fs: typeof nodeFs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs

/** Deletes a file or folder and everything in it. A path that is already gone is fine. */
export function removeTree(path: string): Promise<void> {
  return fs.promises.rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
