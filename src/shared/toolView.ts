export type ToolService = 'linear' | 'github' | 'kernel' | 'figma' | 'notion' | 'vercel' | 'neon' | 'posthog' | 'mcp'

export type ToolState = 'running' | 'done' | 'failed' | 'denied' | 'stopped'

/** What a tool row needs from a chat's tool item. Old chats carry only these, so the view is computed when a row draws. */
export interface ToolLike {
  name: string
  status: 'running' | 'done' | 'failed'
  input?: Record<string, unknown>
  output?: string
  label?: string
  detail?: string
}

/** What the view can't know from the item alone. Both are optional. */
export interface ToolCtx {
  /** The workspace folder, dropped from the front of paths. */
  root?: string
  /** The agent a workspace belongs to, for message_agent, whose input names the workspace and not the agent. */
  agentOf?: (workspaceId: string) => string | undefined
}

export interface ToolView {
  verb: string
  object?: string
  /** The folder of a file object, drawn muted after its name. */
  dir?: string
  detail?: string
  service?: ToolService
  hidden?: boolean
  /** The name is neither an MCP tool nor a built-in the label rules know, so the row says "Used a tool" and not the name. */
  unknown?: boolean
  state: ToolState
  /** The object is a raw command, which keeps its mono face. */
  mono?: boolean
  /** The file a Read, Edit or Write row names, for its icon. */
  file?: string
  /** The teammate a handoff or message names, for the avatar. */
  agent?: string
  /** The whole row as a sentence, for its accessible name. */
  sentence: string
}

const HIDDEN = new Set(['ToolSearch', 'TodoWrite', 'ListMcpResourcesTool', 'ReadMcpResourceTool'])

const SERVICES = ['linear', 'github', 'kernel', 'figma', 'notion', 'vercel', 'neon', 'posthog'] as const

export const SERVICE_NAME: Record<Exclude<ToolService, 'mcp'>, string> = { linear: 'Linear', github: 'GitHub', kernel: 'Kernel', figma: 'Figma', notion: 'Notion', vercel: 'Vercel', neon: 'Neon', posthog: 'PostHog' }

const DETAIL_MAX = 160

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** Terminal colour codes and other escape sequences, removed. */
export const stripAnsi = (text: string) => text.replace(ANSI, '')

const MASK = '***'

