import { dirname } from 'node:path'

/**
 * Where an open dialog starts. Since Electron 43 a dialog with no `defaultPath` opens in Downloads and macOS no longer
 * brings back the folder last picked from, so each picker remembers it until Kernel quits (KERNEL-223).
 */
export function lastFolder() {
  let last: string | undefined
  return {
    get defaultPath() { return last },
    picked(paths: string[]) { if (paths[0]) last = dirname(paths[0]) }
  }
}
