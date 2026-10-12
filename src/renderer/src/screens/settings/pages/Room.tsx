import { useEffect, useState } from 'react'
import type { LinearScope } from '@shared/types'
import { trackerKind } from '@shared/trackerKind'
import { call, cleanError } from '../../../api'
import { actions, go, useStore } from '../../../store'
import { Button, Select, useBusy } from '../../../ui'
import { sourceOf } from '../../rooms/roomInfo'
import { RoomIconRow } from './RoomIconRow'
import { RoomTrackerRow } from './RoomTrackerRow'
import { NoRoom, Row, RoomPage, Section, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

const USE_DEFAULT = ''
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** Settings > a room > General (SettingsRoom.png): what the room is, its issue tracker, its Linear team when that is the tracker, and Archive. The rest of the room's settings have pages of their own. */
export function Room({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const agents = useStore((x) => (roomId ? x.agents[roomId] : undefined))
  const [busy, run] = useBusy()
  // undefined until Integrations answers, so the rows don't flash "Connect Linear" for a connected account or the wrong detected tracker.
  // `teams` is null when Linear isn't connected or its teams didn't load.
  const [linear, setLinear] = useState<{ connected: boolean; teams: LinearScope['teams'] | null } | undefined>(undefined)
  useEffect(() => {
    void call('integrations.list', undefined)
      .then(async (rows) => {
        if (!rows.find((r) => r.id === 'linear')?.connected) return setLinear({ connected: false, teams: null })
        setLinear({ connected: true, teams: await call('linear.scope', undefined).then((scope) => scope.teams, () => null) })
      })
      .catch(() => setLinear({ connected: false, teams: null }))
  }, [])
  if (!room || !roomId) return <NoRoom />

  const team = rs?.linear?.team
  const teams = linear?.teams
  const detected = trackerKind({ linearToken: !!linear?.connected, linearTeam: !!team, githubRemote: !!room.repo })
  const tracker = rs?.tracker?.kind ?? detected
  // A saved team that is no longer in the list still shows, so the select never claims None for a team that is set.
  const teamOptions = [{ value: USE_DEFAULT, label: 'None' }, ...[...new Set([...(team ? [team] : []), ...(teams ?? []).map((t) => t.key)])].map((k) => ({ value: k, label: k }))]
  const archive = () => run('archive', async () => {
    try {
      await call('rooms.update', { roomId, patch: { archived: true } })
      go({ name: 'rooms' })
    } catch (e) { actions.ui.toast({ title: 'Could not archive the room', sub: cleanError(e) }) }
  })
  return (
    <RoomPage room={room} rs={rs} title="General" intro={`How ${room.name} is set up in Kernel.`}>
      <Section title="Room">
        <RoomIconRow room={room} />
        <Row label="Repository"><span className="set-value">{room.repo ?? sourceOf(room)}</span></Row>
        <Row label="Local path"><span className="set-value">{home(room.path)}</span></Row>
        <Row label="Team"><span className="set-value">{agents?.filter((a) => !a.retired).map((a) => a.role).join(', ') || 'No agents yet'}</span></Row>
        {rs && linear && <RoomTrackerRow roomId={roomId} rs={rs} detected={detected} />}
        {rs && linear && tracker === 'linear' && (teams
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