/** Secrets as they show in a command, an environment line, a header or a JSON body. Whatever follows the marker is replaced. */
export function maskSecrets(text: string): string {
  return text
    .replace(/\b(\w*(?:TOKEN|KEY|SECRET))=("[^"]*"|'[^']*'|[^\s"']+)/gi, `$1=${MASK}`)
    .replace(/("\w*(?:token|secret|api_?key|password)"\s*:\s*)"[^"]*"/gi, `$1"${MASK}"`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${MASK}`)
    .replace(/\blin_api_[A-Za-z0-9]{8,}/g, `lin_api_${MASK}`)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}/g, `ghp_${MASK}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, `sk-${MASK}`)
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

const firstLine = (text: string | undefined) => text?.split('\n').map((l) => l.trim()).find(Boolean)

const clip = (text: string, max = DETAIL_MAX) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const title = (s: string) => s.split(/[\s_-]+/).filter(Boolean).map(upperFirst).join(' ')

/** The home folder (`/Users/x`, `/home/x`) and the workspace folder, dropped from a path. */
export function shortPath(path: string, root?: string): string {
  const base = root?.replace(/[\\/]+$/, '')
  let p = path
  if (base && (p === base || p.startsWith(`${base}/`) || p.startsWith(`${base}\\`))) p = p.slice(base.length + 1)
  else p = p.replace(/^(?:\/Users|\/home)\/[^/]+\/?/, '').replace(/^[a-zA-Z]:\\Users\\[^\\]+\\?/, '')
  return p || path
}

/** A path as its file name and its folder. */
function fileParts(path: string, root?: string): { name: string; dir?: string } {
  const p = shortPath(path, root)
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return at < 0 ? { name: p } : { name: p.slice(at + 1) || p, dir: p.slice(0, at) || undefined }
}

/** A command without the `cd <dir> &&` an agent puts in front of it. */
export function stripCd(command: string): string {
  let c = command.trim()
  for (;;) {
    const next = c.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s&;]+)\s*&&\s*/, '')
    if (next === c) return c
    c = next
  }
}

const domainOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

/** The server name of an MCP tool, and its tool. `mcp__claude_ai_Linear__save_issue` is `claude_ai_Linear` and `save_issue`. */
export function parseMcp(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const [server, ...rest] = name.slice(5).split('__')
  return { server: server ?? '', tool: rest.join('__') }
}

/** linear, github, kernel, figma, notion, vercel, neon, posthog by the server's name, and mcp for anything else. */
export function serviceOf(server: string): ToolService {
  const words = server.toLowerCase().split(/[^a-z0-9]+/)
  return SERVICES.find((s) => words.includes(s)) ?? 'mcp'
}

const serverTitle = (server: string) => title(server.replace(/^claude[_ .]?ai[_ .]?/i, ''))

/** A tool's verb in its three tenses. `rest` is what follows the verb, and `base` is how "Couldn't …" says it. */
interface Say { base: string; ing: string; ed: string; rest?: string; object?: string; dir?: string; mono?: boolean; file?: string; agent?: string; fixed?: string; /** The agent's own words for what the call does, in the imperative ("Run steps 1 to 5"), which the row says in the call's tense. */ description?: string }

/** The verbs an agent starts a Bash description with. Only these change tense, so a description that starts with something else is left as it was written. */
const DESCRIPTION_VERBS = new Set((
  'add analyze apply archive ask attach benchmark build bundle calculate capture check clean clear clone close collect commit compare compile confirm copy count create debug delete deploy describe diff display download dump edit enable ensure evaluate execute export extract fetch find fix format generate get grep import inspect install kill launch lint list load locate make measure merge migrate move open parse patch ping preview print profile publish pull push query read rebase rebuild record refresh regenerate reinstall remove rename replace report reproduce reset resolve restart restore review revert run rerun save scan search seed send set show simulate sort stage start stop submit summarize sync tail tag test trace trim uninstall unpack unstage update upload validate verify view wait watch write zip'
).split(' '))

const IRREGULAR_PAST: Record<string, string> = { run: 'ran', rerun: 'reran', read: 'read', build: 'built', rebuild: 'rebuilt', find: 'found', get: 'got', make: 'made', write: 'wrote', set: 'set', reset: 'reset', send: 'sent', show: 'showed' }

/** The verbs that double their last letter before "-ing" and "-ed". */
const DOUBLES = new Set(['run', 'rerun', 'stop', 'get', 'set', 'reset', 'plan', 'commit', 'submit', 'ship', 'drop', 'skip', 'map', 'scan', 'trim', 'tag', 'zip', 'grep'])

const gerund = (v: string) => (v.endsWith('ie') ? `${v.slice(0, -2)}ying` : DOUBLES.has(v) ? `${v}${v.slice(-1)}ing` : /[^eoy]e$/.test(v) ? `${v.slice(0, -1)}ing` : `${v}ing`)

const past = (v: string) => IRREGULAR_PAST[v] ?? (v.endsWith('e') ? `${v}d` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ied` : DOUBLES.has(v) ? `${v}${v.slice(-1)}ed` : `${v}ed`)

/** The verb a first word is, in its plain form: "capture" for "Capture" and for "Capturing". */
function verbOfWord(word: string): { verb: string; ing: boolean } | undefined {
  const w = word.toLowerCase()
  if (DESCRIPTION_VERBS.has(w)) return { verb: w, ing: false }
  if (!w.endsWith('ing') || w.length < 6) return undefined
  const stem = w.slice(0, -3)
  const verb = [stem, `${stem}e`, stem.slice(0, -1)].find((c) => DESCRIPTION_VERBS.has(c) && gerund(c) === w)
  return verb ? { verb, ing: true } : undefined
}

/**
 * A description in the tense of its call: "Capture every screen" is "Capturing every screen" while it runs and "Captured every screen" once it is done. Only the first
 * word changes, and only when it is a verb this knows. Anything else is left as the agent wrote it.
 */
export function inflect(description: string, form: 'ing' | 'ed'): string {
  const m = /^([A-Za-z]+)([\s\S]*)$/.exec(description)
  const word = m && verbOfWord(m[1])
  if (!m || !word) return description
  if (form === 'ing' && word.ing) return description
  const out = form === 'ing' ? gerund(word.verb) : past(word.verb)
  return `${m[1][0] === m[1][0].toUpperCase() ? out[0].toUpperCase() : out[0]}${out.slice(1)}${m[2]}`
}

const say = (base: string, ing: string, ed: string, rest = ''): Say => ({ base, ing, ed, rest })

