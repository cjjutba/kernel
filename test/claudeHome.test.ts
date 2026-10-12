import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyClaudeConfig, credentialsItem, linkClaudeHome, loginMcp, mcpLoginLink, removeClaudeHome, shareMcpSignIns } from '../src/main/services/providers/claudeHome'
import { fakeClaude, MCP_LINK } from './helpers/fakeClaude'
import { fakeKeychain } from './helpers/fakeKeychain'

// An added Claude account's folder (KERNEL-560, KERNEL-567): its own login and `.claude.json`, and `~/.claude` linked in.

/** A `~/.claude` with settings, chats, skills, plugins and the CLI login's own files, and an account folder beside it. */
async function setUp() {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-claude-home-'))
  const root = join(dir, '.claude')
  const home = join(dir, 'claude-homes', 'acct')
  await mkdir(join(root, 'projects', '-repo'), { recursive: true })
  await writeFile(join(root, 'projects', '-repo', 'chat.jsonl'), '{}\n')
  await writeFile(join(root, 'settings.json'), '{"hooks":{}}')
  await writeFile(join(root, 'CLAUDE.md'), '# me')
  await mkdir(join(root, 'skills', 'impeccable'), { recursive: true })
  await mkdir(join(root, 'skills', 'synced', 'org-cli'), { recursive: true })
  await mkdir(join(root, 'plugins', 'cache'), { recursive: true })
  await writeFile(join(root, 'plugins', 'installed_plugins.json'), '{}')
  for (const own of ['.claude.json', '.credentials.json', 'mcp-needs-auth-cache.json', 'remote-settings.json', 'daemon.log']) await writeFile(join(root, own), 'cli')
  await mkdir(join(root, 'backups'))
  return { dir, root, home }
}

const isLink = async (path: string) => (await lstat(path)).isSymbolicLink()

describe('linkClaudeHome', () => {
  it("links every entry of ~/.claude but the login's own files, and skills and plugins entry by entry but synced", async () => {
    const { root, home } = await setUp()
    linkClaudeHome(home, root)
    for (const name of ['projects', 'settings.json', 'CLAUDE.md']) expect(await readlink(join(home, name))).toBe(join(root, name))
    for (const own of ['.claude.json', '.credentials.json', 'mcp-needs-auth-cache.json', 'remote-settings.json', 'daemon.log', 'backups']) expect(existsSync(join(home, own))).toBe(false)
    // Real folders whose entries are links, so the account's org can sync its own skills and plugins beside them.
    expect(await isLink(join(home, 'skills'))).toBe(false)
    expect(await readlink(join(home, 'skills', 'impeccable'))).toBe(join(root, 'skills', 'impeccable'))
    expect(await readdir(join(home, 'skills'))).toEqual(['impeccable'])
    expect((await readdir(join(home, 'plugins'))).sort()).toEqual(['cache', 'installed_plugins.json'])
    expect(await readlink(join(home, 'plugins', 'cache'))).toBe(join(root, 'plugins', 'cache'))
  })

  it("links what ~/.claude gained since, keeps what the folder has, and gives way only where the CLI left an empty folder", async () => {
    const { root, home } = await setUp()
    await mkdir(join(home, 'plans'), { recursive: true })
    await mkdir(join(home, 'tasks', 'mine'), { recursive: true })
    await mkdir(join(root, 'plans'))
    await mkdir(join(root, 'tasks'))
    linkClaudeHome(home, root)
    expect(await readlink(join(home, 'plans'))).toBe(join(root, 'plans'))
    expect(await isLink(join(home, 'tasks'))).toBe(false)
    expect(await readdir(join(home, 'tasks'))).toEqual(['mine'])
    await writeFile(join(root, 'history.jsonl'), '')
    await mkdir(join(root, 'skills', 'unslop'))
    await mkdir(join(home, 'skills', 'synced', 'org-acct'), { recursive: true })
    linkClaudeHome(home, root)
    expect(await readlink(join(home, 'history.jsonl'))).toBe(join(root, 'history.jsonl'))
    expect(await readlink(join(home, 'skills', 'unslop'))).toBe(join(root, 'skills', 'unslop'))
    expect(await isLink(join(home, 'skills', 'synced'))).toBe(false)
  })
})

