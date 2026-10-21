/** Remote access (remote-access-server): what Settings, Remote access shows. */

export interface RemoteStatus {
  /** The setting. */
  enabled: boolean
  /** Whether the server is listening now. False while it is off, and when it could not start (`error` says why). */
  running: boolean
  /** The address it listens on and the port it got, which is not the saved one when that was taken. */
  host?: string
  port?: number
  /** The page a device opens, like `http://192.168.1.20:47100`. */
  url?: string
  error?: string
}

export interface RemotePairing {
  /** `http://<host>:<port>/#pair=<code>`. The code is single use. */
  url: string
  /** The same URL as an SVG QR code. */
  qr: string
  expiresAt: number
}

export interface RemoteDevice {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  /** Whether it has a socket open now. */
  connected: boolean
}