/** Words the generic tools of a known service start with. */
const GENERIC: Record<string, [string, string, string]> = {
  list: ['list', 'Listing', 'Listed'], get: ['read', 'Reading', 'Read'], read: ['read', 'Reading', 'Read'], fetch: ['read', 'Reading', 'Read'],
  search: ['search', 'Searching', 'Searched'], query: ['query', 'Querying', 'Queried'], save: ['save', 'Saving', 'Saved'], create: ['create', 'Creating', 'Created'],
  add: ['add', 'Adding', 'Added'], update: ['update', 'Updating', 'Updated'], edit: ['edit', 'Editing', 'Edited'], delete: ['delete', 'Deleting', 'Deleted'],
  remove: ['remove', 'Removing', 'Removed'], merge: ['merge', 'Merging', 'Merged'], run: ['run', 'Running', 'Ran'], push: ['push', 'Pushing', 'Pushed'],
  deploy: ['deploy', 'Deploying', 'Deployed'], upload: ['upload', 'Uploading', 'Uploaded'], download: ['download', 'Downloading', 'Downloaded'], generate: ['generate', 'Generating', 'Generated']
}

const words = (tool: string, service: ToolService) => {
  const w = tool.split(/[_-]+/).filter(Boolean)
  return w.length > 1 && w[0].toLowerCase() === service ? w.slice(1) : w
}

function generic(tool: string, service: ToolService, input: Record<string, unknown>): Say {
  const w = words(tool, service)
  const [first = '', ...more] = w
  const g = GENERIC[first.toLowerCase()]
  const rest = more.join(' ')
  if (g) return { base: g[0], ing: g[1], ed: g[2], rest: rest ? ` ${rest}` : '', object: str(input.title) ?? str(input.name) ?? str(input.query) }
  const human = upperFirst(w.join(' ').toLowerCase())
  return { base: lowerFirst(human), ing: human, ed: human, fixed: human }
}

function linear(tool: string, i: Record<string, unknown>): Say | undefined {
  const key = str(i.id) ?? str(i.issueId) ?? str(i.issue)
  switch (tool) {
    case 'save_issue': return key ? { ...say('update', 'Updating', 'Updated', ` ${key}`), object: str(i.title) } : { ...say('file', 'Filing', 'Filed', ' issue'), object: str(i.title) }
    case 'list_issues': return { ...say('search', 'Searching', 'Searched', ' issues'), object: str(i.query) }
    case 'get_issue': return say('read', 'Reading', 'Read', key ? ` ${key}` : ' issue')
    case 'save_comment': return { ...say('comment on', 'Commenting on', 'Commented on', key ? ` ${key}` : ' issue'), object: firstLine(str(i.body)) }
    default: return undefined
  }
}

