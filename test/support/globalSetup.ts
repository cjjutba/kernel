import { ensureSqliteForNode } from '../../scripts/sqlite-node'

// Worktrees installed before KERNEL-735 have no Node build of better-sqlite3 yet.
export default function setup() {
  ensureSqliteForNode()
}
