/**
 * Kernel's own variables. Every session, script and terminal in a workspace gets the same set, and they win over the
 * user's variables, so a variable can't take one of these names (KERNEL-247).
 */
export const KERNEL_VARS = {
  KERNEL_PORT: 'The first of the workspace\'s ten ports. Start a dev server on it.',
  KERNEL_WORKSPACE_ID: 'The workspace\'s id in Kernel.',
  KERNEL_WORKSPACE: 'The workspace\'s folder.',
  KERNEL_ROOT_PATH: 'The room\'s main checkout.'
} as const

export type KernelVar = keyof typeof KERNEL_VARS

/** What scripts get on top of `KERNEL_VARS`. They win over a variable of the same name in scripts only. */
export const SCRIPT_VARS = {
  PORT: 'The same as KERNEL_PORT, for tools that read PORT.',
  FORCE_COLOR: 'Set to 0, so the output panel gets plain text.'
} as const

/** A variable's name: a letter or `_`, then letters, digits and `_`. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export const isKernelVar = (name: string): name is KernelVar => Object.hasOwn(KERNEL_VARS, name)

/**
 * A name Kernel drops from app and room variables for chats and terminals, because it picks Claude Code's endpoint, account or
 * billing (KERNEL-247). Scripts still get it. The engine keeps its own copy of the rule, `CLAUDE_NAME` in src/main/services/env.ts.
 */
export const isClaudeVar = (name: string) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(name)
