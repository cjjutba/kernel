# Hooks contract

Kernel listens on `http://127.0.0.1:7420/hooks` (port configurable). "Install hooks" merges these entries into `~/.claude/settings.json`, keeping any hooks the user already has. The first install or uninstall copies the file to `settings.json.kernel-backup`, and nothing overwrites that copy later. Both write a temp file and rename it over, so Claude Code never reads a half-written file. Only the Install button writes them (CheckHooks, Settings > Hooks). A port or approval timeout change rewrites hooks that are already there and never adds them. Code: `src/main/services/hooksInstaller.ts`.

Each entry is a command hook that pipes the payload to the server with curl (D-050):

```
/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' -H 'X-Kernel-Token: <token>' --data-binary @- http://127.0.0.1:7420/hooks || true
```

## Who can post

`<token>` is 64 hex characters from `randomBytes(32)`, made once and kept in `hook-token` in the app data folder (mode 0600). The server checks every `POST /hooks` before it reads the body:

- The Host must be `127.0.0.1:<port>` or `localhost:<port>`, and the `X-Kernel-Token` header must match the token. Either failing gets a 401. The token is compared in constant time.
- The content type must be `application/json`, or the server answers 415. A web page's `no-cors` fetch can only send `text/plain`.

`GET /health` needs no token. An entry with another token, or none, counts as not installed, so CheckHooks and Settings > Hooks offer Install, which rewrites it. curl's `-f` keeps a 401 quiet, the same way it handles a server that is down. See KERNEL-206.

## When Kernel isn't running

curl can't connect, prints nothing, and `|| true` exits 0, so Claude Code shows nothing and carries on. A `PermissionRequest` gets no decision, so the normal prompt shows. An `http` hook can't do this: when nothing listens, Claude Code reports `HTTP undefined from <url>` as a hook error on every event (CLI 2.1.292). Installs from before KERNEL-56 wrote `http` entries. Kernel reports those as not installed, and Install replaces them.

## Events

| Event | Matcher | Used for |
|---|---|---|
| SessionEnd | none | agent offline. Kernel installs no SessionStart hook, so the first event from a new session id counts as its start (D-020, D-047) |
| UserPromptSubmit | none | "got a message" in the logs |
| PreToolUse, PostToolUse, PostToolUseFailure | `*` | live activity: reading, editing, running |
| PermissionRequest | `*` | approvals from outside sessions (held, see below) |
| Notification | none | log line |
| Stop | none | turn finished |
| TaskCreated, TaskCompleted, TeammateIdle | none | task status for agent teams sessions (the Board that listed them is hidden, D-104). Kernel's own sessions report them in process, with agent teams on in Settings > Models (D-027) |

Payload shapes are validated with Zod in `src/shared/hookSchemas.ts`, loosely, so newer Claude Code fields never break parsing. Unknown events still parse against the base shape and are logged. CLI 2.1.292 also sends `prompt_id` on every event, and `last_assistant_message`, `background_tasks` and `session_crons` on Stop; the loose schemas pass them through.

## Example entry

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' -H 'X-Kernel-Token: <token>' --data-binary @- http://127.0.0.1:7420/hooks || true", "timeout": 10 }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/bin/curl -sf --connect-timeout 1 -m 320 -H 'Content-Type: application/json' -H 'X-Kernel-Token: <token>' --data-binary @- http://127.0.0.1:7420/hooks || true", "timeout": 330 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' -H 'X-Kernel-Token: <token>' --data-binary @- http://127.0.0.1:7420/hooks || true", "timeout": 10 }] }]
  }
}
```

## Permission requests

Kernel only asks about sessions inside one of its rooms (D-138). A `PermissionRequest` whose `cwd` maps to no room gets `{}` at once and opens no approval, so Superset, Conductor and terminal sessions elsewhere on the Mac ask in their own window as if Kernel weren't installed.

For a session in a room, the server holds the `PermissionRequest` open and creates an approval in the Inbox. When the user decides, it answers with `hookSpecificOutput.decision` (`allow`, or `deny` with a message). If nobody decides within the approval timeout (Settings > Permissions, 300s default), it answers `{}` and Claude Code falls back to its normal prompt in the terminal. curl prints the answer to stdout, where Claude Code reads it. curl's `-m` is the approval timeout plus 20s and the hook's `timeout` is plus 30s, so the server always answers first and curl exits before Claude Code would kill it.

When Claude Code stops waiting first (the user answers in the terminal, the session ends, or curl's `-m` runs out), the request closes. The server aborts the approval, which turns `expired` and leaves Needs you.

## Mapping a session to a room

Kernel matches the hook body's `cwd` against open workspace paths (longest match first), then room paths. A workspace's worktree can sit outside its room's folder and still maps to that room. Sessions Kernel started are skipped, because their in-process hooks already report.
