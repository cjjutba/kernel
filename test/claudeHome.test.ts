import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountEnv, credentialsDir, credentialsItem, linkClaudeHome, loginMcp, mcpLoginLink, removeClaudeHome, shareMcpSignIns, syncClaudeConfig, syncClaudePlugins } from '../src/main/services/providers/claudeHome'
import { sessionEnv } from '../src/main/services/providers/claude'
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
  await mkdir(join(root, '.claude.json.lock'))
  await mkdir(join(root, 'backups'))
  return { dir, root, home }
}

const isLink = async (path: string) => (await lstat(path)).isSymbolicLink()

describe('linkClaudeHome', () => {
  it("links every entry of ~/.claude but the login's own files, and skills and plugins entry by entry but synced", async () => {
    const { root, home } = await setUp()
    linkClaudeHome(home, root)
    for (const name of ['projects', 'settings.json', 'CLAUDE.md']) expect(await readlink(join(home, name))).toBe(join(root, name))
    for (const own of ['.claude.json', '.claude.json.lock', '.credentials.json', 'mcp-needs-auth-cache.json', 'remote-settings.json', 'daemon.log', 'backups']) expect(existsSync(join(home, own))).toBe(false)
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
  it("moves the chats an account's own projects folder holds into ~/.claude's and links it, keeping a file both have (KERNEL-941)", async () => {
    const { root, home } = await setUp()
    await mkdir(join(home, 'projects', '-repo', 'sess', 'subagents'), { recursive: true })
    await writeFile(join(home, 'projects', '-repo', 'mine.jsonl'), 'mine\n')
    await writeFile(join(home, 'projects', '-repo', 'sess', 'subagents', 'a.jsonl'), 'a\n')
    await mkdir(join(home, 'projects', '-other'))
    await writeFile(join(home, 'projects', '-other', 'x.jsonl'), 'x\n')
    linkClaudeHome(home, root)
    expect(await readlink(join(home, 'projects'))).toBe(join(root, 'projects'))
    expect(await readFile(join(root, 'projects', '-repo', 'mine.jsonl'), 'utf8')).toBe('mine\n')
    expect(await readFile(join(root, 'projects', '-repo', 'sess', 'subagents', 'a.jsonl'), 'utf8')).toBe('a\n')
    expect(await readFile(join(root, 'projects', '-other', 'x.jsonl'), 'utf8')).toBe('x\n')
    expect(await readFile(join(root, 'projects', '-repo', 'chat.jsonl'), 'utf8')).toBe('{}\n')

    // A transcript both have is never overwritten: it stays in the folder, and so does the folder.
    const { root: root2, home: home2 } = await setUp()
    await mkdir(join(home2, 'projects', '-repo'), { recursive: true })
    await writeFile(join(home2, 'projects', '-repo', 'chat.jsonl'), 'other\n')
    await writeFile(join(home2, 'projects', '-repo', 'new.jsonl'), 'new\n')
    linkClaudeHome(home2, root2)
    expect(await isLink(join(home2, 'projects'))).toBe(false)
    expect(await readFile(join(home2, 'projects', '-repo', 'chat.jsonl'), 'utf8')).toBe('other\n')
    expect(await readFile(join(root2, 'projects', '-repo', 'chat.jsonl'), 'utf8')).toBe('{}\n')
    expect(await readFile(join(root2, 'projects', '-repo', 'new.jsonl'), 'utf8')).toBe('new\n')
  })

  it("makes ~/.claude/projects before linking, so a fresh login's chats are shared from its first one (KERNEL-941)", async () => {
    const { root, home } = await setUp()
    await rm(join(root, 'projects'), { recursive: true })
    linkClaudeHome(home, root)
    expect(await readlink(join(home, 'projects'))).toBe(join(root, 'projects'))
  })

  it("never links Claude Code's locks, and drops a link to one an older Kernel left, which would block the account's saves", async () => {
    const { root, home } = await setUp()
    // The CLI login is saving and renewing its login right now.
    for (const lock of ['.storage-write.lock', '.oauth_refresh.lock', '.design_oauth_refresh.lock']) await mkdir(join(root, lock))
    await mkdir(home, { recursive: true })
    await symlink(join(root, '.storage-write.lock'), join(home, '.storage-write.lock'))
    linkClaudeHome(home, root)
    for (const lock of ['.storage-write.lock', '.oauth_refresh.lock', '.design_oauth_refresh.lock']) expect(existsSync(join(home, lock))).toBe(false)
    // The account's own lock, a real folder its CLI holds, stays.
    await mkdir(join(home, '.oauth_refresh.lock'))
    linkClaudeHome(home, root)
    expect((await stat(join(home, '.oauth_refresh.lock'))).isDirectory()).toBe(true)
    expect(await isLink(join(home, 'settings.json'))).toBe(true)
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

describe('syncClaudeConfig', () => {
  const cli = { mcpServers: { neon: { command: 'neon' } }, projects: { '/repo': { allowedTools: [], mcpServers: { local: { command: 'x' } } } }, oauthAccount: { emailAddress: 'cj@example.com' }, numStartups: 9 }
  const side = { oauthAccount: { emailAddress: 'side@example.com' }, userID: 'u1' }
  const read = async (file: string) => JSON.parse(await readFile(file, 'utf8'))

  /** The CLI login's `.claude.json` and an account folder whose own one has `own`, synced once unless `own` says not to. */
  async function synced(own: object = side, o: { sync?: boolean } = {}) {
    const { dir, home } = await setUp()
    const from = join(dir, '.claude.json')
    const file = join(home, '.claude.json')
    await writeFile(from, JSON.stringify(cli))
    await mkdir(home, { recursive: true })
    await writeFile(file, JSON.stringify(own))
    if (o.sync !== false) syncClaudeConfig(home, from)
    /** Changes one login's file the way `claude mcp add` or `remove` would. */
    const edit = async (at: string, change: (c: any) => void) => { const c = await read(at); change(c); await writeFile(at, JSON.stringify(c)) }
    return { dir, home, from, file, edit }
  }

  it("gives the account the CLI login's MCP servers and projects in place of its own, and keeps its login's keys", async () => {
    const { home, from, file } = await synced(side)
    expect(await read(file)).toEqual({ ...side, mcpServers: cli.mcpServers, projects: cli.projects })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    // The CLI login's file had nothing to gain, so it is as it was.
    expect(await read(from)).toEqual(cli)
    // A key the CLI login dropped goes from the account too, servers and all.
    await writeFile(from, JSON.stringify({ projects: {} }))
    syncClaudeConfig(home, from)
    expect(await read(file)).toEqual({ ...side, projects: {} })
  })

  it('keeps a user and a local MCP server added on the account, on both logins, with each project it was added in (KERNEL-618)', async () => {
    const { home, from, file, edit } = await synced()
    await edit(file, (c) => { c.mcpServers.fal = { command: 'fal' }; c.projects['/repo'].mcpServers.db = { command: 'db' }; c.projects['/side'] = { allowedTools: ['Bash'], mcpServers: { s: { command: 's' } } } })
    syncClaudeConfig(home, from)
    const both = { neon: { command: 'neon' }, fal: { command: 'fal' } }
    const projects = { '/repo': { allowedTools: [], mcpServers: { local: { command: 'x' }, db: { command: 'db' } } }, '/side': { allowedTools: ['Bash'], mcpServers: { s: { command: 's' } } } }
    expect(await read(from)).toEqual({ ...cli, mcpServers: both, projects })
    expect(await read(file)).toEqual({ ...side, mcpServers: both, projects })
    // A server the CLI login gains while the account keeps its own reaches the account, and the account's stays.
    await edit(from, (c) => { c.mcpServers.linear = { type: 'http', url: 'https://mcp.linear.app' } })
    syncClaudeConfig(home, from)
    expect(Object.keys((await read(file)).mcpServers)).toEqual(['neon', 'fal', 'linear'])
  })

  it('removes a server removed on either login from the other, and never brings it back (KERNEL-618)', async () => {
    const { home, from, file, edit } = await synced()
    await edit(file, (c) => { c.mcpServers.fal = { command: 'fal' } })
    syncClaudeConfig(home, from)
    // Removed on the account.
    await edit(file, (c) => { delete c.mcpServers.fal; delete c.projects['/repo'].mcpServers.local })
    syncClaudeConfig(home, from)
    syncClaudeConfig(home, from)
    expect((await read(from)).mcpServers).toEqual({ neon: { command: 'neon' } })
    expect((await read(from)).projects['/repo']).toEqual({ allowedTools: [], mcpServers: {} })
    // Removed on the CLI login.
    await edit(from, (c) => { delete c.mcpServers.neon })
    syncClaudeConfig(home, from)
    syncClaudeConfig(home, from)
    expect((await read(file)).mcpServers).toEqual({})
    expect((await read(from)).mcpServers).toEqual({})
  })

  it("lets the CLI login win when both changed one server, and takes the account's change when only it did (KERNEL-618)", async () => {
    const { home, from, file, edit } = await synced()
    await edit(file, (c) => { c.mcpServers.neon = { command: 'neon', args: ['--account'] } })
    await edit(from, (c) => { c.mcpServers.neon = { command: 'neon', args: ['--cli'] } })
    syncClaudeConfig(home, from)
    expect((await read(file)).mcpServers.neon).toEqual({ command: 'neon', args: ['--cli'] })
    await edit(file, (c) => { c.mcpServers.neon = { command: 'neon', args: ['--account'] } })
    syncClaudeConfig(home, from)
    expect((await read(from)).mcpServers.neon).toEqual({ command: 'neon', args: ['--account'] })
  })

  it("never removes the CLI login's servers when the account's file lost its own, as a reset file has (KERNEL-618)", async () => {
    const { home, from, file } = await synced()
    for (const own of [JSON.stringify(side), undefined]) {
      if (own) await writeFile(file, own)
      else await rm(file)
      syncClaudeConfig(home, from)
      expect(await read(from)).toEqual(cli)
      expect(await read(file)).toEqual({ ...(own ? side : {}), mcpServers: cli.mcpServers, projects: cli.projects })
    }
  })

  it('counts a server only the account has as added there the first time, with no base to go by (KERNEL-618)', async () => {
    const { from, file } = await synced({ ...side, mcpServers: { added: { command: 'a' } } })
    expect((await read(from)).mcpServers).toEqual({ neon: { command: 'neon' }, added: { command: 'a' } })
    expect((await read(file)).mcpServers).toEqual({ neon: { command: 'neon' }, added: { command: 'a' } })
  })

  it('changes nothing while Claude Code holds either lock, and takes over one left behind (KERNEL-618)', async () => {
    const { home, from, file, edit } = await synced()
    await edit(file, (c) => { c.mcpServers.fal = { command: 'fal' } })
    for (const lock of [`${from}.lock`, `${file}.lock`]) {
      await mkdir(lock)
      syncClaudeConfig(home, from)
      expect((await read(from)).mcpServers).toEqual(cli.mcpServers)
      expect(existsSync(lock)).toBe(true)
      // Claude Code renews its lock every 5 seconds, so one a minute old was left behind.
      const old = new Date(Date.now() - 60_000)
      await utimes(lock, old, old)
    }
    syncClaudeConfig(home, from)
    expect((await read(from)).mcpServers).toEqual({ neon: { command: 'neon' }, fal: { command: 'fal' } })
    expect([existsSync(`${from}.lock`), existsSync(`${file}.lock`)]).toEqual([false, false])
  })

  it('writes a linked .claude.json through its link, at its own mode (KERNEL-618)', async () => {
    const { dir, home, from, file, edit } = await synced()
    const real = join(dir, 'dotfiles.json')
    await writeFile(real, await readFile(from, 'utf8'), { mode: 0o644 })
    await rm(from)
    await symlink(real, from)
    await edit(file, (c) => { c.mcpServers.fal = { command: 'fal' } })
    syncClaudeConfig(home, from)
    expect(await readlink(from)).toBe(real)
    expect((await read(real)).mcpServers.fal).toEqual({ command: 'fal' })
    expect((await stat(real)).mode & 0o777).toBe(0o644)
  })

  it("changes nothing while either file can't be read whole", async () => {
    const { home, from, file } = await synced('{"oauthAccount":' as never, { sync: false })
    await writeFile(file, '{"oauthAccount":')
    syncClaudeConfig(home, from)
    expect(await readFile(file, 'utf8')).toBe('{"oauthAccount":')
    await writeFile(file, '{"userID":"u1"}')
    await writeFile(from, '{"mcpServers":')
    syncClaudeConfig(home, from)
    expect(await readFile(file, 'utf8')).toBe('{"userID":"u1"}')
  })
})

// MCP sign-ins (KERNEL-616): Claude Code keeps a login and its MCP servers' OAuth sign-ins in one Keychain item, so Kernel
// copies the sign-ins of the servers the user added between logins. No real Keychain is touched.

describe('syncClaudePlugins (KERNEL-646)', () => {
  /** Plugin `name` installed at `version`, from `at`'s plugin cache, as Claude Code 2.1.292 writes it. */
  const entry = (at: string, name: string, version: string) => [{ scope: 'user', installPath: join(at, 'plugins', 'cache', 'official', name, version), version }]
  const installed = (plugins: Record<string, unknown>) => JSON.stringify({ version: 2, plugins })
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

  /** `~/.claude` with the vercel plugin installed, an account folder linked to it, and Claude Code's rename on the account. */
  async function linked() {
    const s = await setUp()
    await writeFile(join(s.root, 'plugins', 'installed_plugins.json'), installed({ 'vercel@official': entry(s.root, 'vercel', '0.43.0') }))
    await writeFile(join(s.root, 'plugins', 'known_marketplaces.json'), JSON.stringify({ official: { installLocation: join(s.root, 'plugins', 'marketplaces', 'official'), lastUpdated: '1' } }))
    linkClaudeHome(s.home, s.root)
    const own = join(s.home, 'plugins', 'installed_plugins.json')
    /** What Claude Code does on the account: a new file in place of the link. */
    const write = async (plugins: Record<string, unknown>) => { await rm(own); await writeFile(own, installed(plugins)) }
    return { ...s, own, write }
  }

  it('brings a plugin installed on the account to ~/.claude with its path there, and links the file again', async () => {
    const { root, home, own, write } = await linked()
    await write({ 'vercel@official': entry(root, 'vercel', '0.43.0'), 'figma@official': entry(home, 'figma', '1.0.0') })
    syncClaudePlugins(home, root)
    const shared = await read(join(root, 'plugins', 'installed_plugins.json'))
    expect(shared.version).toBe(2)
    expect(shared.plugins['figma@official']).toEqual(entry(root, 'figma', '1.0.0'))
    expect(shared.plugins['vercel@official']).toEqual(entry(root, 'vercel', '0.43.0'))
    expect(await readlink(own)).toBe(join(root, 'plugins', 'installed_plugins.json'))
    // The marketplaces file is still a link, so nothing changed there.
    expect(await isLink(join(home, 'plugins', 'known_marketplaces.json'))).toBe(true)
  })

  it('takes a plugin removed or updated on either login to the other, and the CLI login wins when both changed one', async () => {
    const { root, home, own, write } = await linked()
    await write({ 'vercel@official': entry(home, 'vercel', '0.50.0'), 'figma@official': entry(home, 'figma', '1.0.0') })
    syncClaudePlugins(home, root)
    // The CLI login removes figma: the account reads it through the link at once.
    const sharedFile = join(root, 'plugins', 'installed_plugins.json')
    await writeFile(sharedFile, installed({ 'vercel@official': entry(root, 'vercel', '0.50.0') }))
    expect(Object.keys((await read(own)).plugins)).toEqual(['vercel@official'])
    // The account removes vercel and adds context7, while the CLI login updates vercel: the CLI login's update stays.
    await write({ 'context7@official': entry(home, 'context7', '2.0.0') })
    await writeFile(sharedFile, installed({ 'vercel@official': entry(root, 'vercel', '0.51.0') }))
    syncClaudePlugins(home, root)
    expect((await read(sharedFile)).plugins).toEqual({ 'vercel@official': entry(root, 'vercel', '0.51.0'), 'context7@official': entry(root, 'context7', '2.0.0') })
    // An account that removed a plugin nobody else touched removes it on the CLI login too.
    await write({ 'vercel@official': entry(root, 'vercel', '0.51.0') })
    syncClaudePlugins(home, root)
    expect(Object.keys((await read(sharedFile)).plugins)).toEqual(['vercel@official'])
    expect(await isLink(own)).toBe(true)
  })

  it("keeps the CLI login's plugin on a first sync when both have it, and merges marketplaces the same way", async () => {
    const { root, home, write } = await linked()
    await write({ 'vercel@official': entry(home, 'vercel', '0.50.0') })
    const markets = join(home, 'plugins', 'known_marketplaces.json')
    await rm(markets)
    await writeFile(markets, JSON.stringify({ official: { installLocation: join(home, 'plugins', 'marketplaces', 'official'), lastUpdated: '2' }, vercel: { installLocation: join(home, 'plugins', 'marketplaces', 'vercel'), lastUpdated: '2' } }))
    syncClaudePlugins(home, root)
    expect((await read(join(root, 'plugins', 'installed_plugins.json'))).plugins['vercel@official']).toEqual(entry(root, 'vercel', '0.43.0'))
    expect(await read(join(root, 'plugins', 'known_marketplaces.json'))).toEqual({
      official: { installLocation: join(root, 'plugins', 'marketplaces', 'official'), lastUpdated: '1' },
      vercel: { installLocation: join(root, 'plugins', 'marketplaces', 'vercel'), lastUpdated: '2' }
    })
    expect(await isLink(markets)).toBe(true)
  })

  it("changes nothing while Claude Code holds a lock or the account's file can't be read whole", async () => {
    const { root, home, own, write } = await linked()
    const sharedFile = join(root, 'plugins', 'installed_plugins.json')
    const before = await readFile(sharedFile, 'utf8')
    await write({ 'figma@official': entry(home, 'figma', '1.0.0') })
    await mkdir(`${sharedFile}.lock`)
    syncClaudePlugins(home, root)
    expect(await readFile(sharedFile, 'utf8')).toBe(before)
    expect(await isLink(own)).toBe(false)
    await rm(`${sharedFile}.lock`, { recursive: true })
    await writeFile(own, '{"plugins":')
    syncClaudePlugins(home, root)
    expect(await readFile(sharedFile, 'utf8')).toBe(before)
    expect(await isLink(own)).toBe(false)
  })
})

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
  it("names an added account's own item whatever CLAUDE_SECURESTORAGE_CONFIG_DIR the Mac or a workspace exports", () => {
    const dir = '/Users/me/Library/Application Support/Kernel/claude-homes/acct'
    const own = credentialsItem({ CLAUDE_CONFIG_DIR: dir })
    for (const base of [{}, { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/me/.claude' }]) {
      const env = sessionEnv(base, accountEnv(dir))
      expect(credentialsItem(env)).toBe(own)
      expect(credentialsDir(env, '/Users/me')).toBe(dir)
    }
    // The CLI login's item, and the folder Claude Code locks to write it.
    expect(credentialsDir({}, '/Users/me')).toBe('/Users/me/.claude')
    expect(credentialsDir({ CLAUDE_CONFIG_DIR: '/c' }, '/Users/me')).toBe('/c')
    expect(credentialsDir({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, '/Users/me')).toBe('/Users/me/.claude')
    expect(credentialsDir({ CLAUDE_CONFIG_DIR: '/c', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/s' }, '/Users/me')).toBe('/s')
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

  /**
   * Claude Code 2.1.292 renewing a login as it does: it takes `.storage-write.lock` in the login's folder, reads the item
   * fresh, saves the new login only if the refresh token it sent is still the stored one, and keeps every other key. While
   * another process holds the lock it can't save yet and tries again later. Returns whether it saved.
   */
  const renew = (kc: ReturnType<typeof fakeKeychain>, item: string, dir: string, to: string) => {
    const lock = join(dir, '.storage-write.lock')
    try { mkdirSync(lock) } catch { return false }
    try {
      const now = kc.json(item)
      kc.set(item, { ...now, claudeAiOauth: { accessToken: `${to}-access`, refreshToken: `${to}-refresh` } })
      return true
    } finally { rmdirSync(lock) }
  }

  it("never rolls back a login Claude Code renews between Kernel's last read and its write", async () => {
    const { side, logins } = await folders()
    const kc = fakeKeychain({
      [CLI]: { claudeAiOauth: { accessToken: 'max-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR) } },
      [SIDE]: { claudeAiOauth: { accessToken: 'pro-access', refreshToken: 'pro-refresh' }, mcpOAuth: {} }
    })
    // The account's session renews its login right as Kernel writes the item. The server has already swapped the refresh
    // token, so a write that put the old one back would sign the account out at its next refresh.
    const write = kc.keychain.write
    let tried = false
    let saved = false
    kc.keychain.write = (item, secret) => {
      if (item === SIDE && !tried) { tried = true; saved = renew(kc, SIDE, side, 'pro-renewed') }
      return write(item, secret)
    }
    shareMcpSignIns(kc.keychain, logins)
    expect(tried).toBe(true)
    // Kernel holds the lock while it writes, so the CLI saves once Kernel is done. Written without the lock, the CLI's save
    // landed first and Kernel's write then put the old login back.
    if (!saved) saved = renew(kc, SIDE, side, 'pro-renewed')
    expect(saved).toBe(true)
    expect(kc.json(SIDE)).toEqual({ claudeAiOauth: { accessToken: 'pro-renewed-access', refreshToken: 'pro-renewed-refresh' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR) } })
    expect(existsSync(join(side, '.storage-write.lock'))).toBe(false)
  })

  it("leaves a login alone while Claude Code holds its lock, shares the others, and takes over a lock left behind", async () => {
    const { cli, side, logins } = await folders()
    const kc = fakeKeychain({
      [CLI]: { claudeAiOauth: { accessToken: 'max-login' }, mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR) } },
      [SIDE]: { claudeAiOauth: { accessToken: 'pro-login' }, mcpOAuth: { 'posthog|bbb': signIn('posthog', 'side', now + HOUR) } }
    })
    await mkdir(join(side, '.storage-write.lock'))
    expect(shareMcpSignIns(kc.keychain, logins)).toEqual(new Map([[cli, ['posthog']]]))
    expect(kc.writes).toEqual([CLI])
    expect(kc.json(SIDE).mcpOAuth).toEqual({ 'posthog|bbb': signIn('posthog', 'side', now + HOUR) })
    // A lock nobody renewed for a minute was left by a process that quit.
    const old = new Date(Date.now() - 60_000)
    await utimes(join(side, '.storage-write.lock'), old, old)
    expect(shareMcpSignIns(kc.keychain, logins)).toEqual(new Map([[side, ['linear']]]))
    expect(existsSync(join(side, '.storage-write.lock'))).toBe(false)
  })

  it("locks the folder the item belongs to, which CLAUDE_SECURESTORAGE_CONFIG_DIR can move from the login's own", async () => {
    const { cli, side } = await folders()
    const store = join(side, '..', 'store')
    await mkdir(store)
    const kc = fakeKeychain({
      [CLI]: { mcpOAuth: { 'linear|aaa': signIn('linear', 'cli', now + HOUR) } },
      [SIDE]: { mcpOAuth: {} }
    })
    await mkdir(join(store, '.storage-write.lock'))
    const logins = [{ item: CLI, dir: cli }, { item: SIDE, dir: side, store }]
    expect(shareMcpSignIns(kc.keychain, logins).size).toBe(0)
    rmdirSync(join(store, '.storage-write.lock'))
    expect(shareMcpSignIns(kc.keychain, logins)).toEqual(new Map([[side, ['linear']]]))
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
