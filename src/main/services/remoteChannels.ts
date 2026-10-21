import type { Channel } from '@shared/ipc'

/**
 * What a paired device may not ask for, in one place (remote-access-server). The server answers every other channel the
 * window can call, through the same handlers, so a new channel is open to a device until it is listed here. Each group is a
 * reason, and `test/remoteServer.test.ts` fails for a name that is not a channel.
 */
export const REFUSED_CHANNELS = [
  // They open something on this Mac: Terminal, an editor, Finder, Preview, a config file or a sign-in browser.
  'app.openTerminal', 'app.openIn', 'app.openApps', 'app.exportLogs', 'shared.reveal', 'shared.open', 'providers.openConfig',
  // Sign-ins and accounts stay with whoever sits at the Mac. A secret's value is never read back either.
  'account.signIn', 'account.signOut', 'providers.signIn', 'accounts.add', 'accounts.addKey', 'accounts.code', 'accounts.signOut', 'accounts.remove',
  'accounts.mcpSignIn', 'accounts.mcpSetUp', 'env.reveal',
  // They write Claude Code's settings file, restart the hook server or quit the app.
  'hooks.install', 'hooks.restart', 'hooks.uninstall', 'hooks.turnOn', 'hooks.test', 'preflight.fix', 'update.install',
  // A raw shell on the Mac with no approval step. Agents' commands still go through Kernel's approvals.
  'terminal.write', 'terminal.resize', 'terminal.replay', 'terminal.presets',
  // A paired device can't pair another, list its peers or turn the server off. The window does.
  'remote.status', 'remote.pair', 'remote.devices', 'remote.revoke'
] as const satisfies readonly Channel[]

const refused: ReadonlySet<string> = new Set(REFUSED_CHANNELS)

/** The settings keys a device may not change through `settings.set`: where the server listens, and the hook server's port. */
const LOCKED_SETTINGS = ['remote', 'hookPort']

/** Why a call is refused, or undefined when it may go on. `channel` is already known to be a channel the handlers answer. */
export function refusal(channel: string, req: unknown): string | undefined {
  if (channel.startsWith('system.')) return `${channel} belongs to the app's window`
  if (refused.has(channel)) return `${channel} is not available from another device`
  if (channel === 'settings.set') {
    const patch = (req as { patch?: unknown } | undefined)?.patch
    if (patch && typeof patch === 'object' && LOCKED_SETTINGS.some((k) => k in patch)) return 'Remote access settings can only be changed in the app'
  }
  return undefined
}
