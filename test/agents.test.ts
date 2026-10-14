import { describe, expect, it, vi } from 'vitest'
import { watch } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentFromFile, createAgent, draftAgent, hireDefaults, loadAgents, parseFrontmatter, renderAgentFile, restoreAgent, retireAgent, saveAgent, updateAgent, watchAgents } from '../src/main/services/agents'
import { canOpenPr } from '../src/main/services/agentTools'

// fs.watch timing varies under load, so wait for the callback instead of sleeping a fixed time.
const WATCH = { timeout: 10_000 }

/**
 * Resolves once the watches started so far deliver events, and returns a stop that closes the probe and deletes its folder. On macOS, libuv runs every
 * directory watch in the process on one FSEvents stream and restarts it when a watch is added or closed, and events in
 * that gap are dropped. A probe watched after the others firing means the restarted stream covers theirs too. The probe
 * stays open until the test ends, since closing it restarts the stream again (KERNEL-187).
 */
async function watchesLive(): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), 'probe-'))
  let seen = false
  const probe = watch(dir, { persistent: false }, () => { seen = true })
  await vi.waitFor(async () => { await writeFile(join(dir, 'p'), String(Date.now())); expect(seen).toBe(true) }, { ...WATCH, interval: 100 })
  return async () => { probe.close(); await rm(dir, { recursive: true, force: true }) }
}

