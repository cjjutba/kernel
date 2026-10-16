**A copied MCP sign-in is not trusted until Claude Code confirms it, and a dead token is never copied.** Amends KERNEL-616.

On 2026-10-16 Settings, MCP servers showed porkbun as ready on the Main account while `claude mcp get porkbun` said it needed authentication, and a Lead session started without Porkbun's tools. Kernel had copied a porkbun token to that login and counted the copy as a sign-in. Claude Code was never asked.

- A server a sign-in just landed on reads `checking`. That covers a copy from another login (`shareMcpSignIns`) and a sign-in from Kernel (`Providers.mcpSignIn`). Kernel checks the login again right away (`Mcp.checkAccount` with `fresh`), and the server then reads what Claude Code reported. Only Claude Code's `connected` makes it `ready`. `checking` counts as neither ready nor needing the user.
- A token whose `expiresAt` has passed and that has no refresh token counts as no token. Kernel never copies it.
- A login whose own token is still valid by its `expiresAt` keeps it. KERNEL-616 copied a token with a later expiry over it, so a refresh on one login reached the others before their refresh token died. A later expiry can also belong to a token the server revoked, and that copy broke a working sign-in. A login whose refresh token did die now fails one refresh, drops the token, and gets the fresh one at the next share. A token with no expiry still loses to a dated one, as before.
- When the check after a copy still says `needs-auth`, Kernel remembers that token as rejected for that server and never copies it again. Without this, the rejected token would be copied back from the login that still holds it after Claude Code drops it, every share. Kernel keeps a sha256 of the server name and the token's `expiresAt`, in memory only, never the token. A login holding a rejected token counts as holding none, so a new sign-in elsewhere still reaches it.
- claude.ai connectors are still never copied.
KERNEL-935.
