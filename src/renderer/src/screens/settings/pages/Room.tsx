import { useEffect, useState } from 'react'
import type { LinearScope } from '@shared/types'
import { trackerKind } from '@shared/trackerKind'
import { call, cleanError } from '../../../api'
import { actions, go } from '../../../store'
import { Button, ConfirmDialog, Select, useBusy } from '../../../ui'
import { sourceOf } from '../../rooms/roomInfo'
import { RoomIconRow } from './RoomIconRow'
import { RoomTrackerRow } from './RoomTrackerRow'
import { NoRoom, Row, RoomPage, Section, SettingsLink, useRoomPage } from '../kit'
import { patchRoomSettings } from '../useSettings'

const USE_DEFAULT = ''
const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')

/** Settings > a room > General (MorePage roomGeneral, KERNEL-680): the room, its issue tracker and Linear team, and Archive behind a confirm. The rest of the room's settings have pages of their own. */
export function Room({ roomId }: { roomId?: string }) {
  const { room, rs } = useRoomPage(roomId)
  const [busy, run] = useBusy()
  const [confirming, setConfirming] = useState(false)
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
    setConfirming(false)
  })
  const open = (what: () => Promise<unknown>, failed: string) => void what().catch((e) => actions.ui.toast({ title: failed, sub: cleanError(e) }))
  return (
    <RoomPage room={room} rs={rs} title="General">
      <Section title="Room">
        <RoomIconRow room={room} />
        <Row id="repository" label="Repository">
          <span className="set-value">{room.repo ?? sourceOf(room)}</span>
          {room.repo && <Button onClick={() => open(() => call('system.openExternal', { url: `https://github.com/${room.repo}` }), 'Could not open GitHub')}>Open on GitHub</Button>}
        </Row>
        <Row id="path" label="Local path">
          <span className="set-value">{home(room.path)}</span>
          <Button onClick={() => open(() => call('app.openIn', { path: room.path }), 'Could not open the folder')}>Open</Button>
        </Row>
      </Section>
      {rs && linear && (
        <Section title="Issues">
          <RoomTrackerRow roomId={roomId} rs={rs} detected={detected} />
          {tracker === 'linear' && (teams
            ? <Row id="linear-team" label="Linear team" desc="Issues from this team open here.">
                <Select label="Linear team" value={team ?? USE_DEFAULT} options={teamOptions} align="right" onChange={(v) => void patchRoomSettings(roomId, { linear: { team: v || null } })} />
              </Row>
            : <Row id="linear-team" label="Linear team" desc={<>Connect Linear in <SettingsLink to={{ page: 'integrations' }}>Settings, Integrations</SettingsLink>.</>} />)}
        </Section>
      )}
      <Section title="Danger zone">
        <Row id="archive-room" label="Archive room" desc="Stops every agent and archives its workspaces. You can restore it.">
          <Button disabled={!!room.archived} onClick={() => setConfirming(true)}>Archive room</Button>
        </Row>
      </Section>
      {confirming && (
        <ConfirmDialog
          title={`Archive ${room.name}?`} body="Every agent stops and all of the room’s workspaces are archived. You can restore the room later." danger
          confirmLabel="Archive room" busy={!!busy} busyLabel="Archiving" onConfirm={() => void archive()} onCancel={() => setConfirming(false)}
        />
      )}
    </RoomPage>
  )
}
