import type { Fixture } from './types'
import { scene } from './base'

// Team lane: Home and Inbox (KERNEL-17).

const empty = { rooms: [], agents: {}, status: {}, workspaces: [], chats: [], items: {}, approvals: [], activity: [], changes: {}, diffs: {}, push: [] }

export const teamFixtures: Record<string, Fixture> = {
  Home: scene(() => ({ ui: { route: { name: 'home' } } })),
  HomeEmpty: scene(() => ({ ...empty, ui: { route: { name: 'home' } } })),
  Inbox: scene(() => ({ ui: { route: { name: 'inbox' } } })),
  InboxEmpty: scene(() => ({ approvals: [], ui: { route: { name: 'inbox' } } }))
}
