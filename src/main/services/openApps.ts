import { dirname, join } from 'node:path'
import type { OpenApp } from '@shared/types'
import { insideRoots } from '../windowGuard'
import type { ExecResult } from './exec'

/**
 * One app the Open in menu can list (KERNEL-427). `file` is the .app's name in an Applications folder, and `bundleId` is what
 * Spotlight finds it by anywhere else. `args` are the `open` arguments that start it on `target`, which is a folder for a
 * terminal and for Finder.
 */
export interface CatalogApp {
  id: string
  name: string
  kind: OpenApp['kind']
  bundleId?: string
  file: string
  args: (appPath: string, target: string) => string[]
}

const opens = (appPath: string, target: string) => ['-a', appPath, target]

/** Every app Kernel knows how to open a path in, in the menu's order: Finder, the editors, the terminals. */
export const OPEN_APPS: CatalogApp[] = [
  { id: 'finder', name: 'Finder', kind: 'finder', bundleId: 'com.apple.finder', file: 'Finder.app', args: opens },
  { id: 'vscode', name: 'VS Code', kind: 'editor', bundleId: 'com.microsoft.VSCode', file: 'Visual Studio Code.app', args: opens },
  { id: 'vscode-insiders', name: 'VS Code Insiders', kind: 'editor', bundleId: 'com.microsoft.VSCodeInsiders', file: 'Visual Studio Code - Insiders.app', args: opens },
  { id: 'cursor', name: 'Cursor', kind: 'editor', bundleId: 'com.todesktop.230313mzl4w4u92', file: 'Cursor.app', args: opens },
  { id: 'windsurf', name: 'Windsurf', kind: 'editor', bundleId: 'com.exafunction.windsurf', file: 'Windsurf.app', args: opens },
  { id: 'zed', name: 'Zed', kind: 'editor', bundleId: 'dev.zed.Zed', file: 'Zed.app', args: opens },
  { id: 'sublime', name: 'Sublime Text', kind: 'editor', bundleId: 'com.sublimetext.4', file: 'Sublime Text.app', args: opens },
  { id: 'xcode', name: 'Xcode', kind: 'editor', bundleId: 'com.apple.dt.Xcode', file: 'Xcode.app', args: opens },
  { id: 'android-studio', name: 'Android Studio', kind: 'editor', bundleId: 'com.google.android.studio', file: 'Android Studio.app', args: opens },
  { id: 'intellij', name: 'IntelliJ IDEA', kind: 'editor', bundleId: 'com.jetbrains.intellij', file: 'IntelliJ IDEA.app', args: opens },
  { id: 'webstorm', name: 'WebStorm', kind: 'editor', bundleId: 'com.jetbrains.WebStorm', file: 'WebStorm.app', args: opens },
  { id: 'pycharm', name: 'PyCharm', kind: 'editor', bundleId: 'com.jetbrains.pycharm', file: 'PyCharm.app', args: opens },
  { id: 'antigravity', name: 'Antigravity', kind: 'editor', bundleId: 'com.google.antigravity', file: 'Antigravity.app', args: opens },
  { id: 'terminal', name: 'Terminal', kind: 'terminal', bundleId: 'com.apple.Terminal', file: 'Terminal.app', args: opens },
  { id: 'iterm', name: 'iTerm', kind: 'terminal', bundleId: 'com.googlecode.iterm2', file: 'iTerm.app', args: opens },
  { id: 'warp', name: 'Warp', kind: 'terminal', bundleId: 'dev.warp.Warp-Stable', file: 'Warp.app', args: opens },
  // Ghostty doesn't start in a folder `open` hands it, so a new instance gets the folder as its working directory.
  { id: 'ghostty', name: 'Ghostty', kind: 'terminal', bundleId: 'com.mitchellh.ghostty', file: 'Ghostty.app', args: (appPath, folder) => ['-n', '-a', appPath, '--args', `--working-directory=${folder}`] }
]

/** The folders an installed app's .app sits in. Anything else is left to Spotlight. */
export const appFolders = (home: string) => ['/Applications', join(home, 'Applications'), '/System/Applications/Utilities', '/System/Library/CoreServices']

