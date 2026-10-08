# Hooks contract

Kernel listens on `http://127.0.0.1:7420/hooks` (port configurable). "Install hooks" merges these entries into `~/.claude/settings.json`, keeping any hooks the user already has and saving a backup to `settings.json.kernel-backup`. Only the Install button writes them (CheckHooks, Settings > Hooks). A port or approval timeout change rewrites hooks that are already there and never adds them. Code: `src/main/services/hooksInstaller.ts`.

Each entry is a command hook that pipes the payload to the server with curl (D-050):

```
/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:7420/hooks || true
```

## When Kernel isn't running

curl can't connect, prints nothing, and `|| true` exits 0, so Claude Code shows nothing and carries on. A `PermissionRequest` gets no decision, so the normal prompt shows. An `http` hook can't do this: when nothing listens, Claude Code reports `HTTP undefined from <url>` as a hook error on every event (CLI 2.1.292). Installs from before KERNEL-56 wrote `http` entries. Kernel reports those as not installed, and Install replaces them.

## Events

| Event | Matcher | Used for |
|---|---|---|
| SessionEnd | none | agent offline on the floor. Kernel installs no SessionStart hook, so the first event from a new session id counts as its start (D-020, D-047) |
| UserPromptSubmit | none | "got a message" in the logs |
| PreToolUse, PostToolUse, PostToolUseFailure | `*` | live activity: reading, editing, running |
| PermissionRequest | `*` | approvals from outside sessions (held, see below) |
| Notification | none | log line |
| Stop | none | turn finished |
| TaskCreated, TaskCompleted, TeammateIdle | none | Board tasks and status for agent teams sessions. Kernel's own sessions report them in process, with agent teams on in Settings > Models (D-027) |

Payload shapes are validated with Zod in `src/shared/hookSchemas.ts`, loosely, so newer Claude Code fields never break parsing. Unknown events still parse against the base shape and are logged. CLI 2.1.292 also sends `prompt_id` on every event, and `last_assistant_message`, `background_tasks` and `session_crons` on Stop; the loose schemas pass them through.

## Example entry

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:7420/hooks || true", "timeout": 10 }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/bin/curl -sf --connect-timeout 1 -m 320 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:7420/hooks || true", "timeout": 330 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "/usr/bin/curl -sf --connect-timeout 1 -m 8 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:7420/hooks || true", "timeout": 10 }] }]
  }
}
```

## Permission requests

The server holds a `PermissionRequest` open and creates an approval in the Inbox. When the user decides, it answers with `hookSpecificOutput.decision` (`allow`, or `deny` with a message). If nobody decides within the approval timeout (Settings > Permissions, 300s default), it answers `{}` and Claude Code falls back to its normal prompt in the terminal. curl prints the answer to stdout, where Claude Code reads it. curl's `-m` is the approval timeout plus 20s and the hook's `timeout` is plus 30s, so the server always answers first and curl exits before Claude Code would kill it.

## Mapping a session to a room

The hook body's `cwd` is matched against open workspace paths (longest match first), then room paths. Sessions Kernel started are skipped, because their in-process hooks already report.
