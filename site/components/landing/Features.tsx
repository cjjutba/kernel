import { SectionHead } from '@/components/ui/SectionHead'
import { Clip } from './Clip'
import { SpotlightGrid } from './SpotlightGrid'

// What surrounds the loop the hero shows, as a bento of clips recorded from the real app on sample data
// (demo/clips.ts). Two wide tiles bracket two rows of pairs. Every clip is the full window, so all of them share an aspect.

/** Wide tiles carry a title only. The pairs between them add one short line. */
type Feature = { id: string; title: string; text?: string; clip: string; width: number; height: number; label: string; wide?: boolean }

const FEATURES: Feature[] = [
  {
    id: 'f-workspaces',
    wide: true,
    title: 'A workspace for every task.',
    clip: 'workspaces',
    width: 2400,
    height: 1500,
    label: 'The plan is approved, three workspaces appear under the chat and each agent builds in its own; back in Kernel\'s chat the team updates arrive, Theo approves the first pull request and it merges'
  },
  {
    id: 'f-reviews',
    title: 'Reviews that run themselves.',
    text: "Theo reviews every pull request. Blockers hold the merge.",
    clip: 'reviews',
    width: 1600,
    height: 1000,
    label: 'A team update arrives row by row: one pull request merged on its own, one held by blockers, one approved and merged; Noor then fixes both blockers and that pull request merges too'
  },
  {
    id: 'f-permissions',
    title: 'You decide what runs.',
    text: "Every request says why it asks. You choose what runs.",
    clip: 'permissions',
    width: 1600,
    height: 1000,
    label: 'Noor asks to run a command that writes outside the workspace and gets Allow once, then a bigger export gets Always allow here, and a third export runs without asking'
  },
  {
    id: 'f-sharing',
    title: 'Agents show you their work.',
    text: "Pin a comment on a page an agent shared. It goes straight back.",
    clip: 'sharing',
    width: 1600,
    height: 1000,
    label: 'A comment pinned to a button on a shared pricing page goes to Noor, who changes the button and shares the page again; the version menu then lists v3'
  },
  {
    id: 'f-accounts',
    title: 'Claude Code and Codex, side by side.',
    text: 'Add Claude and Codex accounts, by subscription or API key.',
    clip: 'accounts',
    width: 1600,
    height: 1000,
    label: 'From Home, the account menu opens Settings, Accounts: a Claude API key is added and checked, then a Codex subscription signs in, and both show with their usage'
  },
  {
    id: 'f-issues',
    wide: true,
    title: 'From issue to plan to team.',
    clip: 'issues',
    width: 2400,
    height: 1500,
    label: 'An issue planned with Kernel, which reads it and proposes three tasks; once approved, the issue lists its three linked workspaces'
  }
]

function Tile({ f }: { f: Feature }) {
  return (
    <article aria-labelledby={f.id} className={`spot-card flex flex-col rounded-frame border border-line bg-surface-1 ${f.wide ? 'col-span-full' : ''}`}>
      {/* The text sits on a fixed floor, so a line more or less (fonts measure a little differently across systems) never moves the clip. */}
      <div className={`px-10 pt-10 pb-8 max-nav:px-5 max-nav:pt-7 max-nav:pb-6 ${f.wide ? '' : 'faq:min-h-44'}`}>
        <h3 id={f.id} className={`text-balance ${f.wide ? 'text-h3' : 'text-entry-title max-nav:text-h3'}`}>
          {f.title}
        </h3>
        {f.text ? <p className="mt-3 max-w-110 text-body text-muted">{f.text}</p> : null}
      </div>
      <div className="mt-auto px-10 pb-10 max-nav:px-3 max-nav:pb-3">
        {/* Each clip sits in a smaller version of the hero demo's bezel, with the same glow along its top edge. */}
        <div className="demo-bezel bezel-sm">
          <span aria-hidden="true" className="demo-edge" />
          <div className="demo-screen relative overflow-hidden">
            <Clip name={f.clip} width={f.width} height={f.height} label={f.label} />
          </div>
        </div>
      </div>
    </article>
  )
}

export function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="mx-auto max-w-312 px-6 pt-40 max-nav:pt-24">
      <SectionHead
        title="The whole team, in one window."
        titleId="features-title"
      />
      <SpotlightGrid className="mt-14 grid grid-cols-2 gap-4 max-faq:grid-cols-1 max-nav:mt-10 max-nav:gap-3">
        {FEATURES.map((f) => (
          <Tile key={f.id} f={f} />
        ))}
      </SpotlightGrid>
    </section>
  )
}