describe('removeClaudeHome', () => {
  it("deletes the folder and its links, and never what they point to in ~/.claude", async () => {
    const { root, home } = await setUp()
    linkClaudeHome(home, root)
    await writeFile(join(home, '.claude.json'), '{}')
    await mkdir(join(home, 'skills', 'synced', 'org-acct', 'a-skill'), { recursive: true })
    const before = await readdir(root, { recursive: true })
    await removeClaudeHome(home)
    expect(existsSync(home)).toBe(false)
    expect(await readdir(root, { recursive: true })).toEqual(before)
    expect(await readFile(join(root, 'projects', '-repo', 'chat.jsonl'), 'utf8')).toBe('{}\n')
    await removeClaudeHome(home)
  })
})

describe('copyClaudeConfig', () => {
  const cli = { mcpServers: { neon: { command: 'neon' } }, projects: { '/repo': { mcpServers: { local: { command: 'x' } } } }, oauthAccount: { emailAddress: 'cj@example.com' }, numStartups: 9 }

  it("gives the account the CLI login's MCP servers and projects in place of its own, and keeps its login's keys", async () => {
    const { dir, home } = await setUp()
    const from = join(dir, '.claude.json')
    await writeFile(from, JSON.stringify(cli))
    await mkdir(home, { recursive: true })
    await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'side@example.com' }, userID: 'u1', mcpServers: { added: {} } }))
    copyClaudeConfig(home, from)
    expect(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))).toEqual({ oauthAccount: { emailAddress: 'side@example.com' }, userID: 'u1', mcpServers: cli.mcpServers, projects: cli.projects })
    expect((await stat(join(home, '.claude.json'))).mode & 0o777).toBe(0o600)
    // A key the CLI login dropped goes from the account too.
    await writeFile(from, JSON.stringify({ projects: {} }))
    copyClaudeConfig(home, from)
    expect(JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'))).toEqual({ oauthAccount: { emailAddress: 'side@example.com' }, userID: 'u1', projects: {} })
  })

  it("changes nothing while either file can't be read whole", async () => {
    const { dir, home } = await setUp()
    const from = join(dir, '.claude.json')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, '.claude.json'), '{"oauthAccount":')
    await writeFile(from, JSON.stringify(cli))
    copyClaudeConfig(home, from)
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{"oauthAccount":')
    await writeFile(join(home, '.claude.json'), '{"userID":"u1"}')
    await writeFile(from, '{"mcpServers":')
    copyClaudeConfig(home, from)
    expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{"userID":"u1"}')
  })
})

// MCP sign-ins (KERNEL-616): Claude Code keeps a login and its MCP servers' OAuth sign-ins in one Keychain item, so Kernel
// copies the sign-ins of the servers the user added between logins. No real Keychain is touched.

describe("naming a login's Keychain item", () => {
  it('names it the way Claude Code 2.1.292 does, from CLAUDE_SECURESTORAGE_CONFIG_DIR or else CLAUDE_CONFIG_DIR', () => {
    const dir = '/Users/me/Library/Application Support/Kernel/claude-homes/acct'
    const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8)
    expect(credentialsItem({})).toBe('Claude Code-credentials')
    expect(credentialsItem({ CLAUDE_CONFIG_DIR: dir })).toBe(`Claude Code-credentials-${hash}`)
    // The exact string counts: a trailing slash is another item.
    expect(credentialsItem({ CLAUDE_CONFIG_DIR: `${dir}/` })).not.toBe(`Claude Code-credentials-${hash}`)
    expect(credentialsItem({ CLAUDE_CONFIG_DIR: '/elsewhere', CLAUDE_SECURESTORAGE_CONFIG_DIR: dir })).toBe(`Claude Code-credentials-${hash}`)
    expect(credentialsItem({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })).toBe('Claude Code-credentials')
  })
})

