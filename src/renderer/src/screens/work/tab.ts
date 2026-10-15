import { oneOf, useRemembered } from '../../remember'

export type WorkTab = 'issues' | 'prs'

/** The Work page's tab is the route's name, so every link to Issues or Pull requests lands on its tab. The last one used is what the sidebar's Work opens. */
export const WORK_TABS: readonly WorkTab[] = ['issues', 'prs']

export const useWorkTab = () => useRemembered<WorkTab>('kernel.workTab', oneOf(WORK_TABS, 'issues'))
