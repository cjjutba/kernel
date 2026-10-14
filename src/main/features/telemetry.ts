import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkEvent, type TelemetryEvent, type TelemetryRecord } from '@shared/telemetry'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { batchBody, type Queued } from '../services/telemetrySend'
import { Feature } from './feature'

/** How many events Kernel keeps on disk while it can't send, and how many it lists for Settings, Privacy. */
export const QUEUE_CAP = 1000
const RECENT_CAP = 200
/** How often a queue that has events goes out. */
export const SEND_EVERY_MS = 60_000

/**
 * Usage data, opt-in (KERNEL-397). Every event is checked against `@shared/telemetry` and kept in a short list for
 * Settings, Privacy and Help, Copy diagnostics, whatever the setting. Only a build with a key, with the user's yes, sends:
 * the events wait in a capped file in the data folder and go out in a batch once a minute. Turning it off deletes the
 * file and the install id. A failed send keeps the events for the next try, and the cap drops the oldest.
 */
export class Telemetry extends Feature {
  private recent: TelemetryRecord[] = []
  private queue: Queued[] = []
  private timer?: NodeJS.Timeout
  /** The send in flight, so a second call waits for it instead of returning before anything went out. */
  private sending?: Promise<void>
  private loaded = false
  private writing: Promise<void> = Promise.resolve()
  private saving = false
  private readonly onTrack = (e: TelemetryEvent) => this.track(e)

  private get queueFile() { return join(this.o.dataDir, 'telemetry-queue.json') }
  private get idFile() { return join(this.o.dataDir, 'telemetry.json') }

  /** Whether this build can send at all: a release build with a key, and nothing in the environment saying no. */
  get canSend(): boolean { return !!this.o.telemetry?.key }
  /** Whether events go out: the build can send and the user said yes. */
  get on(): boolean { return this.canSend && this.settings?.privacy?.telemetry === 'on' }

  start() {
    bus.on('track', this.onTrack)
    bus.track({ name: 'app.started' })
    void this.settingsChanged()
  }

  stop() {
    bus.off('track', this.onTrack)
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** An event from anywhere in Kernel. One that breaks the rules is dropped, and fails a test. */
  track(event: TelemetryEvent) {
    const wrong = checkEvent(event as never)
    if (wrong) {
      if (process.env.VITEST) throw new Error(`Bad usage event: ${wrong}`)
      console.warn(`[telemetry] dropped an event: ${wrong}`)
      return
    }
    const at = Date.now()
    this.recent = [{ event, at, sent: false }, ...this.recent].slice(0, RECENT_CAP)
    if (!this.on) return
    this.queue = [...this.queue, { event, at }].slice(-QUEUE_CAP)
    this.save()
  }

  /** Settings, Privacy changed, or Kernel started: start sending, or stop and delete what waited. */
  async settingsChanged() {
    if (!this.on) {
      clearInterval(this.timer)
      this.timer = undefined
      this.queue = []
      this.loaded = false
      await (this.writing = this.writing.then(() => Promise.all([rm(this.queueFile, { force: true }), rm(this.idFile, { force: true })])).then(() => undefined, () => undefined))
      return
    }
    if (!this.loaded) {
      this.loaded = true
      const saved = await readFile(this.queueFile, 'utf8').then((t) => JSON.parse(t) as Queued[], () => [])
      this.queue = [...saved.filter((q) => !checkEvent(q.event as never)), ...this.queue].slice(-QUEUE_CAP)
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.send(), SEND_EVERY_MS)
      this.timer.unref?.()
    }
    void this.send()
  }

  /** Sends what waits, in one batch. Events that go out are marked sent in the list Settings, Privacy shows. */
  send(): Promise<void> {
    if (this.sending) return this.sending
    if (!this.on || !this.queue.length || !this.o.telemetry) return Promise.resolve()
    return (this.sending = this.sendBatch().finally(() => { this.sending = undefined }))
  }

  private async sendBatch(): Promise<void> {
    if (!this.o.telemetry) return
    const batch = this.queue.slice()
    try {
      const body = batchBody({ key: this.o.telemetry.key, installId: await this.installId(), base: { app: this.o.version ?? '0.0.0', os: this.o.telemetry.os ?? 'unknown', arch: this.o.telemetry.arch ?? process.arch }, events: batch })
      const r = await (this.o.fetch ?? fetch)(`${this.o.telemetry.host.replace(/\/$/, '')}/batch/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
      if (!r.ok) return
      const gone = new Set(batch)
      this.queue = this.queue.filter((q) => !gone.has(q))
      const sent = new Set(batch.map((q) => q.at + JSON.stringify(q.event)))
      this.recent = this.recent.map((r) => (sent.has(r.at + JSON.stringify(r.event)) ? { ...r, sent: true } : r))
      this.save()
    } catch {
      // Offline or the service is down: the events wait for the next minute.
    }
  }

  /** The latest events for Help, Copy diagnostics, one line each. */
  lines(): string[] {
    return this.recent.slice(0, 50).map((r) => `${new Date(r.at).toISOString()} ${r.sent ? 'sent' : 'kept'} ${JSON.stringify(r.event)}`)
  }

  /** A random id for this install, made when sending is turned on and deleted when it is turned off. */
  private async installId(): Promise<string> {
    const saved = await readFile(this.idFile, 'utf8').then((t) => (JSON.parse(t) as { installId?: string }).installId, () => undefined)
    if (saved) return saved
    const id = randomUUID()
    await writeFile(this.idFile, JSON.stringify({ installId: id }))
    return id
  }

  /** Writes the queue as it is when the write runs, so a burst of events is one write. */
  private save() {
    if (this.saving) return
    this.saving = true
    this.writing = this.writing.then(async () => { this.saving = false; if (this.on) await writeFile(this.queueFile, JSON.stringify(this.queue)) }).catch(() => undefined)
  }

  handlers() {
    return {
      'telemetry.recent': async () => this.recent.slice(),
      'telemetry.track': async ({ event }) => {
        const wrong = checkEvent(event as never)
        if (wrong) throw new Error(`Kernel can't keep that event: ${wrong}.`)
        bus.track(event)
        return { ok: true as const }
      }
    } satisfies Partial<Handlers>
  }
}
