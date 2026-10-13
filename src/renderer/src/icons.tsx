import { HugeiconsIcon } from '@hugeicons/react'
import type { Provider } from '@shared/types'
import {
  Add01Icon,
  Alert02Icon,
  Archive02Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowRightDoubleIcon,
  ArrowUp02Icon,
  ArrowUpRight01Icon,
  Asterisk02Icon,
  Attachment01Icon,
  BookOpen01Icon,
  BracketsIcon,
  Cancel01Icon,
  CancelCircleIcon,
  Chat01Icon,
  CheckmarkCircle02Icon,
  ClipboardIcon,
  Clock01Icon,
  CodeIcon,
  CommandLineIcon,
  CommentAdd01Icon,
  ComputerTerminal01Icon,
  ContrastIcon,
  Copy01Icon,
  CpuIcon,
  Delete02Icon,
  Download02Icon,
  Edit02Icon,
  File01Icon,
  FlaskConicalIcon,
  Folder01Icon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  GridViewIcon,
  HelpCircleIcon,
  HistoryIcon,
  Home01Icon,
  Idea01Icon,
  Image01Icon,
  InboxIcon,
  InformationCircleIcon,
  Key01Icon,
  KeyboardIcon,
  Layers01Icon,
  Link01Icon,
  ListTreeIcon,
  LockIcon,
  MinusSignIcon,
  MoreHorizontalIcon,
  Notification01Icon,
  PauseIcon,
  PencilEdit01Icon,
  PlayIcon,
  PlugSocketIcon,
  RefreshIcon,
  ReplyIcon,
  Search01Icon,
  SentIcon,
  ServerStack01Icon,
  Settings01Icon,
  Shield01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Task01Icon,
  TextAlignLeftIcon,
  Tick02Icon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
  UserGroupIcon,
  UserIcon,
  ViewOffIcon,
  WifiOff01Icon
} from '@hugeicons/core-free-icons'

// Hugeicons' free stroke-rounded set is the icon spec (KERNEL-663). Each name maps to its closest glyph.
const H = {
  search: Search01Icon,
  home: Home01Icon,
  inbox: InboxIcon,
  issues: Task01Icon,
  refresh: RefreshIcon,
  rooms: GridViewIcon,
  history: HistoryIcon,
  layers: Layers01Icon,
  team: UserGroupIcon,
  branch: GitBranchIcon,
  plus: Add01Icon,
  close: Cancel01Icon,
  compose: PencilEdit01Icon,
  pen: Edit02Icon,
  up: ArrowUp02Icon,
  chevron: ArrowDown01Icon,
  right: ArrowRight01Icon,
  check: Tick02Icon,
  x: Cancel01Icon,
  term: CommandLineIcon,
  bulb: Idea01Icon,
  plug: PlugSocketIcon,
  doc: File01Icon,
  image: Image01Icon,
  pause: PauseIcon,
  play: PlayIcon,
  ext: ArrowUpRight01Icon,
  code: CodeIcon,
  more: MoreHorizontalIcon,
  left: ArrowLeft01Icon,
  folder: Folder01Icon,
  trash: Delete02Icon,
  send: SentIcon,
  pr: GitPullRequestIcon,
  prDraft: GitPullRequestDraftIcon,
  prClosed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  question: HelpCircleIcon,
  fork: GitForkIcon,
  sliders: SlidersHorizontalIcon,
  gear: Settings01Icon,
  half: ContrastIcon,
  bell: Notification01Icon,
  user: UserIcon,
  keyboard: KeyboardIcon,
  chip: CpuIcon,
  shield: Shield01Icon,
  providers: ServerStack01Icon,
  sparkle: SparklesIcon,
  plan: ClipboardIcon,
  copy: Copy01Icon,
  link: Link01Icon,
  flask: FlaskConicalIcon,
  bigterm: ComputerTerminal01Icon,
  env: BracketsIcon,
  info: InformationCircleIcon,
  checkCircle: CheckmarkCircle02Icon,
  burst: Asterisk02Icon,
  archive: Archive02Icon,
  comment: CommentAdd01Icon,
  chat: Chat01Icon,
  chevrons: UnfoldMoreIcon,
  forward: ArrowRightDoubleIcon,
  arrowLeft: ArrowLeft02Icon,
  arrowRight: ArrowRight02Icon,
  arrowDown: ArrowDown02Icon,
  eyeoff: ViewOffIcon,
  reply: ReplyIcon,
  sidebar: SidebarLeftIcon,
  panelRight: SidebarRightIcon,
  minus: MinusSignIcon,
  clock: Clock01Icon,
  context: TextAlignLeftIcon,
  wifioff: WifiOff01Icon,
  key: Key01Icon,
  lock: LockIcon,
  warning: Alert02Icon,
  xCircle: CancelCircleIcon,
  clip: Attachment01Icon,
  book: BookOpen01Icon,
  collapse: UnfoldLessIcon,
  listTree: ListTreeIcon,
  download: Download02Icon
}

/** The size scale (DESIGN.md, Icons): 12 carets, chips and inline meta; 14 rows, buttons and menu items; 16 headers and the sidebar; 20 empty states. */
export type IconSize = 12 | 14 | 16 | 20

