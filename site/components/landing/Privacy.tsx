import Link from 'next/link'
import type { ReactNode } from 'react'
import { ClaudeLogo, OpenAILogo } from '@/components/brand/logos'
import { KernelMark } from '@/components/brand/KernelMark'
import { ArrowIcon, GitHubIcon, IssueIcon, PulseIcon, ReplayIcon } from '@/components/ui/icons'
import { SpotlightGrid } from './SpotlightGrid'

// Privacy, shown rather than claimed: a map of everything Kernel connects to. Your Mac sits in the middle. On its left,
// what Kernel always talks to, on solid lines that carry a slow pulse outward. On its right, what it talks to only if
// you turn it on, on still, dashed lines. There is no line to a Kernel server, because there is none. The list follows
// docs/privacy (content/docs/privacy.md, Network calls), which has every call in full.
//
// Wide screens: nodes | wire | Mac | wire | nodes (globals.css, Privacy map). Each wire is an SVG stretched over its
// column, from the nodes' centers on one edge to ports on the Mac's edge on the other, so the lines meet both exactly.
// Narrow screens: the Mac, then each group hanging from it on a rail.

type Node = { title: string; text: string; icon: ReactNode }

const ALWAYS: Node[] = [
  {
    title: 'Your agents',
    text: 'Claude Code and Codex, on your login',
    icon: (
      <span className="flex items-center gap-0.5">
        <ClaudeLogo size={12} className="text-claude" />
        <OpenAILogo size={12} className="text-ink" />
      </span>
    )
  },
  { title: 'Git and GitHub', text: "Your repo's remote and pull requests", icon: <GitHubIcon size={14} /> },
  { title: 'Update check', text: "Kernel's releases on GitHub", icon: <ReplayIcon size={14} /> }
]

const OPTIONAL: Node[] = [
  { title: 'Linear or Jira', text: 'Only if you connect them', icon: <IssueIcon size={14} /> },
  { title: 'Usage data', text: 'Anonymous, only if you say yes', icon: <PulseIcon size={14} /> }
]

/** Where the lines meet the nodes' column (their centers) and the Mac's edge, as percentages of the map's height. */
const LEFT = { nodes: [16.67, 50, 83.33], ports: [40, 50, 60] }
const RIGHT = { nodes: [25, 75], ports: [44, 56] }

/** On the map every node is the same height, space for two lines, so each one's middle sits where its line meets it. */
function NodeCard({ node, optional }: { node: Node; optional?: boolean }) {
  return (
    <div className={`spot-card map-node-card flex items-center gap-3 rounded-lg border px-3 py-2.5 faq:min-h-19 ${optional ? 'border-dashed border-edge bg-surface-1/60' : 'border-line-strong bg-surface-1'}`}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface-2 text-ink-2">{node.icon}</span>
      <span className="min-w-0">
        <span className={`block text-ui font-medium ${optional ? 'text-ink-2' : 'text-ink'}`}>{node.title}</span>
        <span className="block text-small text-muted faq:line-clamp-2">{node.text}</span>
      </span>
    </div>
  )
}

/** One side's lines, drawn from the Mac outward. `side` says which edge the Mac is on. */
function Wire({ side, nodes, ports, optional }: { side: 'left' | 'right'; nodes: number[]; ports: number[]; optional?: boolean }) {
  // In a 100 by 100 box: the Mac's edge is x 100 for the left wire and x 0 for the right one.
  const [mac, far] = side === 'left' ? [100, 0] : [0, 100]
  const paths = nodes.map((y, i) => `M${mac} ${ports[i]}C50 ${ports[i]} 50 ${y} ${far} ${y}`)
  return (
    <div aria-hidden="true" className="relative max-faq:hidden">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" fill="none">
        {paths.map((d) => (
          <path key={d} d={d} vectorEffect="non-scaling-stroke" className={optional ? 'map-line map-line-optional' : 'map-line'} />
        ))}
        {optional
          ? null
          : paths.map((d, i) => (
              <path key={`p-${d}`} d={d} pathLength={1} vectorEffect="non-scaling-stroke" className="map-pulse" style={{ animationDelay: `${i * 1.3}s` }} />
            ))}
      </svg>
      {/* Ports: a dot where each line meets the Mac, and one where it meets its node. */}
      {ports.map((y) => (
        <span key={`m${y}`} className={`map-port ${side === 'left' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'}`} style={{ top: `${y}%` }} />
      ))}
      {nodes.map((y) => (
        <span key={`n${y}`} className={`map-port ${optional ? 'map-port-optional' : ''} ${side === 'left' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'}`} style={{ top: `${y}%` }} />
      ))}
    </div>
  )
}

function Group({ label, nodes, optional }: { label: string; nodes: Node[]; optional?: boolean }) {
  return (
    <div className="map-group relative self-stretch">
      <p className="map-label text-small text-faint">{label}</p>
      <ul className="flex h-full flex-col justify-around max-faq:h-auto max-faq:gap-3">
        {nodes.map((n) => (
          <li key={n.title} className="map-node">
            <NodeCard node={n} optional={optional} />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Privacy() {
  return (
    <section id="privacy" aria-labelledby="privacy-title" className="mx-auto max-w-312 px-6 pt-40 max-nav:pt-24">
      <h2 id="privacy-title" className="text-center text-h2 text-balance">
        Your Mac. <br className="nav:hidden" />
        Your plan. <br className="nav:hidden" />
        Your code.
      </h2>
      <p className="mx-auto mt-4 max-w-120 text-center text-lead text-balance text-muted">Everything Kernel connects to. None of it is us.</p>

      <figure className="mt-20 max-nav:mt-10" aria-label="What Kernel connects to">
        {/* The cards take the bento's pointer light. */}
        <SpotlightGrid className="privacy-map grid">
          <Group label="Always" nodes={ALWAYS} />
          <Wire side="left" {...LEFT} />

          {/* The Mac: everything Kernel keeps lives here. */}
          <div className="spot-card map-mac relative self-center rounded-frame border border-line-strong bg-surface-2 p-5 max-faq:order-first">
            <div className="flex flex-col items-center text-center max-faq:flex-row max-faq:items-start max-faq:gap-4 max-faq:text-left">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-edge bg-surface-3 text-ink">
                <KernelMark className="h-4.5 w-auto" />
              </span>
              <span className="mt-4 max-faq:mt-0">
                <span className="block text-item text-ink">Your Mac</span>
                <span className="mt-1 block text-small text-muted">Everything Kernel keeps stays here</span>
                <span className="mt-4 flex flex-wrap justify-center gap-1.5 max-faq:mt-3 max-faq:justify-start">
                  {['Chats', 'History', 'Settings'].map((t) => (
                    <span key={t} className="rounded-chip border border-line-strong bg-surface-1 px-1.5 py-0.5 font-mono text-tag text-ink-3">
                      {t}
                    </span>
                  ))}
                </span>
              </span>
            </div>
          </div>

          <Wire side="right" {...RIGHT} optional />
          <Group label="Only if you turn them on" nodes={OPTIONAL} optional />
        </SpotlightGrid>
        <figcaption className="mt-14 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-small text-muted max-nav:mt-10">
          <span>No Kernel account. No Kernel server.</span>
          <Link href="/docs/privacy#network-calls" className="group inline-flex items-center gap-1 text-ink-2 transition-colors hover:text-ink">
            <span className="decoration-rule underline-offset-3 group-hover:underline">Every network call</span>
            <ArrowIcon className="text-muted transition-transform group-hover:translate-x-0.5" />
          </Link>
        </figcaption>
      </figure>
    </section>
  )
}
