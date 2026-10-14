// Tests run on plain Node, but postinstall builds better-sqlite3 for Electron's ABI (KERNEL-735).
// This puts a second copy built for the running Node at node_modules/.kernel/better_sqlite3-<abi>.node,
// which test/support/sqlite.ts passes as nativeBinding. The app's own binary isn't touched.
// Runs from postinstall and from vitest's globalSetup, and does nothing when the file exists.
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A string, not new URL: happy-dom tests replace the global URL.
const root = dirname(dirname(fileURLToPath(import.meta.url)))

export const sqliteNodeBinding = (abi = process.versions.modules) => join(root, 'node_modules/.kernel', `better_sqlite3-${abi}.node`)

export function ensureSqliteForNode(): string {
  const target = sqliteNodeBinding()
  if (existsSync(target)) return target
  const pkg = realpathSync(join(root, 'node_modules/better-sqlite3'))
  const work = mkdtempSync(join(tmpdir(), 'kernel-sqlite-'))
  try {
    // prebuild-install and node-gyp both write build/Release under their working folder,
    // so they run on a copy and never replace the Electron build in the package.
    const built = join(work, 'build/Release/better_sqlite3.node')
    copyFileSync(join(pkg, 'package.json'), join(work, 'package.json'))
    const prebuild = createRequire(join(pkg, 'package.json')).resolve('prebuild-install/bin.js')
    const flags = ['--runtime=node', `--target=${process.versions.node}`, `--arch=${process.arch}`, `--platform=${process.platform}`]
    try {
      execFileSync(process.execPath, [prebuild, ...flags], { cwd: work, stdio: 'inherit' })
    } catch {
      console.warn('No prebuilt better-sqlite3 for this Node, building it with node-gyp')
    }
    if (!existsSync(built)) {
      cpSync(pkg, work, { recursive: true, filter: (from) => !from.startsWith(join(pkg, 'build')) })
      const gyp = join(root, 'node_modules/.pnpm/node_modules/node-gyp/bin/node-gyp.js')
      execFileSync(process.execPath, [gyp, 'rebuild', '--release', `--target=${process.versions.node}`], { cwd: work, stdio: 'inherit' })
    }
    mkdirSync(join(root, 'node_modules/.kernel'), { recursive: true })
    // Copy next to the target, then rename, so a test run starting at the same time never loads half a file.
    const partial = `${target}.${process.pid}.partial`
    copyFileSync(built, partial)
    renameSync(partial, target)
    return target
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureSqliteForNode()
