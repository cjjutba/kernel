import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo } from './helpers'
import { bus } from '../src/main/bus'
import { Kernel } from '../src/main/kernel'
import type { Cipher } from '../src/main/services/env'
import { saveJiraAccount, storedJiraAccount } from '../src/main/services/jiraAccount'
import {
  adfToMarkdown, jiraJql, jiraKey, jiraMyself, jiraSite, jiraTracker, jiraTransitions, latestToDo, listJiraIssues, NO_JIRA, type JiraCredentials
} from '../src/main/services/trackers/jira'
import type { ActivityEvent } from '../src/shared/types'

interface Call { method: string; path: string; body?: any; auth?: string }

/** A Jira that answers each call with `answer`, and keeps the calls. A value that isn't a Response goes back as JSON. */
function jira(answer: (c: Call) => unknown = () => ({})) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url)
    const call: Call = { method: init.method ?? 'GET', path: `${u.pathname}${decodeURIComponent(u.search)}`, ...(init.body ? { body: JSON.parse(init.body) } : {}), auth: init.headers.authorization }
    calls.push(call)
    const out = answer(call)
    return out instanceof Response ? out : new Response(JSON.stringify(out))
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

const CREDS: JiraCredentials = { site: 'acme.atlassian.net', email: 'sam@acme.com', token: 'jira_tok' }
const creds = async () => CREDS

const text = (t: string, marks?: unknown[]) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const para = (...content: unknown[]) => ({ type: 'paragraph', content })
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content })
const item = (...content: unknown[]) => ({ type: 'listItem', content })

const status = (name: string, key: string) => ({ name, statusCategory: { key } })

const raw = (key: string, o: { summary?: string; status?: ReturnType<typeof status> } = {}) => ({
  id: '10001', key,
  fields: {
    summary: o.summary ?? 'Crash on save', status: o.status ?? status('To Do', 'new'),
    assignee: { displayName: 'Sam Lee', accountId: 'acc-sam' }, issuetype: { name: 'Bug' }, priority: { name: 'High' },
    labels: ['ui'], updated: '2026-10-11T09:00:00.000+0000'
  }
})

const crash = {
  id: 'PROJ-7', title: 'Crash on save', url: 'https://acme.atlassian.net/browse/PROJ-7', status: { name: 'To Do', category: 'new' },
  assignee: { name: 'Sam Lee', accountId: 'acc-sam' }, type: 'Bug', priority: 'High', labels: ['ui'], updatedAt: '2026-10-11T09:00:00.000+0000'
}

const SEARCH_FIELDS = ['summary', 'status', 'assignee', 'issuetype', 'priority', 'labels', 'updated']

describe('Jira sites, keys and JQL (KERNEL-474)', () => {
  it('reads a site from a name, a host or a page on it', () => {
    expect(jiraSite('acme')).toBe('acme.atlassian.net')
    expect(jiraSite('  acme.atlassian.net/ ')).toBe('acme.atlassian.net')
    expect(jiraSite('https://Acme.atlassian.net/jira/software/projects/PROJ/boards/1?x=1')).toBe('acme.atlassian.net')
    expect(jiraSite('')).toBeUndefined()
    expect(jiraSite('not a site')).toBeUndefined()
  })

  it('takes a key in any case, and a number in a room that names its project', () => {
    expect(jiraKey(' proj-7 ')).toBe('PROJ-7')
    expect(jiraKey('7', 'proj')).toBe('PROJ-7')
    expect(jiraKey('7')).toBeUndefined()
    expect(jiraKey('7', 'My project')).toBeUndefined()
    expect(jiraKey('#7', 'PROJ')).toBeUndefined()
    expect(jiraKey('Crash on save', 'PROJ')).toBeUndefined()
  })

  it('lists open issues, narrowed by the project, the assignee and the summary, with the query quoted', () => {
    expect(jiraJql({})).toBe('statusCategory != Done ORDER BY updated DESC')
    expect(jiraJql({ project: 'PROJ', mine: true, query: 'crash "on" save?' }))
      .toBe('statusCategory != Done AND project = "PROJ" AND assignee = currentUser() AND summary ~ "crash on save*" ORDER BY updated DESC')
    expect(jiraJql({ project: 'A"B\\C', todo: true })).toBe('statusCategory = "To Do" AND project = "A\\"B\\\\C" ORDER BY updated DESC')
    expect(jiraJql({ query: ' ?* ' })).toBe('statusCategory != Done ORDER BY updated DESC')
  })
})

