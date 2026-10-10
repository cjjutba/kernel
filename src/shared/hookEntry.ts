/** Events whose Kernel hook takes a "*" matcher. The rest take none. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])

export const hookUrl = (port: number) => `http://127.0.0.1:${port}/hooks`

/** The header that proves a post came from the hook Kernel installed (KERNEL-206). The token is hex, so single quotes are safe. */
export const TOKEN_HEADER = 'X-Kernel-Token'
export const tokenArg = (token: string) => `-H '${TOKEN_HEADER}: ${token}'`

/**
 * The hook command (D-050). curl posts the payload from stdin and prints the server's JSON. When nothing listens it prints
 * nothing and `|| true` exits 0, so Claude Code shows no error and a PermissionRequest gets its normal prompt.
 * The server turns away a post without the token with a 401, which `-f` also keeps quiet (KERNEL-206).
 */
export const hookCommand = (port: number, maxSec: number, token: string) =>
  `/usr/bin/curl -sf --connect-timeout 1 -m ${maxSec} -H 'Content-Type: application/json' ${tokenArg(token)} --data-binary @- ${hookUrl(port)} || true`

/**
 * The matcher Kernel writes for one event. The installer and the Settings > Hooks snippet both use it, so they stay the same.
 * curl gives up before Claude Code's own timeout would kill it. The server answers a PermissionRequest at the approval timeout.
 */
export function kernelHookMatcher(event: string, port: number, approvalTimeoutSec: number, token: string) {
  const entry = event === 'PermissionRequest'
    ? { type: 'command', command: hookCommand(port, approvalTimeoutSec + 20, token), timeout: approvalTimeoutSec + 30 }
    : { type: 'command', command: hookCommand(port, 8, token), timeout: 10 }
  return TOOL_EVENTS.has(event) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] }
}
