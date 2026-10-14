import { useId } from 'react'
import type { AgentReach } from '@shared/types'
import { Icon } from '../../../ui'

type Blocked = AgentReach['blocked'][number]

/** A server as the pill shows it: Claude Code's `claude_ai_` prefix dropped, the first letter capital (WorkspaceHireServers.png). */
export const serverTitle = (name: string) => {
  const bare = name.replace(/^claude[._ ]ai[._ ]/i, '')
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

/** The new agent's name for the card's sentences: the file's `name:` line, else its file name, with a capital (`wren.md` is Wren). */
export function hireName(file: { path: string; text: string }): string {
  const named = /^name:\s*(.+?)\s*$/m.exec(file.text)?.[1]
  const bare = (named ?? file.path.split('/').pop()?.replace(/\.md$/, '') ?? '').replace(/^["']|["']$/g, '')
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : 'The new agent'
}

/** What is wrong with a server, in the pill. */
export const WHY: Record<Blocked['why'], string> = {
  'needs-auth': 'Needs sign-in',
  failed: 'Didn’t connect',
  off: 'Off in this room',
  disabled: 'Disabled',
  missing: 'Not in this room'
}

/** What has to happen before the new agent can use the server. */
const UNTIL: Record<Exclude<Blocked['why'], 'missing'>, string> = {
  'needs-auth': 'until you sign in',
  failed: 'until it connects',
  off: 'until you switch it on in this room',
  disabled: 'until you enable it'
}

/** The line under the row for one blocked server: what the agent can't do, and what that means for the Lead's hand-offs. */
export function blockedNote(b: Blocked, agent: string, lead: string): string {
  const server = serverTitle(b.name)
  const effect = `so ${lead} won’t hand ${agent} ${server} tasks.`
  if (b.why === 'missing') return `This room has no ${server} server, ${effect}${b.suggestion ? ` Did you mean ${b.suggestion}?` : ''}`
  return `${agent} can’t use ${server} ${UNTIL[b.why]}, ${effect}`
}

/**
 * The servers row of the hire card: one pill per server the new agent reaches, then one per server its file names that it
 * can't use, with the problem and a sentence under the row about what that means for hand-offs (WorkspaceHireServers.png,
 * KERNEL-484). The pills carry no action, so nothing here waits on the main process. A file that names no server and
 * reaches none draws no row.
 */
export function HireServers({ servers, agent, lead }: { servers?: AgentReach; agent: string; lead: string }) {
  const labelId = useId()
  if (!servers || (!servers.reach.length && !servers.blocked.length)) return null
  return (
    <div className="hire-servers">
      <div className="hire-servers-row">
        <span id={labelId} className="hire-servers-label">Servers</span>
        <ul className="hire-servers-pills" aria-labelledby={labelId}>
          {servers.reach.map((name) => <li key={name} className="srv">{serverTitle(name)}</li>)}
          {servers.blocked.map((b) => (
            <li key={b.name} className="srv" data-why={b.why}>
              <span className="srv-warn"><Icon name="warning" size={12} /></span>
              {serverTitle(b.name)}
              <span className="srv-why">{WHY[b.why]}</span>
            </li>
          ))}
        </ul>
      </div>
      {!!servers.blocked.length && (
        <div className="hire-servers-notes">
          {servers.blocked.map((b) => <p key={b.name} className="hire-servers-note">{blockedNote(b, agent, lead)}</p>)}
        </div>
      )}
    </div>
  )
}
