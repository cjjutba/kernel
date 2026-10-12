**Sessions use an API key only when the user picked an API key account.** Amends D-018 and KERNEL-406. An API key is one more kind of account for Claude Code and for Codex, next to the CLI's own login and the subscription accounts Kernel adds. The user adds it with a name and the key. Like every account, it runs nothing until the user switches to it, and Kernel never switches to it on its own, at a limit or anywhere else. KERNEL-406's "Neither provider has an API key option anywhere" no longer holds, and PRODUCT.md drops API key billing from Not in v1.

D-018 now reads: `sessionEnv` drops `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment every session inherits, the Mac's and the workspace's alike. Only the active account's credential goes back in. For a key account that is its key as `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` goes too, so a token in the user's shell can't take over. For the CLI's own login and for a `setup-token` account nothing changes. The chat note keeps its job of catching a session billed by something the user didn't pick. On a subscription account it fires for any `apiKeySource` but `none`, as before. On a key account it stays quiet for `ANTHROPIC_API_KEY` and fires for anything else, `none` included, since then the plan pays instead of the key. A Codex CLI login made with an API key still reads as signed out: the key accounts are the ones the user added in Kernel. KERNEL-523.

**Spike: what the pinned CLIs do with an API key.** Run on Claude Code 2.1.292 (SDK 0.3.292) and Codex 0.153.4 with made-up keys. The machine's network sandbox refused connections to api.anthropic.com and api.openai.com, so nothing reached either API.

Claude Code:
- With `ANTHROPIC_API_KEY` in the session env and a Max login in the Keychain, `init` said `apiKeySource: 'ANTHROPIC_API_KEY'`.
- `claude auth status` with the key set said `authMethod: 'api_key'` and `apiKeySource: 'ANTHROPIC_API_KEY'`. Without it, the same command said `claude.ai` and `max`. So the env key wins over the Keychain login, as the token did in KERNEL-406's spike.
- Not answered: whether `rate_limit_event` arrives on a key, and how a refused key comes back. Both need a turn that reaches the API. Kernel doesn't depend on the first, since a key account drops every window (below). The second goes through the path a refused token takes: `authentication_failed`, or `api_retry` with a 401. Checking both takes one Haiku turn on a real key from a machine that can reach the API.

Codex:
- `account/login/start` with `{ type: 'apiKey', apiKey }` answered `{ type: 'apiKey' }` within a millisecond, then sent `account/login/completed` with `success: true` and `account/updated` with `authMode: 'apikey'`. It never called OpenAI, so the login checks nothing.
- It wrote `auth.json` in the account's home as `{ auth_mode: 'apikey', OPENAI_API_KEY: <the key> }`, mode 600, in plain text.
- `account/read` answered `{ account: { type: 'apiKey' }, requiresOpenaiAuth: true }`, with no email and no plan.
- `account/rateLimits/read` failed with -32600, "chatgpt authentication required to read rate limits".
- With `-c cli_auth_credentials_store="ephemeral"` on `codex app-server`, the same login worked and wrote no `auth.json`. `account/read` said `apiKey` in that process, a turn on it tried to reach `api.openai.com/v1/responses`, and a second process on the same home had no account.

**A key account keeps its key encrypted, and Codex holds it only in memory.**
- Kernel keeps both providers' keys encrypted with `safeStorage` in `api-keys.json`, next to `claude-tokens.json`. The account itself is in `accounts.json` with `auth: 'apiKey'`. Without encryption on the Mac, adding a key fails and says why.
- A Codex key account gets its own `codex-homes/<id>/`, linked to `~/.codex` like any other account's. Because Codex's own login writes the key to `auth.json` in plain text, every Codex process on a key account starts with `-c cli_auth_credentials_store="ephemeral"` and logs in with `{ type: 'apiKey' }` over stdin right after `initialize`. The key is never in a file, in the process arguments or in the environment, and `codexEnv` still strips `OPENAI_API_KEY` and `CODEX_API_KEY`.
- Adding a key checks it with one request that costs nothing: Anthropic's models list for Claude. Codex's login checks nothing, so a Codex key is checked against OpenAI's models list. A failure says why in plain words: not accepted, not allowed, rate limited, or Anthropic or OpenAI couldn't be reached. No error message carries the key, and the log's `sk-` rule (KERNEL-288) hides both providers' key shapes anyway.
- The same channel with an `accountId` replaces a key account's key, which is how one signs in again.

**A key account has no usage windows, and a 401 signs it out.**
- Kernel drops every usage window a key account's process reports: `rate_limit_event`, the usage call and Codex's rate limit reads. So no limit holds a chat or pauses a room on a key account, and the limit banner's "Switch to" offers one whenever it is signed in, since it never has a rejected window. An API rate limit or an empty balance fails the turn like any other error.
- A session that refuses the key marks the account signed out and holds that provider's chats, like a refused token, until the user gives it a new key. Run login on a key account says to add a new key instead of starting a sign-in.
- A key account has no Claude plan, so switching to one keeps the last plan's defaults (KERNEL-225), as a sign-out does. Switching back to a subscription account applies that account's plan.
KERNEL-523.
