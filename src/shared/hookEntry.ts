import type { HookBuild } from './types'

/** Events whose Kernel hook takes a "*" matcher. The rest take none. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])

/**
 * The installed app's entries post to `/hooks`, as every release before KERNEL-675 did, and Kernel Dev's to `/hooks/dev`.
 * Each build tells its own entries apart by the path, and a release from before then doesn't count Kernel Dev's as its own,
 * because its pattern ends at `/hooks`. A workspace run's path is `/hooks/run`, which Kernel never writes to Claude's
 * settings (KERNEL-679).
 */
export const hookPath = (build: HookBuild = 'app') => (build === 'app' ? '/hooks' : `/hooks/${build}`)
export const hookUrl = (port: number, build: HookBuild = 'app') => `http://127.0.0.1:${port}${hookPath(build)}`

/** The header that proves a post came from the hook Kernel installed (KERNEL-206). The token is hex, so single quotes are safe. */
export const TOKEN_HEADER = 'X-Kernel-Token'
export const tokenArg = (token: string) => `-H '${TOKEN_HEADER}: ${token}'`

/**
 * The build that started a session, set in the environment of every session, terminal and script a Kernel starts. The hook
 * command sends it back as `BUILD_HEADER`, so neither build shows a session the other one started (KERNEL-675).
 */
export const BUILD_ENV = 'KERNEL_BUILD'
export const BUILD_HEADER = 'X-Kernel-Build'
/** Double quotes, so the shell fills in the variable. Unset, curl sends no header. */
const buildArg = `-H "${BUILD_HEADER}: \${${BUILD_ENV}:-}"`

/**
 * The chat a terminal seat's pty belongs to, set in its environment as `KERNEL_CHAT_ID` (KERNEL-998) and sent back by the hook
 * command, so Kernel knows which terminal a hook comes from (KERNEL-999). Unset, curl sends no header.
 */
export const CHAT_ENV = 'KERNEL_CHAT_ID'
export const CHAT_HEADER = 'X-Kernel-Chat'
const chatArg = `-H "${CHAT_HEADER}: \${${CHAT_ENV}:-}"`

/**
 * The hook command (D-050). curl posts the payload from stdin and prints the server's JSON. When nothing listens it prints
 * nothing and `|| true` exits 0, so Claude Code shows no error and a PermissionRequest gets its normal prompt.
 * The server turns away a post without the token with a 401, which `-f` also keeps quiet (KERNEL-206).
 */
export const hookCommand = (port: number, maxSec: number, token: string, build: HookBuild = 'app') =>
  `/usr/bin/curl -sf --connect-timeout 1 -m ${maxSec} -H 'Content-Type: application/json' ${tokenArg(token)} ${buildArg} ${chatArg} --data-binary @- ${hookUrl(port, build)} || true`

/**
 * The matcher Kernel writes for one event. The installer and the Settings > Hooks snippet both use it, so they stay the same.
 * curl gives up before Claude Code's own timeout would kill it. The server answers a PermissionRequest at the approval timeout.
 */
export function kernelHookMatcher(event: string, port: number, approvalTimeoutSec: number, token: string, build: HookBuild = 'app') {
  const entry = event === 'PermissionRequest'
    ? { type: 'command', command: hookCommand(port, approvalTimeoutSec + 20, token, build), timeout: approvalTimeoutSec + 30 }
    : { type: 'command', command: hookCommand(port, 8, token, build), timeout: 10 }
  return TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] }
}
