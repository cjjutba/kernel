import type { Tracker } from '@shared/types'

export const NO_TRACKER = 'This project has no issue tracker.'

/** A project with no issue tracker (KERNEL-462): no issues to list, none to read or file, nothing to move. */
export function noneTracker(): Tracker {
  return {
    kind: 'none',
    search: async () => [],
    issue: async () => { throw new Error(NO_TRACKER) },
    start: async () => undefined,
    create: async () => { throw new Error(NO_TRACKER) },
    edit: async () => { throw new Error(NO_TRACKER) }
  }
}