describe('Atlassian Document Format as Markdown (KERNEL-474)', () => {
  it('converts the nodes Jira descriptions and comments use', () => {
    const md = adfToMarkdown(doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Steps')] },
      para(
        text('Open '), text('Settings', [{ type: 'strong' }]), text(', then '), text('save ', [{ type: 'em' }]), text('again', [{ type: 'strike' }]),
        text(' with '), text('cmd+s', [{ type: 'code' }]), text('. See '),
        text('the docs', [{ type: 'link', attrs: { href: 'https://acme.dev/docs' } }, { type: 'underline' }]),
        { type: 'hardBreak' },
        { type: 'mention', attrs: { id: 'acc-sam', text: '@Sam Lee' } }, text(' saw it on '), { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 9, 12)) } },
        text(' '), { type: 'status', attrs: { text: 'BLOCKED', color: 'red' } }, text(' '), { type: 'emoji', attrs: { shortName: ':fire:' } }
      ),
      { type: 'bulletList', content: [item(para(text('One')), { type: 'bulletList', content: [item(para(text('Nested')))] }), item(para(text('Two')))] },
      { type: 'orderedList', attrs: { order: 3 }, content: [item(para(text('Three'))), item(para(text('Four')))] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('save()\nexit()')] },
      { type: 'blockquote', content: [para(text('Quoted')), para(text('Twice'))] },
      { type: 'panel', attrs: { panelType: 'warning' }, content: [para(text('Careful'))] },
      { type: 'rule' },
      { type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [para(text('Field'))] }, { type: 'tableHeader', content: [para(text('Value'))] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [para(text('a|b'))] }, { type: 'tableCell', content: [para(text('one')), para(text('two'))] }] }
      ] },
      { type: 'taskList', content: [
        { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('Reproduce')] },
        { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('Fix')] }
      ] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'file', id: 'f1', alt: 'screenshot.png' } }] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { type: 'external', url: 'https://acme.dev/a.png' } }] },
      { type: 'expand', attrs: { title: 'Logs' }, content: [para(text('Trace'))] },
      para({ type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/PROJ-2' } }),
      { type: 'bodiedExtension', attrs: { extensionKey: 'macro' }, content: [para(text('From a macro'))] },
      para()
    ))
    expect(md).toBe([
      '## Steps',
      'Open **Settings**, then *save* ~~again~~ with `cmd+s`. See [the docs](https://acme.dev/docs)\n@Sam Lee saw it on 2026-10-12 [BLOCKED] :fire:',
      '- One\n  - Nested\n- Two',
      '3. Three\n4. Four',
      '```ts\nsave()\nexit()\n```',
      '> Quoted\n>\n> Twice',
      '> Careful',
      '---',
      '| Field | Value |\n| --- | --- |\n| a\\|b | one two |',
      '- [x] Reproduce\n- [ ] Fix',
      '[attachment: screenshot.png]',
      '![](https://acme.dev/a.png)',
      '**Logs**\n\nTrace',
      '<https://acme.atlassian.net/browse/PROJ-2>',
      'From a macro'
    ].join('\n\n'))
  })

  it('reads no description as empty, keeps plain text, and fences code that holds backticks', () => {
    expect(adfToMarkdown(null)).toBe('')
    expect(adfToMarkdown(undefined)).toBe('')
    expect(adfToMarkdown(doc())).toBe('')
    expect(adfToMarkdown(' Plain text from an old issue ')).toBe('Plain text from an old issue')
    expect(adfToMarkdown(doc(para(text('Run '), text('a`b', [{ type: 'code' }]))))).toBe('Run `` a`b ``')
    expect(adfToMarkdown(doc({ type: 'codeBlock', content: [text('```\nnested\n```')] }))).toBe('~~~\n```\nnested\n```\n~~~')
  })
})

