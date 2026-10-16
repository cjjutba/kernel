import type { HookStatus } from '@shared/types'

/** Whether a first run opens Check hooks: hooks aren't installed, and this isn't a workspace run, which never installs them (KERNEL-679). */
export const needsHookCheck = (hooks: HookStatus | null) => !!hooks && !hooks.installed && hooks.problem?.kind !== 'workspace-run'
