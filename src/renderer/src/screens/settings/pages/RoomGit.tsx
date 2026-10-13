import { useEffect, useState } from 'react'
import type { AppSettings, PushCheck, PushCheckRow, RoomSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions } from '../../../store'
import { Button, CodeBlock, Icon, SegmentedControl, Select, Spinner, useBusy } from '../../../ui'
import { isOverride, LinesField, NoRoom, Row, RoomPage, Section, sourceLine, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'
import { BranchPattern } from './Git'

const USE_DEFAULT = ''
const withCurrent = (list: string[], current: string) => [...new Set([current, ...list])].map((v) => ({ value: v, label: v }))
const ON_OFF = [{ value: USE_DEFAULT, label: 'Use default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]
const onOff = (v: boolean | undefined) => (v === undefined ? USE_DEFAULT : v ? 'on' : 'off')
const MODE: Record<AppSettings['workspace']['mode'], string> = { worktree: 'New worktree', current: 'Current branch' }

const REACHED: Record<PushCheckRow['state'], string> = { ok: 'Reached', fail: 'Failed', unchecked: 'Not checked' }
const PUSHES: Record<PushCheckRow['state'], string> = { ok: 'Can push', fail: 'Can’t push', unchecked: 'Not checked' }

/** "just now", "2 minutes ago", for Last checked. */
export function checkedAgo(at: number, now = Date.now()): string {
  const m = Math.floor((now - at) / 60_000)
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`
  if (m < 1) return 'just now'
  if (m < 60) return unit(m, 'minute')
  return m < 24 * 60 ? unit(Math.floor(m / 60), 'hour') : unit(Math.floor(m / (24 * 60)), 'day')
}

/** One push check row: its result in words with an icon and no dot, and under it git's error, the fix or what to try (KERNEL-437). */
function PushRow({ label, row, words }: { label: string; row?: PushCheckRow; words: Record<PushCheckRow['state'], string> }) {
  const more = row && (row.output || row.fix || row.note)
  return (
    <Row label={label} desc={row?.detail} full={more ? (
      <div className="set-push-more">
        {row.output && <pre className="code boxed">{row.output}</pre>}
        {row.fix && <CodeBlock>{row.fix}</CodeBlock>}
        {row.note && <p className="set-desc">{row.note}</p>}
      </div>
    ) : undefined}>
      {row
        ? <span className="set-result" data-state={row.state}>{row.state === 'ok' && <Icon name="check" size={14} />}{row.state === 'fail' && <Icon name="xCircle" size={14} />}{words[row.state]}</span>
        : <span className="set-result"><Spinner label="Checking" />Checking</span>}
    </Row>
  )
}

/**
 * Push access (SettingsRoomGit.png, SettingsRoomGitPushFailed.png, SettingsRoomGitUnreachable.png): whether git can reach
 * the room's remote and push to it, from the last check. Check again runs it now. A room with no remote has no section.
 */
function PushAccess({ roomId, remote }: { roomId: string; remote: string }) {
  const [check, setCheck] = useState<PushCheck | null>()
  const [busy, run] = useBusy()
  const [, tick] = useState(0)
  useEffect(() => {
    let stale = false
    setCheck(undefined)
    call('rooms.pushCheck', { roomId }).then((c) => { if (!stale) setCheck(c) }, () => { if (!stale) setCheck(null) })
    return () => { stale = true }
  }, [roomId, remote])
  // Last checked keeps counting while the page is open.
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t) }, [])
  const recheck = () => run('recheck', async () => {
    try { setCheck(await call('rooms.pushCheck', { roomId, recheck: true })) } catch (e) { actions.ui.toast({ title: 'Could not check push access', sub: cleanError(e) }) }
  })
  if (check === null) return null
  const name = check?.remote ?? remote
  return (
    <Section title="Push access" action={<Button busy={busy === 'recheck'} busyLabel="Checking" disabled={busy !== null || !check} onClick={() => void recheck()}>Check again</Button>} note={check && `Last checked ${checkedAgo(check.at)}.`}>
      <PushRow label={`Reach ${name}`} row={check?.reach} words={REACHED} />
      <PushRow label="Permission to push" row={check?.push} words={PUSHES} />
    </Section>
  )
}

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
      <PushAccess roomId={roomId} remote={remote} />
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
