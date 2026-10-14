import './rooms.css'
import { useEffect, useState } from 'react'
import type { AppSettings, PushCheck, PushCheckRow, RoomSettings } from '@shared/types'
import { call, cleanError } from '../../../api'
import { actions } from '../../../store'
import { Button, CodeBlock, Select, useBusy } from '../../../ui'
import { isOverride, NoRoom, Row, RoomPage, Section, StatusLine, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

const USE_DEFAULT = ''
const MODE: Record<AppSettings['workspace']['mode'], string> = { worktree: 'New worktree', current: 'Current branch' }
const onOff = (v: boolean | undefined) => (v === undefined ? USE_DEFAULT : v ? 'on' : 'off')
const yesNo = (on: boolean) => (on ? 'On' : 'Off')

/** "just now", "2 minutes ago", for Checked. */
export function checkedAgo(at: number, now = Date.now()): string {
  const m = Math.floor((now - at) / 60_000)
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'} ago`
  if (m < 1) return 'just now'
  if (m < 60) return unit(m, 'minute')
  return m < 24 * 60 ? unit(Math.floor(m / 60), 'hour') : unit(Math.floor(m / (24 * 60)), 'day')
}

/** What a failed row adds under the status: git's own error, the fix to copy, what to try. */
function FailDetail({ row }: { row: PushCheckRow }) {
  if (!row.output && !row.fix && !row.note) return null
  return (
    <div className="rm-fail">
      {row.output && <pre className="code boxed">{row.output}</pre>}
      {row.fix && <CodeBlock>{row.fix}</CodeBlock>}
      {row.note && <p className="set-note">{row.note}</p>}
    </div>
  )
}

/**
 * Push access (MorePage roomGit, KERNEL-680): whether git can reach the room's remote and push to it, from the last check, as one
 * status line. Check again runs it now. A room with no remote has no line.
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
  // The age keeps counting while the page is open.
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t) }, [])
  const recheck = () => run('recheck', async () => {
    try { setCheck(await call('rooms.pushCheck', { roomId, recheck: true })) } catch (e) { actions.ui.toast({ title: 'Could not check push access', sub: cleanError(e) }) }
  })
  if (check === null) return null
  const name = check?.remote ?? remote
  const failed = check && (check.reach.state === 'fail' ? check.reach : check.push.state === 'fail' ? check.push : undefined)
  const title = !check ? `Checking ${name}` : check.reach.state === 'fail' ? `Can’t reach ${name}` : check.push.state === 'fail' ? `Can’t push to ${name}` : check.push.state === 'ok' ? `Can push to ${name}` : 'Push access not checked'
  const sub = !check ? undefined : [failed?.detail, `Checked ${checkedAgo(check.at)}`].filter(Boolean).join(' · ')
  return (
    <Section label="Push access" plain>
      <StatusLine
        icon={!check ? 'clock' : failed ? 'xCircle' : 'check'} tone={failed ? 'warn' : check?.push.state === 'ok' ? 'ok' : undefined} title={title} sub={sub}
        action={<Button busy={busy === 'recheck'} busyLabel="Checking" disabled={busy !== null || !check} onClick={() => void recheck()}>Check again</Button>}
      />
      {failed && <FailDetail row={failed} />}
    </Section>
  )
}

/** The pattern keeps `{slug}`, or every chat would get one branch name. Empty goes back to the default. */
function LeadPattern({ value, placeholder, save }: { value: string; placeholder: string; save: (v: string | null) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  const commit = () => {
    const next = text.trim()
    if (next === value) return
    if (!next) return save(null)
    if (!next.includes('{slug}')) return setText(value)
    save(next)
  }
  return <input className="set-inline set-boxed" aria-label="Branch names for chats with Kernel" spellCheck={false} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}

/** Settings > a room > Git (MorePage roomGit, KERNEL-680): the room's overrides of the app's Git defaults. Each Select starts with "Default (the app's value)", and Reset goes back to it. */
export function RoomGit({ roomId, s }: { roomId?: string; s: AppSettings }) {
  const { room, rs } = useRoomPage(roomId)
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    if (roomId) void call('git.branches', { roomId }).then(setBranches).catch(() => setBranches([]))
  }, [roomId])
  if (!room || !roomId) return <NoRoom />
  const app = s.workspace
  const set = (patch: Partial<Record<keyof RoomSettings['workspace'], string | boolean | null>>) => void patchRoomSettings(roomId, { workspace: patch as never })
  const reset = (key: keyof RoomSettings['workspace']) => (isOverride(rs, `workspace.${key}`) ? () => set({ [key]: null }) : undefined)
  const choice = (appValue: string, list: { value: string; label: string }[]) => [{ value: USE_DEFAULT, label: `Default (${appValue})` }, ...list]
  const flag = (key: 'deleteBranchOnArchive' | 'archiveOnMerge' | 'archiveChatWorkspaces', label: string) => (
    <Row label={label} onReset={reset(key)}>
      <Select label={label} align="right" value={onOff(rs?.workspace[key])} onChange={(v) => set({ [key]: v ? v === 'on' : null })} options={choice(yesNo(app[key]), [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }])} />
    </Row>
  )
  const own = (key: 'baseRef' | 'remote') => rs?.workspace[key] ?? USE_DEFAULT
  const named = (list: string[], current: string) => [...new Set([...(current ? [current] : []), ...list])].map((v) => ({ value: v, label: v }))
  const remotes = [...new Set(branches.filter((b) => b.includes('/')).map((b) => b.split('/')[0]))]
  return (
    <RoomPage room={room} rs={rs} title="Git">
      <PushAccess roomId={roomId} remote={rs?.workspace.remote ?? app.remote} />
      <Section title="New workspaces" scope="mac">
        <Row setting="workspace.mode" label="Workspace type" onReset={reset('mode')}>
          <Select label="Workspace type" align="right" value={rs?.workspace.mode ?? USE_DEFAULT} onChange={(v) => set({ mode: v || null })} options={choice(MODE[app.mode], [{ value: 'worktree', label: 'New worktree' }, { value: 'current', label: 'Current branch' }])} />
        </Row>
        <Row setting="workspace.baseRef" label="Branch from" onReset={reset('baseRef')}>
          <Select label="Branch from" align="right" value={own('baseRef')} onChange={(v) => set({ baseRef: v || null })} options={choice(app.baseRef, named(branches, own('baseRef')))} />
        </Row>
        <Row label="Remote" onReset={reset('remote')}>
          <Select label="Remote" align="right" value={own('remote')} onChange={(v) => set({ remote: v || null })} options={choice(app.remote, named(remotes.length ? remotes : ['origin'], own('remote')))} />
        </Row>
        <Row setting="workspace.leadBranchPattern" label="Branch names for chats with Kernel" onReset={reset('leadBranchPattern')}>
          <LeadPattern value={rs?.workspace.leadBranchPattern ?? ''} placeholder={`${app.leadBranchPattern}  Default`} save={(v) => set({ leadBranchPattern: v })} />
        </Row>
      </Section>
      <Section title="Cleanup" scope="mac">
        {flag('deleteBranchOnArchive', 'Delete the branch on archive')}
        {flag('archiveOnMerge', 'Archive on merge')}
        {flag('archiveChatWorkspaces', 'Archive a chat’s workspaces with it')}
      </Section>
    </RoomPage>
  )
}
