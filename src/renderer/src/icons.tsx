import { HugeiconsIcon } from '@hugeicons/react'
import type { Provider } from '@shared/types'
import {
  Add01Icon,
  Alert02Icon,
  AlertCircleIcon,
  BanIcon,
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
  CalendarClockIcon,
  CalendarXIcon,
  ChartNoAxesColumnIcon,
  BookOpen01Icon,
  CancelCircleIcon,
  Chat01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  CodeIcon,
  ComputerIcon,
  ContrastIcon,
  DashboardSpeed01Icon,
  Copy01Icon,
  Delete02Icon,
  Download02Icon,
  EyeIcon,
  File01Icon,
  FileAddIcon,
  FlaskConicalIcon,
  Folder01Icon,
  GaugeIcon,
  GitForkIcon,
  GridViewIcon,
  HelpCircleIcon,
  HourglassIcon,
  HistoryIcon,
  Home01Icon,
  Image01Icon,
  InboxIcon,
  InformationCircleIcon,
  Key01Icon,
  Layers01Icon,
  ListTreeIcon,
  MinusSignIcon,
  MessageSquareOffIcon,
  MoreHorizontalIcon,
  Notification01Icon,
  PauseIcon,
  PlayIcon,
  PowerIcon,
  RefreshIcon,
  ReplyIcon,
  Search01Icon,
  StarIcon,
  SentIcon,
  Settings01Icon,
  StopIcon,
  ServerStack01Icon,
  Shield01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
  SlidersHorizontalIcon,
  Task01Icon,
  TextAlignLeftIcon,
  Tick02Icon,
  UserGroupIcon,
  UserIcon,
  WifiOff01Icon
} from '@hugeicons/core-free-icons'

// Hugeicons' free stroke-rounded set is the icon spec (KERNEL-663). Each name maps to its closest glyph.
const H = {
  search: Search01Icon,
  star: StarIcon,
  home: Home01Icon,
  inbox: InboxIcon,
  issues: Task01Icon,
  refresh: RefreshIcon,
  projects: GridViewIcon,
  history: HistoryIcon,
  layers: Layers01Icon,
  team: UserGroupIcon,
  /** This Mac only: a setting that stays on this computer (KERNEL-680). */
  computer: ComputerIcon,
  plus: Add01Icon,
  up: ArrowUp02Icon,
  chevron: ArrowDown01Icon,
  right: ArrowRight01Icon,
  check: Tick02Icon,
  doc: File01Icon,
  image: Image01Icon,
  pause: PauseIcon,
  play: PlayIcon,
  stop: StopIcon,
  settings: Settings01Icon,
  ext: ArrowUpRight01Icon,
  code: CodeIcon,
  more: MoreHorizontalIcon,
  left: ArrowLeft01Icon,
  folder: Folder01Icon,
  trash: Delete02Icon,
  send: SentIcon,
  question: HelpCircleIcon,
  fork: GitForkIcon,
  sliders: SlidersHorizontalIcon,
  half: ContrastIcon,
  bell: Notification01Icon,
  user: UserIcon,
  shield: Shield01Icon,
  providers: ServerStack01Icon,
  copy: Copy01Icon,
  eye: EyeIcon,
  flask: FlaskConicalIcon,
  info: InformationCircleIcon,
  checkCircle: CheckmarkCircle02Icon,
  burst: Asterisk02Icon,
  chat: Chat01Icon,
  forward: ArrowRightDoubleIcon,
  arrowLeft: ArrowLeft02Icon,
  arrowRight: ArrowRight02Icon,
  arrowDown: ArrowDown02Icon,
  reply: ReplyIcon,
  sidebar: SidebarLeftIcon,
  panelRight: SidebarRightIcon,
  minus: MinusSignIcon,
  clock: Clock01Icon,
  context: TextAlignLeftIcon,
  wifioff: WifiOff01Icon,
  key: Key01Icon,
  warning: Alert02Icon,
  alertCircle: AlertCircleIcon,
  xCircle: CancelCircleIcon,
  clip: Attachment01Icon,
  book: BookOpen01Icon,
  listTree: ListTreeIcon,
  download: Download02Icon,
  /** The footer's Usage button: bars that take the tone of the tightest window (KERNEL-1101). */
  usage: ChartNoAxesColumnIcon,
  gauge: GaugeIcon,
  circleGauge: DashboardSpeed01Icon,
  calendarClock: CalendarClockIcon,
  calendarX: CalendarXIcon,
  /** The glyphs of the transcript's steps and turn ends (KERNEL-1094): a new file, the waiting hourglass, a refused step, a quit, and a chat that didn't load. */
  filePlus: FileAddIcon,
  hourglass: HourglassIcon,
  ban: BanIcon,
  power: PowerIcon,
  chatOff: MessageSquareOffIcon
}

