import type { TeammatesRunIn } from '@shared/types'

/** Where a Lead's hand-off runs, as Settings names it. A project and a hand-off can say otherwise (KERNEL-1005). */
export const RUN_IN_NAMES: Record<TeammatesRunIn, string> = { kernel: 'Kernel', terminal: 'Terminal', lead: 'Same as the Lead' }
