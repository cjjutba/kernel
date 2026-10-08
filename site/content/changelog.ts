import { Changelog } from '@/lib/schema'

// Newest release first. The first one gets the Latest badge and sets the hero pill on the landing page.
// The schema runs at build time, so a malformed entry fails the build.
export const changelog = Changelog.parse({
  releases: [
    {
      version: '0.1.0',
      date: '2026-10-08',
      title: 'Meet your team',
      image: {
        src: '/images/floor.png',
        alt: "The Kernel floor in 0.1.0: the lead's plan waits for review while the team works"
      },
      intro:
        'The first release of Kernel. Brief a lead, approve the plan, and watch a team of coding agents build in parallel, each in its own workspace, on an office floor you can see.',
      sections: [
        {
          title: 'Highlights',
          items: [
            { lead: 'The floor.', text: 'Your team at their desks, driven by real agent events.' },
            { lead: 'Plans you approve.', text: 'The lead splits a brief into tasks and hands each one out.' },
            { lead: 'Workspaces.', text: 'One git worktree, branch and port for every task.' },
            { lead: 'Inbox.', text: 'Plans, risky commands and questions in one place.' },
            { lead: 'Pull requests, end to end.', text: 'Create, fix checks, address review and merge.' },
            { lead: 'Checkpoints', text: "after every turn, and your agent's own terminal in a tab." },
            { lead: 'Board, settings and a light theme,', text: 'plus macOS notifications.' }
          ]
        },
        {
          title: 'Under the hood',
          items: [
            { text: 'Signed and notarized by Apple, with automatic updates.', pr: 32 },
            { text: "Hooks stay silent when Kernel isn't running.", pr: 33 },
            { text: 'Open at login is off by default, and only the installed app can turn it on.', pr: 34 },
            { text: 'A smaller download, with unused native files left out.', pr: 35 },
            { text: 'Repos without a remote, or with a master branch, work out of the box.', pr: 37 },
            { text: "Every release checks that the app's native modules load before it ships.", pr: 38 }
          ]
        }
      ]
    }
  ],
  upNext: {
    title: "What we're working on",
    intro: "A look at what's coming. Plans can change, and the issues on GitHub are the best place to follow along.",
    items: [
      { lead: 'More coding agents.', text: 'Support for agents beyond the one Kernel runs today.' },
      {
        lead: 'A smoother first launch.',
        text: "An offer to move Kernel into Applications when it's opened from somewhere else."
      },
      { lead: 'Outside sessions on the floor.', text: 'Agents you start in a terminal show up the moment they begin.' },
      { lead: 'A much smaller download.', text: 'Exploring using the agent you already have installed.' }
    ]
  }
})

export const latestRelease = changelog.releases[0]!
