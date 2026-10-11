import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** Until the provider accounts land later in KERNEL-406, the new channels say so instead of answering. */
const notYet = (): never => { throw new Error('Providers and accounts are not ready yet (KERNEL-406).') }

/** Claude Code and Codex: their executables, accounts, switching, model lists and status (KERNEL-406). */
export class Providers extends Feature {
  handlers() {
    return {
      'providers.status': async () => notYet(),
      'providers.setPath': async () => notYet(),
      'providers.signIn': async () => notYet(),
      'providers.openConfig': async () => notYet(),
      'accounts.list': async () => notYet(),
      'accounts.add': async () => notYet(),
      'accounts.code': async () => notYet(),
      'accounts.cancelAdd': async () => notYet(),
      'accounts.switch': async () => notYet(),
      'accounts.signOut': async () => notYet(),
      'accounts.remove': async () => notYet(),
      'models.list': async () => notYet()
    } satisfies Partial<Handlers>
  }
}
