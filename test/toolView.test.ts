import { describe, expect, it } from 'vitest'
import { maskSecrets, serviceOf, shortPath, stripCd, toolTitle, toolView, type ToolLike } from '../src/shared/toolView'

const call = (name: string, input: Record<string, unknown> = {}, extra: Partial<ToolLike> = {}): ToolLike => ({ name, input, status: 'done', ...extra })

describe('toolView verbs and tenses', () => {
  it('follows the status', () => {
    const save = { title: 'Settings say Saving' }
    expect(toolView(call('mcp__linear__save_issue', save, { status: 'running' })).verb).toBe('Filing issue')
    expect(toolView(call('mcp__linear__save_issue', save)).verb).toBe('Filed issue')
    const failed = toolView(call('mcp__linear__save_issue', save, { status: 'failed', output: 'Team not found\nmore' }))
    expect(failed.verb).toBe("Couldn't file issue")
    expect(failed.detail).toBe('Team not found')
    expect(failed.state).toBe('failed')
  })

  it('reads a refused approval as denied and a cut-off call as stopped', () => {
    const denied = toolView(call('Bash', { command: 'rm -rf dist' }, { status: 'failed', output: "The user doesn't want to proceed with this tool use." }))
    expect(denied.verb).toBe('You denied running a command')
    expect(denied.state).toBe('denied')
    const clicked = toolView(call('Bash', { command: 'pnpm test' }, { status: 'failed', output: 'Denied in Kernel.' }))
    expect(clicked).toMatchObject({ verb: 'You denied running a command', state: 'denied' })
    expect(clicked.detail).toBeUndefined()
    const stopped = toolView(call('mcp__linear__save_issue', {}, { status: 'failed', output: 'Stopped when Kernel quit' }))
    expect(stopped.verb).toBe('Stopped filing issue')
    expect(stopped.state).toBe('stopped')
  })

  it('shows Bash by its description, or by its command without a leading cd', () => {
    expect(toolView(call('Bash', { command: 'pnpm test', description: 'Run the unit tests.' })).verb).toBe('Run the unit tests')
    const bare = toolView(call('Bash', { command: 'cd /tmp/x && cd y && pnpm test --run\nmore' }))
    expect(bare).toMatchObject({ verb: 'Ran a command', object: 'pnpm test --run', mono: true })
    expect(toolView(call('Bash', { command: 'ls', description: 'List files' }, { status: 'failed', output: 'denied by user: you denied' })).verb).toBe('Denied: List files')
  })

  it('reads a Bash call with no description as a command, in each tense, and keeps the command', () => {
    const command = { command: 'pnpm test' }
    expect(toolView(call('Bash', command, { status: 'running' })).verb).toBe('Running a command')
    expect(toolView(call('Bash', command, { status: 'failed', output: 'exit 1' }))).toMatchObject({ verb: "Couldn't run a command", object: 'pnpm test' })
    expect(toolView(call('Bash', command)).sentence).toBe('Ran a command: pnpm test')
    expect(toolView(call('Bash', { ...command, description: '' })).verb).toBe('Ran a command')
    expect(toolView(call('Bash', { ...command, description: 'Run the invoice tests' }, { status: 'running' })).verb).toBe('Run the invoice tests')
  })

  it('reads a denied call with a fixed label without quotes, and other denied wording as before', () => {
    const refused = { status: 'failed' as const, output: "The user doesn't want to proceed with this tool use." }
    expect(toolView(call('Bash', { command: 'pnpm test', description: 'Run the invoice tests' }, refused)).verb).toBe('Denied: Run the invoice tests')
    expect(toolView(call('mcp__my_server__list_things', {}, refused)).verb).toBe('Denied: List things')
    expect(toolView(call('Read', { file_path: 'a.ts' }, refused)).verb).toBe('You denied reading')
  })

  it('names a file by its name with its folder apart', () => {
    const v = toolView(call('Edit', { file_path: '/Users/cj/kernel/worktrees/k/src/a/b.ts' }), { root: '/Users/cj/kernel/worktrees/k' })
    expect(v).toMatchObject({ verb: 'Edited', object: 'b.ts', dir: 'src/a', file: '/Users/cj/kernel/worktrees/k/src/a/b.ts' })
    expect(toolView(call('Write', { file_path: 'x.md' }, { status: 'running' })).verb).toBe('Writing')
    expect(toolView(call('NotebookEdit', { notebook_path: 'n.ipynb' })).object).toBe('n.ipynb')
  })

  it('covers search, web, agents and skills', () => {
    expect(toolView(call('Grep', { pattern: 'foo' }))).toMatchObject({ verb: 'Searched code', object: 'foo' })
    expect(toolView(call('Glob', { pattern: '**/*.ts' })).verb).toBe('Searched code')
    expect(toolView(call('WebFetch', { url: 'https://www.example.com/a?b=1' }))).toMatchObject({ verb: 'Fetched', object: 'example.com' })
    expect(toolView(call('WebSearch', { query: 'electron ipc' })).object).toBe('electron ipc')
    expect(toolView(call('Task', { description: 'Find callers' })).object).toBe('Find callers')
    expect(toolView(call('Agent', { description: 'Review it' })).object).toBe('Review it')
    expect(toolView(call('Skill', { skill: 'unslop' }))).toMatchObject({ verb: 'Used skill', object: 'unslop' })
  })

  it('reads Kernel tools', () => {
    expect(toolView(call('mcp__kernel__create_workspace', { agent: 'christian', title: 'Tool rows' }))).toMatchObject({ verb: 'Handed to Christian', object: 'Tool rows', agent: 'christian', service: 'kernel' })
    expect(toolView(call('mcp__kernel__message_agent', { workspace_id: 'w1', text: 'Rebase please' }), { agentOf: () => 'sean' })).toMatchObject({ verb: 'Messaged Sean', object: 'Rebase please' })
    expect(toolView(call('mcp__kernel__list_workspaces')).verb).toBe('Checked workspaces')
    expect(toolView(call('mcp__kernel__get_issue', { key: 'KERNEL-5' })).verb).toBe('Read KERNEL-5')
    expect(toolView(call('mcp__kernel__share_file', { path: '.kernel/shared/mock.html' })).verb).toBe('Shared mock.html')
    expect(toolView(call('mcp__kernel__request_plan_approval')).verb).toBe('Asked for plan approval')
    expect(toolView(call('mcp__kernel__wait_for_merge')).verb).toBe('Set a wait')
    expect(toolView(call('mcp__kernel__merge_workspace')).verb).toBe('Merged')
    expect(toolView(call('mcp__kernel__archive_workspace')).verb).toBe('Archived')
    expect(toolView(call('mcp__kernel__read_plans')).verb).toBe("Read this chat's plans")
  })

  it('reads Linear and GitHub tools', () => {
    expect(toolView(call('mcp__linear__save_issue', { id: 'KERNEL-7', title: 'T' })).verb).toBe('Updated KERNEL-7')
    expect(toolView(call('mcp__linear__list_issues', { query: 'saving' }))).toMatchObject({ verb: 'Searched issues', object: 'saving' })
    expect(toolView(call('mcp__linear__get_issue', { id: 'KERNEL-3' })).verb).toBe('Read KERNEL-3')
    expect(toolView(call('mcp__linear__save_comment', { issueId: 'KERNEL-3', body: 'Done\nmore' }))).toMatchObject({ verb: 'Commented on KERNEL-3', object: 'Done' })
    expect(toolView(call('mcp__linear__list_issue_labels')).verb).toBe('Listed issue labels')
    expect(toolView(call('mcp__claude_ai_github__list_pull_requests')).verb).toBe('Listed pull requests')
    expect(toolView(call('mcp__github__get_file_contents')).verb).toBe('Read file contents')
  })

  it('humanizes an unknown MCP tool and names its server', () => {
    const v = toolView(call('mcp__my_server__list_issue_labels'))
    expect(v).toMatchObject({ verb: 'List issue labels', object: 'My Server', service: 'mcp' })
    expect(v.sentence).toBe('List issue labels in My Server')
  })

  it('never previews JSON from an MCP tool and falls back to the stored label elsewhere', () => {
    const v = toolView(call('mcp__linear__list_issues', {}, { detail: '{"team":"Kernel"}' }))
    expect(v.detail).toBeUndefined()
  })

  it('never prints the name of a tool it does not know', () => {
    const v = toolView({ name: 'bash_placeholder', status: 'done', label: 'bash_placeholder', detail: 'about it' })
    expect(v).toMatchObject({ verb: 'Used a tool', unknown: true, detail: 'about it' })
    expect(v.sentence).not.toContain('bash_placeholder')
    expect(toolView({ name: 'Mystery', status: 'running', label: 'Did a thing' }).verb).toBe('Using a tool')
    expect(toolView({ name: 'Mystery', status: 'failed', output: 'No such tool available' }).verb).toBe("Couldn't use a tool")
    expect(toolView(call('mcp__context7__query_docs')).unknown).toBeUndefined()
    expect(toolView(call('Read', { file_path: 'a.ts' })).unknown).toBeUndefined()
    expect(toolView(call('ToolSearch')).unknown).toBeUndefined()
  })
})

