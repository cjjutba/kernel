/**
 * The card set_project_scripts shows (KERNEL-683, KERNEL-1094): the question it asks, and the scripts it holds, which main sends as one text of sections, each a
 * heading line and the script under it. The window reads them back into sections to draw each in its own box. Main's own copy of the question is held equal by a test.
 */
export const SAVE_SCRIPTS_QUESTION = 'Save these scripts to .kernel/settings.local.toml?'

export interface ScriptSection {
  /** `mode` is the run mode, a plain line and not a script. */
  kind: 'setup' | 'run' | 'archive' | 'mode'
  /** What the box is called: Setup, Run, a named run script's name in quotes, Archive, Run mode. */
  label: string
  /** When the script runs, in a few words. */
  hint: string
  text: string
}

const HEADING = /^(Setup script|Run script|Archive script|Run script "(.+)"|Run mode)$/

const SECTION: Record<string, Pick<ScriptSection, 'kind' | 'label' | 'hint'>> = {
  'Setup script': { kind: 'setup', label: 'Setup', hint: 'Runs alongside the agent in each new worktree' },
  'Run script': { kind: 'run', label: 'Run', hint: 'Runs from the Run button' },
  'Archive script': { kind: 'archive', label: 'Archive', hint: 'Runs before a chat is archived' },
  'Run mode': { kind: 'mode', label: 'Run mode', hint: '' }
}

/** The scripts a card holds, in the order main wrote them. Text before the first heading is dropped, and a heading with nothing under it has no section. */
export function parseScriptsCard(detail: string): ScriptSection[] {
  const out: ScriptSection[] = []
  let cur: { head: RegExpExecArray; lines: string[] } | undefined
  const close = () => {
    if (!cur) return
    const text = cur.lines.join('\n').replace(/^\n+|\n+$/g, '')
    const [, line, name] = cur.head
    if (text) out.push(name ? { kind: 'run', label: `Run "${name}"`, hint: 'Runs from the Run button', text } : { ...SECTION[line], text })
  }
  for (const line of detail.split('\n')) {
    const head = HEADING.exec(line)
    if (head) { close(); cur = { head, lines: [] } } else cur?.lines.push(line)
  }
  close()
  return out
}
