import { UpNext } from '@/lib/schema'

// The last entry on the changelog page. Update it when plans change.
export const upNext = UpNext.parse({
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
})
