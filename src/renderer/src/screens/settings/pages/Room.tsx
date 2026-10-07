import { useEffect, useState } from 'react'
import type { AppSettings, RoomSettings } from '@shared/types'
import { call } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, SegmentedControl, Select } from '../../../ui'
import { sourceOf } from '../../rooms/roomInfo'
import { NoRoom, Page, Row, Section, TextField } from '../kit'
import { patchRoomSettings, useRoomSettings } from '../useSettings'

const USE_DEFAULT = ''
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** Settings > a room (SettingsRoom.png): what the room is, the app defaults it overrides, and the Always allow rules approvals saved for it. */
export function Room({ roomId, s }: { roomId?: string; s: AppSettings }) {
  const room = useStore((x) => x.rooms.find((r) => r.id === roomId))
  const agents = useStore((x) => (roomId ? x.agents[roomId] : undefined))
  const rs = useRoomSettings(roomId)
  const [branches, setBranches] = useState<string[]>([])
  useEffect(() => {
    if (roomId) void call('git.branches', { roomId }).then(setBranches).catch(() => setBranches([]))
  }, [roomId])
  if (!room || !roomId) return <NoRoom />

  const mode = rs?.workspace.mode
  const base = rs?.workspace.baseRef
  const setWs = (patch: Partial<Record<keyof RoomSettings['workspace'], string | null>>) => void patchRoomSettings(roomId, { workspace: patch as never })
  const branchOptions = [{ value: USE_DEFAULT, label: 'Use default' }, ...[...new Set([...(base ? [base] : []), ...branches])].map((b) => ({ value: b, label: b }))]
  const allow = room.allow ?? []
  const removeRule = async (rule: string) => {
    try {
      const next = await call('rooms.update', { roomId, patch: { allow: allow.filter((r) => r !== rule) } })
      actions.rooms.upsert(next)
    } catch (e) { actions.ui.toast({ title: 'Could not remove the rule', sub: (e as Error).message }) }
  }
  const archive = async () => {
    try {
      await call('rooms.update', { roomId, patch: { archived: true } })
      actions.ui.toast({ title: `Archived ${room.name}`, sub: 'Restore it from Rooms, Archived.' })
      go({ name: 'rooms' })
    } catch (e) { actions.ui.toast({ title: 'Could not archive the room', sub: (e as Error).message }) }
  }
  return (
    <Page title={room.name}>
      <Section title="Room">
        <Row label="Repository"><span className="set-value">{room.repo ?? sourceOf(room)}</span></Row>
        <Row label="Local path"><span className="set-value">{home(room.path)}</span></Row>
        <Row label="Team"><span className="set-value">{agents?.filter((a) => !a.retired).map((a) => a.role).join(', ') || 'No agents yet'}</span></Row>
      </Section>
      <Section title="Overrides">
        <Row label="Default workspace type">
          <SegmentedControl label="Default workspace type" value={mode ?? USE_DEFAULT} onChange={(v) => setWs({ mode: v || null })} options={[{ value: USE_DEFAULT, label: 'Use default' }, { value: 'worktree', label: 'New worktree' }, { value: 'current', label: 'Current branch' }]} />
        </Row>
        <Row label="Branch new workspaces from">
          <Select label="Branch new workspaces from" value={base ?? USE_DEFAULT} options={branchOptions} onChange={(e) => setWs({ baseRef: e.target.value || null })} />
        </Row>
        <Row label="Setup script" desc="Overrides the default for this room only" full={<TextField label="Setup script for this room" value={rs?.scripts.setup ?? ''} onSave={(text) => void patchRoomSettings(roomId, { scripts: { setup: text.trim() || null } })} placeholder="pnpm install" />} />
      </Section>
      <Section title="Always allowed in this room">
        {allow.length === 0 && <p className="set-empty">Nothing yet. Choosing Always allow in this room on an approval saves its command here.</p>}
        {allow.map((rule) => (
          <div key={rule} className="set-line">
            <code>{rule}</code>
            <Button aria-label={`Remove ${rule}`} onClick={() => void removeRule(rule)}>Remove</Button>
          </div>
        ))}
      </Section>
      <Section title="Danger zone">
        <Row label="Archive room" desc="Stops every agent and archives all workspaces. You can restore it later.">
          <Button onClick={() => void archive()} disabled={!!room.archived}>Archive</Button>
        </Row>
      </Section>
    </Page>
  )
}
