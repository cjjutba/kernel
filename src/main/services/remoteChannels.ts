import type { Channel } from '@shared/ipc'

/**
 * What a paired device may call, in one place (remote-access-server). A device is a remote control for the chats, not an admin
 * console: it follows work (projects, workspaces, chats, transcripts, diffs, files inside a workspace, plans, approvals,
 * notifications, PR status, usage) and steers it (send, queue, stop, answer, start a chat or workspace, create and merge a PR).
 * Every other channel is refused, so a channel added to `KernelApi` stays refused until someone lists it here on purpose.
 * `refusal` below still checks what a few of these calls carry.
 *
 * The file reads under `workspaces.*` are confined to the workspace (and the agent's own scratchpad) by their handlers, which
 * `test/files.test.ts` covers, so a device can't read the rest of the Mac through them.
 */
export const ALLOWED_CHANNELS = [
  'activity.recent',
  'agents.list', 'agents.status',
  'approvals.decide', 'approvals.list', 'approvals.planFile',
  'attention.plan',
  'chats.close', 'chats.compact', 'chats.configure', 'chats.create', 'chats.fork', 'chats.interrupt', 'chats.items', 'chats.list', 'chats.live', 'chats.markRead', 'chats.moveNotice', 'chats.queue', 'chats.queueReason', 'chats.rename', 'chats.retry', 'chats.runMode', 'chats.send', 'chats.sendNow', 'chats.steer', 'chats.unqueue',
  'checkpoints.list', 'checkpoints.preview',
  'commands.list',
  'evidence.pr',
  'git.branchList', 'git.branches',
  'github.issue', 'github.issueList', 'github.issues', 'github.prs',
  'issues.list', 'issues.next', 'issues.taken', 'issues.tracker',
  'lead.open', 'lead.start',
  'models.list',
  'notifications.list', 'notifications.read',
  'openItems.dismiss', 'openItems.list',
  'permissions.availability',
  'pr.continue', 'pr.create', 'pr.get', 'pr.merge', 'pr.pendingAll', 'pr.ready', 'pr.refresh', 'pr.reopen', 'pr.resolve', 'pr.update',
  'projects.brief', 'projects.icon', 'projects.lastActivity', 'projects.list', 'projects.overlaps', 'projects.pushCheck', 'projects.setupLog',
  'settings.get',
  'shared.comments', 'shared.list', 'shared.read', 'shared.thumb',
  'skills.list',
  'tasks.list',
  'threads.list', 'threads.rename',
  'usage.get',
  'workspaces.changes', 'workspaces.commits', 'workspaces.compareBranches', 'workspaces.create', 'workspaces.diff', 'workspaces.files', 'workspaces.fork', 'workspaces.gitStatus', 'workspaces.hunks', 'workspaces.list', 'workspaces.readFile', 'workspaces.readImage', 'workspaces.resolvePaths', 'workspaces.tree'
] as const satisfies readonly Channel[]

/**
 * What a paired device may not call, listed so that each channel is classified exactly once and the test can say so. The
 * reasons: they write settings, project config, scripts, hooks, accounts, sign-ins, providers, env values or integrations;
 * they open something on this Mac (Terminal, an editor, Finder, a browser, a file or folder picker); they run a raw shell
 * (`terminal.*`, `scripts.*`); they delete, discard or revert work; they take a path from the caller outside a workspace
 * (`projects.add`, `projects.setIcon`, `files.*`, `projects.inspectFolder`); they skip a review gate (`reviews.overrule`);
 * they change the agents' team and its instructions; they update the app; or they belong to the window (`system.*`) or to
 * pairing (`remote.*`), so a paired device can't pair another, list its peers or turn the server off.
 */
