import { useEffect, useState } from 'react'
import type { AppSettings, RoomSettings } from '@shared/types'
import { call } from '../../../api'
import { SegmentedControl, Select } from '../../../ui'
import { isOverride, LinesField, NoRoom, Row, RoomPage, Section, sourceLine, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'
import { BranchPattern } from './Git'

const USE_DEFAULT = ''
const withCurrent = (list: string[], current: string) => [...new Set([current, ...list])].map((v) => ({ value: v, label: v }))
const ON_OFF = [{ value: USE_DEFAULT, label: 'Use default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]
const onOff = (v: boolean | undefined) => (v === undefined ? USE_DEFAULT : v ? 'on' : 'off')
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
  const set = (patch: Partial<Record<keyof RoomSettings['workspace'], string | boolean | null>>) => void patchRoomSettings(roomId, { workspace: patch as never })
  const reset = (key: 'mode' | 'baseRef' | 'remote') => (isOverride(rs, `workspace.${key}`) ? () => set({ [key]: null }) : undefined)
  // The source line when the room's file says where the value is from, else what the app default is.
  const note = (key: 'mode' | 'baseRef' | 'remote' | 'deleteBranchOnArchive' | 'archiveOnMerge' | 'leadWaitForSetup' | 'archiveChatWorkspaces', appValue: string) => ({ source: sourceLine(rs, `workspace.${key}`), desc: sourceLine(rs, `workspace.${key}`) ? undefined : `The app default is ${appValue}` })
  // An empty list is saved as one when settings.toml has a list, so the field can be cleared; else the key goes (KERNEL-401).
  const saveOptional = (lines: string[]) => void patchRoomSettings(roomId, { pr: { optionalChecks: lines.length || rs?.sources['pr.optionalChecks'] === 'shared' || rs?.sources['pr.optionalChecks'] === 'override' ? lines : null } })
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
      <Section title="Cleanup">
        <Row label="Delete branch on archive" {...note('deleteBranchOnArchive', app.deleteBranchOnArchive ? 'On' : 'Off')}>
          <SegmentedControl label="Delete branch on archive" value={onOff(rs?.workspace.deleteBranchOnArchive)} onChange={(v) => set({ deleteBranchOnArchive: v ? v === 'on' : null })} options={ON_OFF} />
        </Row>
        <Row label="Archive on merge" {...note('archiveOnMerge', app.archiveOnMerge ? 'On' : 'Off')}>
          <SegmentedControl label="Archive on merge" value={onOff(rs?.workspace.archiveOnMerge)} onChange={(v) => set({ archiveOnMerge: v ? v === 'on' : null })} options={ON_OFF} />
        </Row>
      </Section>
      <Section title="Pull requests">
        <Row label="Optional checks" source={sourceLine(rs, 'pr.optionalChecks')} onReset={isOverride(rs, 'pr.optionalChecks') ? () => void patchRoomSettings(roomId, { pr: { optionalChecks: null } }) : undefined} full={
          <>
            <LinesField label="Optional checks" value={rs?.pr?.optionalChecks ?? []} onSave={saveOptional} />
            <p className="set-hint">One check name per line. <code>*</code> matches anything, like <code>Vercel*</code>. A check on this list that fails doesn’t mark a pull request as failed, when GitHub requires no checks on this repo. A check GitHub requires always counts.</p>
          </>
        } />
      </Section>
      <Section title="Lead chats">
        <Row label="Branch name pattern" source={sourceLine(rs, 'workspace.leadBranchPattern')} desc={sourceLine(rs, 'workspace.leadBranchPattern') ? undefined : `The app default is ${app.leadBranchPattern}`} onReset={isOverride(rs, 'workspace.leadBranchPattern') ? () => set({ leadBranchPattern: null }) : undefined}>
          <BranchPattern value={rs?.workspace.leadBranchPattern ?? ''} label="Lead chat branch name pattern" placeholder={app.leadBranchPattern} save={(v) => set({ leadBranchPattern: v })} />
        </Row>
        <Row label="Wait for setup before the first message" {...note('leadWaitForSetup', app.leadWaitForSetup ? 'On' : 'Off')}>
          <SegmentedControl label="Wait for setup before the first message" value={onOff(rs?.workspace.leadWaitForSetup)} onChange={(v) => set({ leadWaitForSetup: v ? v === 'on' : null })} options={ON_OFF} />
        </Row>
        <Row label="Archive a chat's workspaces with it" {...note('archiveChatWorkspaces', app.archiveChatWorkspaces ? 'On' : 'Off')}>
          <SegmentedControl label="Archive a chat's workspaces with it" value={onOff(rs?.workspace.archiveChatWorkspaces)} onChange={(v) => set({ archiveChatWorkspaces: v ? v === 'on' : null })} options={ON_OFF} />
        </Row>
      </Section>
    </RoomPage>
  )
}