/** One stroke for every glyph: 1.4 in the old 16px grid, which Hugeicons' 24 grid draws as 2.1. */
const STROKE = 1.4 * (24 / 16)

export function Icon({ name, size = 16 }: { name: IconName; size?: IconSize }) {
  return <HugeiconsIcon icon={H[name]} size={size} strokeWidth={STROKE} aria-hidden="true" />
}

/** The big mark on Welcome and Home. Off the size scale and drawn thin, so nothing else uses it. */
export function LargeMark({ size, stroke }: { size: number; stroke: number }) {
  return <HugeiconsIcon icon={H.layers} size={size} strokeWidth={stroke * (24 / 16)} aria-hidden="true" />
}

export type IconName = keyof typeof H
export const iconNames = (): IconName[] => Object.keys(H) as IconName[]

// Claude's mark as Anthropic draws it (simple-icons, source claude.ai), filled in `--claude`. Brand art, so it keeps its own 24px grid.
const CLAUDE = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'

/** The Claude mark in Claude's orange, for the models in the model picker. */
export function ClaudeMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="var(--claude)">
      <path d={CLAUDE} />
    </svg>
  )
}

// The OpenAI blossom, the mark ChatGPT and Codex both use (simple-icons `openai`, v15). OpenAI allows it in black or white only, so it fills with `currentColor`, never a brand color.
const OPENAI = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'

/** The OpenAI mark in ink, for Codex. */
export function OpenAIMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d={OPENAI} />
    </svg>
  )
}

/** The mark of the provider a heading or row names: Claude's for Claude Code, OpenAI's for Codex. */
export function ProviderMark({ provider, size = 16 }: { provider: Provider; size?: number }) {
  return provider === 'codex' ? <OpenAIMark size={size} /> : <ClaudeMark size={size} />
}

// Linear's states and priorities, copied from Linear (KERNEL-160).
// Monochrome: the state is said in words in the group header, and urgent is not colored. `tone` is a color token, never a hex.
export type IssueStateShape = 'triage' | 'backlog' | 'todo' | 'started' | 'done' | 'canceled'
interface StateDraw { label: string; dash?: string; inner?: string; fill?: boolean; tone: 'ink' | 'ink-2' | 'muted' }
const ST: Record<IssueStateShape, StateDraw> = {
  triage: { label: 'Triage', inner: 'M8 5.2v4.2M6.2 7.7 8 9.5l1.8-1.8', tone: 'ink-2' },
  backlog: { label: 'Backlog', dash: '2 2.4', tone: 'muted' },
  todo: { label: 'Todo', tone: 'ink-2' },
  started: { label: 'In progress', inner: 'M8 4.6a3.4 3.4 0 0 1 0 6.8Z', fill: true, tone: 'ink' },
  done: { label: 'Done', inner: 'm5.6 8.2 1.6 1.6 3.2-3.4', tone: 'muted' },
  canceled: { label: 'Canceled', inner: 'M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6', tone: 'muted' }
}
export const issueStateLabel = (s: IssueStateShape) => ST[s].label

/** A Linear state as a 16px circle: dashed for backlog, a half fill for in progress. */
export function IssueState({ shape, size = 16 }: { shape: IssueStateShape; size?: number }) {
  const d = ST[shape]
  const color = `var(--${d.tone})`
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="5.6" strokeDasharray={d.dash} />
      {d.inner && <path d={d.inner} fill={d.fill ? color : 'none'} stroke={d.fill ? 'none' : color} />}
    </svg>
  )
}

export const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const
// Bars lit by level, an outlined square with a mark for urgent, three dashes for none.
const BARS: Record<number, [boolean, boolean, boolean]> = { 2: [true, true, true], 3: [true, true, false], 4: [true, false, false] }
const PRIORITY_MARK: Record<number, string> = {
  1: 'M4.3 2.5h7.4a1.8 1.8 0 0 1 1.8 1.8v7.4a1.8 1.8 0 0 1-1.8 1.8H4.3a1.8 1.8 0 0 1-1.8-1.8V4.3a1.8 1.8 0 0 1 1.8-1.8ZM8 5.3v3.4M8 10.8v.1',
  0: 'M3 8h2M7 8h2M11 8h2'
}

/** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. The name is the accessible name unless the caller says it in words beside it. */
export function IssuePriority({ priority, size = 16, label }: { priority: number; size?: number; label?: boolean }) {
  const bars = BARS[priority]
  const name = PRIORITIES[priority] ?? PRIORITIES[0]
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role={label ? undefined : 'img'} aria-hidden={label ? true : undefined} aria-label={label ? undefined : `${name} priority`} fill="none" stroke="var(--ink-2)" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      {bars && [[2.8, 10, 3], [6.8, 7, 6], [10.8, 4, 9]].map(([x, y, h], i) => <rect key={x} x={x} y={y} width="2.4" height={h} rx="0.8" fill={bars[i] ? 'var(--ink-2)' : 'var(--track)'} stroke="none" />)}
      {PRIORITY_MARK[priority] && <path d={PRIORITY_MARK[priority]} />}
    </svg>
  )
}