describe('toolView service and hiding', () => {
  it('matches the service by the normalized server name', () => {
    expect(serviceOf('linear')).toBe('linear')
    expect(serviceOf('claude_ai_Linear')).toBe('linear')
    expect(serviceOf('claude_ai_github')).toBe('github')
    for (const s of ['kernel', 'figma', 'notion', 'vercel', 'neon', 'posthog']) expect(serviceOf(s)).toBe(s)
    expect(serviceOf('context7')).toBe('mcp')
    expect(toolView(call('mcp__claude_ai_Linear__save_issue')).service).toBe('linear')
    expect(toolView(call('Bash', { command: 'ls' })).service).toBeUndefined()
  })

  it('hides the plumbing', () => {
    for (const n of ['ToolSearch', 'TodoWrite', 'ListMcpResourcesTool', 'ReadMcpResourceTool']) expect(toolView(call(n)).hidden).toBe(true)
    expect(toolView(call('Bash', { command: 'ls' })).hidden).toBeUndefined()
  })

  it('says the whole row as a sentence', () => {
    expect(toolView(call('mcp__linear__save_issue', { title: 'Settings say Saving' })).sentence).toBe('Filed issue in Linear: Settings say Saving')
  })
})

describe('paths', () => {
  it('drops the worktree root and the home folder', () => {
    expect(shortPath('/w/k/src/a.ts', '/w/k/')).toBe('src/a.ts')
    expect(shortPath('/Users/cj/Projects/x/a.ts')).toBe('Projects/x/a.ts')
    expect(shortPath('/home/cj/a.ts')).toBe('a.ts')
    expect(shortPath('src/a.ts', '/w/k')).toBe('src/a.ts')
  })

  it('strips a leading cd', () => {
    expect(stripCd('cd "/a b" && ls')).toBe('ls')
    expect(stripCd('ls && cd x')).toBe('ls && cd x')
  })
})

