/**
 * Kernel's own variables. Every session, script and terminal in a workspace gets the same set, and they win over the
 * user's variables, so a variable can't take one of these names (KERNEL-247).
 */
export const KERNEL_VARS = {
  KERNEL_PORT: 'The first of the workspace\'s ten ports. Start a dev server on it.',
  KERNEL_WORKSPACE_ID: 'The workspace\'s id in Kernel.',
  KERNEL_WORKSPACE: 'The workspace\'s folder.',
  KERNEL_ROOT_PATH: 'The room\'s main checkout.',
  KERNEL_WORKSPACE_NAME: 'The workspace\'s name, as the sidebar shows it.',
  KERNEL_WORKSPACE_SLUG: 'The workspace\'s folder and id in lowercase letters, digits and _. Name a database after it to give each workspace its own.',
  KERNEL_BRANCH: 'The branch the workspace started on.',
  KERNEL_BASE_REF: 'The ref the workspace started from, like origin/main.',
  KERNEL_DEFAULT_BRANCH: 'The room\'s default branch.'
} as const

export type KernelVar = keyof typeof KERNEL_VARS

/** What scripts get on top of `KERNEL_VARS`. They win over a variable of the same name in scripts only. */
export const SCRIPT_VARS = {
  PORT: 'The same as KERNEL_PORT, for tools that read PORT.',
  FORCE_COLOR: 'Set to 0, so the output panel gets plain text.'
} as const

/**
 * `KERNEL_WORKSPACE_SLUG` (KERNEL-449): the folder's name in lowercase with anything but letters and digits made `_`, cut
 * to 40 characters, then `_` and the first 6 letters and digits of the id. It starts with a letter, so it is a valid
 * Postgres or MySQL database name and Docker Compose project name. It comes from the folder, not the name, so a workspace
 * renamed from its chat's title keeps its database.
 */
export function workspaceSlug(ws: { id: string; path: string }): string {
  const folder = (ws.path.split(/[\\/]/).filter(Boolean).pop() ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '')
  const id = ws.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
  const slug = [folder, id].filter(Boolean).join('_') || 'workspace'
  return /^[a-z]/.test(slug) ? slug : `ws_${slug}`
}

/** A variable's name: a letter or `_`, then letters, digits and `_`. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * What the setup script gets on top of `SCRIPT_VARS` (KERNEL-405). It writes NAME=value lines to the file, and the workspace's
 * agents, run scripts and terminals get them once setup passes.
 */
export const SETUP_VARS = {
  KERNEL_ENV: 'A file setup can write NAME=value lines to. The workspace\'s agents, run scripts and terminals get them.'
} as const

/** One of Kernel's names, which a variable the user or setup sets can't take. */
export const isKernelVar = (name: string): boolean => Object.hasOwn(KERNEL_VARS, name) || Object.hasOwn(SETUP_VARS, name)

/**
 * A name Kernel drops from app and room variables for chats and terminals, because it picks Claude Code's endpoint, account or
 * billing (KERNEL-247). Scripts still get it. The engine strips these names with this rule too, so the Environment page and what agents get agree.
 */
export const isClaudeVar = (name: string) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(name)