describe('sharing MCP sign-ins between Claude logins', () => {
  const HOUR = 3600_000
  const now = Date.now()
  const CLI = 'Claude Code-credentials'
  const SIDE = 'Claude Code-credentials-0175ce98'
  /** A server's sign-in as Claude Code keeps it, its tokens named after `who`. */
  const signIn = (server: string, who: string, expiresAt?: number) => ({ serverName: server, serverUrl: `https://${server}.example.com/mcp`, accessToken: `${who}-${server}-access`, refreshToken: `${who}-${server}-refresh`, ...(expiresAt !== undefined ? { expiresAt } : {}), clientId: `client-${server}` })
  /** What Claude Code leaves for a server it couldn't reach: discovery, no token. */
  const stub = (server: string) => ({ serverName: server, serverUrl: `https://${server}.example.com/mcp`, accessToken: '', discoveryState: { authorizationServerUrl: `https://${server}.example.com` } })

  async function folders() {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-mcp-'))
    const cli = join(dir, '.claude')
    const side = join(dir, 'claude-homes', 'side')
    await mkdir(cli, { recursive: true })
    await mkdir(side, { recursive: true })
    return { cli, side, logins: [{ item: CLI, dir: cli }, { item: SIDE, dir: side }] }
  }

  it("gives an added login the CLI login's sign-ins it lacks, keeps its own login, and leaves claude.ai connectors alone", async () => {
    const { side, logins } = await folders()
    const kc = fakeKeychain({
      [CLI]: {
        claudeAiOauth: { accessToken: 'max-login' },
        mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR), 'posthog|bbb': signIn('posthog', 'cli'), 'claude.ai Gmail|ccc': { serverName: 'claude.ai Gmail', accessToken: 'cli-gmail-access' } },
        mcpOAuthClientConfig: { 'corp|ddd': { clientSecret: 'corp-secret' } }
      },
      [SIDE]: { claudeAiOauth: { accessToken: 'pro-login' }, mcpOAuth: { 'linear|aaa': stub('linear'), 'mobbin|eee': stub('mobbin') } }
    })
    const at = Date.now()
    await writeFile(join(side, 'mcp-needs-auth-cache.json'), JSON.stringify({ linear: { timestamp: at }, mobbin: { timestamp: at }, 'claude.ai Google Drive': { timestamp: at } }))
    expect(shareMcpSignIns(kc.keychain, logins)).toEqual(new Map([[side, ['linear', 'posthog']]]))
    const got = kc.json(SIDE)
    expect(got.claudeAiOauth).toEqual({ accessToken: 'pro-login' })
    expect(got.mcpOAuth).toEqual({ 'linear|aaa': signIn('linear', 'cli', now + HOUR), 'posthog|bbb': signIn('posthog', 'cli'), 'mobbin|eee': stub('mobbin') })
    expect(got.mcpOAuthClientConfig).toEqual({ 'corp|ddd': { clientSecret: 'corp-secret' } })
    // Claude Code would skip linear for 15 minutes while the cache names it. Mobbin has no sign-in anywhere, and the
    // connector is the account's own.
    expect(JSON.parse(await readFile(join(side, 'mcp-needs-auth-cache.json'), 'utf8'))).toEqual({ mobbin: { timestamp: at }, 'claude.ai Google Drive': { timestamp: at } })
    expect(kc.writes).toEqual([SIDE])
    // Shared again, nothing is behind.
    expect(shareMcpSignIns(kc.keychain, logins).size).toBe(0)
    expect(kc.writes).toEqual([SIDE])
  })

  it('sends a token one login refreshed or signed in again back to the others, and never a sign-in without a token', async () => {
    const { cli, logins } = await folders()
    const kc = fakeKeychain({
      // The CLI's linear refresh was refused, so Claude Code cleared it. Its posthog has no expiry.
      [CLI]: { claudeAiOauth: { accessToken: 'max-login' }, mcpOAuth: { 'linear|aaa': { ...stub('linear'), expiresAt: 0 }, 'posthog|bbb': signIn('posthog', 'cli'), 'porkbun|ccc': signIn('porkbun', 'cli', now + HOUR) } },
      [SIDE]: { claudeAiOauth: { accessToken: 'pro-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'side', now + HOUR), 'posthog|bbb': signIn('posthog', 'side', now + HOUR), 'porkbun|ccc': signIn('porkbun', 'side', now + HOUR) } }
    })
    await writeFile(join(cli, 'mcp-needs-auth-cache.json'), JSON.stringify({ linear: { timestamp: Date.now() } }))
    expect(shareMcpSignIns(kc.keychain, logins)).toEqual(new Map([[cli, ['linear', 'posthog']]]))
    expect(kc.json(CLI)).toEqual({ claudeAiOauth: { accessToken: 'max-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'side', now + HOUR), 'posthog|bbb': signIn('posthog', 'side', now + HOUR), 'porkbun|ccc': signIn('porkbun', 'cli', now + HOUR) } })
    expect(JSON.parse(await readFile(join(cli, 'mcp-needs-auth-cache.json'), 'utf8'))).toEqual({})
    // A tie keeps each as it is: porkbun stays the CLI's on the CLI and the account's on the account.
    expect(kc.json(SIDE).mcpOAuth['porkbun|ccc'].accessToken).toBe('side-porkbun-access')
    expect(kc.writes).toEqual([CLI])
  })

  it("leaves an item it can't read whole alone, and makes none", async () => {
    const { logins } = await folders()
    const kc = fakeKeychain({ [CLI]: { mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR) } }, [SIDE]: '{"claudeAiOauth":' })
    expect(shareMcpSignIns(kc.keychain, logins).size).toBe(0)
    expect(kc.json(CLI).mcpOAuth['linear|aaa'].accessToken).toBe('cli-linear-access')
    const none = fakeKeychain({ [CLI]: { mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR) } } })
    expect(shareMcpSignIns(none.keychain, logins).size).toBe(0)
    expect(none.writes).toEqual([])
    expect(kc.writes).toEqual([])
  })

  it('reads an item again right before writing it, so what Claude Code wrote meanwhile stays', async () => {
    const { logins } = await folders()
    const kc = fakeKeychain({
      [CLI]: { claudeAiOauth: { accessToken: 'max-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR), 'posthog|bbb': signIn('posthog', 'cli', now + HOUR) } },
      [SIDE]: { claudeAiOauth: { accessToken: 'pro-login' }, mcpOAuth: {} }
    })
    // Between Kernel's two reads, the account refreshes its login and signs linear in itself.
    kc.between.set(SIDE, () => kc.set(SIDE, { claudeAiOauth: { accessToken: 'pro-login-refreshed' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'side', now + 2 * HOUR) } }))
    shareMcpSignIns(kc.keychain, logins)
    expect(kc.json(SIDE)).toEqual({ claudeAiOauth: { accessToken: 'pro-login-refreshed' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'side', now + 2 * HOUR), 'posthog|bbb': signIn('posthog', 'cli', now + HOUR) } })
  })

  it('logs nothing it read', async () => {
    const { logins } = await folders()
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m))
    const kc = fakeKeychain({ [CLI]: { mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR) } }, [SIDE]: { mcpOAuth: {} } })
    shareMcpSignIns(kc.keychain, logins)
    shareMcpSignIns(fakeKeychain({ [CLI]: 'not json', [SIDE]: { mcpOAuth: {} } }).keychain, logins)
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore() }
  })
})

