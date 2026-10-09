'use client'

import * as Tabs from '@radix-ui/react-tabs'
import type { StaticImageData } from 'next/image'
import type { ReactNode } from 'react'
import checkpoints from '@/public/images/checkpoints.png'
import inbox from '@/public/images/inbox.png'
import team from '@/public/images/team.png'
import workspace from '@/public/images/workspace.png'
import { BranchIcon, CheckpointIcon, InboxIcon, TeamIcon } from '@/components/ui/icons'
import { SectionHead } from '@/components/ui/SectionHead'
import { Shot } from '@/components/ui/Shot'

const tabs: { value: string; label: string; icon: ReactNode; line: string; image: StaticImageData; alt: string }[] = [
  {
    value: 'workspaces',
    label: 'Workspaces',
    icon: <BranchIcon />,
    line: 'Every task runs in its own git worktree, branch and port.',
    image: workspace,
    alt: "A Kernel workspace: the agent's chat, the changed files and the run output"
  },
  {
    value: 'inbox',
    label: 'Inbox',
    icon: <InboxIcon />,
    line: 'Plans, risky commands and questions wait here for you.',
    image: inbox,
    alt: 'The Kernel Inbox: an agent asks to run a database command, with Deny and Approve'
  },
  {
    value: 'team',
    label: 'Team',
    icon: <TeamIcon />,
    line: 'See who is working, who needs you and which workspace each agent is in.',
    image: team,
    alt: 'The Kernel Team: each agent with its model, status and workspace'
  },
  {
    value: 'checkpoints',
    label: 'Checkpoints',
    icon: <CheckpointIcon />,
    line: 'Every turn is saved. Step back without losing the chat.',
    image: checkpoints,
    alt: 'The Checkpoints drawer: one saved snapshot per agent turn'
  }
]

export function ProductTour() {
  return (
    <section id="features" aria-labelledby="tour-title" className="mx-auto max-w-312 px-6 pt-40">
      <SectionHead eyebrow="The app" title="The whole team, in one window." titleId="tour-title" />
      <Tabs.Root defaultValue="workspaces">
        <div className="mt-14 flex justify-center">
          <Tabs.List
            aria-label="Product tour"
            className="inline-flex flex-wrap justify-center gap-1 rounded-track border border-line-track bg-track p-1"
          >
            {tabs.map((t) => (
              <Tabs.Trigger
                key={t.value}
                value={t.value}
                className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-transparent px-4 text-ui font-medium text-muted transition-colors hover:text-ink-2 focus-visible:outline-offset-1 tab-active:border-edge tab-active:bg-surface-4 tab-active:text-ink"
              >
                {t.icon}
                {t.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </div>
        {/* All panels stay mounted and hidden, so switching never shifts the layout. Hidden images stay lazy. */}
        {tabs.map((t) => (
          <Tabs.Content key={t.value} value={t.value} forceMount className="outline-none tab-inactive:hidden">
            <p className="mx-auto my-8 max-w-160 text-center text-callout text-muted">{t.line}</p>
            <Shot src={t.image} alt={t.alt} sizes="(max-width: 1248px) calc(100vw - 48px), 1200px" />
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </section>
  )
}