/**
 * Kernel's own glyphs: the PR states and the archive box (KERNEL-753), then the icons redrawn in KERNEL-754. Drawn on a 16 unit grid, stroke 1.4, round caps and joins,
 * commit nodes as rings of radius 1.75. The rules are in docs/decisions/KERNEL-753.md.
 */
const K = {
  branch: <><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="4.5" r="1.75"/><path d="M4 2.5V10.7"/><path d="M12 6.25C12 9.6 4 8.2 4 10.7"/></>,
  pr: <><circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="12.5" r="1.75"/><path d="M4 5.25V10.75"/><path d="M12 10.75V7.5C12 5.8 10.8 5 9.2 5H6.5"/><path d="M8.4 3.2L6.4 5L8.4 6.8"/></>,
  prReady: <><circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><path d="M4 5.25V10.75"/><path d="M8 8.6L10.4 11L14.2 5.6"/></>,
  prDraft: <><circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="12.5" r="1.75"/><path d="M4 5.25V10.75" strokeDasharray="1.6 2.2"/><path d="M12 10.75V8C12 6 11 5 9 5H7.5" strokeDasharray="1.6 2.2"/></>,
  prCifail: <><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3" /><path d="M5.9 5.9L10.1 10.1"/><path d="M10.1 5.9L5.9 10.1"/></>,
  prChanges: <><path d="M3.5 2.2H12.5A1.8 1.8 0 0 1 14.3 4V9.2A1.8 1.8 0 0 1 12.5 11H8.6L5.4 13.8V11H3.5A1.8 1.8 0 0 1 1.7 9.2V4A1.8 1.8 0 0 1 3.5 2.2Z"/><path d="M8 4.3V6.5"/><path d="M8 8.3V8.4"/></>,
  prConflict: <><path d="M1.8 8H5.2"/><path d="M3.4 6.2L5.2 8L3.4 9.8"/><path d="M14.2 8H10.8"/><path d="M12.6 6.2L10.8 8L12.6 9.8"/><path d="M8.6 2.5L7.4 6.2L8.6 9.8L7.4 13.5"/></>,
  merged: <><circle cx="4" cy="3.5" r="1.75"/><circle cx="4" cy="12.5" r="1.75"/><circle cx="12" cy="9.5" r="1.75"/><path d="M4 5.25V10.75"/><path d="M4 5.25C4 8 7 8.2 9 8.4C10.4 8.55 12 8.1 12 7.75"/></>,
  prClosed: <><circle cx="8" cy="8" r="6" /><path d="M3.8 12.2L12.2 3.8"/></>,
  archive: <><rect x="1.8" y="2.6" width="12.4" height="3.4" rx="1.2" /><path d="M2.9 6V11.2A2 2 0 0 0 4.9 13.2H11.1A2 2 0 0 0 13.1 11.2V6"/><path d="M6.3 9H9.7"/></>,
  // KERNEL-754: the icons that read badly at app size, redrawn in the same style.
  plan: <><path d="M1.8 4L5.6 2.6L10.4 4.2L14.2 2.8V12L10.4 13.4L5.6 11.8L1.8 13.2Z"/><path d="M5.6 2.6V11.8"/><path d="M10.4 4.2V13.4"/></>,
  keyboard: <><rect x="1.5" y="3.5" width="13" height="9" rx="2.2"/><path d="M4.8 6.4V6.5"/><path d="M8 6.4V6.5"/><path d="M11.2 6.4V6.5"/><path d="M4.8 9.6V9.7"/><path d="M8 9.6V9.7"/><path d="M11.2 9.6V9.7"/></>,
  lock: <><rect x="3" y="7.2" width="10" height="6.8" rx="2"/><path d="M5.3 7.2V5A2.7 2.7 0 0 1 10.7 5V7.2"/></>,
  eyeoff: <><path d="M1.5 8C3 5.2 5.3 3.9 8 3.9S13 5.2 14.5 8C13 10.8 10.7 12.1 8 12.1S3 10.8 1.5 8Z"/><path d="M2.8 13.4L13.2 2.6"/></>,
  link: <><path d="M9 4.2L9.6 3.6A2.9 2.9 0 0 1 13.7 7.7L11.7 9.7A2.9 2.9 0 0 1 7.6 9.7"/><path d="M7 11.8L6.4 12.4A2.9 2.9 0 0 1 2.3 8.3L4.3 6.3A2.9 2.9 0 0 1 8.4 6.3"/></>,
  plug: <><path d="M6 1.8V5"/><path d="M10 1.8V5"/><path d="M4 5H12V7.6A4 4 0 0 1 4 7.6Z"/><path d="M8 11.6V14.2"/></>,
  chip: <><rect x="3" y="3.5" width="10" height="9" rx="2.2"/><rect x="6.3" y="6.2" width="3.4" height="3.4" rx="0.9"/><path d="M6 1.8V3.5"/><path d="M10 1.8V3.5"/><path d="M6 12.5V14.2"/><path d="M10 12.5V14.2"/></>,
  collapse: <><path d="M3 2.8H13"/><path d="M3 13.2H13"/><path d="M5.8 4.4L8 6.6L10.2 4.4"/><path d="M5.8 11.6L8 9.4L10.2 11.6"/></>,
  /** Another account's chip in the footer: pressing it switches to that account (KERNEL-697). */
  swap: <><path d="M2 5H13.5"/><path d="M11 2.5L13.5 5L11 7.5"/><path d="M14 11H2.5"/><path d="M5 8.5L2.5 11L5 13.5"/></>,
  comment: <><path d="M3.5 2.2H12.5A1.8 1.8 0 0 1 14.3 4V9.2A1.8 1.8 0 0 1 12.5 11H8.6L5.4 13.8V11H3.5A1.8 1.8 0 0 1 1.7 9.2V4A1.8 1.8 0 0 1 3.5 2.2Z"/><path d="M8 4.6V8.2"/><path d="M6.2 6.4H9.8"/></>,
  env: <><path d="M6.5 2.5C5 2.5 4.5 3.2 4.5 4.5V6.3C4.5 7.3 4 8 3 8C4 8 4.5 8.7 4.5 9.7V11.5C4.5 12.8 5 13.5 6.5 13.5"/><path d="M9.5 2.5C11 2.5 11.5 3.2 11.5 4.5V6.3C11.5 7.3 12 8 13 8C12 8 11.5 8.7 11.5 9.7V11.5C11.5 12.8 11 13.5 9.5 13.5"/></>,
  bulb: <><path d="M8 1.8A4.5 4.5 0 0 0 5.3 9.9C5.8 10.3 6 10.8 6 11.4V12H10V11.4C10 10.8 10.2 10.3 10.7 9.9A4.5 4.5 0 0 0 8 1.8Z"/><path d="M6.5 14.2H9.5"/></>,
  sparkle: <path d="M8 1.8C8.5 5.5 10.5 7.5 14.2 8C10.5 8.5 8.5 10.5 8 14.2C7.5 10.5 5.5 8.5 1.8 8C5.5 7.5 7.5 5.5 8 1.8Z"/>,
  close: <><path d="M4 4L12 12"/><path d="M12 4L4 12"/></>,
  term: <><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2.4"/><path d="M4.8 6.4L7 8.4L4.8 10.4"/><path d="M8.8 10.6H11.4"/></>,
  pen: <><path d="M10.4 2.8L13.2 5.6L5.8 13L2.6 13.4L3 10.2Z"/><path d="M8.8 4.4L11.6 7.2"/></>
}