function kernel(tool: string, i: Record<string, unknown>, ctx: ToolCtx): Say | undefined {
  switch (tool) {
    case 'create_workspace': { const agent = str(i.agent); return { ...say('hand', 'Handing', 'Handed', ` to ${agent ? title(agent) : 'an agent'}`), object: str(i.title), agent } }
    case 'message_agent': { const id = str(i.workspace_id); const agent = (id && ctx.agentOf?.(id)) || undefined; return { ...say('message', 'Messaging', 'Messaged', ` ${agent ? title(agent) : 'an agent'}`), object: firstLine(str(i.text)), agent } }
    case 'list_workspaces': return say('check', 'Checking', 'Checked', ' workspaces')
    case 'get_issue': return say('read', 'Reading', 'Read', str(i.key) ? ` ${str(i.key)}` : ' the issue')
    case 'share_file': { const path = str(i.path); return say('share', 'Sharing', 'Shared', ` ${str(i.title) ?? (path ? fileParts(path).name : 'a file')}`) }
    case 'request_plan_approval': return say('ask', 'Asking', 'Asked', ' for plan approval')
    case 'wait_for_merge': return say('set', 'Setting', 'Set', ' a wait')
    case 'merge_workspace': return say('merge', 'Merging', 'Merged')
    case 'archive_workspace': return say('archive', 'Archiving', 'Archived')
    case 'read_plans': return say('read', 'Reading', 'Read', " this chat's plans")
    default: return undefined
  }
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** `stored` is the row's own detail, which an old chat's Bash and file rows have in place of an input. */
function builtIn(name: string, i: Record<string, unknown>, ctx: ToolCtx, stored?: string): Say | undefined {
  const file = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path) ?? (FILE_TOOLS.has(name) ? str(stored) : undefined)
  const withFile = (s: Say): Say => {
    if (!file) return s
    const { name: object, dir } = fileParts(file, ctx.root)
    return { ...s, file, object, dir }
  }
  switch (name) {
    case 'Bash': {
      const description = str(i.description)
      const command = str(i.command) ?? str(stored)
      const object = command && firstLine(stripCd(command))
      if (description) return { ...say('run', 'Running', 'Ran'), description: description.replace(/[.\s]+$/, ''), object, mono: true }
      return { ...say('run', 'Running', 'Ran', ' a command'), object, mono: true }
    }
    case 'Read': return withFile(say('read', 'Reading', 'Read'))
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return withFile(say('edit', 'Editing', 'Edited'))
    case 'Write': return withFile(say('write', 'Writing', 'Wrote'))
    case 'Grep': case 'Glob': return { ...say('search', 'Searching', 'Searched', ' code'), object: str(i.pattern) }
    case 'WebFetch': return { ...say('fetch', 'Fetching', 'Fetched'), object: str(i.url) && domainOf(str(i.url)!) }
    case 'WebSearch': return { ...say('search', 'Searching', 'Searched', ' the web'), object: str(i.query) }
    case 'Agent': case 'Task': return { ...say('run', 'Running', 'Ran', ' agent'), object: str(i.description) }
    case 'Skill': return { ...say('use', 'Using', 'Used', ' skill'), object: str(i.skill) ?? str(i.name) }
    case 'ExitPlanMode': return say('finish', 'Finishing', 'Finished', ' the plan')
    case 'EnterPlanMode': return say('start', 'Starting', 'Started', ' a plan')
    case 'AskUserQuestion': return say('ask', 'Asking', 'Asked', ' a question')
    case 'BashOutput': case 'TaskOutput': return say('read', 'Reading', 'Read', ' command output')
    case 'KillShell': case 'TaskStop': return say('stop', 'Stopping', 'Stopped', ' a command')
    case 'Monitor': return { ...say('watch', 'Watching', 'Watched', ' a command'), object: str(i.description) }
    case 'TaskCreate': return { ...say('add', 'Adding', 'Added', ' a task'), object: str(i.subject) }
    case 'TaskUpdate': return { ...say('update', 'Updating', 'Updated', ' a task'), object: str(i.subject) }
    case 'TaskGet': case 'TaskList': return say('read', 'Reading', 'Read', ' tasks')
    case 'ScheduleWakeup': return { ...say('schedule', 'Scheduling', 'Scheduled', ' a wake-up'), object: str(i.reason) }
    case 'CronCreate': return say('schedule', 'Scheduling', 'Scheduled', ' a task')
    case 'CronDelete': return say('cancel', 'Canceling', 'Canceled', ' a scheduled task')
    case 'CronList': return say('list', 'Listing', 'Listed', ' scheduled tasks')
    case 'EnterWorktree': return say('enter', 'Entering', 'Entered', ' a worktree')
    case 'ExitWorktree': return say('leave', 'Leaving', 'Left', ' a worktree')
    case 'PushNotification': return say('send', 'Sending', 'Sent', ' a notification')
    case 'RemoteTrigger': return say('run', 'Running', 'Ran', ' a remote trigger')
    default: return undefined
  }
}

const UNKNOWN = say('use', 'Using', 'Used', ' a tool')

const DENIED = /doesn't want to proceed|tool use was rejected|permission to use .* has been denied|request interrupted by user|you denied|user denied|denied in kernel/i

/** Whether a failed call failed because its approval was refused, or because it was cut off and never answered. */
function stateOf(item: ToolLike): ToolState {
  if (item.status !== 'failed') return item.status
  const out = item.output ?? ''
  if (/^stopped\b/i.test(out.trim())) return 'stopped'
  return DENIED.test(out) ? 'denied' : 'failed'
}

function verbOf(s: Say, state: ToolState): string {
  const rest = s.rest ?? ''
  if (s.description !== undefined) {
    if (state === 'denied') return `Denied: ${s.description}`
    if (state === 'stopped') return `Stopped: ${s.description}`
    return inflect(s.description, state === 'running' ? 'ing' : 'ed')
  }
  if (s.fixed !== undefined) {
    if (state === 'denied') return `Denied: ${s.fixed}`
    return state === 'stopped' ? `Stopped: ${s.fixed}` : s.fixed
  }
  switch (state) {
    case 'running': return `${s.ing}${rest}`
    case 'done': return `${s.ed}${rest}`
    case 'failed': return `Couldn't ${s.base}${rest}`
    case 'denied': return `You denied ${lowerFirst(s.ing)}${rest}`
    case 'stopped': return `Stopped ${lowerFirst(s.ing)}${rest}`
  }
}

