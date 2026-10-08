import type { Room, TeamTemplate } from '@shared/types'
import { call } from '../../api'
import { actions, loadRoom, useStore } from '../../store'
import { useBusy } from '../../ui'

const TEMPLATES: { name: string; sub: string; template: (from?: string) => TeamTemplate }[] = [
  { name: 'Starter team', sub: 'Lead, Frontend, Backend, QA and Reviewer', template: () => ({ kind: 'starter' }) },
  { name: 'Pair', sub: 'A Lead and one engineer', template: () => ({ kind: 'pair' }) },
  { name: 'From another room', sub: '', template: (from) => ({ kind: 'copy', fromRoomId: from ?? '' }) }
]

/**
 * An empty room's team choices, which the empty floor offered until D-104 hid it. The default template from Settings, Agents
 * comes first, and copying needs another room with agents.
 */
export function TeamTemplates({ room }: { room: Room }) {
  const other = useStore((s) => {
    const r = s.rooms.find((x) => x.id !== room.id && !x.archived && (s.agents[x.id] ?? []).some((a) => !a.retired))
    return r ? { id: r.id, name: r.name } : null
  })
  const preferred = useStore((x) => x.settings?.team.defaultTemplate ?? 'starter')
  const [busy, run] = useBusy()
  const seed = (name: string, template: TeamTemplate) => run(name, async () => {
    try { await call('agents.seed', { roomId: room.id, template }); await loadRoom(room.id) } catch (e) {
      actions.ui.toast({ title: 'Could not add that team', sub: (e as Error).message })
    }
  })
  return (
    <div className="tm-templates" role="group" aria-label="Start from a team">
      {[...TEMPLATES].sort((a, b) => Number(b.template().kind === preferred) - Number(a.template().kind === preferred)).map((t) => {
        const copy = t.name === 'From another room'
        return (
          <button key={t.name} type="button" className="tm-template" disabled={busy !== null || (copy && !other)} aria-busy={busy === t.name || undefined} onClick={() => void seed(t.name, t.template(other?.id))}>
            <span style={{ fontWeight: 500 }}>{t.name}</span>
            {busy === t.name
              ? <span className="muted tm-template-busy"><span className="spin" aria-hidden="true" />Adding the team</span>
              : <span className="muted" style={{ fontSize: 12 }}>{copy ? (other ? `Copy agents from ${other.name}` : 'No other room has agents yet') : t.sub}</span>}
          </button>
        )
      })}
    </div>
  )
}
