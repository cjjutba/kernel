import type { Workspace } from '@shared/types'

/**
 * The chat never waits for the setup script (KERNEL-490, KERNEL-1012, KERNEL-1086). A brief and a Lead's messages go out once the
 * worktree exists, so a teammate's chat shows its transcript and stays open while setup runs. Only a chat whose queue reason is
 * `worktree` is held.
 */
export const skipsSetup = (held: boolean) => !held

/**
 * What a chat shows while its workspace is made, or after it failed to start: `wait` draws WorktreeWait in place of the transcript, and
 * `shut` closes the composer. A teammate's brief goes in the chat's queue as setup starts and nothing may go before it, so until it
 * waits there the composer stays shut (KERNEL-430). A chat with history has no brief on its way, so it stays open and its held
 * messages wait in the queue above the box (KERNEL-1018). A chat that isn't held stays open and shows its transcript. Only a failed
 * workspace with nothing sent yet draws WorktreeWait there, for Try again (KERNEL-490).
 */
export function setupGate(o: { status: Workspace['status']; skips: boolean; held: boolean; empty: boolean }): { wait: boolean; shut: boolean } {
  const setup = o.status === 'setup'
  const failed = o.status === 'failed'
  if (o.skips) return { wait: failed && o.empty, shut: false }
  return { wait: (setup || failed) && o.empty, shut: setup && !o.held && o.empty }
}
