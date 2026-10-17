import type { Workspace } from '@shared/types'
import { isLeadChatWorkspace } from '@shared/leadWorkspace'

/**
 * The chat doesn't wait for setup: a Lead chat with nothing held for setup in main (KERNEL-490). Its first message went at
 * once, or Kernel opened it with none, and no brief is on its way, so what you send goes at once, or waits in main if the chat is held.
 */
export const skipsSetup = (ws: Workspace, held: boolean) => isLeadChatWorkspace(ws) && !held

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
