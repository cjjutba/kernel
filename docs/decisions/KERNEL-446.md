**A PreToolUse hook on Claude that asks the user waits for the answer itself, and only the user's yes lets the call through.** `awaitDecision(host, req, signal)` in `providers/claude.ts` is the path KERNEL-433 names for asks a hook `ask` can't carry: Always ask in Auto (A3), and the tools gate in Auto and Bypass (D5). It returns hook `allow` on the user's yes. A no, a typed answer, an abort, the wait running out and no decision all return `deny`, because a PreToolUse hook that times out lets the call go. A hook already aborted when it asks opens no card, since the approval's abort listener would never fire and the card would sit there until it expired.

The hook's matcher takes the room-pause hold's timeout, `HOLD_TIMEOUT_SEC`, and the card expires a minute before it (`HOOK_ASK_MS`), so Kernel denies before the CLI stops waiting. Both stay under setTimeout's limit of about 24.8 days, past which Node fires at once and every ask would deny before the user saw it.

It asks through `host.ask`, the same path canUseTool takes, and not through `Approvals` directly. So the card lands in the chat, the agent shows as needing the user, and a quit or an archived workspace ends the wait the way they end any other ask. `host.ask` passes `timeoutMs` on to `approvals.request`, whose own timer expires the card.

It saves no Always allow rule. A caller whose card offers Always allow saves the rule itself, as canUseTool does with `saveAlwaysAllow`.

No hook calls it yet. Every mode still runs Claude Code in `default` or `acceptEdits`, where the guard's hook `ask` already reaches canUseTool: Manual, Accept edits, and Auto and Bypass permissions until A3 runs them as Claude Code's own `auto` and `bypassPermissions`. A3 and D5 are its first callers. KERNEL-446.
