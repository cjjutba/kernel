import type { Workspace } from '@shared/types'

/**
 * The chat doesn't wait for setup unless main actually holds something for it (KERNEL-490, KERNEL-1012). With Wait for setup off, the
 * default, a brief and a Lead's messages go out once the worktree exists, so a teammate's chat shows its transcript and stays open
 * while setup runs. Only a chat whose queue reason is `setup` is held.
 */
export const skipsSetup = (held: boolean) => !held

/**
 * What a chat shows while its workspace sets up, or after its setup failed: `wait` draws SetupWait in place of the transcript, and
 * `shut` closes the composer. A teammate's brief goes in the chat's queue as setup starts and nothing may go before it, so until it
 * waits there the composer stays shut (KERNEL-430). A chat with history has no brief on its way, so it stays open and its held
 * messages wait in the queue above the box (KERNEL-1018). A chat that skips setup stays open and shows its transcript. Only a failed setup
 * with nothing sent yet draws SetupWait there, for Run again and Send anyway (KERNEL-490).
 */
export function setupGate(o: { status: Workspace['status']; skips: boolean; held: boolean; empty: boolean }): { wait: boolean; shut: boolean } {
  const setup = o.status === 'setup'
  const failed = o.status === 'failed'
  if (o.skips) return { wait: failed && o.empty, shut: false }
  return { wait: (setup || failed) && o.empty, shut: setup && !o.held && o.empty }
}