describe('Jira as a tracker (KERNEL-474)', () => {
  it('searches open issues with JQL, signs every call with the email and token, and links each issue', async () => {
    const j = jira(() => ({ issues: [raw('PROJ-7')], isLast: true }))
    const t = jiraTracker({ creds, project: 'PROJ', fetch: j.fetch })
    expect(t.kind).toBe('jira')
    expect(await t.search('crash')).toEqual([{ id: 'PROJ-7', title: 'Crash on save', url: 'https://acme.atlassian.net/browse/PROJ-7', source: 'jira' }])
    expect(j.calls).toEqual([{
      method: 'POST', path: '/rest/api/3/search/jql', auth: `Basic ${Buffer.from('sam@acme.com:jira_tok').toString('base64')}`,
      body: { jql: 'statusCategory != Done AND project = "PROJ" AND summary ~ "crash*" ORDER BY updated DESC', maxResults: 50, fields: SEARCH_FIELDS }
    }])
  })

  it('lists the issues for the Issues screen, with the assignee filter', async () => {
    const j = jira(() => ({ issues: [raw('PROJ-7'), { key: 'PROJ-8', fields: { summary: 'Bare', status: status('In Review', 'indeterminate'), assignee: null } }] }))
    expect(await listJiraIssues(CREDS, { mine: true, project: 'PROJ' }, 100, j.fetch)).toEqual([
      crash,
      { id: 'PROJ-8', title: 'Bare', url: 'https://acme.atlassian.net/browse/PROJ-8', status: { name: 'In Review', category: 'indeterminate' }, labels: [], updatedAt: '' }
    ])
    expect(j.calls[0].body).toEqual({ jql: 'statusCategory != Done AND project = "PROJ" AND assignee = currentUser() ORDER BY updated DESC', maxResults: 100, fields: SEARCH_FIELDS })
  })

  it('puts the issue a key names first when it is open, and skips a key Jira has no issue for', async () => {
    const open = jira((c) => c.method === 'GET' ? raw('PROJ-7') : { issues: [raw('PROJ-9', { summary: 'Proj 7 again' }), raw('PROJ-7')] })
    expect((await jiraTracker({ creds, project: 'PROJ', fetch: open.fetch }).search('7')).map((i) => i.id)).toEqual(['PROJ-7', 'PROJ-9'])
    expect(open.calls.find((c) => c.method === 'GET')?.path).toBe(`/rest/api/3/issue/PROJ-7?fields=${SEARCH_FIELDS.join(',')}`)
    const done = jira((c) => c.method === 'GET' ? raw('PROJ-7', { status: status('Done', 'done') }) : { issues: [] })
    expect(await jiraTracker({ creds, fetch: done.fetch }).search('proj-7')).toEqual([])
    const missing = jira((c) => c.method === 'GET' ? new Response(JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }), { status: 404 }) : { issues: [raw('PROJ-9')] })
    expect((await jiraTracker({ creds, fetch: missing.fetch }).search('PROJ-7')).map((i) => i.id)).toEqual(['PROJ-9'])
  })

  it('reads an issue with its description and comments as Markdown, oldest first, and the open issues that block it', async () => {
    const j = jira(() => ({
      key: 'PROJ-7',
      fields: {
        summary: 'Crash on save', labels: ['ui', 'Bug'], status: status('To Do', 'new'),
        description: doc(para(text('Saving '), text('crashes', [{ type: 'strong' }]))),
        comment: { comments: [
          { author: { displayName: 'Rowan' }, body: doc(para(text('Second'))), created: '2026-10-11T10:00:00.000+0000' },
          { author: null, body: doc(para(text('First'))), created: '2026-10-10T10:00:00.000+0000' }
        ] },
        issuelinks: [
          { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PROJ-2', fields: { status: status('In Progress', 'indeterminate') } } },
          { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PROJ-3', fields: { status: status('Done', 'done') } } },
          { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'PROJ-9' } },
          { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'PROJ-4', fields: { status: status('To Do', 'new') } } }
        ]
      }
    }))
    expect(await jiraTracker({ creds, project: 'PROJ', fetch: j.fetch }).issue('7')).toEqual({
      id: 'PROJ-7', title: 'Crash on save', url: 'https://acme.atlassian.net/browse/PROJ-7', description: 'Saving **crashes**', labels: ['ui', 'Bug'],
      comments: [{ body: 'First', createdAt: '2026-10-10T10:00:00.000+0000' }, { author: 'Rowan', body: 'Second', createdAt: '2026-10-11T10:00:00.000+0000' }],
      blockedBy: ['PROJ-2']
    })
    expect(j.calls.map((c) => c.path)).toEqual(['/rest/api/3/issue/PROJ-7?fields=summary,description,labels,status,comment,issuelinks'])
  })

  it('refuses a key that isn\'t Jira\'s without asking, and needs an account to read', async () => {
    const j = jira()
    await expect(jiraTracker({ creds, fetch: j.fetch }).issue('#41')).rejects.toThrow('#41 is not a Jira issue. Jira issues go by key, like PROJ-7.')
    expect(j.calls).toEqual([])
    const none = jiraTracker({ creds: async () => undefined, transition: '21', fetch: j.fetch })
    await expect(none.search()).rejects.toThrow(NO_JIRA)
    await expect(none.issue('PROJ-7')).rejects.toThrow(NO_JIRA)
    expect(await none.start('PROJ-7')).toBeUndefined()
    expect(j.calls).toEqual([])
  })
})