describe('agents', () => {
  it('parses frontmatter including folded lines and lists', () => {
    const { meta, body } = parseFrontmatter('---\nname: wren\ndescription: Designer. Checks every screen\n  against DESIGN.md.\ntools: Read, Grep\n---\nYou are Wren.')
    expect(meta.description).toBe('Designer. Checks every screen against DESIGN.md.')
    expect(meta.tools).toBe('Read, Grep')
    expect(body).toBe('You are Wren.')
  })
  it('derives display name, role and lead', () => {
    const a = agentFromFile('/r/.claude/agents/kai.md', '---\nname: kai\ndescription: Frontend engineer. Builds UI.\nmodel: sonnet\ntools: Read, Edit\n---\nBody')
    expect(a).toMatchObject({ id: 'kai', name: 'Kai', role: 'Frontend', model: 'sonnet', tools: ['Read', 'Edit'], lead: false })
    // Only the file marks the Lead: lead: true, or a role that says Lead. A description that does isn't enough (KERNEL-397).
    const r = agentFromFile('/r/.claude/agents/rowan.md', '---\nname: rowan\ndescription: Lead. Plans and hands out tasks.\n---\n')
    expect(r).toMatchObject({ role: 'Lead', lead: false })
    expect(agentFromFile('/r/a.md', '---\nname: a\ndescription: x\nrole: Tech Lead\n---\n').lead).toBe(true)
    expect(agentFromFile('/r/b.md', '---\nname: b\ndescription: x\nrole: Lead\nlead: false\n---\n').lead).toBe(false)
    expect(agentFromFile('/r/c.md', '---\nname: c\ndescription: x\nlead: True\n---\n').lead).toBe(true)
  })
  it('reads block values, comments, a BOM and Windows line endings as Claude Code does', () => {
    const folded = parseFrontmatter('---\nname: code-reviewer\ndescription: >-\n  Reviews pull requests.\n  Use proactively\n  after a change.\n\n  Read-only.\ntools:\n  - Read\n  - Grep\n---\nBody')
    expect(folded.meta).toMatchObject({ name: 'code-reviewer', description: 'Reviews pull requests. Use proactively after a change.\nRead-only.', tools: ['Read', 'Grep'] })
    expect(agentFromFile('/r/x.md', '---\nname: x\ndescription: |\n  Line one\n    indented\n  line two\nmodel: opus\n---\n')).toMatchObject({ description: 'Line one\n  indented\nline two', model: 'opus' })
    expect(agentFromFile('/r/x.md', '---\nname: x\ndescription: >+ # kept\n  One.\n---\n').description).toBe('One.')
    expect(parseFrontmatter('---\nname: x\nmodel: sonnet # cheap\ndescription: "Fixes #12"\nrole: QA #tests\n---\n').meta).toMatchObject({ model: 'sonnet', description: 'Fixes #12', role: 'QA' })
    expect(parseFrontmatter('\uFEFF---\r\nname: win\r\ndescription: >\r\n  From Windows.\r\ntools: [Read, Edit]\r\n---\r\nBody\r\n')).toMatchObject({ meta: { name: 'win', description: 'From Windows.\n', tools: ['Read', 'Edit'] }, body: 'Body' })
    const a = agentFromFile('/r/code-reviewer.md', '---\nname: code-reviewer\ndescription: >-\n  Reviews pull requests.\n---\nBody')
    // A description that opens with a sentence names no role, so the file's name does.
    expect(a).toMatchObject({ description: 'Reviews pull requests.', role: 'Code Reviewer' })
    expect(agentFromFile('/r/b.md', '---\nname: api\ndescription: Backend engineer. Builds the API.\n---\n').role).toBe('Backend')
    expect(agentFromFile('/r/c.md', '---\nname: architect\ndescription: Designs the system.\n---\n').role).toBe('Architect')
    expect(agentFromFile('/r/w.md', '---\nname: w\ndescription: x\ntools: [Read, Edit, Bash]\n---\n').tools).toEqual(['Read', 'Edit', 'Bash'])
  })
  // KERNEL-451: the YAML reader, the retry and the fields as Claude Code 2.1.292 reads them.
  it('reads a description Claude Code reads only on its second try, quoted', () => {
    const a = agentFromFile('/r/helper.md', '---\nname: helper\ndescription: Use this agent when: the user asks for help. Examples: <example>hi</example>\ntools: Read\n---\nBody')
    expect(a).toMatchObject({ id: 'helper', description: 'Use this agent when: the user asks for help. Examples: <example>hi</example>', tools: ['Read'] })
    expect(a.warnings).toBeUndefined()
    // A written \n is a new line, as Claude Code reads it, and a tab-indented list reads as one indented with spaces.
    expect(agentFromFile('/r/x.md', '---\nname: x\ndescription: One.\\nTwo.\ntools:\n\t- Read\n\t- Grep\n---\n')).toMatchObject({ description: 'One.\nTwo.', tools: ['Read', 'Grep'] })
    // A key written twice keeps its last value.
    expect(agentFromFile('/r/x.md', '---\nname: x\ndescription: x\nmodel: haiku\nmodel: opus\n---\n').model).toBe('opus')
  })

  it('splits tools as Claude Code does: at commas and spaces outside parentheses, every tool for *, none for an empty line', () => {
    const tools = (line: string) => agentFromFile('/r/x.md', `---\nname: x\ndescription: x\n${line}\n---\n`).tools
    expect(tools('tools: Read Grep, Bash(git status:*)')).toEqual(['Read', 'Grep', 'Bash(git status:*)'])
    expect(tools('tools: ["Read", "mcp__linear"]')).toEqual(['Read', 'mcp__linear'])
    expect(tools('tools: "*"')).toBeUndefined()
    expect(tools('tools: [Read, "*"]')).toBeUndefined()
    expect(tools('tools:')).toEqual([])
    expect(tools('tools: []')).toEqual([])
    expect(tools('tools: ""')).toEqual([])
    expect(tools('color: blue')).toBeUndefined()
  })

  it('reads disallowedTools, mcpServers, permissionMode and an inherited model', () => {
    const a = agentFromFile('/r/x.md', [
      '---', 'name: x', 'description: x', 'model: inherit', 'disallowedTools: WebFetch, mcp__github', 'permissionMode: plan',
      'mcpServers:', '  - linear', '  - sentry:', '      type: http', '      url: https://mcp.sentry.dev/mcp', '  - { a: 1, b: 2 }', '---', 'Body'
    ].join('\n'))
    expect(a).toMatchObject({ disallowedTools: ['WebFetch', 'mcp__github'], mcpServers: ['linear', 'sentry'], permissionMode: 'plan' })
    // `inherit` follows Settings, Models, as no model line does.
    expect(a.model).toBeUndefined()
    const mode = (v: string) => agentFromFile('/r/x.md', `---\nname: x\ndescription: x\npermissionMode: ${v}\n---\n`).permissionMode
    expect(['manual', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'yolo'].map(mode)).toEqual(['default', 'acceptEdits', 'dontAsk', 'bypassPermissions', undefined])
    expect(agentFromFile('/r/x.md', '---\nname: x\ndescription: x\ndisallowedTools:\n---\n')).not.toHaveProperty('disallowedTools')
  })

  it("keeps a file Claude Code can't read, with what went wrong, no tools and no Lead", () => {
    const broken = agentFromFile('/r/.claude/agents/kai.md', '---\nname: kai\ndescription: "Frontend engineer\nlead: true\n---\nYou are Kai.')
    expect(broken).toMatchObject({ id: 'kai', name: 'Kai', role: 'Agent', description: '', lead: false, tools: [], prompt: '', file: '/r/.claude/agents/kai.md' })
    expect(broken.warnings).toHaveLength(1)
    // Team shows it as "Kernel couldn't read its file: line 5 isn't valid YAML. Missing closing "quote."
    expect(broken.warnings![0]).toEqual({ kind: 'unreadable-file', detail: 'line 5 isn\'t valid YAML. Missing closing "quote' })
    const why = (head: string) => agentFromFile('/r/x.md', `---\n${head}\n---\n`).warnings?.[0]?.detail
    expect(why('name: x\n  bad: indent')).toBe("line 2 isn't valid YAML. Nested mappings are not allowed in compact mappings")
    expect(why('name: -x\ndescription: x')).toBe('its name starts with a dash')
    expect(why('name: acme:x\ndescription: x')).toBe('its name has a colon, which Claude Code keeps for plugin agents')
    expect(why('name: 7\ndescription: x')).toBe("its name isn't text. Put it in quotes")
    expect(why('- Read\n- Grep')).toBe('its frontmatter has no key: value lines')
    // A file with no frontmatter, or one that names no agent, is still read as Kernel always read it.
    expect(agentFromFile('/r/plain.md', 'Just instructions.')).toMatchObject({ id: 'plain', prompt: 'Just instructions.' })
    expect(agentFromFile('/r/plain.md', '---\n# nothing yet\n---\nBody').warnings).toBeUndefined()
  })

  it("loads a broken file with its error instead of dropping it, and won't edit it until it's fixed", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    const dir = join(repo, '.claude', 'agents')
    await mkdir(join(dir, 'notes.md'), { recursive: true })
    await saveAgent(repo, { id: 'kai', description: 'Frontend engineer.', prompt: 'You are Kai.' })
    const text = '---\nname: ivy\ndescription: "QA\n---\nYou are Ivy.\n'
    await writeFile(join(dir, 'ivy.md'), text)
    const list = await loadAgents(repo)
    expect(list.map((a) => [a.id, a.warnings?.map((w) => w.kind) ?? []])).toEqual([['ivy', ['unreadable-file']], ['kai', []], ['notes', ['unreadable-file']]])
    expect(list.find((a) => a.id === 'notes')!.warnings![0].detail).toBe("it's a folder, not a file")
    expect(list.find((a) => a.id === 'ivy')!.joinedAt).toBeGreaterThan(0)
    await expect(updateAgent(repo, 'ivy', { model: 'opus' })).rejects.toThrow('Kernel can\'t read ivy.md: line 4 isn\'t valid YAML. Missing closing "quote. Fix the file, then save again.')
    expect(await readFile(join(dir, 'ivy.md'), 'utf8')).toBe(text)
    // New agent won't write a file Claude Code can't read.
    await expect(createAgent(repo, { ...draftAgent({ description: 'QA', name: 'Rex' }), text })).rejects.toThrow('Claude Code can\'t read this file: line 4 isn\'t valid YAML. Missing closing "quote.')
  })

  it('round-trips, loads lead first, and retires out of the loaded folder', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await saveAgent(repo, { id: 'kai', description: 'Frontend engineer.', prompt: 'You are Kai.' })
    await saveAgent(repo, { id: 'rowan', description: 'Lead.', prompt: 'You are Rowan.', lead: true, role: 'Lead' })
    const list = await loadAgents(repo)
    expect(list.map((a) => a.id)).toEqual(['rowan', 'kai'])
    await retireAgent(repo, 'kai')
    expect((await loadAgents(repo)).map((a) => a.id)).toEqual(['rowan'])
    expect(await readdir(join(repo, '.claude', 'retired-agents'))).toEqual(['kai.md'])
  })
  it('renders a file Claude Code can read', () => {
    expect(renderAgentFile({ id: 'ivy', description: 'QA.', prompt: 'Test things.', tools: ['Read', 'Bash'] })).toContain('tools: Read, Bash')
  })
  it('returns no agents for a repo without the folder', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'none-'))
    await mkdir(join(repo, '.claude'))
    await writeFile(join(repo, '.claude', 'settings.json'), '{}')
    expect(await loadAgents(repo)).toEqual([])
  })

  it('round-trips effort and keeps frontmatter Kernel does not manage when saving an edit', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
    await writeFile(join(repo, '.claude', 'agents', 'kai.md'), '---\nname: kai\ndescription: Frontend engineer.\nmodel: sonnet\ncolor: green\ntools: Read, Edit\n---\nYou are Kai.\n')
    const saved = await updateAgent(repo, 'kai', { description: 'UI work.\nFollows DESIGN.md.', effort: 'xhigh', tools: ['Read', 'Bash'], skills: ['/verify'], prompt: 'New instructions.' })
    expect(saved).toMatchObject({ id: 'kai', description: 'UI work. Follows DESIGN.md.', effort: 'xhigh', tools: ['Read', 'Bash'], skills: ['/verify'], model: 'sonnet', prompt: 'New instructions.' })
    const file = await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')
    expect(file).toContain('color: green')
    expect(file).toContain('effort: xhigh')
    await expect(updateAgent(repo, 'kai', { description: '  ' })).rejects.toThrow(/description/)
    await expect(updateAgent(repo, 'nobody', {})).rejects.toThrow(/not in/)
  })
  it('drafts a file from a description and creates it once', async () => {
    const d = draftAgent({ description: 'a designer who checks every screen against DESIGN.md', name: 'Wren', model: 'opus' })
    expect(d).toMatchObject({ id: 'wren', name: 'Wren', model: 'opus', file: '.claude/agents/wren.md' })
    expect(d.text).toContain('name: wren')
    expect(d.text).toContain('role: Designer')
    expect(draftAgent({ description: 'Reviews security in every diff' }).id).toBe('reviewer')
    expect(() => draftAgent({ description: '   ' })).toThrow(/Describe/)
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    const made = await createAgent(repo, d)
    expect(made).toMatchObject({ id: 'wren', role: 'Designer', model: 'opus' })
    expect((await loadAgents(repo)).map((a) => a.id)).toEqual(['wren'])
    await expect(createAgent(repo, d)).rejects.toThrow(/already on the team/)
    await expect(createAgent(repo, { ...d, text: '---\nname: Bad Name\ndescription: x\n---\nbody' })).rejects.toThrow(/lowercase/)
    await expect(createAgent(repo, { ...d, text: '---\nname: ok\n---\nbody' })).rejects.toThrow(/description/)
  })
  // KERNEL-476: a drafted Designer used to get Read, Grep, Glob and Bash, and a Docs writer had no Bash, so both joined as helpers.
  it('gives every drafted role but a reviewer the tools to open a pull request', async () => {
    const pr = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']
    const drafts = ['a designer who checks every screen against DESIGN.md', 'writes the docs for each release', 'owns the SQL schema and migrations', 'QA: tests each flow end to end', 'Reviews security in every diff']
      .map((description) => draftAgent({ description }))
    expect(drafts.map((d) => [d.id, d.tools])).toEqual([['designer', pr], ['docs', pr], ['data', pr], ['qa-tests', pr], ['reviewer', ['Read', 'Grep', 'Glob']]])
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    for (const d of drafts) await createAgent(repo, d)
    expect((await loadAgents(repo)).map((a) => [a.id, canOpenPr(a.tools)])).toEqual([['data', true], ['designer', true], ['docs', true], ['qa-tests', true], ['reviewer', false]])
    expect(hireDefaults('Frontend')).toEqual({ tools: pr })
    expect(hireDefaults('Security reviewer')).toEqual({ role: 'Reviewer', tools: ['Read', 'Grep', 'Glob'] })
  })
  it('lists retired agents and restores one, refusing when the name is taken', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await saveAgent(repo, { id: 'kai', description: 'Frontend engineer.', prompt: 'You are Kai.' })
    await retireAgent(repo, 'kai')
    expect((await loadAgents(repo, { retired: true })).map((a) => [a.id, a.retired])).toEqual([['kai', true]])
    await saveAgent(repo, { id: 'kai', description: 'A newer Kai.', prompt: 'x' })
    await expect(restoreAgent(repo, 'kai')).rejects.toThrow(/already an agent/)
    await retireAgent(repo, 'kai')
    await restoreAgent(repo, 'kai')
    expect((await loadAgents(repo)).map((a) => a.id)).toEqual(['kai'])
    await expect(retireAgent(repo, 'ghost')).rejects.toThrow(/not in/)
  })
  it('tells the watcher about files added outside Kernel, even before the folder exists', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await mkdir(join(repo, '.claude'))
    let hits = 0
    const stops: (() => void | Promise<void>)[] = [watchAgents(repo, () => { hits++ }, 20)]
    try {
      stops.push(await watchesLive())
      await mkdir(join(repo, '.claude', 'agents'))
      await vi.waitFor(() => expect(hits).toBeGreaterThan(0), WATCH)
      // The folder's own watch started just now, in the restart that may drop the next change.
      stops.push(await watchesLive())
      const afterDir = hits
      await writeFile(join(repo, '.claude', 'agents', 'theo.md'), '---\nname: theo\ndescription: Reviewer.\n---\nx')
      await vi.waitFor(() => expect(hits).toBeGreaterThan(afterDir), WATCH)
    } finally { for (const stop of stops) await stop() }
  })
  it('saves only the fields an edit changed, so block values and lists keep their form', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
    const head = 'name: kai\ndescription: >-\n  Frontend engineer.\n  Builds UI.\ntools:\n  - Read\n  - Edit\nmodel: sonnet'
    await writeFile(join(repo, '.claude', 'agents', 'kai.md'), `---\n${head}\n---\nYou are Kai.\n`)
    await updateAgent(repo, 'kai', { effort: 'high', description: 'Frontend engineer. Builds UI.', tools: ['Read', 'Edit'] })
    expect(await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')).toBe(`---\n${head}\neffort: high\n---\n\nYou are Kai.\n`)
  })
  it('saves, retires and restores an agent whose name differs from its file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
    await writeFile(join(repo, '.claude', 'agents', 'code-reviewer.md'), '---\nname: reviewer\ndescription: Reviews code.\n---\nBody\n')
    expect((await updateAgent(repo, 'reviewer', { model: 'opus' })).file).toBe(join(repo, '.claude', 'agents', 'code-reviewer.md'))
    expect(await readdir(join(repo, '.claude', 'agents'))).toEqual(['code-reviewer.md'])
    await retireAgent(repo, 'reviewer')
    expect(await readdir(join(repo, '.claude', 'retired-agents'))).toEqual(['code-reviewer.md'])
    await restoreAgent(repo, 'reviewer')
    expect((await loadAgents(repo)).map((a) => [a.id, a.model])).toEqual([['reviewer', 'opus']])
  })
  it("never replaces an agent the room has, or takes the name of Kernel's own", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await saveAgent(repo, { id: 'kai', description: 'Frontend engineer.', prompt: 'You are Kai.' })
    await expect(saveAgent(repo, { id: 'kai', description: 'Another Kai.', prompt: 'x' })).rejects.toThrow(/already on the team/)
    expect(await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')).toContain('You are Kai.')
    await expect(saveAgent(repo, { id: 'kernel-lead', description: 'Lead.', prompt: 'x' })).rejects.toThrow(/Kernel's own Lead/)
    await expect(createAgent(repo, draftAgent({ description: 'reviews', name: 'Kernel Reviewer' }))).rejects.toThrow(/Kernel's own reviewer/)
    await writeFile(join(repo, '.claude', 'agents', 'other.md'), '---\nname: ivy\ndescription: QA.\n---\nx\n')
    await expect(saveAgent(repo, { id: 'ivy', description: 'QA.', prompt: 'x' })).rejects.toThrow(/already on the team/)
  })
  it('saves an edit without touching nested frontmatter or quoted values', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'agents-'))
    await mkdir(join(repo, '.claude', 'agents'), { recursive: true })
    const hooks = 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh'
    await writeFile(join(repo, '.claude', 'agents', 'kai.md'), `---\nname: kai\ndescription: "Frontend: builds UI"\n# keep this comment\n${hooks}\nmodel: sonnet\n---\nYou are Kai.\n`)
    const saved = await updateAgent(repo, 'kai', { effort: 'high' })
    expect(saved).toMatchObject({ description: 'Frontend: builds UI', effort: 'high', model: 'sonnet' })
    const file = await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')
    expect(file).toContain(hooks)
    expect(file).toContain('# keep this comment')
    expect(file).toContain('description: "Frontend: builds UI"')
    // A new colon in a description is quoted so the file stays valid YAML, and the draft does the same.
    await updateAgent(repo, 'kai', { description: 'Designer: checks # every screen' })
    expect(await readFile(join(repo, '.claude', 'agents', 'kai.md'), 'utf8')).toContain('description: "Designer: checks # every screen"')
    expect(draftAgent({ description: 'a reviewer: checks diffs', name: 'Rex' }).text).toContain('description: "A reviewer: checks diffs."')
    expect(agentFromFile('/r/rex.md', draftAgent({ description: 'a reviewer: checks diffs', name: 'Rex' }).text).description).toBe('A reviewer: checks diffs.')
  })
})