/** The permission and Build here glyphs, drawn on a 24 unit grid at stroke 2, which scales to the 1.4 of the 16 grid. */
const K24 = {
  unlock: <><rect x="3.5" y="11" width="17" height="10" rx="2"/><path d="M7.5 11V7.5a4.5 4.5 0 018.8-1.3"/></>,
  filePen: <><path d="M12.5 22H18a2 2 0 002-2V7l-5-5H6a2 2 0 00-2 2v9.5"/><path d="M14 2v4a2 2 0 002 2h4"/><path d="M13.4 15.6a1 1 0 10-3-3l-5 5a2 2 0 00-.5.9l-.8 2.9a.5.5 0 00.6.6l2.9-.8a2 2 0 00.9-.5z"/></>,
  shieldCheck: <><path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 01-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 011-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 011.5 0C14.5 3.8 17 5 19 5a1 1 0 011 1z"/><path d="M9 12l2 2 4-4"/></>,
  hammer: <><path d="M15 12l-8.4 8.4a1 1 0 01-3-3L12 9"/><path d="M18 15l4-4"/><path d="M21.5 11.5l-1.9-1.9a2 2 0 01-.6-1.4V7l-2.3-2.3a6 6 0 00-4.2-1.8L9 3l.9.8A6.2 6.2 0 0112 8.4V10l2 2h1.2a2 2 0 011.4.6l1.9 1.9"/></>
}

/** The size scale (DESIGN.md, Icons): 12 carets, chips and inline meta; 14 rows, buttons and menu items; 16 headers and the sidebar; 20 empty states. */
export type IconSize = 12 | 13 | 14 | 16 | 20