describe('maskSecrets', () => {
  it('masks assignments, keys and bearer tokens', () => {
    expect(maskSecrets('GH_TOKEN=abc123 pnpm x')).toBe('GH_TOKEN=*** pnpm x')
    expect(maskSecrets('STRIPE_SECRET="a b" run')).toBe('STRIPE_SECRET=*** run')
    expect(maskSecrets('API_KEY=zzz')).toBe('API_KEY=***')
    expect(maskSecrets('curl -H "Authorization: Bearer abc.def-ghi"')).toBe('curl -H "Authorization: Bearer ***"')
    const raw = ['sk-ant-api03-abcdefghijkl', `ghp_${'a'.repeat(30)}`, 'lin_api_ABCDEFGH12345678'].join(' ')
    expect(maskSecrets(raw)).toBe('sk-*** ghp_*** lin_api_***')
    expect(maskSecrets('{"api_key": "hunter2", "key": "KERNEL-5"}')).toBe('{"api_key": "***", "key": "KERNEL-5"}')
  })

  it('masks a secret in a row', () => {
    const v = toolView(call('Bash', { command: 'LINEAR_API_KEY=lin_api_ABCDEFGH12345678 node x.js' }))
    expect(v.object).toBe('LINEAR_API_KEY=*** node x.js')
    const failed = toolView(call('Bash', { command: 'x' }, { status: 'failed', output: 'bad Bearer abcdef123' }))
    expect(failed.detail).toBe('bad Bearer ***')
  })
})

describe('toolTitle', () => {
  it('gives a one-line title without renderer code', () => {
    expect(toolTitle('Read', { file_path: 'src/a/b.ts' })).toBe('Reading src/a/b.ts')
    expect(toolTitle('mcp__kernel__list_workspaces')).toBe('Checking workspaces')
    expect(toolTitle('ToolSearch')).toBe('ToolSearch')
  })
})

describe('built-in tools that are not file or shell calls (KERNEL-807)', () => {
  const tenses = (name: string) => (['running', 'done', 'failed', 'denied', 'stopped'] as const).map((status) => {
    const output = status === 'denied' ? "The user doesn't want to proceed with this tool use." : status === 'stopped' ? 'Stopped when Kernel quit' : undefined
    return toolView(call(name, {}, { status: status === 'denied' || status === 'stopped' ? 'failed' : status, output })).verb
  })

  it('labels the plan, command output and stop tools in every tense', () => {
    expect(tenses('ExitPlanMode')).toEqual(['Finishing the plan', 'Finished the plan', "Couldn't finish the plan", 'You denied finishing the plan', 'Stopped finishing the plan'])
    expect(tenses('BashOutput')).toEqual(['Reading command output', 'Read command output', "Couldn't read command output", 'You denied reading command output', 'Stopped reading command output'])
    expect(tenses('KillShell')).toEqual(['Stopping a command', 'Stopped a command', "Couldn't stop a command", 'You denied stopping a command', 'Stopped stopping a command'])
  })

  it('never reads a Claude Code built-in as an unknown tool', () => {
    for (const name of ['ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'BashOutput', 'KillShell', 'TaskOutput', 'TaskStop', 'Monitor', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', 'PushNotification', 'RemoteTrigger']) {
      expect(toolView(call(name)), name).toMatchObject({ unknown: undefined })
    }
  })

  it('names the task or command a row is about', () => {
    expect(toolView(call('TaskCreate', { subject: 'Wire up the toggle' }))).toMatchObject({ verb: 'Added a task', object: 'Wire up the toggle' })
    expect(toolView(call('Monitor', { description: 'dev server logs' }))).toMatchObject({ verb: 'Watched a command', object: 'dev server logs' })
  })
})
