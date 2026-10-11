import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import type { BinarySource, Provider, ProviderBinary } from '@shared/types'

// Which executable each provider runs (KERNEL-406): the path in Settings, Providers, else Kernel's bundled copy, else the
// one on the PATH. "Use system Claude" / "Use system Codex" skips the bundled copy.

/**
 * The SDK's `claude` binary in a packaged app. The SDK finds it with require.resolve, which points inside app.asar,
 * and a binary there can't be spawned. electron-builder unpacks it to app.asar.unpacked (electron-builder.yml).
 * Outside a packaged app this is undefined and the SDK finds its own.
 */
export function packagedClaude(resources = (process as { resourcesPath?: string }).resourcesPath): string | undefined {
  if (!resources) return undefined
  const path = join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude')
  return existsSync(path) ? path : undefined
}

/** The CLI's own command name, as it sits on the PATH. */
export const COMMAND: Record<Provider, string> = { claude: 'claude', codex: 'codex' }

/** The first executable file called `name` on the PATH. Shell aliases don't count, since Kernel spawns the file itself. */
export function findOnPath(name: string, path = process.env.PATH ?? ''): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, constants.X_OK)
      return file
    } catch { /* not here */ }
  }
  return undefined
}

/** Codex's npm package for this Mac, as `@openai/codex` names its optional dependency. */
const CODEX_PLATFORM = `codex-${process.platform}-${process.arch}`
const CODEX_TRIPLE = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`

/**
 * The bundled `codex` binary in a packaged app. electron-builder unpacks it to app.asar.unpacked (electron-builder.yml),
 * the same way as Claude's. Outside a packaged app this is undefined and `bundledCodex` finds the installed package.
 */
export function packagedCodex(resources = (process as { resourcesPath?: string }).resourcesPath): string | undefined {
  if (!resources) return undefined
  const path = join(resources, 'app.asar.unpacked', 'node_modules', '@openai', CODEX_PLATFORM, 'vendor', CODEX_TRIPLE, 'bin', 'codex')
  return existsSync(path) ? path : undefined
}

/** Kernel's own copy of Codex: the packaged one, or the pinned `@openai/codex` package's binary in development. */
export function bundledCodex(): string | undefined {
  const packaged = packagedCodex()
  if (packaged) return packaged
  try {
    const pkg = createRequire(import.meta.url).resolve('@openai/codex/package.json')
    const platform = createRequire(pkg).resolve(`@openai/${CODEX_PLATFORM}/package.json`)
    const path = join(dirname(platform), 'vendor', CODEX_TRIPLE, 'bin', 'codex')
    return existsSync(path) ? path : undefined
  } catch { return undefined }
}

/** Kernel's own copy of Claude Code: the packaged one, or the Agent SDK's platform package in development. */
export function bundledClaude(): string | undefined {
  const packaged = packagedClaude()
  if (packaged) return packaged
  try {
    const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    return createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`)
  } catch { return undefined }
}

const BUNDLED: Record<Provider, () => string | undefined> = { claude: bundledClaude, codex: bundledCodex }

/** Where a provider's executable comes from, by Settings, Providers. `bundled` and `onPath` are for tests. */
export function resolveBinary(provider: Provider, s: ProviderBinary | undefined, o: { bundled?: () => string | undefined; onPath?: (name: string) => string | undefined } = {}): { path?: string; source: BinarySource } {
  const onPath = o.onPath ?? findOnPath
  if (s?.path.trim()) return { path: s.path.trim(), source: 'custom' }
  if (!s?.useSystem) {
    const bundled = (o.bundled ?? BUNDLED[provider])()
    if (bundled) return { path: bundled, source: 'bundled' }
  }
  const system = onPath(COMMAND[provider])
  return system ? { path: system, source: 'system' } : { source: 'missing' }
}

/**
 * The executable Claude sessions get as `pathToClaudeCodeExecutable`. With Settings left alone it is what it always was:
 * the packaged copy, or undefined so the SDK finds its own.
 */
export function claudeExecutable(s: ProviderBinary | undefined): string | undefined {
  if (!s?.path.trim() && !s?.useSystem) return packagedClaude()
  return resolveBinary('claude', s).path
}
