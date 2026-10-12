import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk'

// Bypass permissions on Claude runs every command inside Claude Code's sandbox (KERNEL-458, from KERNEL-436's draft).

/** GitHub, for git over HTTPS, the API, raw files and release downloads. */
export const GITHUB_DOMAINS = ['github.com', '*.github.com', '*.githubusercontent.com']

/** The npm registries, which npm, pnpm, Yarn and Bun install from. */
export const REGISTRY_DOMAINS = ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com']

/** Package manager caches where each tool keeps them by default, from the home folder. Those that exist are writable. */
export const CACHE_DIRS = ['.npm', 'Library/pnpm/store', 'Library/Caches/pnpm', 'Library/Caches/Yarn', '.yarn/berry', '.bun/install/cache', '.cache/node/corepack']

/**
 * The screenshot commands, which run outside the sandbox (KERNEL-541). They start Electron or Chromium, which register a Mach
 * service at startup, and the sandbox refuses every registration. Each matches the command and its arguments, alone: Claude
 * Code sandboxes a command that chains one with anything else. `pnpm shots:compare` only joins two PNGs, so it stays in.
 */
export const SCREENSHOT_COMMANDS = ['pnpm shots:*', 'node design/canvas/source/render.mjs:*']

/**
 * The sandbox for a Claude process that may run in Bypass permissions, working in `cwd` (KERNEL-458). Commands may write the
 * folder, the repo's git folder (minus its hooks and config), the main checkout's node_modules when Kernel linked it in,
 * Kernel's temp folder and the package manager caches. They reach GitHub and the npm registries and nothing else, and may
 * listen on localhost. A command can't ask to leave the sandbox, and only the screenshot commands run outside it. Claude Code
 * runs the commands without it, rather than refusing to start, where the sandbox can't run. `root` is the room's checkout,
 * whose git folder this opens and whose node_modules `linkNodeModules` links in. Without it neither is writable.
 */
export function bypassSandbox(cwd: string, o: { root?: string; home?: string; tmp?: string } = {}): SandboxSettings {
  const gitDir = o.root ? gitFolder(o.root) : undefined
  const home = o.home ?? homedir()
  const writable = [gitDir, linkedModules(cwd, o.root), real(o.tmp ?? tmpdir()), ...CACHE_DIRS.map((dir) => real(join(home, dir)))]
  return {
    enabled: true,
    failIfUnavailable: false,
    allowUnsandboxedCommands: false,
    // Claude Code allows a sandboxed command without asking unless told not to. That would stop plan mode, and the stricter
    // mode a switch out of Bypass permissions puts this process in, from asking about commands.
    autoAllowBashIfSandboxed: false,
    filesystem: {
      allowWrite: [...new Set(writable.filter((p): p is string => !!p))],
      ...(gitDir ? { denyWrite: [join(gitDir, 'hooks'), join(gitDir, 'config')] } : {})
    },
    network: { allowedDomains: [...GITHUB_DOMAINS, ...REGISTRY_DOMAINS], strictAllowlist: true, allowLocalBinding: true },
    // gh checks certificates through com.apple.trustd.agent, which the sandbox opens only with this (KERNEL-436).
    enableWeakerNetworkIsolation: true,
    excludedCommands: [...SCREENSHOT_COMMANDS]
  }
}

/**
 * The room checkout's own `.git` folder, which every worktree Kernel makes from it commits into. Only a real folder counts.
 * Unlike git, Kernel follows no `.git` file and reads no `commondir`, because the sandbox lets commands write the worktree's
 * `.git` file and the git folder, and through them a command could point the next process's sandbox at the home folder. So a
 * room that is itself a linked worktree or a submodule gets no git folder, and neither does a repo in a parent folder (a
 * dotfiles repo in the home folder). Read from files, since a runner starts synchronously.
 */
export function gitFolder(checkout: string): string | undefined {
  const dotGit = join(checkout, '.git')
  try { return lstatSync(dotGit).isDirectory() ? realpathSync(dotGit) : undefined } catch { return undefined }
}

/**
 * The main checkout's node_modules, when `linkNodeModules` linked the worktree's to it. A link the repo itself carries, or one
 * through a main checkout whose node_modules is a link too, adds nothing, so a cloned repo can't open the home folder this way.
 */
function linkedModules(cwd: string, root?: string): string | undefined {
  if (!root) return undefined
  const link = join(cwd, 'node_modules')
  const target = join(root, 'node_modules')
  try {
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== target || !lstatSync(target).isDirectory()) return undefined
    return realpathSync(target)
  } catch { return undefined }
}

/** The path with every link resolved, as the sandbox checks a write, or nothing when it doesn't exist. */
function real(path: string): string | undefined {
  try { return realpathSync(path) } catch { return undefined }
}

/** What Claude Code 2.1.292 writes to stderr, before the reason, when the sandbox can't start and `failIfUnavailable` is off. */
export const SANDBOX_DISABLED = 'Sandbox disabled: '

/** Calls `fell` once, with Claude Code's reason, when its stderr says it runs commands without the sandbox. */
export function onSandboxFallback(stderr: NodeJS.ReadableStream | null | undefined, fell: (reason: string) => void) {
  if (!stderr) return
  let tail = ''
  const read = (d: string | Buffer) => {
    tail = (tail + d.toString()).slice(-4096)
    const at = tail.indexOf(SANDBOX_DISABLED)
    const end = at < 0 ? -1 : tail.indexOf('\n', at)
    if (end < 0) return
    stderr.removeListener('data', read)
    fell(tail.slice(at + SANDBOX_DISABLED.length, end).trim())
  }
  stderr.on('data', read)
}

/** The chat's note when Claude Code runs a Bypass permissions chat's commands without the sandbox. Its terminal hint is dropped. */
export function sandboxFallbackNote(reason: string): string {
  const why = reason.split(' · ')[0].trim().replace(/\.+$/, '')
  return `The sandbox didn't start, so this chat's commands run in Bypass permissions without it.${why ? ` Claude Code says: ${why}.` : ''}`
}
