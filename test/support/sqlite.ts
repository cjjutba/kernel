// vitest.config.ts aliases better-sqlite3 here, so app code under test opens its database with
// the binary built for plain Node (scripts/sqlite-node.ts) instead of the Electron one (KERNEL-735).
// require doesn't go through the alias, so this loads the real package.
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { sqliteNodeBinding } from '../../scripts/sqlite-node'

const Real: typeof Database = createRequire(import.meta.url)('better-sqlite3')
const nativeBinding = sqliteNodeBinding()

class NodeDatabase extends Real {
  constructor(filename?: string | Buffer, options?: Database.Options) {
    super(filename, { nativeBinding, ...options })
  }
}

export default NodeDatabase as unknown as typeof Database
