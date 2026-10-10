import { useEffect, useState } from 'react'
import type { LinearScope } from '@shared/types'
import { call } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, Select, useBusy } from '../../../ui'
import { sourceOf } from '../../rooms/roomInfo'
import { RoomIconRow } from './RoomIconRow'
import { NoRoom, Row, RoomPage, Section, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

const USE_DEFAULT = ''
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** Settings > a room > General (SettingsRoom.png): what the room is, its Linear team, and Archive. The rest of the room's settings have pages of their own. */
export function Room({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const agents = useStore((x) => (roomId ? x.agents[roomId] : undefined))
  const [busy, run] = useBusy()
  // null until Integrations answers, so the row doesn't flash "Connect Linear" for a connected account.
  const [teams, setTeams] = useState<LinearScope['teams'] | null | undefined>(undefined)
  useEffect(() => {
    void call('integrations.list', undefined)
      .then((rows) => (rows.find((r) => r.id === 'linear')?.connected ? call('linear.scope', undefined).then((scope) => setTeams(scope.teams)) : setTeams(null)))
      .catch(() => setTeams(null))
  }, [])
  if (!room || !roomId) return <NoRoom />

  const team = rs?.linear?.team
  // A saved team that is no longer in the list still shows, so the select never claims None for a team that is set.
  const teamOptions = [{ value: USE_DEFAULT, label: 'None' }, ...[...new Set([...(team ? [team] : []), ...(teams ?? []).map((t) => t.key)])].map((k) => ({ value: k, label: k }))]
  const archive = () => run('archive', async () => {
    try {
      await call('rooms.update', { roomId, patch: { archived: true } })
      actions.ui.toast({ title: `Archived ${room.name}`, sub: 'Restore it from Rooms, Archived.' })
      go({ name: 'rooms' })
    } catch (e) { actions.ui.toast({ title: 'Could not archive the room', sub: (e as Error).message }) }
  })
  return (
    <RoomPage room={room} rs={rs} title="General" intro={`How ${room.name} is set up in Kernel.`}>
      <Section title="Room">
        <RoomIconRow room={room} />
        <Row label="Repository"><span className="set-value">{room.repo ?? sourceOf(room)}</span></Row>
        <Row label="Local path"><span className="set-value">{home(room.path)}</span></Row>
        <Row label="Team"><span className="set-value">{agents?.filter((a) => !a.retired).map((a) => a.role).join(', ') || 'No agents yet'}</span></Row>
        {teams !== undefined && (teams
          ? <Row label="Linear team" desc="Issues from this team open in this room">
              <Select label="Linear team" value={team ?? USE_DEFAULT} options={teamOptions} onChange={(e) => void patchRoomSettings(roomId, { linear: { team: e.target.value || null } })} />
            </Row>
          : <Row label="Linear team" desc={<>Connect Linear in <button type="button" className="set-link" onClick={() => go({ name: 'settings', page: 'integrations' })}>Settings, Integrations</button></>} />)}
      </Section>
      <Section title="Danger zone">
        <Row label="Archive room" desc="Stops every agent and archives all workspaces. You can restore it later.">
          <Button busy={!!busy} busyLabel="Archiving" disabled={!!room.archived} onClick={() => void archive()}>Archive</Button>
        </Row>
      </Section>
    </RoomPage>
  )
}
