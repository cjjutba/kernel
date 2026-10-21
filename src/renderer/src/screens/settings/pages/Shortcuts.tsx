import { useState } from 'react'
import { Icon } from '../../../ui'
import { Keys, Page, Section } from '../kit'
import './personal.css'

/** The shortcuts Kernel listens for, as bound in App.tsx, the composers, the chat tabs and the menu. They are fixed, so the page is read only. */
export const SHORTCUTS: { title: string; rows: [string, string[]][] }[] = [
  { title: 'Workspaces', rows: [
    ['New chat', ['⌘', 'N']], ['New tab', ['⌘', 'T']], ['Close tab', ['⌘', 'W']], ['Big terminal tab', ['⌘', '⇧', 'T']],
    ['Create PR or mark ready', ['⌘', '⇧', 'P']],
    ['Merge PR', ['⌘', '⇧', 'M']],
    ['Fix conflicts, checks or review', ['⌘', '⇧', 'F']],
    ['Archive merged or closed', ['⌘', '⇧', 'A']],
    ['Open diff', ['⌘', '⇧', 'D']], ['Run dev script', ['⌘', 'R']],
    ['Open in default app', ['⌘', 'O']]
  ] },
  { title: 'Agents', rows: [
    ['Approve request', ['⌘', '↵']], ['Deny request', ['⌘', '⌫']], ['Toggle plan mode', ['⇧', 'Tab']], ['Focus composer', ['⌘', 'L']], ['Open Kernel chat', ['⌘', '⇧', 'L']],
    ['Open the nth Kernel chat', ['⌘', '1 to 9']], ['Open the nth workspace of this chat', ['⌃', '1 to 9']], ['Link issue', ['⌘', 'I']], ['Add attachment', ['⌘', 'U']],
    ['Pick model 1 to 4', ['⌃', '⌘', '1 to 4']], ['Cycle effort', ['⌘', '⇧', '/']]
  ] },
  { title: 'App', rows: [
    ['Command palette', ['⌘', 'K']], ['Settings', ['⌘', ',']], ['Toggle sidebar', ['⌘', 'B']], ['Toggle right panel', ['⌘', '⌥', 'B']], ['Toggle right panel', ['⌘', '⇧', 'B']], ['Toggle bottom panel', ['⌘', 'J']], ['Focus mode', ['⌘', '\\']],
    ['New chat', ['⌘', '⇧', 'N']], ['Back', ['⌘', '[']], ['Forward', ['⌘', ']']],
    ['Press the newest toast’s button, like Undo', ['⌘', '⌥', 'Z']], ['Dismiss the newest toast', ['Esc']]
  ] }
]

const NAMES: Record<string, string> = { '⌘': 'Command', '⇧': 'Shift', '⌥': 'Option', '⌃': 'Control', '↵': 'Return', '⌫': 'Delete' }

/** Settings > Shortcuts (SettingsPage.png, page shortcuts): a filter, then each group's shortcuts in two columns (KERNEL-680, Redesign 15). */
export function Shortcuts() {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const groups = SHORTCUTS.map((g) => ({ ...g, rows: g.rows.filter(([label]) => !q || label.toLowerCase().includes(q)) })).filter((g) => g.rows.length)
  return (
    <Page title="Shortcuts" desc="The keys Kernel listens for. They're fixed, so this page is read only.">
      <div className="pe-filter">
        <span aria-hidden="true"><Icon name="search" size={12} /></span>
        <input type="search" aria-label="Filter shortcuts" placeholder="Filter shortcuts" autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {groups.map((g) => {
        // Two columns read down, then across, so the first half of a group sits on the left.
        const per = g.rows.length > 1 ? Math.ceil(g.rows.length / 2) : 1
        return (
          <Section key={g.title} title={g.title}>
            <div className="pe-grid" role="list" aria-label={g.title} style={{ gridTemplateRows: `repeat(${per}, auto)` }}>
              {g.rows.map(([label, keys], i) => (
                <div key={label + keys.join('')} role="listitem" className="pe-key" data-right={i >= per || undefined} data-first={i % per === 0 || undefined}>
                  <span className="pe-key-label">{label}</span>
                  <span role="img" aria-label={keys.map((k) => NAMES[k] ?? k).join(' ')}><Keys keys={keys} /></span>
                </div>
              ))}
            </div>
          </Section>
        )
      })}
      {!groups.length && <p className="pe-empty">No shortcuts match “{query}”</p>}
    </Page>
  )
}
