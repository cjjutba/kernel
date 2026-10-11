import type { TelemetryEvent } from '@shared/telemetry'

// What a batch of usage events looks like on the wire (KERNEL-397), apart from the feature so a test can read it whole.

/** An event waiting to go out, with when it happened. */
export interface Queued { event: TelemetryEvent; at: number }

/** What goes with every event: the app's version, the Mac's macOS version and chip. */
export interface Base { app: string; os: string; arch: string }

/**
 * The body for PostHog's batch endpoint. Each event carries its own properties and the base, under a random install id,
 * with no person profile and no location looked up from the address it came from.
 */
export function batchBody(o: { key: string; installId: string; base: Base; events: Queued[] }) {
  return {
    api_key: o.key,
    batch: o.events.map(({ event: { name, ...props }, at }) => ({
      event: name,
      distinct_id: o.installId,
      timestamp: new Date(at).toISOString(),
      properties: { ...props, app_version: o.base.app, os_version: o.base.os, arch: o.base.arch, $process_person_profile: false, $geoip_disable: true }
    }))
  }
}

/**
 * An error nothing caught, as usage data names it: its class, and the first stack line in Kernel's own bundle as a file name
 * and a line. No message and no path, which could hold the user's files.
 */
export function errorEvent(kind: 'exception' | 'rejection', err: unknown): Extract<TelemetryEvent, { name: 'app.error' }> {
  const cls = err instanceof Error ? err.constructor.name : 'Error'
  const errorClass = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(cls) ? cls : 'Error'
  const line = (err instanceof Error ? err.stack ?? '' : '').split('\n').find((l) => /[/\\](out|app\.asar)[/\\]/.test(l))
  const m = line ? /([A-Za-z0-9_.-]{1,40}):(\d{1,7}):(\d{1,5})\)?\s*$/.exec(line) : null
  return { name: 'app.error', kind, errorClass, frame: m ? `${m[1]}:${m[2]}:${m[3]}` : 'unknown' }
}
