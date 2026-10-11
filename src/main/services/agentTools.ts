// What an agent file's `tools:` line lets the agent do (KERNEL-397).

/** `Bash(git:*)` is Bash, and Claude Code's older names are the tools that replaced them. */
const ALIASES: Record<string, string> = { Task: 'Agent', MultiEdit: 'Edit', LS: 'Glob', NotebookRead: 'Read', TodoRead: 'TodoWrite' }

/** A tools entry as the tool it names. */
export const toolName = (entry: string): string => {
  const name = entry.trim().replace(/\(.*$/, '').trim()
  return ALIASES[name] ?? name
}

/**
 * Whether an agent with these tools can take a task through to a pull request: it edits files and runs git and gh. No
 * tools line means every tool.
 */
export function canOpenPr(tools: string[] | undefined): boolean {
  if (!tools) return true
  const names = new Set(tools.map(toolName))
  return names.has('Bash') && (names.has('Edit') || names.has('Write'))
}
