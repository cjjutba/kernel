# Hooks contract

Kernel listens on `http://localhost:7420/hooks` (port configurable). "Install hooks" merges these entries into `~/.claude/settings.json`, keeping any hooks CJ already has and saving a backup to `settings.json.kernel-backup`. Code: `src/main/services/hooksInstaller.ts`.

## Events

| Event | Matcher | Used for |
|---|---|---|
| SessionStart, SessionEnd | none | agent online and offline on the floor. Claude Code skips http hooks for SessionStart, so the first event from a new session id counts as its start (D-020) |
| UserPromptSubmit | none | "got a message" in the logs |
| PreToolUse, PostToolUse, PostToolUseFailure | `*` | live activity: reading, editing, running |
| PermissionRequest | `*` | approvals from outside sessions (held, see below) |
| Notification | none | log line |
| Stop | none | turn finished |
| TaskCreated, TaskCompleted, TeammateIdle | none | Board tasks and status for agent teams sessions |

Payload shapes are validated with Zod in `src/shared/hookSchemas.ts`, loosely, so newer Claude Code fields never break parsing. Unknown events still parse against the base shape and are logged. CLI 2.1.292 also sends `prompt_id` on every event, and `last_assistant_message`, `background_tasks` and `session_crons` on Stop; the loose schemas pass them through.

## Example entry

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:7420/hooks", "timeout": 10 }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "http://localhost:7420/hooks", "timeout": 330 }] }],
    "Stop": [{ "hooks": [{ "type": "http", "url": "http://localhost:7420/hooks", "timeout": 10 }] }]
  }
}
```

## Permission requests

The server holds a `PermissionRequest` open and creates an approval in the Inbox. When CJ decides, it answers with `hookSpecificOutput.decision` (`allow`, or `deny` with a message). If nobody decides within the approval timeout (Settings > Permissions, 300s default), it answers `{}` and Claude Code falls back to its normal prompt in the terminal.

## Mapping a session to a room

The hook body's `cwd` is matched against open workspace paths (longest match first), then room paths. Sessions Kernel started are skipped, because their in-process hooks already report.
