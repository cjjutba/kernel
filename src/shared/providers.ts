import { MODELS, type Chat, type Provider } from './types'

// Which provider runs a model or a chat (KERNEL-406).

/** Claude's aliases an agent file may use for `model:`, as Claude Code takes them. */
const CLAUDE_ALIASES = MODELS.map((m) => m.id.split('-')[1])

/** The provider a model id belongs to: Claude for `claude-*` and Claude's aliases (`opus`, `sonnet`), Codex for the rest. */
export function providerOf(model: string): Provider {
  const m = model.trim().toLowerCase()
  return m.startsWith('claude-') || CLAUDE_ALIASES.includes(m) ? 'claude' : 'codex'
}

/** The provider a chat runs on. Chats from before KERNEL-406 have none and ran on Claude. */
export const chatProvider = (chat: Pick<Chat, 'provider'>): Provider => chat.provider ?? 'claude'

/** The provider a rate limit belongs to. Limits saved before KERNEL-406 have none and were Claude's. */
export const limitProvider = (l: { provider?: Provider }): Provider => l.provider ?? 'claude'
