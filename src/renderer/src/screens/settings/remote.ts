import type { AppSettings, RoomSettings } from '@shared/types'

/** The git remote a room uses: its own setting, then the app's, then `origin`. Main picks the same way (`remoteOf`, KERNEL-190). */
export const remoteOf = (room: Pick<RoomSettings, 'workspace'> | null | undefined, app: Pick<AppSettings, 'workspace'> | null | undefined): string =>
  room?.workspace.remote?.trim() || app?.workspace.remote?.trim() || 'origin'

/**
 * A branch ref without its remote: `origin/main` is `main`. A ref written as `origin/` means the room's remote, so both prefixes go,
 * and a ref on another remote keeps its name.
 */
export function stripRemote(ref: string, remote: string): string {
  for (const r of [remote, 'origin']) if (ref.startsWith(`${r}/`)) return ref.slice(r.length + 1)
  return ref
}
