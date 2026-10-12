import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A stand-in for Claude Code's own login commands (KERNEL-567): `auth login`, `auth status` and `auth logout`. Its Keychain is
// a folder of files, one per login, named after CLAUDE_CONFIG_DIR's exact string as the real items are, or `cli` without it.
// The CLI's own login starts signed in as cj@example.com on Max.
// `auth login` prints a link and its code prompt. `FAKE_CODE_FILE` makes it wait for a code and write what it got there,
// `FAKE_LOGIN_WAIT` makes it wait until it is stopped, and `FAKE_LOGIN_FAIL` makes it fail. It signs in as `FAKE_EMAIL`
// on `FAKE_PLAN`, side@example.com on Pro by default.

export const LINK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz'

export interface FakeClaude {
  bin: string
  /** The logins signed in now, by Keychain name: `cli`, or the folder path. */
  logins(): Promise<Record<string, { email: string; plan: string }>>
  /** Signs a folder's login in or out behind Kernel's back, as a sign-out on another Mac or an upgrade would. */
  setLogin(home: string | 'cli', login: { email: string; plan: string } | null): Promise<void>
  /** Each command it ran: its arguments, CLAUDE_CONFIG_DIR, and whether it got a token from the Mac. */
  calls(): Promise<{ args: string; dir: string; token: boolean }[]>
}

const keyOf = (home: string) => (home === 'cli' ? 'cli' : home.replace(/\//g, '%'))

export async function fakeClaude(): Promise<FakeClaude> {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-claude-'))
  const bin = join(dir, 'claude')
  const keychain = join(dir, 'keychain')
  const log = join(dir, 'calls.log')
  await mkdir(keychain)
  await writeFile(join(keychain, 'cli'), 'cj@example.com max\n')
  await writeFile(log, '')
  await writeFile(bin, `#!/bin/sh
KC="${keychain}"
key() { if [ -n "$CLAUDE_CONFIG_DIR" ]; then printf %s "$CLAUDE_CONFIG_DIR" | sed 's#/#%#g'; else printf cli; fi; }
printf '%s\\t%s\\t%s\\n' "$*" "$CLAUDE_CONFIG_DIR" "\${CLAUDE_CODE_OAUTH_TOKEN:+token}" >> "${log}"
case "$1 $2" in
  "--version "*) echo "2.1.292 (Claude Code)"; exit 0;;
  "auth status")
    F="$KC/$(key)"
    if [ -f "$F" ]; then read EMAIL PLAN < "$F"; printf '{"loggedIn":true,"authMethod":"claude.ai","email":"%s","subscriptionType":"%s"}\\n' "$EMAIL" "$PLAN"; exit 0; fi
    printf '{"loggedIn":false,"authMethod":"none"}\\n'; exit 1;;
  "auth logout") rm -f "$KC/$(key)"; echo "Successfully logged out from your Anthropic account."; exit 0;;
  "auth login")
    printf 'Opening browser to sign in\\342\\200\\246\\n'
    printf "If the browser didn't open, visit: \\033]8;;${LINK}\\007${LINK}\\033]8;;\\007\\n"
    printf 'Paste code here if prompted > '
    if [ -n "$FAKE_CODE_FILE" ]; then read code; echo "$code" > "$FAKE_CODE_FILE"; fi
    if [ -n "$FAKE_LOGIN_WAIT" ]; then sleep 30; fi
    if [ -n "$FAKE_LOGIN_FAIL" ]; then printf '\\nOAuth error: Request failed with status code 400\\n'; exit 1; fi
    printf '%s %s\\n' "\${FAKE_EMAIL:-side@example.com}" "\${FAKE_PLAN:-pro}" > "$KC/$(key)"
    if [ -n "$CLAUDE_CONFIG_DIR" ]; then mkdir -p "$CLAUDE_CONFIG_DIR"; printf '{"oauthAccount":{"emailAddress":"%s"},"userID":"u1"}\\n' "\${FAKE_EMAIL:-side@example.com}" > "$CLAUDE_CONFIG_DIR/.claude.json"; fi
    printf '\\nLogin successful.\\n'; exit 0;;
esac
exit 2
`)
  await chmod(bin, 0o755)
  return {
    bin,
    logins: async () => {
      const out: Record<string, { email: string; plan: string }> = {}
      for (const name of await readdir(keychain)) {
        const [email, plan] = (await readFile(join(keychain, name), 'utf8')).trim().split(' ')
        out[name === 'cli' ? 'cli' : name.replace(/%/g, '/')] = { email, plan }
      }
      return out
    },
    setLogin: async (home, login) => {
      if (login) await writeFile(join(keychain, keyOf(home)), `${login.email} ${login.plan}\n`)
      else await rm(join(keychain, keyOf(home)), { force: true })
    },
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => {
      const [args, dir, token] = l.split('\t')
      return { args, dir, token: token === 'token' }
    })
  }
}
