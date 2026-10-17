/**
 * Terminal seats (KERNEL-996) are off in v1 (KERNEL-1034). Off, a big terminal tab is a plain terminal, every hand-off runs
 * in Kernel, and Settings, Terminal's connect and teammates-run-in are ignored. A teammate seat made before it went off keeps
 * running as one. True brings all of it back as it was.
 */
export const SEATS_ENABLED = false
