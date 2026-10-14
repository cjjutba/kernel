import { ensureSqliteForNode } from '../../scripts/sqlite-node'
import { exitWhenRunnerDies } from './orphanGuard'

// Worktrees installed before KERNEL-735 have no Node build of better-sqlite3 yet.
export default function setup() {
  exitWhenRunnerDies()
  ensureSqliteForNode()
  // A commit starts `git maintenance run --auto` in the background, which takes `.git/objects/maintenance.lock` for a moment.
  // A test that copies or removes a repo meanwhile fails on a file that vanished. No test relies on git's own cleanup.
  Object.assign(process.env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0' })
}
