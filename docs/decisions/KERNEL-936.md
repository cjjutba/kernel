**Each account's last MCP check is saved, the page answers from it at once, and Ready accounts get checked again too.** Amends KERNEL-660.

The first open of Settings, MCP servers waited for every account's check, up to 30 seconds each, and an account that read Ready was never checked again, so a sign-in that expired later went unnoticed.

- Kernel saves each account's last check to `mcp-accounts.json` in its data folder: provider, account id, `checkedAt`, and each server's name, kind, state, note, error and connector link. Never a token. It writes through a temp file and a rename. A file that doesn't parse, or has another `version`, reads as nothing and the next check overwrites it.
- `mcp.accounts` and `mcp.recheck` answer at once with what Kernel has, saved or live. An account whose check runs carries `checking: true` and keeps its last `checkedAt`. Each account is pushed as `mcp.accounts` when its own check ends, not when the slowest one does.
- A saved result counts as known but not live. The first `mcp.accounts` after launch checks every account once.
- The app checks every account 5 seconds after launch and again when the Mac wakes (`started` and `woke` in `features/wiring.ts`, turned on by `checkMcp`). Tests leave it off.
- On focus, `mcp.recheck` still checks accounts with something pending, and now also any account whose last check is 5 minutes old or more, Ready ones included. A saved result counts by its `checkedAt`. The 10 second throttle stays.
- Removing an account takes it out of the file. A check that was running when it left doesn't write it back.
KERNEL-936.
