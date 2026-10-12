import { describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyClaudeConfig, linkClaudeHome, removeClaudeHome } from '../src/main/services/providers/claudeHome'

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