describe('moving a Jira issue to In Progress (KERNEL-474)', () => {
  const offered = [
    { id: '11', name: 'Back to backlog', to: status('Backlog', 'new') },
    { id: '21', name: 'Start progress', to: status('In Progress', 'indeterminate') }
  ]
  /** PROJ-7 in `now`, offering `transitions`. The move answers 204. */
  const issueIn = (now: ReturnType<typeof status>, transitions = offered) => jira((c) => c.method === 'POST' ? new Response(null, { status: 204 }) : { key: 'PROJ-7', fields: { status: now }, transitions })

  it('runs the room\'s transition on an issue still in To Do', async () => {
    const j = issueIn(status('To Do', 'new'))
    expect(await jiraTracker({ creds, transition: '21', fetch: j.fetch }).start('PROJ-7')).toBe('In Progress')
    expect(j.calls.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'GET', path: '/rest/api/3/issue/PROJ-7?fields=status&expand=transitions', body: undefined },
      { method: 'POST', path: '/rest/api/3/issue/PROJ-7/transitions', body: { transition: { id: '21' } } }
    ])
  })

  it('leaves an issue in progress or done where it is', async () => {
    for (const now of [status('In Review', 'indeterminate'), status('Done', 'done')]) {
      const j = issueIn(now)
      expect(await jiraTracker({ creds, transition: '21', fetch: j.fetch }).start('PROJ-7')).toBeUndefined()
      expect(j.calls.map((c) => c.method)).toEqual(['GET'])
    }
  })

  it('moves nothing without a transition, and says so when the issue\'s status doesn\'t offer the room\'s', async () => {
    const j = issueIn(status('Backlog', 'new'), [offered[0]])
    expect(await jiraTracker({ creds, fetch: j.fetch }).start('PROJ-7')).toBeUndefined()
    expect(j.calls).toEqual([])
    await expect(jiraTracker({ creds, transition: '21', fetch: j.fetch }).start('PROJ-7'))
      .rejects.toThrow("Jira doesn't offer the room's transition from Backlog. Pick another in the room's settings.")
    expect(j.calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('lists the transitions an issue offers, and finds the room\'s latest To Do issue to list them from', async () => {
    const j = jira((c) => c.path.endsWith('/transitions') ? { transitions: offered } : { issues: [raw('PROJ-3')] })
    expect(await latestToDo(CREDS, 'PROJ', j.fetch)).toBe('PROJ-3')
    expect(j.calls[0].body).toEqual({ jql: 'statusCategory = "To Do" AND project = "PROJ" ORDER BY updated DESC', maxResults: 1, fields: ['summary'] })
    expect(await jiraTransitions(CREDS, 'PROJ-3', j.fetch)).toEqual([
      { id: '11', name: 'Back to backlog', to: { name: 'Backlog', category: 'new' } },
      { id: '21', name: 'Start progress', to: { name: 'In Progress', category: 'indeterminate' } }
    ])
    expect(j.calls[1]).toMatchObject({ method: 'GET', path: '/rest/api/3/issue/PROJ-3/transitions' })
  })
})

describe('when Jira refuses (KERNEL-474)', () => {
  const answering = (r: () => Response) => jiraTracker({ creds, fetch: jira(r).fetch })

  it('says when the email or token is wrong', async () => {
    const t = answering(() => new Response('', { status: 401 }))
    const said = 'Jira rejected the email or API token. Reconnect Jira in Settings > Integrations.'
    await expect(t.search()).rejects.toThrow(said)
    await expect(t.issue('PROJ-7')).rejects.toThrow(said)
    await expect(jiraMyself(CREDS, jira(() => new Response('', { status: 401 })).fetch)).rejects.toThrow(said)
  })

  it('says how long to wait when Jira limits requests', async () => {
    await expect(answering(() => new Response('', { status: 429, headers: { 'retry-after': '30' } })).search())
      .rejects.toThrow('Jira is limiting requests. Try again in 30 seconds.')
    await expect(answering(() => new Response('', { status: 429 })).issue('PROJ-7'))
      .rejects.toThrow('Jira is limiting requests. Try again in a minute.')
  })

  it('passes on what Jira said, and says when it can\'t reach Jira or the site isn\'t Jira', async () => {
    await expect(answering(() => new Response(JSON.stringify({ errorMessages: ["The value 'NOPE' does not exist for the field 'project'."], errors: {} }), { status: 400 })).search())
      .rejects.toThrow("The value 'NOPE' does not exist for the field 'project'.")
    await expect(answering(() => new Response(JSON.stringify({ errorMessages: [], errors: { jql: 'Bad JQL' } }), { status: 400 })).search()).rejects.toThrow('Bad JQL')
    await expect(answering(() => new Response('oops', { status: 500 })).search()).rejects.toThrow('Jira answered 500.')
    await expect(answering(() => new Response('<html>', { status: 200 })).search()).rejects.toThrow("acme.atlassian.net didn't answer like Jira Cloud.")
    const offline = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(jiraTracker({ creds, fetch: offline }).search()).rejects.toThrow('Could not reach Jira at acme.atlassian.net. Check your connection.')
    await expect(jiraMyself(CREDS, jira(() => new Response('<html>Not found</html>', { status: 404 })).fetch)).rejects.toThrow('There is no Jira Cloud site at acme.atlassian.net.')
  })
})

/** Stands in for safeStorage, which doesn't work under ELECTRON_RUN_AS_NODE. Its output never holds the text it was given. */
const cipher: Cipher = { encrypt: (t) => `enc:${Buffer.from([...t].reverse().join('')).toString('base64')}`, decrypt: (d) => [...Buffer.from(d.slice(4), 'base64').toString()].reverse().join('') }
/** A Keychain that is there but refuses, as safeStorage does when the user denies access. */
const refusing: Cipher = { encrypt: () => { throw new Error('denied') }, decrypt: () => { throw new Error('denied') } }

describe('the saved Jira account (KERNEL-474)', () => {
  const onDisk = async (dir: string) => ({ text: await readFile(join(dir, 'jira.json'), 'utf8'), mode: (await stat(join(dir, 'jira.json'))).mode & 0o777 })

  it('round trips through the Keychain and never writes the site, email or token in the clear', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    await saveJiraAccount(dir, CREDS, cipher)
    const file = await onDisk(dir)
    for (const secret of ['acme', 'sam@acme.com', 'jira_tok']) expect(file.text).not.toContain(secret)
    expect(file.mode).toBe(0o600)
    expect(await readdir(dir)).toEqual(['jira.json'])
    expect(await storedJiraAccount(dir, cipher)).toEqual(CREDS)
    await saveJiraAccount(dir, null, cipher)
    expect(await readdir(dir)).toEqual([])
    expect(await storedJiraAccount(dir, cipher)).toBeUndefined()
  })

  it('falls back to a file only the user can read without the Keychain', async () => {
    for (const c of [undefined, refusing]) {
      const dir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
      await saveJiraAccount(dir, CREDS, c)
      const file = await onDisk(dir)
      expect(JSON.parse(file.text)).toEqual(CREDS)
      expect(file.mode).toBe(0o600)
      expect(await storedJiraAccount(dir, c)).toEqual(CREDS)
    }
  })

  it('reads an account it can\'t decrypt, or an odd file, as none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    await saveJiraAccount(dir, CREDS, cipher)
    expect(await storedJiraAccount(dir)).toBeUndefined()
    expect(await storedJiraAccount(dir, refusing)).toBeUndefined()
    for (const t of ['not json', 'null', '[]', '{"site":"acme.atlassian.net","email":"sam@acme.com"}', '{"encrypted":42}']) {
      await writeFile(join(dir, 'jira.json'), t)
      expect(await storedJiraAccount(dir, cipher)).toBeUndefined()
    }
  })
})