/** How long the Spotlight search for apps outside those folders may take before Kernel lists what it found without them. */
export const MDFIND_MS = 3_000

/** What finding and opening apps goes through. The app passes the file system and `exec`; tests pass fakes. */
export interface OpenAppsSystem {
  exists: (path: string) => Promise<boolean>
  exec: (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>
}

/** An installed catalog app and the .app it was found at. */
export interface FoundApp { app: CatalogApp; path: string }

const ATTR = 'kMDItemCFBundleIdentifier'

/**
 * The bundle ids Spotlight finds, each with the first .app that has it, from one `mdfind`. A search that fails or runs out of
 * time finds nothing. An app in the Trash doesn't count.
 */
async function spotlight(sys: OpenAppsSystem, ids: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const r = await sys.exec('mdfind', ['-attr', ATTR, ids.map((id) => `${ATTR} == '${id}'`).join(' || ')], { timeoutMs: MDFIND_MS })
  if (r.code !== 0 || r.timedOut) return found
  // Each line is the path, three spaces, then `kMDItemCFBundleIdentifier = <id>`.
  const sep = `   ${ATTR} = `
  for (const line of r.stdout.split('\n')) {
    const at = line.lastIndexOf(sep)
    if (at < 0) continue
    const path = line.slice(0, at), id = line.slice(at + sep.length).trim()
    if (path.endsWith('.app') && !path.includes('/.Trash/') && ids.includes(id) && !found.has(id)) found.set(id, path)
  }
  return found
}

/** The catalog apps installed on this Mac, in catalog order. Only the ones missing from the usual folders cost a Spotlight search. */
export async function findApps(sys: OpenAppsSystem, home: string): Promise<FoundApp[]> {
  const folders = appFolders(home)
  const inFolders = await Promise.all(OPEN_APPS.map(async (app) => {
    for (const dir of folders) if (await sys.exists(join(dir, app.file))) return join(dir, app.file)
    return undefined
  }))
  const missing = OPEN_APPS.flatMap((app, i) => (!inFolders[i] && app.bundleId ? [app.bundleId] : []))
  const elsewhere = missing.length ? await spotlight(sys, missing) : new Map<string, string>()
  return OPEN_APPS.flatMap((app, i) => {
    const path = inFolders[i] ?? (app.bundleId ? elsewhere.get(app.bundleId) : undefined)
    return path ? [{ app, path }] : []
  })
}

/** The app the Open in button shows: the last pick while it is installed, else the first editor, else Finder. */
export function defaultApp(found: FoundApp[], saved?: string): FoundApp | undefined {
  return found.find((f) => f.app.id === saved) ?? found.find((f) => f.app.kind === 'editor') ?? found.find((f) => f.app.kind === 'finder')
}

/** What Open in editor uses when no app is named: the last pick when it is an editor, else the first editor. Never a terminal. */
export function defaultEditor(found: FoundApp[], saved?: string): FoundApp | undefined {
  return found.find((f) => f.app.id === saved && f.app.kind === 'editor') ?? found.find((f) => f.app.kind === 'editor')
}

/** How to open `path` in `to`: the `open` arguments, or Finder's reveal for a file. */
export type Launch = { args: string[] } | { reveal: string }

/**
 * Terminals and Finder never get a file, since `open -a Terminal run.command` runs it. A terminal opens in the file's
 * folder, and Finder shows the file in its folder.
 */
export function launch(to: FoundApp, path: string, dir: boolean): Launch {
  if (to.app.kind === 'finder' && !dir) return { reveal: path }
  return { args: to.app.args(to.path, to.app.kind === 'editor' || dir ? path : dirname(path)) }
}

/** Refuses a path outside every project and workspace, so a page can't open the rest of the Mac. */
export function mustBeInside(path: string, roots: string[]) {
  if (typeof path !== 'string' || !insideRoots(path, roots)) throw new Error('Kernel only opens files inside a project or workspace.')
}
