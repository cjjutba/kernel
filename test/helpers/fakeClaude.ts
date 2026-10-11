import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A stand-in for `claude setup-token` (KERNEL-406). `FAKE_CODE_FILE` makes it ask for a code and write what it got there,
// `FAKE_WRAP` wraps the token after that many characters, and `FAKE_NO_TOKEN` makes it end without one.

export const TOKEN = `sk-ant-oat01-${'Ab3_x-9Zq'.repeat(10)}abcde`
export const LINK = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz'

/** A fake `claude` that does what `setup-token` does: a link, maybe a code prompt, then the token, wrapped where `WRAP` says. */
export async function fakeClaude(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-claude-'))
  const bin = join(dir, 'claude')
  await writeFile(bin, `#!/bin/sh
case "$1" in --version) echo "2.1.292 (Claude Code)"; exit 0;; setup-token) ;; *) exit 2;; esac
printf "Browser didn't open? Use the url below to sign in\\n\\033]8;;${LINK}\\007${LINK}\\033]8;;\\007\\n"
if [ -n "$FAKE_CODE_FILE" ]; then printf 'Paste code here if prompted > '; read code; echo "$code" > "$FAKE_CODE_FILE"; fi
if [ -n "$FAKE_NO_TOKEN" ]; then exit 1; fi
T="${TOKEN}"
W=\${FAKE_WRAP:-0}
if [ "$W" -gt 0 ]; then HEAD=$(printf %s "$T" | cut -c1-$W); TAIL=$(printf %s "$T" | cut -c$((W + 1))-); else HEAD=$T; TAIL=; fi
printf '\\033[32m\\342\\234\\223 Long-lived authentication token created successfully!\\033[39m\\n\\nYour OAuth token (valid for 1 year):\\n\\n\\033[33m%s\\n%s\\033[39m\\n\\nStore this token securely. You won'"'"'t be able to see it again.\\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\\n' "$HEAD" "$TAIL"
sleep 5
`)
  await chmod(bin, 0o755)
  return bin
}