describe('Jira in a room (KERNEL-474)', () => {
  const NOOR = '---\nname: noor\ndescription: Engine.\nrole: Engine\n---\nYou are Noor.'
  const JIRA_ROOM = '[tracker]\nkind = "jira"\n\n[jira]\nproject = "PROJ"\n'
  const kernels: Kernel[] = []
  afterEach(async () => { for (const k of kernels.splice(0)) await k.stop() })

  /** A Kernel with a Keychain on a temp repo whose settings are `settings`, and whose Jira calls go to `answer`. */
  async function kernel(answer: (c: Call) => unknown, settings = JIRA_ROOM) {
    const repo = await tempRepo({ 'README.md': '# app\n', '.kernel/settings.toml': settings, '.claude/agents/noor.md': NOOR })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const j = jira(answer)
    const k = new Kernel({ dataDir, home, fetch: j.fetch, cipher })
    kernels.push(k)
    await k.start()
    k.sessions.send = async () => ({ queued: false })
    const room = await k.rooms.addRoom(repo)
    return { k, h: k.integrations.handlers(), room, repo, dataDir, calls: j.calls }
  }

  const me = { accountId: 'acc-sam', displayName: 'Sam Lee' }
  const account = { site: 'acme.atlassian.net', email: 'sam@acme.com', name: 'Sam Lee', accountId: 'acc-sam' }

  it('connects an account after Jira accepts it, keeps it encrypted, and lists the room\'s issues from it', async () => {
    const { h, room, dataDir, calls } = await kernel((c) => c.path === '/rest/api/3/myself' ? me : { issues: [raw('PROJ-7')] })
    expect(await h['issues.tracker']({ roomId: room.id })).toEqual({ kind: 'jira' })
    await expect(h['issues.list']({ roomId: room.id, query: '' })).rejects.toThrow(NO_JIRA)
    expect(await h['jira.test']()).toBeNull()
    expect(await h['jira.connect']({ site: 'https://acme.atlassian.net/jira', email: ' sam@acme.com ', token: ' jira_tok ' })).toEqual(account)
    expect(await readFile(join(dataDir, 'jira.json'), 'utf8')).not.toContain('jira_tok')
    expect(await h['jira.test']()).toEqual(account)
    expect(await h['issues.list']({ roomId: room.id, query: '' })).toEqual([{ id: 'PROJ-7', title: 'Crash on save', url: crash.url, source: 'jira' }])
    expect(await h['jira.issues']({ roomId: room.id, filter: { mine: true } })).toEqual([crash])
    const searches = calls.filter((c) => c.path === '/rest/api/3/search/jql').map((c) => c.body.jql)
    expect(searches).toEqual([
      'statusCategory != Done AND project = "PROJ" ORDER BY updated DESC',
      'statusCategory != Done AND project = "PROJ" AND assignee = currentUser() ORDER BY updated DESC'
    ])
    expect(new Set(calls.map((c) => c.auth))).toEqual(new Set([`Basic ${Buffer.from('sam@acme.com:jira_tok').toString('base64')}`]))
  })

  it('saves nothing Jira refuses, checks the site and email first, and disconnects with an empty token', async () => {
    const { h, dataDir, calls } = await kernel(() => new Response('', { status: 401 }))
    await expect(h['jira.connect']({ site: 'acme', email: 'sam@acme.com', token: 'wrong' })).rejects.toThrow('Jira rejected the email or API token.')
    expect(await h['jira.test']()).toBeNull()
    await expect(h['jira.connect']({ site: 'not a site', email: 'sam@acme.com', token: 'tok' })).rejects.toThrow('Enter your Jira site, like acme.atlassian.net.')
    await expect(h['jira.connect']({ site: 'acme', email: 'sam', token: 'tok' })).rejects.toThrow('Enter the email you sign in to Jira with.')
    expect(calls).toHaveLength(1)
    await saveJiraAccount(dataDir, CREDS, cipher)
    expect(await h['jira.connect']({ site: '', email: '', token: '' })).toBeNull()
    expect(await readdir(dataDir)).not.toContain('jira.json')
  })

  it('uses Jira only when the room says so', async () => {
    const { h, room, dataDir, calls } = await kernel(() => ({ issues: [raw('PROJ-7')] }), '[jira]\nproject = "PROJ"\n')
    await saveJiraAccount(dataDir, CREDS, cipher)
    expect(await h['issues.tracker']({ roomId: room.id })).toEqual({ kind: 'none' })
    expect(await h['issues.list']({ roomId: room.id, query: '' })).toEqual([])
    expect(calls).toEqual([])
  })

  it('lists transitions, saves the room\'s pick, and runs it when a workspace starts on a To Do issue', async () => {
    const { k, h, room, repo, dataDir, calls } = await kernel((c) => {
      if (c.method === 'POST' && c.path.endsWith('/transitions')) return new Response(null, { status: 204 })
      if (c.path === '/rest/api/3/search/jql') return { issues: [raw('PROJ-3')] }
      if (c.path.endsWith('/transitions')) return { transitions: [{ id: '21', name: 'Start progress', to: status('In Progress', 'indeterminate') }] }
      if (c.path.includes('expand=transitions')) return { key: 'PROJ-7', fields: { status: status('To Do', 'new') }, transitions: [{ id: '21', name: 'Start progress', to: status('In Progress', 'indeterminate') }] }
      return { key: 'PROJ-7', fields: { summary: 'Crash on save', labels: ['Bug'], status: status('To Do', 'new') } }
    })
    await saveJiraAccount(dataDir, CREDS, cipher)
    const transitions = [{ id: '21', name: 'Start progress', to: { name: 'In Progress', category: 'indeterminate' } }]
    expect(await h['jira.transitions']({ roomId: room.id })).toEqual(transitions)
    expect(calls.map((c) => c.path)).toEqual(['/rest/api/3/search/jql', '/rest/api/3/issue/PROJ-3/transitions'])
    expect(await h['jira.transitions']({ roomId: room.id, issue: '7' })).toEqual(transitions)
    expect(calls.at(-1)?.path).toBe('/rest/api/3/issue/PROJ-7/transitions')

    expect((await h['jira.saveTransition']({ roomId: room.id, transition: '21' })).jira).toEqual({ project: 'PROJ', transition: '21' })
    expect(await readFile(join(repo, '.kernel/settings.local.toml'), 'utf8')).toContain('transition = "21"')

    const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'Fix it', agentId: 'noor', source: { kind: 'issue', id: 'PROJ-7', title: 'Crash on save' } })
    expect(ws.source).toEqual({ kind: 'issue', id: 'PROJ-7', title: 'Crash on save', tracker: 'jira' })
    expect(ws.branch).toBe('fix/proj-7-crash-on-save')
    for (let i = 0; i < 100 && !calls.some((c) => c.method === 'POST' && c.path.endsWith('/transitions')); i++) await new Promise((r) => setTimeout(r, 20))
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/transitions'))).toMatchObject({ path: '/rest/api/3/issue/PROJ-7/transitions', body: { transition: { id: '21' } } })

    expect((await h['jira.saveTransition']({ roomId: room.id, transition: null })).jira).toEqual({ project: 'PROJ' })
  })

  it('notes a move Jira refuses in Jira\'s name, and the workspace still starts', async () => {
    const notes: ActivityEvent[] = []
    const listen = (e: ActivityEvent) => { if (e.kind === 'note' && e.text.includes('In Progress')) notes.push(e) }
    bus.on('activity', listen)
    try {
      // A transition written by hand as a number counts as its id.
      const { k, room, dataDir } = await kernel((c) => c.path.includes('expand=transitions') ? new Response('', { status: 429 }) : { key: 'PROJ-7', fields: { summary: 'Crash on save', status: status('To Do', 'new') } }, `${JIRA_ROOM}transition = 21\n`)
      await saveJiraAccount(dataDir, CREDS, cipher)
      const ws = await k.workspaces.createWorkspace(room.id, { prompt: 'Fix it', agentId: 'noor', source: { kind: 'issue', id: 'PROJ-7', title: 'Crash on save' } })
      for (let i = 0; i < 100 && !notes.length; i++) await new Promise((r) => setTimeout(r, 20))
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({ workspaceId: ws.id, text: 'could not move PROJ-7 to In Progress in Jira:', object: 'Jira is limiting requests. Try again in a minute.', warn: true })
      expect(ws.status).not.toBe('failed')
    } finally { bus.off('activity', listen) }
  })
})
