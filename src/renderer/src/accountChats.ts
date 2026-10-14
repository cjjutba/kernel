import { chatProvider } from '@shared/providers'
import type { AccountProfile, Chat, Provider } from '@shared/types'

export const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export const dollars = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`

/** Open chats per account id for one provider: where each chat's last turn ran. A chat with no turn yet counts nowhere (KERNEL-845). */
export function chatsPerAccount(chats: Record<string, Chat[]>, provider: Provider): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const list of Object.values(chats)) {
    for (const c of list) {
      const on = c.ranOn ?? c.lastTurn?.account
      if (c.kind !== 'chat' || c.closed || !on || chatProvider(c) !== provider) continue
      counts[on] = (counts[on] ?? 0) + 1
    }
  }
  return counts
}

export const chatsLabel = (n: number | undefined) => (n ? `${n} chat${n === 1 ? '' : 's'}` : undefined)

export const accountLabel = (accounts: AccountProfile[], provider: Provider, id: string) => accounts.find((a) => a.provider === provider && a.id === id)?.label ?? id
