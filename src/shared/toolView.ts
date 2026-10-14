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
interface Say { base: string; ing: string; ed: string; rest?: string; object?: string; dir?: string; mono?: boolean; file?: string; agent?: string; fixed?: string }

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
      if (description) return { ...say('run', 'Running', 'Ran'), fixed: description.replace(/[.\s]+$/, '') }
      const command = str(i.command) ?? str(stored)
      return { ...say('run', 'Running', 'Ran'), object: command && firstLine(stripCd(command)), mono: true }
    }
    case 'Read': return withFile(say('read', 'Reading', 'Read'))
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return withFile(say('edit', 'Editing', 'Edited'))
    case 'Write': return withFile(say('write', 'Writing', 'Wrote'))
    case 'Grep': case 'Glob': return { ...say('search', 'Searching', 'Searched', ' code'), object: str(i.pattern) }
    case 'WebFetch': return { ...say('fetch', 'Fetching', 'Fetched'), object: str(i.url) && domainOf(str(i.url)!) }
    case 'WebSearch': return { ...say('search', 'Searching', 'Searched', ' the web'), object: str(i.query) }
    case 'Agent': case 'Task': return { ...say('run', 'Running', 'Ran', ' agent'), object: str(i.description) }
    case 'Skill': return { ...say('use', 'Using', 'Used', ' skill'), object: str(i.skill) ?? str(i.name) }
    default: return undefined
  }
}

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
  if (s.fixed !== undefined) {
    if (state === 'denied') return `You denied "${s.fixed}"`
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
  const failedLine = state === 'failed' && item.output ? firstLine(stripAnsi(item.output)) : undefined
  const named = service === 'mcp' && mcp ? serverTitle(mcp.server) : undefined
  const verb = s ? verbOf(s, state) : item.label || item.name
  const object = s ? (s.object ?? named) : undefined
  const fallback = !s && !mcp ? item.detail : undefined
  const detail = failedLine ?? fallback
  const view: ToolView = {
    verb: maskSecrets(verb),
    object: object ? maskSecrets(object) : undefined,
    dir: s?.dir && maskSecrets(s.dir),
    detail: detail ? clip(maskSecrets(detail)) : undefined,
    service,
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
