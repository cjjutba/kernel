import type { Handlers } from '../kernel'
import { Feature } from './feature'

/** Usage data, opt-in (KERNEL-397). */
export class Telemetry extends Feature {
  handlers() {
    return {
      'telemetry.recent': async () => [],
      'telemetry.track': async () => ({ ok: true as const })
    } satisfies Partial<Handlers>
  }
}