/** One stroke for every glyph: 1.4 in the old 16px grid, which Hugeicons' 24 grid draws as 2.1. */
const STROKE = 1.4 * (24 / 16)

export function Icon({ name, size = 16 }: { name: IconName; size?: IconSize }) {
  if (name in K24) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4 * 1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{K24[name as keyof typeof K24]}</svg>
  }
  if (name in K) {
    return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{K[name as keyof typeof K]}</svg>
  }
  return <HugeiconsIcon icon={H[name as keyof typeof H]} size={size} strokeWidth={STROKE} aria-hidden="true" />
}

// Kernel's Block K (design/brand/k-icon.svg, KERNEL-818), centered in a 120 box so the K is 0.8 of the box's height. Solid, in `currentColor`.
const K_MARK = 'M0 2.5A2.5 2.5 0 0 1 2.5 0L29.5 0A2.5 2.5 0 0 1 32 2.5L32 93.5A2.5 2.5 0 0 1 29.5 96L2.5 96A2.5 2.5 0 0 1 0 93.5ZM46 40.59A2.5 2.5 0 0 1 46.26 39.47L65.31 1.38A2.5 2.5 0 0 1 67.55 0L95.95 0A2.5 2.5 0 0 1 98.19 3.62L76 48L98.19 92.38A2.5 2.5 0 0 1 95.95 96L67.55 96A2.5 2.5 0 0 1 65.31 94.62L46.26 56.53A2.5 2.5 0 0 1 46 55.41Z'
// The avatar cut: channel 20 instead of 14 and corners r 1.5, so the channel stays open at 12 to 14px (a 14 channel is 1.1px there).
const K_MARK_SMALL = 'M0 1.5A1.5 1.5 0 0 1 1.5 0L30.5 0A1.5 1.5 0 0 1 32 1.5L32 94.5A1.5 1.5 0 0 1 30.5 96L1.5 96A1.5 1.5 0 0 1 0 94.5ZM52 40.35A1.5 1.5 0 0 1 52.16 39.68L71.59 0.83A1.5 1.5 0 0 1 72.93 0L103.57 0A1.5 1.5 0 0 1 104.91 2.17L82 48L104.91 93.83A1.5 1.5 0 0 1 103.57 96L72.93 96A1.5 1.5 0 0 1 71.59 95.17L52.16 56.32A1.5 1.5 0 0 1 52 55.65Z'

/** The big mark on Welcome and Home. Off the size scale, so nothing else uses it. */
export function LargeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="currentColor" aria-hidden="true">
      <path transform="translate(10 12)" d={K_MARK} />
    </svg>
  )
}

/** Kernel's own mark at avatar size: the Lead's avatar, in place of a letter. */
export function KernelMark({ size = 16 }: { size?: IconSize }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="currentColor" aria-hidden="true">
      <path transform="translate(7 12)" d={K_MARK_SMALL} />
    </svg>
  )
}

export type IconName = keyof typeof H | keyof typeof K | keyof typeof K24
export const iconNames = (): IconName[] => [...Object.keys(H), ...Object.keys(K), ...Object.keys(K24)] as IconName[]

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

export type ServiceName = 'github' | 'linear' | 'kernel' | 'figma' | 'notion' | 'vercel' | 'neon' | 'posthog' | 'mcp'

/** The marks of the services Kernel talks to, drawn in `currentColor` on a 24px grid. Each is the brand's own mark, filled in ink and never in its brand color. */
const MARKS = {
  // GitHub's Invertocat (simple-icons `github`).
  github: 'M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z',
  // Linear's logomark (simple-icons `linear`).
  linear: 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
  // Figma's five-shape logo (simple-icons `figma`).
  figma: 'M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z',
  // Notion's block-letter N in its page outline (simple-icons `notion`).
  notion: 'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z',
  // Vercel's triangle (simple-icons `vercel`).
  vercel: 'm12 1.608 12 20.784H0Z',
  // Neon's N (simple-icons `neon`).
  neon: 'M24 0V24l-9.365-8.045V24H0V0ZM2.942 21.087h8.751V9.563l9.365 8.204V2.919L2.942 2.914Z',
  // PostHog's hedgehog (simple-icons `posthog`).
  posthog: 'M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z'
} as const

/** A service's mark at `size`, in `currentColor`. Kernel's is its own K, and a server Kernel has no mark for gets the plug. */
export function ServiceMark({ name, size = 15 }: { name: ServiceName; size?: number }) {
  const stroked: IconSize = size <= 14 ? 14 : 16
  if (name === 'kernel') return <KernelMark size={stroked} />
  if (name === 'mcp') return <Icon name="plug" size={stroked} />
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={MARKS[name]} /></svg>
}
