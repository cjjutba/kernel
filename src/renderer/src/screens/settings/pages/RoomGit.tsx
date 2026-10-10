import { useEffect, useState } from 'react'
import type { AppSettings, RoomSettings } from '@shared/types'
import { call } from '../../../api'
import { SegmentedControl, Select } from '../../../ui'
import { isOverride, NoRoom, Row, RoomPage, Section, sourceLine, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

const USE_DEFAULT = ''
const withCurrent = (list: string[], current: string) => [...new Set([current, ...list])].map((v) => ({ value: v, label: v }))
const MODE: Record<AppSettings['workspace']['mode'], string> = { worktree: 'New worktree', current: 'Current branch' }

/** Settings > a room > Git (SettingsRoomGit.png): the room's overrides of the app's Git defaults. A field the room leaves alone shows the app's value. */
export function RoomGit({ roomId, s }: { roomId?: string; s: AppSettings }) {
  const { room, rs } = useRoomPage(roomId)
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    if (roomId) void call('git.branches', { roomId }).then(setBranches).catch(() => setBranches([]))
  }, [roomId])
  if (!room || !roomId) return <NoRoom />
  const app = s.workspace
  const set = (patch: Partial<Record<keyof RoomSettings['workspace'], string | null>>) => void patchRoomSettings(roomId, { workspace: patch as never })
  const reset = (key: 'mode' | 'baseRef' | 'remote') => (isOverride(rs, `workspace.${key}`) ? () => set({ [key]: null }) : undefined)
  // The source line when the room's file says where the value is from, else what the app default is.
  const note = (key: 'mode' | 'baseRef' | 'remote', appValue: string) => ({ source: sourceLine(rs, `workspace.${key}`), desc: sourceLine(rs, `workspace.${key}`) ? undefined : `The app default is ${appValue}` })
  const base = rs?.workspace.baseRef ?? app.baseRef
  const remote = rs?.workspace.remote ?? app.remote
  const remotes = [...new Set(branches.filter((b) => b.includes('/')).map((b) => b.split('/')[0]))]
  return (
    <RoomPage room={room} rs={rs} title="Git" intro={`Overrides for ${room.name}. Anything else follows the app default.`}>
      <Section title="New workspaces">
        <Row label="Default workspace type" {...note('mode', MODE[app.mode])}>
          <SegmentedControl label="Default workspace type" value={rs?.workspace.mode ?? USE_DEFAULT} onChange={(v) => set({ mode: v || null })} options={[{ value: USE_DEFAULT, label: 'Use default' }, { value: 'worktree', label: 'New worktree' }, { value: 'current', label: 'Current branch' }]} />
        </Row>
        <Row label="Branch new workspaces from" {...note('baseRef', app.baseRef)} onReset={reset('baseRef')}>
          <Select label="Branch new workspaces from" value={base} options={withCurrent(branches, base)} onChange={(e) => set({ baseRef: e.target.value })} />
        </Row>
        <Row label="Remote origin" {...note('remote', app.remote)} onReset={reset('remote')}>
          <Select label="Remote origin" value={remote} options={withCurrent(remotes.length ? remotes : ['origin'], remote)} onChange={(e) => set({ remote: e.target.value })} />
        </Row>
      </Section>
    </RoomPage>
  )
}