describe('signing an MCP server in with claude mcp login', () => {
  const env = (home: string, extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? '', HOME: tmpdir(), CLAUDE_CONFIG_DIR: home, ...extra })

  it("finds the page Claude Code opens, wrapped in a hyperlink or not", () => {
    expect(mcpLoginLink(`If the browser didn't open, visit: \x1b]8;;${MCP_LINK}\x07${MCP_LINK}\x1b]8;;\x07\r\n`)).toBe(MCP_LINK)
    expect(mcpLoginLink(`Visit this URL to authorize: ${MCP_LINK}\r\n`)).toBe(MCP_LINK)
    expect(mcpLoginLink('Starting authentication for "linear"…')).toBeUndefined()
  })

  it("runs in a terminal in the account's folder, passes the page on, and fails with Claude Code's words or on Cancel", async () => {
    const claude = await fakeClaude()
    const home = join(await mkdtemp(join(tmpdir(), 'kernel-home-')), 'acct')
    const links: string[] = []
    await loginMcp(claude.bin, 'linear', { env: env(home), cwd: tmpdir(), timeoutMs: 10_000, onLink: (u) => links.push(u) }).done
    expect(links).toEqual([MCP_LINK])
    expect((await claude.calls()).at(-1)).toEqual({ args: 'mcp login linear', dir: home, token: false })
    const connector: string[] = []
    await loginMcp(claude.bin, 'claude.ai Google Drive', { env: env(home), cwd: tmpdir(), timeoutMs: 10_000, onLink: (u) => connector.push(u) }).done
    expect(connector).toEqual(['https://claude.ai/customize/connectors'])
    await expect(loginMcp(claude.bin, 'linear', { env: env(home, { FAKE_MCP_FAIL: '1' }), cwd: tmpdir(), timeoutMs: 10_000 }).done).rejects.toThrow('Claude Code said: Couldn\'t complete authentication for "linear": access denied')
    const waiting = loginMcp(claude.bin, 'linear', { env: env(home, { FAKE_LOGIN_WAIT: '1' }), cwd: tmpdir(), timeoutMs: 10_000 })
    waiting.cancel()
    await expect(waiting.done).rejects.toThrow('Sign-in canceled.')
  })
})
