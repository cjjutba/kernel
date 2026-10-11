import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { ActivityEvent } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import type { TelemetryEvent } from '@shared/telemetry'

/** In-process event bus. Everything the UI shows arrives here first, then gets pushed to the renderer. */
class Bus extends EventEmitter {
  push(event: PushEvent) { this.emit('push', event) }
  activity(e: Omit<ActivityEvent, 'id' | 'ts'> & { ts?: number }): ActivityEvent {
    const event: ActivityEvent = { id: randomUUID(), ts: e.ts ?? Date.now(), ...e }
    this.emit('activity', event)
    this.push({ type: 'activity', event })
    return event
  }
  /** A usage event (KERNEL-397). The Telemetry feature keeps it, and sends it only when the user said yes. */
  track(e: TelemetryEvent) { this.emit('track', e) }
}

export const bus = new Bus()
bus.setMaxListeners(100)