export const REFUSED_CHANNELS = [
  'account.get', 'account.signIn', 'account.signOut',
  'accounts.add', 'accounts.addKey', 'accounts.cancelAdd', 'accounts.checkMcp', 'accounts.code', 'accounts.list', 'accounts.mcpIgnore', 'accounts.mcpSetUp', 'accounts.mcpSignIn', 'accounts.remove', 'accounts.rename', 'accounts.signOut', 'accounts.switch',
  'agents.addStarter', 'agents.create', 'agents.customize', 'agents.draft', 'agents.listGlobal', 'agents.moveLead', 'agents.resetLead', 'agents.restore', 'agents.retire', 'agents.save', 'agents.saveGlobal', 'agents.seed', 'agents.setTeam',
  'app.checkOnline', 'app.exportLogs', 'app.info', 'app.openApps', 'app.openIn', 'app.openTerminal',
  'chats.moveChoice',
  'checkpoints.revert',
  'env.get', 'env.reveal', 'env.set',
  'files.keepCopying', 'files.preview', 'files.production',
  'github.auth', 'github.avatar', 'github.owners', 'github.repoAvailable', 'github.repos', 'github.status',
  'hooks.install', 'hooks.restart', 'hooks.status', 'hooks.test', 'hooks.turnOn', 'hooks.uninstall',
  'integrations.connect', 'integrations.list',
  'lead.prefetch', 'lead.retryCopy',
  'linear.issue', 'linear.issues', 'linear.plan', 'linear.scope',
  'mcp.accounts', 'mcp.list', 'mcp.recheck',
  'notifications.playSound',
  'preflight.fix', 'preflight.run',
  'projects.add', 'projects.create', 'projects.inspectFolder', 'projects.recentFolders', 'projects.remove', 'projects.resolveOverlap', 'projects.retrySetup', 'projects.setIcon', 'projects.setPaused', 'projects.update',
  'providers.openConfig', 'providers.setPath', 'providers.signIn', 'providers.status',
  'remote.devices', 'remote.pair', 'remote.revoke', 'remote.status',
  'reviews.overrule',
  'scripts.askLead', 'scripts.replay', 'scripts.resize', 'scripts.run', 'scripts.skipSetup', 'scripts.stop', 'scripts.suggest',
  'settings.project', 'settings.set', 'settings.setAlwaysReview', 'settings.setProject', 'settings.setReview',
  'shared.comment', 'shared.open', 'shared.reveal',
  'system.preview.close', 'system.preview.crop', 'system.preview.focus', 'system.preview.hit', 'system.preview.locate', 'system.preview.open', 'system.preview.place', 'system.preview.reload', 'system.preview.scroll', 'system.preview.still',
  'system.fixture', 'system.openExternal', 'system.openInEditor', 'system.pickFolder', 'system.pickImage', 'system.zoomChanged',
  'telemetry.recent', 'telemetry.track',
  'terminal.presets', 'terminal.replay', 'terminal.resize', 'terminal.write',
  'threads.archive', 'threads.archivePreview',
  'update.check', 'update.get', 'update.install',
  'usage.notifyOnReset',
  'workspaces.archive', 'workspaces.commit', 'workspaces.delete', 'workspaces.deletePreview', 'workspaces.discard', 'workspaces.restore', 'workspaces.retryWorktree'
] as const satisfies readonly Channel[]

// Compile-time check: a channel in neither list is a type error here, so a new channel has to be classified.
type Unclassified = Exclude<Channel, (typeof ALLOWED_CHANNELS)[number] | (typeof REFUSED_CHANNELS)[number]>
export const ALL_CHANNELS_CLASSIFIED: [Unclassified] extends [never] ? true : Unclassified = true

const allowed: ReadonlySet<string> = new Set(ALLOWED_CHANNELS)

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Message parts a device may send: text, skills and images carried inline. A part naming a path on the Mac (`src`, `path`) would copy that file into the chat. */
function partsRefusal(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined
  for (const p of parts) if (isObject(p) && (p.src !== undefined || p.path !== undefined)) return 'A message from another device cannot attach a file from this Mac'
  return undefined
}

/** Why a call is refused, or undefined when it may go on. `channel` is any string the client sent. */
export function refusal(channel: string, req: unknown): string | undefined {
  if (!allowed.has(channel)) return `${channel} is not available from another device`
  const r = isObject(req) ? req : {}
  switch (channel) {
    case 'chats.send': case 'chats.steer': return partsRefusal(r.parts)
    case 'projects.brief': return partsRefusal(r.parts)
    case 'workspaces.create':
      if (r.mode === 'current') return 'A workspace in the project folder itself can only be started in the app'
      return partsRefusal(r.parts)
    case 'lead.start':
      if (r.mode !== undefined) return 'The permission mode can only be changed in the app'
      if (isObject(r.where) && r.where.kind === 'current') return 'A chat in the project folder itself can only be started in the app'
      return partsRefusal(r.parts)
    case 'chats.configure':
      if (r.mode !== undefined) return 'The permission mode can only be changed in the app'
      return undefined
    case 'chats.create':
      if (r.kind === 'terminal' || r.preset !== undefined) return 'A terminal can only be opened in the app'
      return undefined
    case 'approvals.decide': {
      const d = isObject(r.decision) ? r.decision : {}
      if (d.always !== undefined || d.scope !== undefined) return 'A rule that always allows a tool can only be added in the app'
      return undefined
    }
    case 'pr.merge':
      if (r.override !== undefined) return 'Merging past a failed review can only be done in the app'
      return undefined
  }
  return undefined
}
