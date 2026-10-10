import { Keys, Page, Row, Section } from '../kit'

/** The shortcuts Kernel listens for. The canvas shows them as fixed, so they are read only. */
export const SHORTCUTS: { title: string; rows: [string, string[]][] }[] = [
  { title: 'Workspaces', rows: [
    ['New chat', ['⌘', '⇧', 'N']], ['New chat tab', ['⌘', 'T']], ['Big terminal tab', ['⌘', '⇧', 'T']],
    ['Create PR', ['⌘', '⇧', 'P']], ['Open diff', ['⌘', '⇧', 'D']], ['Run dev script', ['⌘', 'R']]
  ] },
  { title: 'Agents', rows: [
    ['Approve request', ['⌘', '↵']], ['Deny request', ['⌘', '⌫']], ['Toggle plan mode', ['⇧', 'Tab']], ['Focus composer', ['⌘', 'L']], ['Open Lead chat', ['⌘', '⇧', 'L']]
  ] },
  { title: 'App', rows: [
    ['Command palette', ['⌘', 'K']], ['Settings', ['⌘', ',']], ['Toggle sidebar', ['⌘', 'B']], ['Toggle right panel', ['⌘', '⌥', 'B']], ['Focus mode', ['⌘', '\\']],
    ['Back', ['⌘', '[']], ['Forward', ['⌘', ']']]
  ] }
]

/** Settings > Shortcuts (SettingsShortcuts.png). */
export function Shortcuts() {
  return (
    <Page title="Shortcuts">
      {SHORTCUTS.map((g) => (
        <Section key={g.title} title={g.title}>
          {g.rows.map(([label, keys]) => <Row key={label} label={label}><Keys keys={keys} /></Row>)}
        </Section>
      ))}
    </Page>
  )
}
