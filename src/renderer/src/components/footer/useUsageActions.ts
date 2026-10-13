import type { Provider } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, go } from '../../store'
import { useBusy } from '../../ui'

export type UsageBusy = `switch:${Provider}:${string}` | `signin:${Provider}`

/**
 * What the footer's chips and its popover both do: switch a provider to another signed-in account, and sign a provider in. One `busy` for both, so a switch from
 * a chip can't start while the popover's is running. The numbers change on the next `usage` and `accounts` push (KERNEL-619, KERNEL-674).
 */
export function useUsageActions() {
  const [busy, run] = useBusy<UsageBusy>()
  const fail = (title: string, e: unknown) => actions.ui.toast({ title, sub: cleanError(e) })
  const switchTo = (provider: Provider, accountId: string) => run(`switch:${provider}:${accountId}`, async () => {
    try {
      actions.accounts.set(await call('accounts.switch', { provider, accountId }))
      void call('usage.get', undefined).then(actions.usage.set).catch(() => undefined)
    } catch (e) { fail('Could not switch accounts', e) }
  })
  // The CLI's own login signs in right here. An added account asks for a code and keeps its name, which its sheet in Settings does.
  const signIn = (provider: Provider, cli: boolean) => {
    if (!cli) {
      actions.ui.closeMenu()
      return go({ name: 'settings', page: 'accounts', tab: provider })
    }
    return run(`signin:${provider}`, async () => {
      try {
        await call('providers.signIn', { provider })
        actions.accounts.set(await call('accounts.list', undefined))
        if (provider === 'claude') actions.account.set(await call('account.get', undefined))
      } catch (e) { fail('Could not sign in', e) }
    })
  }
  return { busy, switchTo, signIn }
}
