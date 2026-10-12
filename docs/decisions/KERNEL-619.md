**The sidebar's pill reads Usage, always shows, and opens one popover for Claude Code and Codex.** Amends D-082. The pill carried the Claude plan's name and vanished when Claude had no plan, so a Codex-only user couldn't see Codex's numbers.

Each provider gets a section from the one account it runs on (`active`), never the first window in `usage`. It shows the nickname, plan and email, the 5-hour and weekly windows, a window for each model with its own limit, then Switch with the provider's other signed-in accounts and their 5-hour use.

A key in use says "Billed per token" and has no windows. The popover doesn't show the subscription behind it. Settings, Account and usage still does (KERNEL-524).

A provider with no signed-in account is one line with Sign in. The CLI's own login signs in there. An added account goes to its row in Settings, Providers, whose sheet takes a code.

A switch from the popover leaves it open, so the numbers change under the click and again on each `usage` and `accounts` push. A window that has reset since it was read says "No usage reported yet" until the engine reads it again, which happens every time the popover opens. KERNEL-619.

**Settings, Providers asks Claude Code which MCP servers need a sign-in when the Claude Code tab opens, once per login.** `accounts.checkMcp` starts Claude Code on a login to list its servers (KERNEL-616). The page calls it one login at a time for each signed-in subscription login whose row has no answer yet, and leaves a row alone if the call fails. A row's Sign in runs `accounts.mcpSignIn` for each server it lists, one at a time because each opens the browser, then checks again. A claude.ai connector finishes on claude.ai, so it can still be listed after its page opened. KERNEL-619.

**The switch warning is a `warn` banner that stays closed until midnight, and "Switch back" goes to the first other signed-in subscription account that offers every model.** The banner reads the active account's `missingModels`. The store keeps no history of the account the user came from, so with two accounts the first other one is the one they left. The close is remembered per account and set of models, and the warning returns the next day, like the Inbox notice. KERNEL-619.