/**
 * A tool call as one short sentence: a verb in the tense the call's status says, what it touched, and the service it touched
 * (KERNEL-782). Computed from `name`, `input`, `status` and `output`, so a chat saved before this existed reads the same way.
 * The stored `label` and `detail` are only the fallback for a tool this doesn't know.
 */
export function toolView(item: ToolLike, ctx: ToolCtx = {}): ToolView {
  const state = stateOf(item)
  const input = item.input ?? {}
  if (HIDDEN.has(item.name)) return { verb: item.name, hidden: true, state, sentence: item.name }
  const mcp = parseMcp(item.name)
  const service = mcp ? serviceOf(mcp.server) : undefined
  let s: Say | undefined
  if (mcp && service) {
    s = service === 'linear' ? linear(mcp.tool, input) : service === 'kernel' ? kernel(mcp.tool, input, ctx) : undefined
    s ??= service === 'mcp' ? humanized(mcp.tool) : generic(mcp.tool, service, input)
  } else s = builtIn(item.name, input, ctx, item.detail)
  const unknown = !s && !mcp
  if (unknown) s = UNKNOWN
  const failedLine = state === 'failed' && item.output ? firstLine(stripAnsi(item.output)) : undefined
  const named = service === 'mcp' && mcp ? serverTitle(mcp.server) : undefined
  const verb = s ? verbOf(s, state) : item.label || item.name
  const object = s ? (s.object ?? named) : undefined
  const fallback = unknown ? item.detail : undefined
  const detail = failedLine ?? fallback
  const view: ToolView = {
    verb: maskSecrets(verb),
    object: object ? maskSecrets(object) : undefined,
    dir: s?.dir && maskSecrets(s.dir),
    detail: detail ? clip(maskSecrets(detail)) : undefined,
    service,
    unknown: unknown || undefined,
    state,
    mono: s?.mono && object ? true : undefined,
    file: s?.file,
    agent: s?.agent,
    sentence: ''
  }
  const at = service && service !== 'kernel' ? ` in ${service === 'mcp' ? (named ?? 'MCP') : SERVICE_NAME[service]}` : ''
  const spoken = service === 'mcp' && view.object === named ? undefined : view.object
  view.sentence = [`${view.verb}${at}`, spoken, view.detail].filter(Boolean).join(': ')
  return view
}

function humanized(tool: string): Say {
  const human = upperFirst(tool.split(/[_-]+/).filter(Boolean).join(' ').toLowerCase())
  return { base: lowerFirst(human), ing: human, ed: human, fixed: human }
}

/** A one-line title for a call, as the approval card and a notification say it. */
export function toolTitle(name: string, input: Record<string, unknown> = {}): string {
  const v = toolView({ name, input, status: 'running' })
  if (v.hidden) return name
  return [v.verb, v.dir && v.object ? `${v.dir}/${v.object}` : v.object].filter(Boolean).join(' ')
}

/**
 * A call as the user is asked to allow it, in the verb's base form: "File issue in Linear: Export invoices as PDF". The
 * running and done tenses are the chat row's, and this is the third, which reads after "Sean wants to" (KERNEL-785).
 */
export function toolAsk(name: string, input: Record<string, unknown> = {}, ctx: ToolCtx = {}): string {
  const mcp = parseMcp(name)
  const service = mcp ? serviceOf(mcp.server) : undefined
  let s: Say | undefined
  if (mcp && service) {
    s = service === 'linear' ? linear(mcp.tool, input) : service === 'kernel' ? kernel(mcp.tool, input, ctx) : undefined
    s ??= service === 'mcp' ? humanized(mcp.tool) : generic(mcp.tool, service, input)
  } else s = builtIn(name, input, ctx)
  // A described command is asked for by its description alone, as it always was: the row shows the command too, the question doesn't.
  const v = toolView({ name, input: s?.description ? { ...input, command: undefined } : input, status: 'running' }, ctx)
  if (v.hidden || !s) return name
  const verb = maskSecrets(s.description ?? s.fixed ?? `${upperFirst(s.base)}${s.rest ?? ''}`)
  return verb + v.sentence.slice(v.verb.length, v.detail ? -(v.detail.length + 2) : undefined)
}
