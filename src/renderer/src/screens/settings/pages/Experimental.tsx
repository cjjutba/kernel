import type { AppSettings } from '@shared/types'
import { Toggle } from '../../../ui'
import { Keys, Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'

/** Settings > Experimental (SettingsExperimental.png). */
export function Experimental({ s }: { s: AppSettings }) {
  const e = s.experimental
  const set = (patch: Partial<AppSettings['experimental']>) => void patchSettings({ experimental: patch })
  return (
    <Page title="Experimental" intro="Early features. They may change or go away.">
      <Section title="Big terminal">
        <Row label="Big terminal tab" desc="Opens Claude Code itself in a terminal tab, next to your chats"><Toggle label="Big terminal tab" checked={e.bigTerminal} onChange={(v) => set({ bigTerminal: v })} /></Row>
        <Row label="Runs" desc="In the workspace worktree. Hooks still report to Kernel." full={<pre className="code" style={{ margin: 0, padding: '10px 12px', borderRadius: 'var(--r)', border: '1px solid var(--line-2)', fontSize: 12.5 }}>claude --dangerously-skip-permissions</pre>} />
        <Row label="Only in worktrees" desc="Never skip permissions on your current branch"><Toggle label="Only in worktrees" checked={e.bigTerminalWorktreeOnly} onChange={(v) => set({ bigTerminalWorktreeOnly: v })} /></Row>
        <Row label="New chat tab"><Keys keys={['⌘', 'T']} /></Row>
        <Row label="Big terminal tab"><Keys keys={['⌘', '⇧', 'T']} /></Row>
      </Section>
      <Section title="Voice">
        <Row label="Voice briefs" desc="Hold Fn and talk to Rowan"><Toggle label="Voice briefs" checked={e.voice} onChange={(v) => set({ voice: v })} /></Row>
      </Section>
    </Page>
  )
}
