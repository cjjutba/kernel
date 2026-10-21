import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import type { PushEvent } from '@shared/ipc'
import type { AppSettings, RemoteDevice, RemotePairing, RemoteStatus } from '@shared/types'
import { bus } from '../bus'
import type { Handlers } from '../kernel'
import { RemoteAuth } from '../services/remoteAuth'
import { RemoteServer, type Asset, type Handler } from '../services/remoteServer'
import { Feature } from './feature'

/** The first IPv4 address of this Mac on a network, which a phone on the same Wi-Fi can reach. */
const lanAddress = (): string | undefined =>
  Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address

/**
 * Remote access (remote-access-server): a server in this app's own process, so another device drives the one Kernel there is.
 * It is off until Settings, Remote access turns it on, and follows the setting from then on. The protocol and the checks are in
 * `services/remoteServer.ts`, the pairing and tokens in `services/remoteAuth.ts`, and what a device may not call in
 * `services/remoteChannels.ts`. These channels are the window's: the server refuses every `remote.*` call from a device.
 */
export class Remote extends Feature {
  private server?: RemoteServer
  private address?: { host: string; port: number }
  private error?: string
  /** Start, stop and restart go one after another, so a quick toggle never leaves two servers. */
  private applying: Promise<void> = Promise.resolve()
  private _auth?: RemoteAuth
  private readonly onPush = (event: PushEvent) => this.server?.broadcast(event)

  /** This Mac's address on the network, for the URL of a server that listens on every interface. Tests swap it. */
  lanAddress: () => string | undefined = lanAddress
  /** The web client's files. None until a later change adds the renderer build here. */
  assets?: (path: string) => Promise<Asset | undefined>

  private get auth(): RemoteAuth { return (this._auth ??= new RemoteAuth(this.store)) }

  start(): Promise<void> {
    bus.on('push', this.onPush)
    return this.apply()
  }

  async stop(): Promise<void> {
    bus.off('push', this.onPush)
    await this.apply(false)
  }

  /** Settings changed: the server follows `remote` if it moved. */
  async settingsChanged(before: AppSettings['remote'] | undefined): Promise<void> {
    const now = this.settings.remote
    if (before?.enabled === now?.enabled && before?.host === now?.host && before?.port === now?.port) return
    await this.apply()
  }

  private apply(want = true): Promise<void> {
    const run = this.applying.then(() => this.reconcile(want))
    this.applying = run.catch(() => undefined)
    return run
  }

  private async reconcile(want: boolean) {
    const old = this.server
    this.server = undefined
    this.address = undefined
    this.error = undefined
    this.auth.clearCodes()
    await old?.stop()
    // A Kernel that never started has no settings, and one that is stopping starts nothing.
    const remote = this.settings?.remote
    if (!want || this.stopped || !remote?.enabled) return
    const server = new RemoteServer({
      host: remote.host === 'network' ? '0.0.0.0' : '127.0.0.1',
      port: remote.port,
      anyHost: remote.host === 'network',
      auth: this.auth,
      handlers: this.k.handlers() as unknown as Record<string, Handler>,
      assets: (path) => this.assets?.(path) ?? Promise.resolve(undefined)
    })
    try {
      this.address = await server.start()
      this.server = server
      this.o.log?.info(`[remote] listening on ${this.address.host}:${this.address.port}`)
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      console.error(`[remote] could not start: ${this.error}`)
    }
  }

  /** The host a device types: this Mac's network address for a server on every interface, else the loopback one. */
  private shownHost(): string {
    return this.settings?.remote?.host === 'network' ? this.lanAddress() ?? '127.0.0.1' : '127.0.0.1'
  }

  status(): RemoteStatus {
    const enabled = this.settings?.remote?.enabled ?? false
    if (!this.server || !this.address) return { enabled, running: false, ...(this.error ? { error: this.error } : {}) }
    return { enabled, running: true, host: this.address.host, port: this.address.port, url: `http://${this.shownHost()}:${this.address.port}` }
  }

  private async pair(): Promise<RemotePairing> {
    const s = this.status()
    if (!s.running || !s.url) throw new Error('Turn on Remote access first.')
    const { code, expiresAt } = this.auth.newCode()
    const url = `${s.url}/#pair=${code}`
    return { url, qr: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }), expiresAt }
  }

  private devices(): RemoteDevice[] {
    const connected = this.server?.connectedIds() ?? new Set<string>()
    return this.auth.devices().map(({ tokenHash: _hash, ...d }) => ({ ...d, connected: connected.has(d.id) }))
  }

  private revoke(id: string) {
    if (!this.auth.revoke(id)) throw new Error('That device is not paired any more.')
    this.server?.closeDevice(id)
    return { ok: true as const }
  }

  handlers() {
    return {
      'remote.status': async () => this.status(),
      'remote.pair': async () => this.pair(),
      'remote.devices': async () => this.devices(),
      'remote.revoke': async ({ id }) => this.revoke(id)
    } satisfies Partial<Handlers>
  }
}
